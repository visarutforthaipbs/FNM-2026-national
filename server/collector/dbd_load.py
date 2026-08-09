#!/usr/bin/env python3
"""
Load resolved DBD matches from the archive into Postgres.

Reads `matches.jsonl` plus the archived raw search responses and populates
`dbd.juristic` and `dbd.operator_match`. Nothing is fetched here — the network
work belongs to dbd_resolve.py, and keeping load separate means the mapping can
be rebuilt from the archive after a rule change without touching DBD again.

Corroborating signals — and what they are actually worth
--------------------------------------------------------
Two signals are computed at load time from data the matcher never consulted.
Neither is used to *make* a match, and neither should be used to reject one:

  * `isic_agrees` — DIW's ISIC_CODE against DBD's setupObjCode/submitObjCode.
    This was intended as independent verification and **does not work as such**.
    Measured over the first 175 comparable matches: 113 agree, 62 disagree — yet
    inspection of the disagreements shows obviously correct matches
    ("บริษัท บี-ควิก จำกัด" -> "บี-ควิก จำกัด", "พีระมิดคอนกรีต"). The codes
    describe different things: DIW records what the *factory* does, DBD what the
    *company* registered to do, and a concrete maker registered as a
    construction firm is ordinary. Kept as a weak descriptive flag only.
  * `province_agrees` — only computed for single-factory operators. For
    multi-site operators DBD holds the head office, so disagreement says nothing
    (บี-ควิก runs 102 factories from one Nonthaburi address).

There is no strong automated proxy for correctness here. Precision has to come
from a human-reviewed random sample, which is what the `verified_by` column on
dbd.operator_match exists to record. The honest machine-side indicator is the
tie rate: the resolver reports `ambiguous` whenever two candidates match the
legal form equally well, and that rate is what bounds silent error.

Usage
-----
    python dbd_load.py                 # load everything resolved so far
    python dbd_load.py --dry-run       # report what would change
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import logging
import os
import sys
from collections import defaultdict
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect import ARCHIVE_ROOT as DIW_ARCHIVE, last_accepted  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("dbd-load")

DBD_ARCHIVE = Path(os.getenv("DBD_ARCHIVE_ROOT", Path.home() / "dbd-archive"))
MATCHES = DBD_ARCHIVE / "matches.jsonl"
csv.field_size_limit(10_000_000)


def diw_isic_by_operator() -> dict[str, set[str]]:
    """
    ISIC codes DIW records for each operator, read from the archived snapshot.

    Uses the archive rather than the database on purpose: this is the evidence
    channel, and it should come from the untouched source rather than from
    values that have already been through the sync pipeline's transforms.
    """
    entry = last_accepted("Factory_Data")
    if not entry:
        logger.warning("no archived Factory_Data snapshot — skipping ISIC verification")
        return {}
    out: dict[str, set[str]] = defaultdict(set)
    with gzip.open(DIW_ARCHIVE / entry["blob"], "rt", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            oname = (row.get("ONAME") or "").strip()
            isic = (row.get("ISIC_CODE") or "").strip()
            if oname and isic:
                out[oname].add(isic)
    logger.info(f"ISIC evidence loaded for {len(out):,} operator names")
    return out


def isic_agreement(diw_codes: set[str], setup: str | None, submit: str | None) -> bool | None:
    """
    Do DIW and DBD describe the same kind of business?

    Compared at 2-digit TSIC division level. Full 5-digit codes disagree
    constantly for legitimate reasons — DIW records what the factory does, DBD
    what the company registered to do — whereas the division is stable enough
    that a mismatch is genuinely informative. Returns None when either side has
    nothing to compare, so "unknown" never masquerades as "disagrees".
    """
    dbd_codes = {c for c in (setup, submit) if c}
    if not diw_codes or not dbd_codes:
        return None
    diw_div = {c[:2] for c in diw_codes if len(c) >= 2}
    dbd_div = {c[:2] for c in dbd_codes if len(c) >= 2}
    if not diw_div or not dbd_div:
        return None
    return bool(diw_div & dbd_div)


def blob_for(query: str) -> dict | None:
    import hashlib
    h = hashlib.sha256(query.encode("utf-8")).hexdigest()
    p = DBD_ARCHIVE / "raw" / h[:2] / f"{h}.json.gz"
    if not p.exists():
        return None
    try:
        with gzip.open(p, "rt", encoding="utf-8") as fh:
            return json.load(fh)["response"]
    except Exception:
        return None


def find_candidate(response: dict, jp_no: str) -> dict | None:
    for c in (response or {}).get("contents") or []:
        if c.get("jpNo") == jp_no:
            return c
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Load DBD matches into Postgres.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    args = ap.parse_args()

    if not MATCHES.exists():
        logger.error(f"no matches at {MATCHES}")
        return 1
    if not args.dsn:
        logger.error("DATABASE_URL not set and --dsn not given")
        return 2

    records = [json.loads(l) for l in MATCHES.read_text(encoding="utf-8").splitlines() if l.strip()]
    logger.info(f"{len(records):,} resolved operators in archive")

    isic_map = diw_isic_by_operator()

    conn = psycopg2.connect(args.dsn)
    conn.autocommit = False
    cur = conn.cursor()

    # legal_name -> business_id. The match was made on the name, and that is
    # what has to be joined back.
    cur.execute("select id, legal_name from public.businesses where legal_name is not null")
    business_by_name: dict[str, str] = {}
    for bid, name in cur.fetchall():
        business_by_name.setdefault(name.strip(), bid)
    logger.info(f"{len(business_by_name):,} businesses available to link")

    counts = defaultdict(int)
    juristic_rows, match_rows = [], []

    for r in records:
        oname = r.get("oname", "")
        bid = business_by_name.get(oname.strip())
        if not bid:
            counts["no_business_row"] += 1
            continue

        jp_no = r.get("jp_no")
        prov_agrees = None
        isic_ok = None

        if jp_no:
            cand = find_candidate(blob_for(r.get("matched_query") or r.get("core") or ""), jp_no) or {}
            setup, submit = cand.get("setupObjCode"), cand.get("submitObjCode")
            isic_ok = isic_agreement(isic_map.get(oname, set()), setup, submit)
            # Province only means something when the operator has one site.
            if (r.get("factories") or 0) == 1:
                prov_agrees = bool(r.get("province")) and r.get("province") == r.get("dbd_province")

            juristic_rows.append((
                jp_no, r.get("jp_name") or "", cand.get("jpTypeCode"), r.get("jp_type"),
                cand.get("jpStatCode"), r.get("jp_status"), cand.get("jpNameOld"),
                r.get("capital"), r.get("dbd_province"), cand.get("pvCode"),
                cand.get("ampurCode"), cand.get("tumbonCode"), setup, submit,
                cand.get("businessSizeCode"), cand.get("jpAge"), cand.get("address"),
                cand.get("fiscalYear"), json.dumps(cand, ensure_ascii=False),
            ))

        match_rows.append((
            bid, oname, r.get("core"), r.get("matched_query"), r.get("expected_form"),
            jp_no, r["outcome"], r.get("candidates"), isic_ok, prov_agrees,
        ))
        counts[r["outcome"]] += 1
        if isic_ok is True:
            counts["isic_agrees"] += 1
        elif isic_ok is False:
            counts["isic_disagrees"] += 1

    logger.info("=" * 56)
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        logger.info(f"  {k:<20} {v:>8,}")

    if args.dry_run:
        logger.info("dry run — nothing written")
        return 0

    psycopg2.extras.execute_batch(cur, """
        insert into dbd.juristic (
          jp_no, jp_name, jp_type_code, jp_type_desc, jp_status_code, jp_status_desc,
          jp_name_old, register_capital, province, province_code, ampur_code, tumbon_code,
          setup_obj_code, submit_obj_code, business_size, jp_age, address, fiscal_year, raw
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        on conflict (jp_no) do update set
          jp_name = excluded.jp_name,
          jp_status_desc = excluded.jp_status_desc,
          register_capital = excluded.register_capital,
          raw = excluded.raw,
          fetched_at = now()
    """, juristic_rows, page_size=500)

    # A human decision outranks any automated re-run, so verified rows keep
    # their jp_no and outcome. Same protection the coordinate pipeline gives
    # community and admin positions.
    psycopg2.extras.execute_batch(cur, """
        insert into dbd.operator_match (
          business_id, legal_name, core_name, matched_query, expected_form,
          jp_no, outcome, candidates, isic_agrees, province_agrees
        ) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        on conflict (business_id) do update set
          core_name = excluded.core_name,
          matched_query = excluded.matched_query,
          jp_no = case when dbd.operator_match.verified_by is null
                       then excluded.jp_no else dbd.operator_match.jp_no end,
          outcome = case when dbd.operator_match.verified_by is null
                         then excluded.outcome else dbd.operator_match.outcome end,
          candidates = excluded.candidates,
          isic_agrees = excluded.isic_agrees,
          province_agrees = excluded.province_agrees,
          resolved_at = now()
    """, match_rows, page_size=500)

    conn.commit()
    logger.info(f"✅ wrote {len(juristic_rows):,} juristic rows, {len(match_rows):,} matches")
    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
