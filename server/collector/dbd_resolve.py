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
import gzip
import hashlib
import json
import logging
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dbd_client import DBDClient  # noqa: E402

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

# Politeness. The API answers in ~0.04s, so the crawl is bounded by this delay,
# not by DBD. ~0.6s average keeps a 40k-name run near seven hours of gentle
# traffic rather than hammering the service flat out.
DELAY_RANGE = (0.4, 0.8)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


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
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({"query": query, "fetched_at": utc_now(), "response": payload}, fh, ensure_ascii=False)
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


def score(candidates: list[dict], expected_form: str, core: str, province: str) -> tuple[dict | None, str, list]:
    """
    Choose among DBD candidates, and say how confident that choice is.

    Deliberately conservative: an ambiguous result is reported as ambiguous
    rather than resolved to a best guess. A wrong ownership claim about a real
    company is worse than an absent one.
    """
    scored = []
    for c in candidates:
        jp_type = ((c.get("jpType") or {}).get("jpTypeDesc") or "").strip()
        jp_name = (c.get("jpName") or "").strip()
        pv = ((c.get("locationProvince") or {}).get("pvDesc") or "").strip()
        status = ((c.get("jpStatus") or {}).get("jpStatDesc") or "").strip()

        points = 0
        if jp_type == expected_form:
            points += 10          # legal form is the one hard signal
        if normalize_name(jp_name) == normalize_name(core):
            points += 5           # exact core-name equality, suffixes ignored
        if province and pv == province:
            points += 1           # tie-break only: DBD holds the head office
        if status == "ยังดำเนินกิจการอยู่":
            points += 1           # prefer a live entity over a dissolved one
        scored.append((points, c, jp_type, jp_name, pv, status))

    if not scored:
        return None, "no_match", []
    scored.sort(key=lambda s: -s[0])
    best = scored[0]
    if best[0] < 10:
        # Nothing matched on legal form; anything else is a coincidence of name.
        return None, "form_mismatch", scored
    if len(scored) > 1 and scored[1][0] == best[0]:
        return best[1], "ambiguous", scored
    return best[1], "exact" if best[0] >= 15 else "probable", scored


def resolve(rows: list[tuple[str, str, int]], limit: int | None, refresh: bool) -> None:
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    done = set()
    if MATCHES.exists() and not refresh:
        for line in MATCHES.read_text(encoding="utf-8").splitlines():
            try:
                done.add(json.loads(line)["oname"])
            except Exception:
                pass
        logger.info(f"resuming — {len(done):,} operators already resolved")

    client = None
    stats: dict[str, int] = {}
    processed = 0

    with MATCHES.open("a", encoding="utf-8") as out:
        for oname, province, count in rows:
            if oname in done:
                continue
            if limit is not None and processed >= limit:
                break

            form, core = split_legal_form(oname)
            if form is None:
                rec = {"oname": oname, "province": province, "factories": count,
                       "outcome": "not_juristic", "resolved_at": utc_now()}
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                stats["not_juristic"] = stats.get("not_juristic", 0) + 1
                continue

            # Try the name as written, then known spelling variants. Each query
            # is archived under its own key so a later rule change can replay
            # them without touching DBD again.
            payload, used_query, cached = None, core, True
            for variant in name_variants(core):
                payload = load_archived(variant)
                if payload is None:
                    if client is None:
                        client = DBDClient()
                    try:
                        payload = client.search(variant)
                        archive_response(variant, payload)
                        cached = False
                    except Exception as exc:
                        payload = None
                        break
                    time.sleep(random.uniform(*DELAY_RANGE))
                if (payload or {}).get("contents"):
                    used_query = variant
                    break

            if payload is None:
                if client is None:
                    client = DBDClient()
                try:
                    payload = client.search(core)
                    archive_response(core, payload)
                except Exception as exc:
                    logger.warning(f"search failed for {core!r}: {exc}")
                    rec = {"oname": oname, "core": core, "province": province, "factories": count,
                           "outcome": "error", "error": str(exc), "resolved_at": utc_now()}
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    stats["error"] = stats.get("error", 0) + 1
                    time.sleep(random.uniform(*DELAY_RANGE) * 4)
                    continue
                time.sleep(random.uniform(*DELAY_RANGE))

            contents = (payload or {}).get("contents") or []
            match, outcome, scored = score(contents, form, core, province)
            rec = {
                "oname": oname, "core": core, "expected_form": form,
                "province": province, "factories": count,
                "outcome": outcome, "candidates": len(contents), "matched_query": used_query,
                "from_cache": cached, "resolved_at": utc_now(),
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
                })
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()

            stats[outcome] = stats.get(outcome, 0) + 1
            processed += 1
            if processed % 25 == 0:
                logger.info(f"  {processed:,} resolved — " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))

    logger.info("=" * 60)
    for k, v in sorted(stats.items(), key=lambda kv: -kv[1]):
        logger.info(f"  {k:<16} {v:>8,}")
    logger.info(f"  {'processed':<16} {processed:>8,}")


def report() -> None:
    if not MATCHES.exists():
        print("No matches yet.")
        return
    recs = [json.loads(l) for l in MATCHES.read_text(encoding="utf-8").splitlines() if l.strip()]
    from collections import Counter
    outcomes = Counter(r["outcome"] for r in recs)
    factories = Counter()
    for r in recs:
        factories[r["outcome"]] += r.get("factories", 0) or 0

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
    ap.add_argument("--report", action="store_true", help="Summarise what has been resolved")
    args = ap.parse_args()

    if args.report:
        report()
        return 0
    if not args.input:
        ap.error("--input is required (or use --report)")

    rows = []
    for line in Path(args.input).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = [p.strip() for p in line.split("\t")]
        name = parts[0]
        province = parts[1] if len(parts) > 1 else ""
        try:
            count = int(parts[2]) if len(parts) > 2 else 0
        except ValueError:
            count = 0
        if name:
            rows.append((name, province, count))

    # Most factories first: if a run is interrupted, the operators already done
    # are the ones explaining the most of the map.
    rows.sort(key=lambda r: -r[2])
    logger.info(f"📋 {len(rows):,} operators to consider · archive {ARCHIVE}")
    resolve(rows, args.limit, args.refresh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
