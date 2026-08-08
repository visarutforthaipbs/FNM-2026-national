#!/usr/bin/env python3
"""
Compare two archived DIW snapshots.

This is the component the archive exists for. Collecting raw data is only
useful if you can ask what changed between two points in time, and that
question is what the project has never been able to answer.

Its immediate purpose is the open FFLAG/STATUS question. `factories.status` is
frozen because nobody knows what DIW's FFLAG (0-3) and STATUS values actually
encode, and no documentation has been found. Guessing produced a corruption
incident. But the meaning is observable: track which records change FFLAG
between snapshots and what changes alongside them, and the semantics fall out
of the evidence. `--field FFLAG` prints exactly that transition matrix.

Usage
-----
    python diff_snapshots.py Factory_Data                    # newest two
    python diff_snapshots.py Factory_Data --field FFLAG      # transition matrix
    python diff_snapshots.py Factory_Data --field STATUS --key FID
    python diff_snapshots.py Factory_Data --from <sha> --to <sha>
    python diff_snapshots.py Factory_Data --sample 5         # show example rows
"""

from __future__ import annotations

import argparse
import csv
import gzip
import sys
from collections import Counter
from pathlib import Path

from collect import ARCHIVE_ROOT, STABLE_ENDPOINTS, read_manifest

# Identity column per endpoint. FID is DIW's stable internal id; FACREG is the
# registration number, which is what the application keys on.
DEFAULT_KEYS = {
    "Factory_Data": "FID",
    "Business_Location": "FID",
    "Factory_Operation_Permit": "FID",
}

csv.field_size_limit(10_000_000)


def snapshots_for(endpoint: str) -> list[dict]:
    return [
        e for e in read_manifest()
        if e.get("endpoint") == endpoint and e.get("status") == "ok" and e.get("blob")
    ]


def load(entry: dict, key: str, fields: list[str] | None) -> dict[str, dict]:
    """Index one snapshot by key. Keeps only `fields` when given, to stay light."""
    path = ARCHIVE_ROOT / entry["blob"]
    rows: dict[str, dict] = {}
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            k = (row.get(key) or "").strip()
            if not k:
                continue
            rows[k] = {f: (row.get(f) or "").strip() for f in fields} if fields else row
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="Diff two archived DIW snapshots.")
    ap.add_argument("endpoint")
    ap.add_argument("--key", help="Identity column (default: FID)")
    ap.add_argument("--field", action="append", dest="fields",
                    help="Track transitions for this column; repeatable")
    ap.add_argument("--from", dest="from_sha", help="Baseline snapshot sha (default: second newest)")
    ap.add_argument("--to", dest="to_sha", help="Comparison snapshot sha (default: newest)")
    ap.add_argument("--sample", type=int, default=0, help="Print N example changed records")
    args = ap.parse_args()

    snaps = snapshots_for(args.endpoint)
    if len(snaps) < 2:
        print(f"Need two accepted snapshots of {args.endpoint}; have {len(snaps)}.")
        print("The archive builds over time — run collect.py on a schedule, then come back.")
        return 1

    by_sha = {s["sha256"]: s for s in snaps}
    older = by_sha[args.from_sha] if args.from_sha else snaps[-2]
    newer = by_sha[args.to_sha] if args.to_sha else snaps[-1]

    if older["sha256"] == newer["sha256"]:
        print(f"Both snapshots are the same content ({older['sha256'][:12]}) — nothing changed.")
        return 0

    key = args.key or DEFAULT_KEYS.get(args.endpoint, "FID")
    fields = args.fields
    keep = list({key, *(fields or [])}) if fields else None

    if STABLE_ENDPOINTS.get(args.endpoint) is False:
        print(f"⚠️  {args.endpoint} is computed live and drifts between requests "
              "(~0.004% of rows differed between back-to-back fetches).")
        print("   Small diffs here are transport noise, not real-world change.\n")

    print(f"endpoint : {args.endpoint}   key: {key}")
    print(f"from     : {older['collected_at'][:19]}  {older['sha256'][:12]}  {older['rows']:,} rows")
    print(f"to       : {newer['collected_at'][:19]}  {newer['sha256'][:12]}  {newer['rows']:,} rows")
    print("-" * 78)

    a, b = load(older, key, keep), load(newer, key, keep)
    added, removed, common = set(b) - set(a), set(a) - set(b), set(a) & set(b)

    print(f"added    : {len(added):,}")
    print(f"removed  : {len(removed):,}")
    print(f"in both  : {len(common):,}")

    if not fields:
        changed = sum(1 for k in common if a[k] != b[k])
        print(f"modified : {changed:,}")
        print("\nPass --field FFLAG (repeatable) to see per-field transitions.")
        return 0

    for field in fields:
        transitions = Counter(
            (a[k].get(field, ""), b[k].get(field, ""))
            for k in common
            if a[k].get(field) != b[k].get(field)
        )
        print(f"\n=== {field}: {sum(transitions.values()):,} records changed ===")
        if not transitions:
            print("  (stable across these snapshots)")
            continue
        print(f"  {'from':<22} {'to':<22} {'count':>9}")
        for (before, after), n in transitions.most_common(25):
            print(f"  {before or '(empty)':<22} {after or '(empty)':<22} {n:>9,}")

        if args.sample:
            print(f"\n  sample of changed records:")
            shown = 0
            for k in common:
                if a[k].get(field) != b[k].get(field):
                    print(f"    {key}={k}  {field}: {a[k].get(field)!r} -> {b[k].get(field)!r}")
                    shown += 1
                    if shown >= args.sample:
                        break

        # Distribution matters as much as transitions: a field whose values are
        # wholly reshuffled is a decoding change on DIW's side, not real-world
        # churn, and that distinction is exactly what was missed before.
        print(f"\n  {field} distribution now:")
        for value, n in Counter(r.get(field, "") for r in b.values()).most_common(8):
            print(f"    {value or '(empty)':<22} {n:>10,}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
