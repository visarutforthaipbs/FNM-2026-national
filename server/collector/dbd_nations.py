#!/usr/bin/env python3
"""
Shareholder nationality per company, from DBD's /nations endpoint.

Why this endpoint matters
-------------------------
The partners endpoint publishes a shareholder list only for partnerships: over
the whole collection it covered 99.8% of ห้างหุ้นส่วนจำกัด and 0 of 44,879
บริษัทจำกัด. `/nations` answers a different question — the *aggregate*
nationality split of a company's shareholders — and it answers it for limited
companies too, with real percentages. That is the one route to foreign-ownership
data for the 83% of matched factories a limited company operates.

What it returns, and what we therefore store
--------------------------------------------
One row per nationality: a code, how many holders hold it, and their combined
share. It is a summary, not a register — DBD does not say who those holders are.
So this stores the summary as a summary. An earlier pass expanded each row into
`shareQty` invented shareholders named "ผู้ถือหุ้นสัญชาติไทย", which reads in the
UI as a list of real owners and attributes the whole stake to the first of them.
That is a fabrication of public record about identifiable companies, and it is
also unnecessary: the percentages DBD gives are strictly better than the counts
the fake rows would produce.

Rate limiting
-------------
One central RateLimiter for every worker, reused from dbd_resolve — the same
gate that sustained a 52,484-operator crawl. The rate is a single number and
concurrency can only decide how much of it is used. Per-worker `time.sleep()`
does not bound anything: 3 workers sleeping 0.5s is 6 req/s, which is four times
the tested ceiling and is what drew the WAF block this replaces.

Token refresh is the tender part. `/api/refresh` is rate-limited harder than the
data endpoints and answers 403 when unhappy, so refreshes are serialised through
one gate and spaced, instead of every worker minting its own token — and a 403
there stops the run rather than triggering more refreshes.
"""

from __future__ import annotations

import argparse
import concurrent.futures
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
from dbd_archive import write_gzip_json_atomic  # noqa: E402
from dbd_resolve import RateLimiter  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("dbd_nations")

ARCHIVE = Path(os.getenv("DBD_ARCHIVE_ROOT", Path.home() / "dbd-archive"))
NATIONS = ARCHIVE / "nations"

DEFAULT_RATE = 1.2
DEFAULT_WORKERS = 3

# DBD juristic type codes, as the profile endpoints expect them.
JP_TYPE_BY_DESC = {
    "บริษัทจำกัด": "5",
    "บริษัทมหาชนจำกัด": "6",
    "ห้างหุ้นส่วนจำกัด": "3",
    "ห้างหุ้นส่วนสามัญนิติบุคคล": "2",
}

# DBD emits a synthetic total row rather than a nationality.
NOT_A_NATIONALITY = {"WORLD2"}

# One refresh at a time, and not more often than this. Three workers each
# minting a token at startup is what produced the first 429s of the last run.
_refresh_lock = threading.Lock()
_last_refresh = 0.0
REFRESH_MIN_INTERVAL = 5.0


