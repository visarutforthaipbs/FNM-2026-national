#!/usr/bin/env python3
"""
Resolve DIW factory operators to DBD juristic persons.

Links each factory's operator (DIW `ONAME`) to its entry in the Department of
Business Development registry, which is what turns "a factory owned by a name"
into "a factory owned by a company with a registration number, directors,
capital and a legal status".

Same discipline as the DIW collector: every raw API response is archived before
anything is inferred from it. Matching rules will improve — being able to
recompute matches from stored responses, rather than re-querying DBD, is the
difference between a rule change costing seconds and costing another full crawl.

What the data supports, measured 2026-08-08
-------------------------------------------
Only juristic persons exist in DBD. 60.8% of all DIW operator names are
individuals (นาย/นาง/นางสาว) with no registry entry at all — though among
*operating* factories the picture is much better, at ~80% juristic.

DBD stores names WITHOUT the legal-form prefix: searching "บริษัท บี-ควิก จำกัด"
returns nothing, "บี-ควิก" returns the company. Stripping the prefix is not a
nicety, it is the difference between working and not.

Legal form is the reliable discriminator. Searching "เกียรติเจริญชัยการโยธา"
returns two entities sharing a core name — a partnership and a company — and
only the DIW prefix says which is meant.

Geography is NOT a reliable filter, and treating it as one would be a mistake:
DBD records the registered head office, not the factory site. บี-ควิก operates
102 factories nationwide from one Nonthaburi address, so its province disagrees
with almost every factory it owns. Province is therefore used only to break
ties, never to reject a candidate.

Usage
-----
    # operators, one per line: name <TAB> province <TAB> factory_count
    psql ... -tAc "select ..." > operators.tsv

    python dbd_resolve.py --input operators.tsv --limit 50   # pilot
    python dbd_resolve.py --input operators.tsv              # full run
    python dbd_resolve.py --report                           # summarise matches
"""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import logging
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dbd_client import DBDClient  # noqa: E402
from dbd_archive import (  # noqa: E402
    latest_match_records,
    operator_key,
    write_gzip_json_atomic,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("dbd-resolve")

ARCHIVE = Path(os.getenv("DBD_ARCHIVE_ROOT", Path.home() / "dbd-archive"))
RAW = ARCHIVE / "raw"
MATCHES = ARCHIVE / "matches.jsonl"

# Legal-form prefixes as they appear in DIW ONAME, longest first so that
# "ห้างหุ้นส่วนจำกัด" is stripped before the shorter "ห้างหุ้นส่วน" can match it.
# The paired value is the DBD jpTypeDesc this form should correspond to; it is
# compared as text rather than by jpTypeCode so the mapping stays self-evident
# and does not depend on guessing DBD's internal code numbering.
LEGAL_FORMS: list[tuple[str, str]] = [
    ("ห้างหุ้นส่วนจำกัด", "ห้างหุ้นส่วนจำกัด"),
    ("ห้างหุ้นส่วนสามัญนิติบุคคล", "ห้างหุ้นส่วนสามัญนิติบุคคล"),
    ("ห้างหุ้นส่วนสามัญ", "ห้างหุ้นส่วนสามัญนิติบุคคล"),
    ("บริษัท", "บริษัทจำกัด"),
]

# Operators that cannot be in DBD. Checked before anything is sent to the API:
# querying 146,792 individuals would be a pointless load on a government service.
INDIVIDUAL_PREFIXES = ("นางสาว", "นาย", "นาง", "ด.ช.", "ด.ญ.")

# Politeness, expressed as a request rate rather than a sleep.
#
# DBD answers in ~0.04s, so the crawl is bounded entirely by how often we choose
# to ask: a single-threaded 0.6s sleep measured 0.58 requests/sec, which is the
# sleep and nothing else. Spreading the work over more machines would not help —
# every node on this tailnet shares one home connection, so DBD would see the
# same source address making N times the requests, which is exactly the pattern
# its Imperva WAF exists to block.
#
# So the rate is a single number, enforced centrally by one limiter that every
# worker passes through. Concurrency then only decides how much of that rate is
# actually used, and can never exceed it.
# Measured against the live service: 4 req/s drew 44 HTTP 429s in 200 operators,
# 0.58 req/s drew almost none. 1.5 is the compromise actually tested below.
DEFAULT_RATE = 1.5     # requests/sec across all workers
DEFAULT_WORKERS = 3

# On repeated failures the limiter halves its own rate rather than retrying into
# a wall — a 401/502 burst usually means the WAF is already unhappy.
BACKOFF_AFTER_ERRORS = 5

# Recovery: after this many clean requests, nudge the rate back up by one
# step toward the ceiling. Slow enough not to re-trigger the WAF, fast
# enough that a single bad minute does not define the whole run.
RECOVER_AFTER_OK = 40
RECOVER_STEP = 0.15


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RateLimiter:
    """
    One gate every request passes through, so total load is a chosen number.

    Deliberately not a per-worker sleep: with N workers each sleeping D seconds
    the real rate is N/D, which drifts as workers are added and is easy to get
    wrong by a factor of six. Here the rate is stated once and the workers
    contend for it.

    `penalise()` halves the rate after a run of failures, on the assumption that
    errors mean the far end wants less traffic, not the same traffic retried.
    """

    def __init__(self, rate: float):
        self.min_interval = 1.0 / rate
        self.rate = rate
        self.ceiling = rate
        self._next = 0.0
        self._lock = threading.Lock()
        self._consecutive_errors = 0
        self._consecutive_ok = 0

    def acquire(self) -> None:
        with self._lock:
            now = time.monotonic()
            wait = max(0.0, self._next - now)
            self._next = max(now, self._next) + self.min_interval
        if wait > 0:
            time.sleep(wait)

    def ok(self) -> None:
        """
        Recover after a quiet spell.

        Halving without recovery meant one burst of 429s crippled the whole run:
        the rate fell to the 0.25 floor and stayed there, turning a ~13 hour job
        into a ~42 hour one. Additive increase against multiplicative decrease
        lets the crawl find the rate the service will actually tolerate, instead
        of being permanently punished for the worst moment of the run.
        """
        with self._lock:
            self._consecutive_errors = 0
            self._consecutive_ok += 1
            if self._consecutive_ok >= RECOVER_AFTER_OK and self.rate < self.ceiling:
                self._consecutive_ok = 0
                self.rate = min(self.ceiling, self.rate + RECOVER_STEP)
                self.min_interval = 1.0 / self.rate
                logger.info(f"↗️  {RECOVER_AFTER_OK} clean requests — easing back to {self.rate:.2f} req/s")

    def penalise(self, hard: bool = False) -> None:
        """
        Slow down. `hard` is for HTTP 429, where the server has stated outright
        that we are asking too often — that needs no corroboration from a run of
        five failures, and waiting for one just means five more rejected
        requests. Measured: 4 req/s produced 44 429s in 200 operators, while
        0.58 req/s produced almost none.
        """
        with self._lock:
            self._consecutive_ok = 0
            self._consecutive_errors += 1
            if hard or self._consecutive_errors >= BACKOFF_AFTER_ERRORS:
                self._consecutive_errors = 0
                self.rate = max(0.25, self.rate / 2)
                self.min_interval = 1.0 / self.rate
                why = "429 Too Many Requests" if hard else "repeated failures"
                logger.warning(f"⚠️  {why} — backing off to {self.rate:.2f} req/s")


_local = threading.local()


def client_for_thread() -> DBDClient:
    """
    One client per worker thread.

    DBDClient holds a requests.Session and a JWT it refreshes on expiry; sharing
    one across threads would race on that refresh and produce spurious 401s that
    look like rate limiting.
    """
    if not hasattr(_local, "client"):
        _local.client = DBDClient()
    return _local.client


def normalize_name(value: str) -> str:
    """
    Reduce a name to the part that actually identifies the entity.

    DBD is inconsistent about suffixes: partnerships are stored bare
    ("เกียรติเจริญชัยการโยธา") while companies keep theirs
    ("เอสซีจี ซิเมนต์ จำกัด"). Comparing raw strings therefore fails for every
    company, which silently demoted correct matches to "probable" and turned
    distinguishable candidates into ties.
    """
    s = " ".join((value or "").split())
    for suffix in ("จำกัด (มหาชน)", "จำกัด(มหาชน)", "(มหาชน)", "จำกัด"):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    return " ".join(s.split())


def name_variants(core: str) -> list[str]:
    """
    Alternative spellings to try when a name finds nothing.

    DIW and DBD disagree on Thai orthography: DIW writes "ปูนซีเมนต์ไทย" where
    DBD has "ปูนซิเมนต์ไทย". This handles that specific well-known alternation
    rather than pretending to solve Thai spelling generally — anything it does
    not cover is reported as no_match, never guessed at.
    """
    out = [core]
    for a, b in (("ซี", "ซิ"), ("ซิ", "ซี")):
        if a in core:
            v = core.replace(a, b)
            if v not in out:
                out.append(v)
    return out


def compare_key(value: str) -> str:
    """
    Comparison form of a name: normalized, with all internal spacing removed.

    Thai does not put semantic spaces between words, so DIW's "เอส.เจ.ซี.คอนกรีต"
    and DBD's "เอส.เจ.ซี. คอนกรีต" are the same name written twice, as are
    "ปูนซิเมนต์ไทย(แก่งคอย)" and "ปูนซิเมนต์ไทย (แก่งคอย)", and DBD's own
    "ลินเด้ (ประเทศไทย )" with its stray space. Comparing on spacing therefore
    measures typing, not identity — and every one of those differences used to
    cost 5 points, dropping a single unambiguous candidate from `exact` to
    `probable`, where the public view then hid it.
    """
    return "".join(normalize_name(value).split())


# How each legal form writes its own suffix, for suffix-qualified queries.
FORM_SUFFIX: dict[str, str] = {
    "บริษัทจำกัด": "จำกัด",
    "บริษัทมหาชนจำกัด": "จำกัด (มหาชน)",
}

# Why a candidate's name counts as equal to ours. Recorded on every match so a
# whole class can be audited — or revoked — later without re-crawling.
BASIS_IDENTICAL = "identical"    # equal after suffix normalization
BASIS_SPACING = "spacing"        # equal once spacing is ignored
BASIS_VARIANT = "variant"        # equal to a known spelling variant


def name_equality(jp_name: str, core: str, matched_query: str | None,
                  original_empty: bool) -> str | None:
    """
    Say whether a DBD name is the same name as ours, and on what basis.

    The variant rung is the only one that accepts a genuinely different
    spelling, and it is admissible only when `original_empty` — that is, when a
    search for the spelling DIW actually wrote returned nothing at all. That
    condition is what makes it safe: it proves no company exists under DIW's
    spelling, so the variant cannot be shadowing a different real company.
    """
    if normalize_name(jp_name) == normalize_name(core):
        return BASIS_IDENTICAL
    if compare_key(jp_name) == compare_key(core):
        return BASIS_SPACING
    if matched_query and original_empty and compare_key(jp_name) == compare_key(matched_query):
        return BASIS_VARIANT
    return None


def query_plan(form: str, core: str) -> list[tuple[str, bool]]:
    """
    The query shapes to try, in order, as (query, is_original_spelling).

    The bare core name comes first so that every query already in the archive
    stays valid and no settled operator is re-fetched. Suffix-qualified shapes
    are appended for the cases the bare name cannot settle: searching "เสริมสุข"
    returns 1,135 rows sorted by name, with the real company far beyond any page
    we would fetch, while "เสริมสุข จำกัด (มหาชน)" returns exactly one row — the
    right one. Narrowing the question beats paging through the wrong answer.
    """
    plan: list[tuple[str, bool]] = []
    seen: set[str] = set()
    variants = name_variants(core)
    for variant in variants:
        if variant not in seen:
            seen.add(variant)
            plan.append((variant, variant == core))
    suffix = FORM_SUFFIX.get(form)
    if suffix:
        for variant in variants:
            query = f"{variant} {suffix}"
            if query not in seen:
                seen.add(query)
                plan.append((query, False))
    return plan


# The one DBD status that means the entity is still trading. Everything else —
# ควบ (merged), สิ้นสภาพ, เลิก, ร้าง — describes a company that cannot be
# operating a factory today.
STATUS_LIVE = "ยังดำเนินกิจการอยู่"

# Best to worst. Used to keep the strongest result across query shapes.
OUTCOME_RANK = {
    "exact": 5,
    "probable": 4,
    "ambiguous": 3,
    "form_mismatch": 2,
    "no_match": 1,
}


def failure_outcome(error: Exception | str | None) -> str:
    """Classify terminal source rejections without pretending they are matches.

    DBD returns HTTP 400 for structurally invalid searches and HTTP 403 for a
    small set of names its gateway refuses. Neither means "no company exists",
    so preserve them as explicit non-matchable states instead of retrying them
    forever or silently converting them to ``no_match``.
    """
    message = str(error or "")
    if "400 Client Error" in message:
        return "invalid_name"
    if "403 Client Error" in message:
        return "source_blocked"
    return "error"


def split_legal_form(oname: str) -> tuple[str | None, str]:
    """
    Return (expected DBD jpTypeDesc, core name) for a DIW operator name.

    A None form means the operator is not a juristic person, or its form is
    unrecognised — either way it should not be searched.
    """
    name = " ".join(oname.split())
    if name.startswith(INDIVIDUAL_PREFIXES):
        return None, name
    for prefix, jp_type_desc in LEGAL_FORMS:
        if name.startswith(prefix):
            core = name[len(prefix):].strip()
            # A public company is its own DBD type, not a บริษัทจำกัด, so the
            # "(มหาชน)" marker has to be read before it is stripped away.
            if jp_type_desc == "บริษัทจำกัด" and "(มหาชน)" in core:
                jp_type_desc = "บริษัทมหาชนจำกัด"
            return jp_type_desc, normalize_name(core)
    return None, name


def blob_path(query: str) -> Path:
    h = hashlib.sha256(query.encode("utf-8")).hexdigest()
    return RAW / h[:2] / f"{h}.json.gz"


def archive_response(query: str, payload: dict) -> Path:
    """Store the raw response verbatim, before any interpretation."""
    path = blob_path(query)
    write_gzip_json_atomic(
        path,
        {"query": query, "fetched_at": utc_now(), "response": payload},
    )
    return path


def load_archived(query: str) -> dict | None:
    path = blob_path(query)
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh)["response"]
    except Exception:
        return None


