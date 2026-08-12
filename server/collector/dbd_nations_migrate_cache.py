#!/usr/bin/env python3
"""
Recover the earlier nationality cache without re-crawling it.

The first pass stored each nationality expanded into `shareQty` invented
shareholder objects — the stake on the first, nulls on the rest. The aggregate
DBD actually returned is still recoverable from that: group by nationality code,
count the objects to get the holder count, and take the one non-null stake.

Dry run by default. This never contacts DBD; it only reshapes what is on disk,
so the 2,379 companies already fetched do not have to be asked for again.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import OrderedDict
from pathlib import Path


def convert(entries: list[dict]) -> list[dict]:
    grouped: "OrderedDict[str, dict]" = OrderedDict()
    for item in entries or []:
        code = (item.get("nationality") or "").strip()
        if not code:
            continue
        row = grouped.setdefault(code, {
            "code": code,
            # The old shape encoded the country name into a sentence; the real
            # name is recoverable from it, but a wrong guess would be worse than
            # None, so leave naming to the label map in the client.
            "name": None,
            "holders": 0,
            "percent": None,
            "amount": None,
        })
        row["holders"] += 1
        if item.get("sharePercent") is not None and row["percent"] is None:
            row["percent"] = item["sharePercent"]
        if item.get("shareAmount") is not None and row["amount"] is None:
            row["amount"] = item["shareAmount"]
    return list(grouped.values())


def main() -> int:
    here = Path(__file__).resolve().parents[1] / "data"
    ap = argparse.ArgumentParser(description="Reshape the legacy nations cache into aggregates.")
    ap.add_argument("--input", type=Path, default=here / "dbd_nations_cache.json")
    ap.add_argument("--out", type=Path, default=here / "dbd_nations.json")
    ap.add_argument("--apply", action="store_true", help="write the converted file")
    args = ap.parse_args()

    if not args.input.exists():
        print(f"no legacy cache at {args.input}", file=sys.stderr)
        return 2

    legacy = json.loads(args.input.read_text(encoding="utf-8"))
    converted = {jp_no: convert(entries) for jp_no, entries in legacy.items()}

    with_data = sum(1 for v in converted.values() if v)
    with_percent = sum(1 for v in converted.values() if any(r["percent"] is not None for r in v))
    foreign = sum(1 for v in converted.values() if any(r["code"] != "TH" for r in v))
    fake_rows = sum(len(v) for v in legacy.values())
    real_rows = sum(len(v) for v in converted.values())

    print(f"companies              {len(converted):>8,}")
    print(f"  with a split         {with_data:>8,}")
    print(f"  with real percent    {with_percent:>8,}")
    print(f"  with a non-Thai code {foreign:>8,}")
    print(f"rows  {fake_rows:,} synthetic shareholders -> {real_rows:,} nationality aggregates")

    sample = [(k, v) for k, v in converted.items() if len(v) > 1][:3]
    print("\nsample:")
    for jp_no, rows in sample:
        print(f"  {jp_no}: " + json.dumps(rows, ensure_ascii=False))

    if not args.apply:
        print("\ndry run — nothing written (pass --apply)")
        return 0

    args.out.write_text(json.dumps(converted, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
