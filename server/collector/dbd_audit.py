#!/usr/bin/env python3
"""Audit the current DBD database and archives at their true logical grain."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from collections import Counter
from pathlib import Path

import psycopg2

from dbd_archive import PII_FIELDS, latest_match_records


KINDS = ("profile", "committees", "partners")


def sensitive_fields(value) -> int:
    if isinstance(value, dict):
        return sum(key in PII_FIELDS for key in value) + sum(
            sensitive_fields(item) for item in value.values()
        )
    if isinstance(value, list):
        return sum(sensitive_fields(item) for item in value)
    return 0


def read_archive(path: Path) -> dict | None:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit DBD collection completeness and safety.")
    ap.add_argument("--archive", type=Path, default=Path.home() / "dbd-archive")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    ap.add_argument("--strict", action="store_true", help="exit non-zero on any blocking issue")
    args = ap.parse_args()
    if not args.dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2

    root = args.archive.expanduser().resolve()
    matches = root / "matches.jsonl"
    records, history_lines, invalid_match_lines = latest_match_records(matches)
    archive_outcomes = Counter(rec.get("outcome") or "(missing)" for rec in records)
    archive_errors = sum(rec.get("outcome") == "error" for rec in records)

    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor() as cur:
        cur.execute("select jp_no from dbd.juristic order by jp_no")
        juristic_ids = [row[0] for row in cur]
        cur.execute("""
            select
              (select count(*) from dbd.juristic),
              (select count(*) from dbd.operator_match),
              (select count(*) from dbd.operator_match where jp_no is not null),
              (select count(*) from dbd.operator_match where outcome='error'),
              (select count(*) from dbd.operator_match m left join public.businesses b
                 on b.id=m.business_id where b.id is null),
              (select count(*) from dbd.operator_match m left join dbd.juristic j
                 on j.jp_no=m.jp_no where m.jp_no is not null and j.jp_no is null),
              (select count(*) from dbd.committee
                 where raw ?| array['cmtNo','address','phoneNo','zipCode','tumbonCode','ampurCode','pvCode']),
              (select count(*) from dbd.shareholder
                 where raw ?| array['cmtNo','address','phoneNo','zipCode','tumbonCode','ampurCode','pvCode']),
              (select count(*) from dbd.factory_owner
                 where match_outcome <> 'exact' and not human_verified),

              -- Shareholder nationality. These are aggregates with no person
              -- in them, so the risk is not disclosure but arithmetic: a
              -- percentage outside 0–100, or a blank country code, would be
              -- rendered to a reader as a fact about who owns a factory.
              (select count(*) from dbd.company_nations),
              (select count(distinct jp_no) from dbd.company_nations),
              (select count(*) from dbd.company_nations
                 where nullif(btrim(nt_code), '') is null),
              (select count(*) from dbd.company_nations
                 where share_percent < 0 or share_percent > 100),
              (select count(*) from dbd.company_nations n
                 left join dbd.juristic j on j.jp_no = n.jp_no where j.jp_no is null),
              -- Splits that do not add up. DBD rounds small stakes, so a few
              -- points either way is the source's own arithmetic, not ours;
              -- anything wider than that means we are reading it wrong.
              (select count(*) from (
                 select jp_no from dbd.company_nations
                 group by jp_no having sum(share_percent) not between 90 and 110
               ) bad),
              (select count(*) from dbd.juristic j
                 join dbd.operator_match m on m.jp_no = j.jp_no
                 where not exists (select 1 from dbd.company_nations n where n.jp_no = j.jp_no))
        """)
        (
            juristic_rows,
            match_rows,
            linked_rows,
            database_errors,
            orphan_business,
            orphan_juristic,
            committee_pii,
            shareholder_pii,
            unsafe_public_matches,
            nation_rows,
            nation_companies,
            nation_blank_code,
            nation_bad_percent,
            nation_orphans,
            nation_bad_total,
            nation_missing,
        ) = cur.fetchone()
    conn.close()

    missing = {kind: 0 for kind in KINDS}
    corrupt = {kind: 0 for kind in KINDS}
    archived_pii = 0
    for jp_no in juristic_ids:
        for kind in KINDS:
            path = root / "detail" / jp_no[:2] / f"{jp_no}.{kind}.json.gz"
            if not path.exists():
                missing[kind] += 1
                continue
            obj = read_archive(path)
            if obj is None:
                corrupt[kind] += 1
                continue
            if kind in ("committees", "partners"):
                archived_pii += sensitive_fields(obj.get("response"))

    print(f"archive_history_lines={history_lines}")
    print(f"canonical_operators={len(records)} invalid_match_lines={invalid_match_lines}")
    print(
        "canonical_outcomes="
        + ",".join(f"{key}:{value}" for key, value in archive_outcomes.most_common())
    )
    print(f"archive_current_errors={archive_errors} database_current_errors={database_errors}")
    print(
        f"juristic_rows={juristic_rows} match_rows={match_rows} "
        f"linked_business_rows={linked_rows}"
    )
    print("missing_endpoints=" + ",".join(f"{k}:{v}" for k, v in missing.items()))
    print("corrupt_endpoints=" + ",".join(f"{k}:{v}" for k, v in corrupt.items()))
    print(f"archived_sensitive_fields={archived_pii}")
    print(
        f"db_pii_rows=committee:{committee_pii},shareholder:{shareholder_pii} "
        f"orphans=business:{orphan_business},juristic:{orphan_juristic} "
        f"unsafe_public_matches={unsafe_public_matches}"
    )
    print(
        f"nationality_rows={nation_rows} companies={nation_companies} "
        f"blank_code={nation_blank_code} bad_percent={nation_bad_percent} "
        f"orphans={nation_orphans} splits_not_totalling_100={nation_bad_total}"
    )
    # Informational: a company DBD publishes no split for is a gap in the
    # source, not a fault of ours, so it is reported without failing the run.
    print(f"nationality_not_collected={nation_missing}")

    blockers = (
        invalid_match_lines
        + archive_errors
        + database_errors
        + sum(missing.values())
        + sum(corrupt.values())
        + archived_pii
        + committee_pii
        + shareholder_pii
        + orphan_business
        + orphan_juristic
        + unsafe_public_matches
        + nation_blank_code
        + nation_bad_percent
        + nation_orphans
    )
    if args.strict and blockers:
        print(f"AUDIT FAILED: {blockers:,} blocking findings", file=sys.stderr)
        return 1
    print("AUDIT PASSED" if not blockers else f"AUDIT WARNINGS: {blockers:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