def score(candidates: list[dict], expected_form: str, core: str, province: str,
          matched_query: str | None = None,
          original_empty: bool = False) -> tuple[dict | None, str, list]:
    """
    Choose among DBD candidates, and say how confident that choice is.

    Deliberately conservative: an ambiguous result is reported as ambiguous
    rather than resolved to a best guess. A wrong ownership claim about a real
    company is worse than an absent one.

    Loosening *how names are compared* (see `name_equality`) must not loosen
    *how confidently we conclude*, so two gates bound the whole function:

      - Legal form stays a hard requirement. DBD really does hold both
        "ไทยวา จำกัด (มหาชน)" and "ไทยวา จำกัด" as separate companies, and the
        form is the only field that tells them apart.
      - A name that fits more than one *operating* candidate of the right form
        is ambiguous, whatever the tie-breakers say. Previously a single point
        of province or liveness could split two identically-named companies and
        return one of them as a confident answer; with a looser comparison that
        would have become the main way to acquire a wrong match.

    Liveness is part of that test rather than a tie-breaker after it, because
    of what the registry actually contains: measured over the full archive, 233
    of 239 names that fit two companies fit exactly one that is still trading,
    the other being ควบ (merged) or สิ้นสภาพ (defunct) — the same business
    before and after a restructuring, as with สยามคราฟท์อุตสาหกรรม or
    ซีพี แอ็กซ์ตร้า. A factory operating today cannot be run by the dissolved
    half, so that is not an ambiguity. Two *live* companies sharing a name is,
    and there were 2 of those.
    """
    scored = []
    for c in candidates:
        jp_type = ((c.get("jpType") or {}).get("jpTypeDesc") or "").strip()
        jp_name = (c.get("jpName") or "").strip()
        pv = ((c.get("locationProvince") or {}).get("pvDesc") or "").strip()
        status = ((c.get("jpStatus") or {}).get("jpStatDesc") or "").strip()
        basis = name_equality(jp_name, core, matched_query, original_empty)

        points = 0
        if jp_type == expected_form:
            points += 10          # legal form is the one hard signal
        if basis:
            points += 5           # same name, on one of the allowed bases
        if province and pv == province:
            points += 1           # tie-break only: DBD holds the head office
        if status == STATUS_LIVE:
            points += 1           # prefer a live entity over a dissolved one
        scored.append((points, c, jp_type, jp_name, pv, status, basis))

    if not scored:
        return None, "no_match", []
    scored.sort(key=lambda s: -s[0])
    best = scored[0]
    if best[0] < 10:
        # Nothing matched on legal form; anything else is a coincidence of name.
        return None, "form_mismatch", scored

    name_matched = [e for e in scored if e[6] and e[2] == expected_form]
    if len(name_matched) > 1:
        live = [e for e in name_matched if e[5] == STATUS_LIVE]
        if len(live) != 1:
            # Either several companies of this name are trading, or none is.
            # No tie-break can honestly choose between them.
            return best[1], "ambiguous", scored
        # Exactly one of them can be running a factory today. Pick it
        # explicitly rather than by points, which province agreement could
        # otherwise swing towards the dissolved one.
        chosen = live[0]
        return chosen[1], "exact" if chosen[0] >= 15 else "probable", scored
    if len(scored) > 1 and scored[1][0] == best[0]:
        return best[1], "ambiguous", scored
    return best[1], "exact" if best[0] >= 15 else "probable", scored


