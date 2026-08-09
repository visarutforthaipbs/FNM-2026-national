#!/usr/bin/env python3
"""
Fetch DBD ownership and financial detail for matched companies.

This is the layer that answers "who runs it, who owns it, and how much money
does it make". dbd_resolve.py only establishes identity; this fills in
directors, shareholders and financial statements for the juristic persons that
identity step already linked to a factory.

Shape of the source, measured 2026-08-08
----------------------------------------
Three calls per company, because DBD splits it that way:

  * `get_profile`  — carries the financial statement inline (totalIncome,
    netProfit, totalAsset, totalEquity and a set of derived ratios) for the
    most recent filed fiscal year.
  * `get_committees` — directors. Populated for companies.
  * `get_partners` — shareholders/partners. Empty for บี-ควิก and generally for
    companies limited; it is partnerships that carry partner records. Both are
    requested rather than guessed at from the legal form.

Only companies already present in dbd.juristic are fetched, so the expensive
crawl is spent on entities that actually own a factory rather than on the whole
registry. Raw responses are archived before parsing, as everywhere else here:
when the parsing turns out to be wrong — and DBD's field names are undocumented
enough that it will — the fix is a replay, not another crawl.

Usage
-----
    python dbd_detail.py --limit 50        # pilot
    python dbd_detail.py                   # everything not yet fetched
    python dbd_detail.py --refresh         # re-fetch even if already stored
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dbd_client import DBDClient  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("dbd-detail")

ARCHIVE = Path(os.getenv("DBD_ARCHIVE_ROOT", Path.home() / "dbd-archive"))
DETAIL_RAW = ARCHIVE / "detail"
DELAY_RANGE = (0.4, 0.8)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def raw_path(jp_no: str, kind: str) -> Path:
    return DETAIL_RAW / jp_no[:2] / f"{jp_no}.{kind}.json.gz"


def archive(jp_no: str, kind: str, payload) -> None:
    p = raw_path(jp_no, kind)
    p.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(p, "wt", encoding="utf-8") as fh:
        json.dump({"jp_no": jp_no, "kind": kind, "fetched_at": utc_now(), "response": payload},
                  fh, ensure_ascii=False)


def load_raw(jp_no: str, kind: str):
    p = raw_path(jp_no, kind)
    if not p.exists():
        return None
    try:
        with gzip.open(p, "rt", encoding="utf-8") as fh:
            return json.load(fh)["response"]
    except Exception:
        return None


def as_list(payload) -> list:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("contents", "data", "items"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def person_name(rec: dict) -> str:
    parts = [rec.get("titleName") or "", rec.get("firstName") or "",
             rec.get("middleName") or "", rec.get("lastName") or ""]
    return " ".join(p.strip() for p in parts if p and p.strip())


def num(value):
    """DBD mixes numbers and formatted strings; keep only what is really numeric."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    s = str(value).replace(",", "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch DBD directors, shareholders and financials.")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--refresh", action="store_true", help="Re-fetch companies already stored")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    args = ap.parse_args()

    if not args.dsn:
        logger.error("DATABASE_URL not set and --dsn not given")
        return 2

    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor()

    # Busiest owners first: if the crawl is interrupted, the companies already
    # done are the ones explaining the most factories on the map.
    cur.execute("""
        select j.jp_no, coalesce(j.jp_type_code, '5'), count(f.id) as factories
        from dbd.juristic j
        join dbd.operator_match m on m.jp_no = j.jp_no
        join public.businesses b on b.id = m.business_id
        left join public.factories f on f.business_id = b.id and f.is_active
        where (%s or not exists (select 1 from dbd.committee c where c.jp_no = j.jp_no)
                  and not exists (select 1 from dbd.financial x where x.jp_no = j.jp_no))
        group by j.jp_no, j.jp_type_code
        order by factories desc
    """, (args.refresh,))
    targets = cur.fetchall()
    if args.limit:
        targets = targets[: args.limit]
    logger.info(f"{len(targets):,} companies to fetch")

    client = DBDClient()
    stats = {"profile": 0, "committees": 0, "partners": 0, "financials": 0, "errors": 0, "cached": 0}

    for i, (jp_no, jp_type, factories) in enumerate(targets, 1):
        payloads = {}
        for kind, fn in (("profile", client.get_profile),
                         ("committees", client.get_committees),
                         ("partners", client.get_partners)):
            cached = load_raw(jp_no, kind)
            if cached is not None and not args.refresh:
                payloads[kind] = cached
                stats["cached"] += 1
                continue
            try:
                payloads[kind] = fn(jp_type, jp_no)
                archive(jp_no, kind, payloads[kind])
                time.sleep(random.uniform(*DELAY_RANGE))
            except Exception as exc:
                logger.warning(f"{jp_no} {kind}: {exc}")
                payloads[kind] = None
                stats["errors"] += 1
                time.sleep(random.uniform(*DELAY_RANGE) * 3)

        profile = payloads.get("profile") or {}
        if profile:
            stats["profile"] += 1

        committees = as_list(payloads.get("committees"))
        if committees:
            psycopg2.extras.execute_batch(cur, """
                insert into dbd.committee (jp_no, seq, full_name, title, raw)
                values (%s,%s,%s,%s,%s)
                on conflict (jp_no, seq) do update set
                  full_name = excluded.full_name, title = excluded.title,
                  raw = excluded.raw, fetched_at = now()
            """, [(jp_no, c.get("cmtSeq") or n, person_name(c), c.get("titleName"),
                   json.dumps(c, ensure_ascii=False))
                  for n, c in enumerate(committees, 1)])
            stats["committees"] += len(committees)

        partners = as_list(payloads.get("partners"))
        if partners:
            psycopg2.extras.execute_batch(cur, """
                insert into dbd.shareholder (jp_no, seq, holder_name, nationality, share_amount, raw)
                values (%s,%s,%s,%s,%s,%s)
                on conflict (jp_no, seq) do update set
                  holder_name = excluded.holder_name, nationality = excluded.nationality,
                  share_amount = excluded.share_amount, raw = excluded.raw, fetched_at = now()
            """, [(jp_no, p.get("cmtSeq") or n, person_name(p) or p.get("jpName"),
                   p.get("ntCode"), num(p.get("investAmt")), json.dumps(p, ensure_ascii=False))
                  for n, p in enumerate(partners, 1)])
            stats["partners"] += len(partners)

        year = profile.get("fiscalYear")
        if year and any(profile.get(k) is not None for k in ("totalIncome", "netProfit", "totalAsset")):
            equity, asset = num(profile.get("totalEquity")), num(profile.get("totalAsset"))
            cur.execute("""
                insert into dbd.financial (jp_no, year, total_assets, total_liabilities,
                                           total_equity, total_revenue, net_profit, raw)
                values (%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (jp_no, year) do update set
                  total_assets = excluded.total_assets,
                  total_liabilities = excluded.total_liabilities,
                  total_equity = excluded.total_equity,
                  total_revenue = excluded.total_revenue,
                  net_profit = excluded.net_profit,
                  raw = excluded.raw, fetched_at = now()
            """, (jp_no, str(year), asset,
                  # DBD reports equity and assets but not liabilities directly.
                  (asset - equity) if (asset is not None and equity is not None) else None,
                  equity, num(profile.get("totalIncome")), num(profile.get("netProfit")),
                  json.dumps({k: v for k, v in profile.items()
                              if any(t in k.lower() for t in
                                     ("revenue", "profit", "asset", "liab", "equity", "incom", "ratio"))},
                             ensure_ascii=False)))
            stats["financials"] += 1

        conn.commit()
        if i % 25 == 0:
            logger.info(f"  {i:,}/{len(targets):,} — " + ", ".join(f"{k}={v}" for k, v in stats.items()))

    logger.info("=" * 56)
    for k, v in stats.items():
        logger.info(f"  {k:<12} {v:>8,}")
    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
