#!/usr/bin/env python3
"""
Export DBD ownership profiles to static per-province JSON.

The map is static-first: province counts, markers and dashboard stats are all
files the browser fetches from its own origin. Ownership was the exception — it
queried PostgREST at runtime, which made a factory's owner unreadable whenever
the machine holding the database was unreachable. This removes that: the data
ships with the app, exactly like markers.

One file per province, keyed by factory registration id, mirroring
`/data/markers/{slug}.json` so the client can reuse the same slug and the same
lazy per-province loading.

Only what `dbd.factory_owner` already publishes is exported — exact or
human-verified links, no personal identifiers, no raw payloads. A probable match
that has not been reviewed is absent here for the same reason it is absent from
the API.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import psycopg2
import psycopg2.extras

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "client" / "public" / "data" / "dbd"
COUNTS = REPO / "client" / "public" / "data" / "province-counts.json"


def province_slug(name_en: str) -> str:
    """Same rule as provinceSlug() in useFactoriesApi.ts."""
    return " ".join(name_en.split()).lower().replace(" ", "-")


def load_slug_map() -> dict[str, str]:
    """Thai province name -> file slug, from the file the client already uses."""
    rows = json.loads(COUNTS.read_text(encoding="utf-8"))
    return {r["name_th"]: province_slug(r["name_en"]) for r in rows}


# Abbreviated keys, as with markers: this file is downloaded by phones on mobile
# data, and the long-form key names cost more than the values.
def compact(row: dict) -> dict:
    out: dict = {
        "j": row["jp_no"],
        "n": row["jp_name"],
    }
    if row.get("jp_type_desc"):
        out["t"] = row["jp_type_desc"]
    if row.get("jp_status_desc"):
        out["s"] = row["jp_status_desc"]
    if row.get("register_capital") is not None:
        out["c"] = float(row["register_capital"])
    if row.get("registered_province"):
        out["p"] = row["registered_province"]
    if row.get("human_verified"):
        out["v"] = 1
    directors = [d.get("name") for d in (row.get("directors") or []) if d.get("name")]
    if directors:
        out["d"] = directors
    owners = []
    for o in (row.get("owners") or []):
        if not o.get("name"):
            continue
        entry = {"n": o["name"]}
        if o.get("nationality"):
            entry["c"] = o["nationality"]
        # Only a stake DBD actually stated. Non-positive means "not published",
        # not "zero", and must not be exported as a number.
        if o.get("sharePercent") not in (None, 0):
            entry["p"] = o["sharePercent"]
        elif o.get("shareAmount") not in (None, 0):
            entry["a"] = o["shareAmount"]
        owners.append(entry)
    if owners:
        out["o"] = owners
    # Aggregate shareholder nationality, carried by the view straight from
    # dbd.company_nations. This is the only source that answers for a limited
    # company, and it answers with real percentages — so it is exported as the
    # summary it is, never expanded into shareholders DBD did not name.
    split = row.get("nationalities")
    if split:
        entries = []
        for item in split:
            if not item.get("code"):
                continue
            entry = {"c": item["code"]}
            if item.get("percent") is not None:
                entry["p"] = float(item["percent"])
            if item.get("holders"):
                entry["h"] = item["holders"]
            entries.append(entry)
        out["nat"] = entries
    if row.get("financial_year"):
        out["f"] = {
            "y": row["financial_year"],
            "r": _num(row.get("total_revenue")),
            "p": _num(row.get("net_profit")),
            "a": _num(row.get("total_assets")),
        }
    return out


def _num(value):
    return float(value) if value is not None else None


def main() -> int:
    ap = argparse.ArgumentParser(description="Export DBD profiles to per-province JSON.")
    ap.add_argument("--dsn", default=os.getenv("DATABASE_URL"))
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    if not args.dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2

    slug_map = load_slug_map()

    conn = psycopg2.connect(args.dsn)
    with conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Join to factories for the province the file is keyed by. The same
        # company can operate in several provinces, so its profile is written
        # into each province file its factories are in.
        cur.execute("""
            select p.*, f.province as factory_province
            from public.factory_dbd_profile p
            join public.factories f on f.id = p.factory_id
            where f.status = 'ดำเนินการ'
        """)
        rows = cur.fetchall()
    conn.close()

    by_province: dict[str, dict[str, dict]] = defaultdict(dict)
    unknown_province = 0
    for row in rows:
        slug = slug_map.get((row.get("factory_province") or "").strip())
        if not slug:
            unknown_province += 1
            continue
        by_province[slug][row["factory_id"]] = compact(row)

    args.out.mkdir(parents=True, exist_ok=True)
    # Remove stale files so a province that lost all its links does not keep
    # serving yesterday's answer.
    for existing in args.out.glob("*.json"):
        if existing.stem not in by_province:
            existing.unlink()

    with_nat = sum(1 for r in rows if r.get("nationalities"))
    print(f"🌏 {with_nat:,} of {len(rows):,} factory rows carry a nationality split")

    total = 0
    for slug, entries in sorted(by_province.items()):
        path = args.out / f"{slug}.json"
        path.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        total += len(entries)

    size = sum(p.stat().st_size for p in args.out.glob("*.json"))
    print(f"✅ {total:,} factory profiles across {len(by_province)} provinces "
          f"-> {args.out} ({size / 1024 / 1024:.1f} MB uncompressed)")
    if unknown_province:
        print(f"⚠️  {unknown_province:,} rows skipped — province not in province-counts.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