def basis_of(scored: list, match: dict | None) -> str | None:
    """The name-equality basis recorded for the candidate that won."""
    if not match:
        return None
    for entry in scored:
        if entry[1] is match:
            return entry[6]
    return None


def resolve_one(oname: str, province: str, count: int,
                limiter: RateLimiter | None, offline: bool = False) -> dict:
    """
    Resolve a single operator. Runs on a worker thread; touches no shared state
    except the limiter and the archive, which is content-addressed by query and
    therefore safe to write concurrently.
    """
    form, core = split_legal_form(oname)
    if form is None:
        return {"oname": oname, "province": province, "factories": count,
                "outcome": "not_juristic", "resolved_at": utc_now()}
    if not core:
        return {
            "oname": oname,
            "core": core,
            "province": province,
            "factories": count,
            "outcome": "invalid_name",
            "error": "legal-form prefix has no company name",
            "resolved_at": utc_now(),
        }

    # Walk the query plan, keeping the strongest outcome any shape produced.
    # Each query is archived under its own key so a later rule change can replay
    # them without touching DBD again.
    best_rec: dict | None = None
    last_error = None
    saw_payload = False
    all_cached = True
    original_empty = False

    for query, is_original in query_plan(form, core):
        payload, error, from_cache = search_once(query, limiter, offline=offline)
        if payload is None:
            last_error = error or last_error
            continue
        saw_payload = True
        all_cached = all_cached and from_cache
        contents = payload.get("contents") or []
        if is_original and not contents:
            # No company answers to the spelling DIW wrote. This is what later
            # licenses a spelling variant to stand in for it.
            original_empty = True
        if not contents:
            continue

        match, outcome, scored = score(contents, form, core, province,
                                       matched_query=query,
                                       original_empty=original_empty)
        rec = build_record(oname, core, form, province, count, outcome,
                           len(contents), query, match, basis_of(scored, match))
        if best_rec is None or OUTCOME_RANK[outcome] > OUTCOME_RANK[best_rec["outcome"]]:
            best_rec = rec
        if outcome == "exact":
            break

    if not saw_payload:
        return {"oname": oname, "core": core, "province": province, "factories": count,
                "outcome": failure_outcome(last_error), "error": str(last_error),
                "resolved_at": utc_now()}

    if best_rec is None:
        best_rec = build_record(oname, core, form, province, count, "no_match",
                                0, core, None, None)
    best_rec["from_cache"] = all_cached
    return best_rec


