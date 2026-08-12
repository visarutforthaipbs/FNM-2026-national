#!/usr/bin/env python3
"""
Load shareholder-nationality aggregates into dbd.company_nations.

Source of truth is the archive: one raw /nations response per company, so a
change to how the response is read re-derives the table without asking DBD
anything. The legacy JSON is a second, lesser source — the ~2,300 companies
collected before the archive existed have no raw response to replay, only the
aggregate recovered from them, so they are loaded where the archive is silent
and never allowed to overwrite it.

Dry run by default.
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dbd_nations import NATIONS, parse_nations  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("dbd_nations_load")


def from_archive() -> dict[str, list[dict]]:
    """Every company whose raw response we still hold."""
    out: dict[str, list[dict]] = {}
    unreadable = 0
    for path in NATIONS.glob("*/*.nations.json.gz"):
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                blob = json.load(fh)
        except Exception:
            unreadable += 1
            continue
        jp_no = blob.get("jp_no")
        if jp_no:
            out[jp_no] = parse_nations(blob.get("response"))
    if unreadable:
        logger.warning(f"{unreadable:,} archive files could not be read")
    return out


def from_legacy(path: Path) -> dict[str, list[dict]]:
    if not path or not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in raw.items() if v}


def main() -> int:
    ap = argparse.ArgumentParser(description="Load DBD nationality aggregates into Postgres.")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    ap.add_argument("--legacy", type=Path,
                    default=Path(__file__).resolve().parents[1] / "data" / "dbd_nations.json",
                    help="Aggregates recovered from the pre-archive cache")
    ap.add_argument("--apply", action="store_true", help="write to the database")
    args = ap.parse_args()
    if not args.dsn:
        logger.error("DATABASE_URL is required")
        return 2

    archived = from_archive()
    legacy = from_legacy(args.legacy)
    only_legacy = {k: v for k, v in legacy.items() if k not in archived}
    logger.info(f"{len(archived):,} companies from the archive · "
                f"{len(only_legacy):,} available only from the legacy cache")

    merged = {**only_legacy, **archived}

    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor() as cur:
        # A row can only be attached to a company we hold, or the foreign key
        # rejects the whole batch. Anything else is reported, not forced.
        cur.execute("select jp_no from dbd.juristic")
        known = {row[0] for row in cur}

        rows = []
        skipped = 0
        for jp_no, entries in merged.items():
            if jp_no not in known:
                skipped += 1
                continue
            for entry in entries:
                if not entry.get("code"):
                    continue
                rows.append((
                    jp_no, entry["code"], entry.get("holders"),
                    entry.get("percent"), entry.get("amount"),
                    json.dumps(entry, ensure_ascii=False),
                ))

        companies = len({r[0] for r in rows})
        logger.info(f"{len(rows):,} nationality rows across {companies:,} companies")
        if skipped:
            logger.info(f"{skipped:,} companies skipped — not in dbd.juristic")

        if not args.apply:
            logger.info("dry run — nothing written (pass --apply)")
            return 0

        psycopg2.extras.execute_batch(cur, """
            insert into dbd.company_nations
              (jp_no, nt_code, holders, share_percent, share_amount, raw, fetched_at)
            values (%s,%s,%s,%s,%s,%s, now())
            on conflict (jp_no, nt_code) do update set
              holders = excluded.holders,
              share_percent = excluded.share_percent,
              share_amount = excluded.share_amount,
              raw = excluded.raw,
              fetched_at = now()
        """, rows, page_size=500)

        # A company whose split changed shape — a nationality sold out entirely
        # — would otherwise keep the stale row forever.
        cur.execute("""
            delete from dbd.company_nations n
            where not exists (
              select 1 from unnest(%s::text[], %s::text[]) as k(jp_no, nt_code)
              where k.jp_no = n.jp_no and k.nt_code = n.nt_code
            ) and n.jp_no = any(%s::text[])
        """, ([r[0] for r in rows], [r[1] for r in rows], list({r[0] for r in rows})))
        removed = cur.rowcount

    conn.close()
    logger.info(f"✅ wrote {len(rows):,} rows for {companies:,} companies"
                + (f", removed {removed:,} stale" if removed else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
