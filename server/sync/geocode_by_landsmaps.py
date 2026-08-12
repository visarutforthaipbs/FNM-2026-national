"""
DOL LandsMaps Land Title Deed Geocoding Script
Scans unmapped factory records for land title deed patterns (โฉนดที่ดิน, เลขที่ดิน, หน้าสำรวจ, ระวาง)
and attempts resolution via Department of Lands (DOL) LandsMaps APIs and administrative code lookups.

Usage:
    python server/sync/geocode_by_landsmaps.py [input.csv] [--limit 100] [--output resolved.json]
"""

import sys
import os
import csv
import json
import argparse
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from server.sync.dol_landsmaps_collector import DOLLandsMapsCollector

def main():
    parser = argparse.ArgumentParser(description="Geocode unmapped factories using DOL LandsMaps title deeds.")
    parser.add_argument("input_csv", nargs="?", default="missing_coordinates.csv", help="CSV file containing unmapped factories")
    parser.add_argument("--output", default="server/data/landsmaps_resolved.json", help="Output JSON results path")
    parser.add_argument("--limit", type=int, default=0, help="Max records to process (0 = process all)")
    args = parser.parse_args()

    collector = DOLLandsMapsCollector()

    if not os.path.exists(args.input_csv):
        print(f"Error: Input file {args.input_csv} not found.")
        return

    limit_desc = "all" if args.limit <= 0 else str(args.limit)
    print(f"Scanning {args.input_csv} for land title deeds (limit={limit_desc})...")
    matched_records = []
    processed = 0

    with open(args.input_csv, mode="r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if args.limit > 0 and processed >= args.limit:
                break

            name = row.get("name", "") or ""
            addr = row.get("address_full", "") or ""
            province = row.get("province", "") or ""
            district = row.get("district", "") or ""
            text = f"{name} {addr}"

            deed_info = collector.parse_deed_text(text)
            if deed_info["deed_no"] or deed_info["land_no"]:
                processed += 1
                pvcode, amcode = collector.resolve_pv_am_codes(province, district)
                
                matched_records.append({
                    "id": row.get("id") or row.get("registration_display"),
                    "name": name.strip(),
                    "province": province,
                    "district": district,
                    "pvcode": pvcode,
                    "amcode": amcode,
                    "deed_no": deed_info["deed_no"],
                    "land_no": deed_info["land_no"],
                    "survey_no": deed_info["survey_no"],
                    "utm_map": deed_info["utm_map"],
                    "address": addr.strip()
                })

    print(f"Extracted {len(matched_records):,} factory records containing land title deed metadata.")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as out_f:
        json.dump(matched_records, out_f, ensure_ascii=False, indent=2)

    print(f"Saved extracted title deed batch to {args.output}")

if __name__ == "__main__":
    main()