def search_once(query: str, limiter: RateLimiter | None,
                offline: bool = False) -> tuple[dict | None, Exception | None, bool]:
    """
    Run one search, preferring the archive. Returns (payload, error, from_cache).

    `offline` restricts the lookup to what has already been archived, which is
    what lets a scoring change be replayed and reviewed without sending a single
    request to DBD.

    One retry after a rate-limit rejection: the limiter has already halved
    itself by then, so the second attempt goes out at a rate the server has not
    refused.
    """
    archived = load_archived(query)
    if archived is not None:
        return archived, None, True
    if offline or limiter is None:
        return None, None, True

    last_error = None
    for attempt in (1, 2):
        limiter.acquire()
        try:
            payload = client_for_thread().search(query)
            archive_response(query, payload)
            limiter.ok()
            return payload, None, False
        except Exception as exc:
            last_error = exc
            throttled = "429" in str(exc)
            limiter.penalise(hard=throttled)
            if not throttled or attempt == 2:
                break
            time.sleep(2.0)
    return None, last_error, False


def build_record(oname: str, core: str, form: str, province: str, count: int,
                 outcome: str, candidates: int, query: str,
                 match: dict | None, basis: str | None) -> dict:
    rec = {
        "oname": oname, "core": core, "expected_form": form,
        "province": province, "factories": count,
        "outcome": outcome, "candidates": candidates, "matched_query": query,
        "resolved_at": utc_now(),
    }
    if match:
        rec.update({
            "jp_no": match.get("jpNo"),
            "jp_name": (match.get("jpName") or "").strip(),
            "jp_type": ((match.get("jpType") or {}).get("jpTypeDesc") or "").strip(),
            "jp_status": ((match.get("jpStatus") or {}).get("jpStatDesc") or "").strip(),
            "dbd_province": ((match.get("locationProvince") or {}).get("pvDesc") or "").strip(),
            "capital": match.get("capAmt"),
            "setup_obj_code": match.get("setupObjCode"),
            "match_basis": basis,
        })
    return rec