class TokenBlocked(RuntimeError):
    """DBD refused to issue a token. More requests will not help."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_local = threading.local()


def client_for_thread() -> DBDClient:
    """
    One client per worker, but serialised construction.

    Per-thread clients avoid racing on the JWT each one refreshes for itself;
    the gate stops those refreshes from arriving together.
    """
    if getattr(_local, "client", None) is not None:
        return _local.client
    global _last_refresh
    with _refresh_lock:
        wait = REFRESH_MIN_INTERVAL - (time.monotonic() - _last_refresh)
        if wait > 0:
            time.sleep(wait)
        try:
            _local.client = DBDClient()
        except Exception as exc:
            if "403" in str(exc) or "429" in str(exc):
                raise TokenBlocked(str(exc)) from exc
            raise
        _last_refresh = time.monotonic()
    return _local.client


def drop_thread_client() -> None:
    _local.client = None


def archive_path(jp_no: str) -> Path:
    return NATIONS / jp_no[:2] / f"{jp_no}.nations.json.gz"


def load_archived(jp_no: str):
    path = archive_path(jp_no)
    if not path.exists():
        return None
    try:
        import gzip
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            return json.load(fh).get("response")
    except Exception:
        return None


def parse_nations(payload) -> list[dict]:
    """
    Reduce DBD's response to the summary it actually is.

    `holders` is how many shareholders carry that nationality; `percent` and
    `amount` are their combined stake. No holder is named, because DBD does not
    name them here.
    """
    rows = []
    for item in (payload or []):
        if not isinstance(item, dict):
            continue
        code = (item.get("ntCode") or "").strip()
        if not code or code in NOT_A_NATIONALITY:
            continue
        nationality = item.get("nationality") or {}
        rows.append({
            "code": code,
            "name": nationality.get("ntName") or nationality.get("countryName") or None,
            "holders": item.get("shareQty"),
            "percent": item.get("sharePctVol") if item.get("sharePctVol") is not None
                       else item.get("sharePctQty"),
            "amount": item.get("shareAmt"),
        })
    return rows


def fetch_one(jp_no: str, jp_type: str, limiter: RateLimiter, refresh: bool) -> tuple[str, list[dict] | None, str | None]:
    if not refresh:
        archived = load_archived(jp_no)
        if archived is not None:
            return jp_no, parse_nations(archived), None

    for attempt in (1, 2):
        limiter.acquire()
        try:
            payload = client_for_thread().get_nations(jp_type, jp_no)
            write_gzip_json_atomic(archive_path(jp_no), {
                "jp_no": jp_no, "jp_type": jp_type,
                "fetched_at": utc_now(), "response": payload,
            })
            limiter.ok()
            return jp_no, parse_nations(payload), None
        except TokenBlocked:
            raise
        except Exception as exc:
            message = str(exc)
            throttled = "429" in message or "403" in message
            limiter.penalise(hard=throttled)
            if throttled:
                # The token may simply have aged out; let this thread mint a
                # fresh one through the gate rather than reusing a dead session.
                drop_thread_client()
            if attempt == 2 or not throttled:
                return jp_no, None, message
            time.sleep(2.0)
    return jp_no, None, "unreachable"


def load_targets(dsn: str | None, source: Path | None) -> list[tuple[str, str]]:
    """
    (jp_no, jp_type) for every company we hold a published link for, in the
    order worth collecting.

    Public companies first — there are only ~500 of them and they run the
    largest plants on the map, so ten minutes of crawling covers the factories
    most people live next to. After that, most factories first. A run that is
    interrupted at any point has therefore already collected the part that
    explains the most of the map, which is the same reason dbd_resolve sorts
    its input this way.
    """
    if source:
        rows = json.loads(source.read_text(encoding="utf-8"))
        return [(r["jp_no"], JP_TYPE_BY_DESC.get(r.get("jp_type_desc") or "", "5")) for r in rows]

    import psycopg2
    conn = psycopg2.connect(dsn)
    with conn, conn.cursor() as cur:
        # jp_type_code comes from DBD's own payload, so it needs no guessing
        # from the Thai description.
        cur.execute("""
            select j.jp_no,
                   coalesce(j.jp_type_code::text, ''),
                   coalesce(j.jp_type_desc, ''),
                   count(*) filter (where f.status = 'ดำเนินการ') as factories
            from dbd.juristic j
            join dbd.operator_match m on m.jp_no = j.jp_no
            left join public.factories f on f.business_id = m.business_id
            group by 1, 2, 3
            order by (coalesce(j.jp_type_desc, '') = 'บริษัทมหาชนจำกัด') desc,
                     factories desc,
                     j.jp_no
        """)
        rows = cur.fetchall()
    conn.close()
    return [(jp_no, code or "5") for jp_no, code, _desc, _n in rows]


def main() -> int:
    ap = argparse.ArgumentParser(description="Collect shareholder nationality summaries from DBD.")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    ap.add_argument("--source", type=Path, help="JSON list of {jp_no, jp_type_desc} instead of the DB")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "dbd_nations.json")
    ap.add_argument("--rate", type=float, default=DEFAULT_RATE,
                    help=f"Total requests/sec across all workers (default {DEFAULT_RATE})")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--refresh", action="store_true", help="Re-fetch companies already archived")
    args = ap.parse_args()

    if not args.dsn and not args.source:
        logger.error("DATABASE_URL or --source is required")
        return 2

    NATIONS.mkdir(parents=True, exist_ok=True)
    targets = load_targets(args.dsn, args.source)

    # Resume on the archive, not on the output file: the archive is the record
    # of what was actually asked, so a change to parse_nations re-derives every
    # company for free instead of re-crawling them.
    todo = targets if args.refresh else [t for t in targets if load_archived(t[0]) is None]
    if args.limit:
        todo = todo[: args.limit]
    logger.info(f"📋 {len(targets):,} companies · {len(todo):,} to fetch · archive {NATIONS}")

    # Seed from whatever the output file already holds, then let the archive
    # win where it exists. The two are not interchangeable: entries recovered
    # from the pre-archive cache have no raw response behind them, so rebuilding
    # purely from the archive would silently discard every company collected
    # before this script existed.
    results: dict[str, list[dict]] = {}
    if args.out.exists():
        try:
            results = json.loads(args.out.read_text(encoding="utf-8"))
            logger.info(f"↺ carried {len(results):,} companies over from {args.out.name}")
        except Exception as exc:
            logger.warning(f"could not read {args.out} ({exc}) — starting from the archive alone")
            results = {}
    for jp_no, _ in targets:
        archived = load_archived(jp_no)
        if archived is not None:
            results[jp_no] = parse_nations(archived)

    if todo:
        stats = {"ok": 0, "empty": 0, "error": 0}
        started = time.time()

        def checkpoint() -> None:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            tmp = args.out.with_suffix(".tmp")
            tmp.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(args.out)

        # A block is a pause, not a failure. Over eight hours it is likely that
        # DBD refuses a token at some point, and dying there would mean the run
        # needs a human at 3am. So wait it out with the same widening interval
        # the block probe uses, and carry on from the archive — which is why the
        # remaining work is recomputed each round rather than queued once.
        cooldowns = [600, 900, 1200, 1800, 3600]
        cooldown_index = 0
        remaining = list(todo)

        while remaining:
            limiter = RateLimiter(args.rate)
            blocked = False
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                    futures = {pool.submit(fetch_one, jp_no, jp_type, limiter, args.refresh): jp_no
                               for jp_no, jp_type in remaining}
                    for n, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                        try:
                            jp_no, rows, err = fut.result()
                        except TokenBlocked as exc:
                            logger.warning(f"⏸️  DBD refused to issue a token ({exc}). "
                                           f"Pausing rather than retrying into it.")
                            blocked = True
                            for f in futures:
                                f.cancel()
                            break
                        if err:
                            stats["error"] += 1
                        elif rows:
                            results[jp_no] = rows
                            stats["ok"] += 1
                        else:
                            results[jp_no] = []
                            stats["empty"] += 1
                        done = stats["ok"] + stats["empty"] + stats["error"]
                        if done % 100 == 0:
                            rate = done / max(time.time() - started, 1e-9)
                            eta = (len(todo) - done) / max(rate, 1e-9) / 60
                            logger.info(f"  {done:,}/{len(todo):,} — {rate:.2f}/s — ETA {eta:.0f} min — "
                                        f"ok={stats['ok']:,} empty={stats['empty']:,} err={stats['error']:,}")
                            checkpoint()
            finally:
                checkpoint()

            if not blocked:
                break
            # Recompute from the archive: everything already answered is done,
            # so a resumed round never re-asks for it.
            remaining = [t for t in remaining if load_archived(t[0]) is None]
            wait = cooldowns[min(cooldown_index, len(cooldowns) - 1)]
            cooldown_index += 1
            logger.info(f"   {len(remaining):,} companies left — waiting {wait // 60} min "
                        f"before trying again")
            drop_thread_client()
            time.sleep(wait)

        logger.info("=" * 56)
        for k, v in stats.items():
            logger.info(f"  {k:<8}{v:>8,}")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    with_data = sum(1 for v in results.values() if v)
    foreign = sum(1 for v in results.values()
                  if any(r["code"] != "TH" for r in v))
    logger.info(f"✅ {len(results):,} companies in {args.out.name} — "
                f"{with_data:,} with a nationality split, {foreign:,} with a non-Thai holder")
    return 0


if __name__ == "__main__":
    sys.exit(main())