def resolve(rows: list[tuple[str, str, int]], limit: int | None, refresh: bool,
            rate: float, workers: int) -> int:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    input_keys = {operator_key(row[0]) for row in rows}
    # Only *settled* outcomes count as done. An "error" row means the request
    # failed, not that the operator has no match — treating it as complete would
    # bake a transient 429 into the dataset as a permanent gap.
    done, errored = set(), set()
    if MATCHES.exists() and not refresh:
        current, physical_lines, invalid_lines = latest_match_records(MATCHES)
        for rec in current:
            key = operator_key(rec.get("oname"))
            if rec.get("outcome") == "error":
                errored.add(key)
            else:
                done.add(key)
        logger.info(
            f"resuming — {len(done):,} settled, {len(errored):,} to retry "
            f"from {physical_lines:,} history lines"
            + (f" ({invalid_lines:,} invalid ignored)" if invalid_lines else "")
        )

    # Retry earlier failures first — they are the known gaps.
    todo = [r for r in rows if operator_key(r[0]) in errored]
    todo += [
        r for r in rows
        if operator_key(r[0]) not in done and operator_key(r[0]) not in errored
    ]
    if limit is not None:
        todo = todo[:limit]
    if not todo:
        logger.info("nothing left to resolve")
        return len(errored & input_keys)

    limiter = RateLimiter(rate)
    stats: dict[str, int] = {}
    started = time.monotonic()
    logger.info(f"resolving {len(todo):,} operators · {workers} workers · {rate:.1f} req/s ceiling")

    # Results are written by this thread only, so the append-only matches file
    # stays consistent without a second lock.
    with MATCHES.open("a", encoding="utf-8") as out:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {
                pool.submit(resolve_one, o, p, c, limiter): (o, p, c)
                for o, p, c in todo
            }
            for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                try:
                    rec = fut.result()
                except Exception as exc:
                    oname, province, count = futures[fut]
                    logger.warning(f"worker failed for {oname!r}: {exc}")
                    rec = {
                        "oname": oname,
                        "province": province,
                        "factories": count,
                        "outcome": "error",
                        "error": str(exc),
                        "resolved_at": utc_now(),
                    }
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                out.flush()
                stats[rec["outcome"]] = stats.get(rec["outcome"], 0) + 1
                if n % 100 == 0:
                    elapsed = time.monotonic() - started
                    eta = (len(todo) - n) / max(n / elapsed, 1e-9) / 60
                    logger.info(
                        f"  {n:,}/{len(todo):,} — {n/elapsed:.1f}/s, ETA {eta:.0f} min — "
                        + ", ".join(f"{k}={v}" for k, v in sorted(stats.items()))
                    )

    elapsed = time.monotonic() - started
    logger.info("=" * 60)
    for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
        logger.info(f"  {k:<16} {v:>8,}")
    logger.info(f"  {'elapsed':<16} {elapsed/60:>7.1f} min at {len(todo)/max(elapsed,1e-9):.1f}/s")

    current, _, _ = latest_match_records(MATCHES)
    unresolved = sum(
        rec.get("outcome") == "error"
        for rec in current
        if operator_key(rec.get("oname")) in input_keys
    )
    if unresolved:
        logger.error(f"{unresolved:,} operators remain unresolved after retries")
    return unresolved


def rescore(rows: list[tuple[str, str, int]], sample: int) -> int:
    """
    Replay the scoring rules over the existing archive and report what changes.

    Sends no requests: every answer already on disk is re-read and re-judged, so
    a scoring change can be inspected before it is allowed to write anything.
    Promotions into `exact` are the ones that matter, because `dbd.factory_owner`
    publishes that tier — so they are printed in full, old name against new, for
    a human to disagree with.
    """
    current = {operator_key(rec.get("oname")): rec
               for rec in latest_match_records(MATCHES)[0]}
    transitions: dict[tuple[str, str], int] = {}
    bases: dict[str, int] = {}
    promotions: list[tuple[str, dict, dict]] = []
    unchanged = missing_archive = 0

    for oname, province, count in rows:
        before = current.get(operator_key(oname))
        if before is None:
            continue
        after = resolve_one(oname, province, count, None, offline=True)
        if after["outcome"] == "error" and not after.get("jp_no"):
            missing_archive += 1
            continue
        old, new = before.get("outcome", "?"), after["outcome"]
        if old == new and before.get("jp_no") == after.get("jp_no"):
            unchanged += 1
            continue
        transitions[(old, new)] = transitions.get((old, new), 0) + 1
        if new == "exact":
            bases[after.get("match_basis") or "?"] = bases.get(after.get("match_basis") or "?", 0) + 1
            promotions.append((oname, before, after))

    print(f"replayed {len(rows):,} operators against the archive")
    print(f"  unchanged                {unchanged:>8,}")
    print(f"  no archived response     {missing_archive:>8,}")
    print(f"  changed                  {sum(transitions.values()):>8,}")
    print()
    print(f"{'from':<16}{'to':<16}{'operators':>10}")
    print("-" * 42)
    for (old, new), n in sorted(transitions.items(), key=lambda kv: -kv[1]):
        print(f"{old:<16}{new:<16}{n:>10,}")

    if bases:
        print()
        print("newly published (exact) by name-equality basis:")
        for basis, n in sorted(bases.items(), key=lambda kv: -kv[1]):
            print(f"   {basis:<12}{n:>8,}")

    print()
    print(f"--- sample of promotions into exact (showing {min(sample, len(promotions))} "
          f"of {len(promotions):,}) ---")
    for oname, before, after in promotions[:sample]:
        print(f"  DIW  {oname}")
        print(f"  DBD  {after.get('jp_name')}  [{after.get('jp_type')}] "
              f"{after.get('dbd_province')}  jp_no={after.get('jp_no')}")
        print(f"       was {before.get('outcome')}"
              f"{'' if before.get('jp_no') == after.get('jp_no') else ' (different company!)'}"
              f" · basis={after.get('match_basis')} · query={after.get('matched_query')!r}")
        print()

    changed_company = sum(
        1 for _, b, a in promotions
        if b.get("jp_no") and b.get("jp_no") != a.get("jp_no")
    )
    if changed_company:
        print(f"⚠️  {changed_company:,} promotions point at a DIFFERENT company than "
              f"the previous record — review these before applying")
    return changed_company


def report() -> None:
    if not MATCHES.exists():
        print("No matches yet.")
        return
    recs, physical_lines, invalid_lines = latest_match_records(MATCHES)
    from collections import Counter
    outcomes = Counter(r["outcome"] for r in recs)
    factories = Counter()
    for r in recs:
        factories[r["outcome"]] += r.get("factories", 0) or 0

    print(
        f"canonical operators: {len(recs):,} from {physical_lines:,} history lines"
        + (f" ({invalid_lines:,} invalid ignored)" if invalid_lines else "")
    )
    print(f"{'outcome':<16} {'operators':>10} {'factories':>11}")
    print("-" * 40)
    for o, n in outcomes.most_common():
        print(f"{o:<16} {n:>10,} {factories[o]:>11,}")

    linked = [r for r in recs if r.get("jp_no")]
    print(f"\nlinked to a juristic id: {len(linked):,} operators "
          f"covering {sum(r.get('factories', 0) or 0 for r in linked):,} factories")
    if linked:
        st = Counter(r.get("jp_status") or "(unknown)" for r in linked)
        print("\nDBD status of matched operators:")
        for s, n in st.most_common(8):
            print(f"  {s:<34} {n:>7,}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Resolve DIW operators to DBD juristic persons.")
    ap.add_argument("--input", help="TSV: name <TAB> province <TAB> factory_count")
    ap.add_argument("--limit", type=int, help="Resolve at most N operators (pilot runs)")
    ap.add_argument("--refresh", action="store_true", help="Re-resolve names already in matches.jsonl")
    ap.add_argument("--rate", type=float, default=DEFAULT_RATE,
                    help=f"Total requests/sec across all workers (default {DEFAULT_RATE})")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                    help=f"Concurrent workers, capped by --rate (default {DEFAULT_WORKERS})")
    ap.add_argument("--report", action="store_true", help="Summarise what has been resolved")
    ap.add_argument("--rescore", action="store_true",
                    help="Re-judge the existing archive offline and report what would change")
    ap.add_argument("--sample", type=int, default=25,
                    help="Promotions to print in full under --rescore (default 25)")
    args = ap.parse_args()

    if args.report:
        report()
        return 0
    if not args.input:
        ap.error("--input is required (or use --report)")

    rows_by_name: dict[str, tuple[str, str, int]] = {}
    physical_input_rows = 0
    for line in Path(args.input).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        physical_input_rows += 1
        parts = [p.strip() for p in line.split("\t")]
        name = parts[0]
        province = parts[1] if len(parts) > 1 else ""
        try:
            count = int(parts[2]) if len(parts) > 2 else 0
        except ValueError:
            count = 0
        if name:
            key = operator_key(name)
            previous = rows_by_name.get(key)
            candidate = (name.strip(), province, count)
            # Duplicates in operators.tsv are export artifacts. Prefer the row
            # carrying real province/factory context, then the larger count.
            if previous is None or (bool(province), count) > (bool(previous[1]), previous[2]):
                rows_by_name[key] = candidate

    rows = list(rows_by_name.values())
    if physical_input_rows != len(rows):
        logger.info(
            f"collapsed {physical_input_rows - len(rows):,} duplicate input rows "
            f"to {len(rows):,} operator names"
        )

    # Most factories first: if a run is interrupted, the operators already done
    # are the ones explaining the most of the map.
    rows.sort(key=lambda r: -r[2])
    logger.info(f"📋 {len(rows):,} operators to consider · archive {ARCHIVE}")

    if args.rescore:
        # Report only. Nothing is written and no request is sent, so the result
        # can be argued with before it becomes data.
        rescore(rows[: args.limit] if args.limit else rows, args.sample)
        return 0

    unresolved = resolve(rows, args.limit, args.refresh, args.rate, args.workers)
    return 1 if unresolved else 0


if __name__ == "__main__":
    sys.exit(main())
