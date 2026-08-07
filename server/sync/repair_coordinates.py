#!/usr/bin/env python3
"""
Tier 1 coordinate recovery — repair coordinates the pipeline threw away.
=======================================================================
pipeline.parse_coordinates() nulls anything outside Thailand's bounding box,
but many of those raw values are recoverable: swapped lat/lng, missing decimal
points (145041 → 14.5041), or both. This script re-reads the raw government
CSVs for factories missing coordinates, tries mechanical repairs, and accepts
a repair ONLY if the result lands inside the factory's stated province polygon.

Usage:
    python repair_coordinates.py            # dry run: measure what's recoverable
    python repair_coordinates.py --apply    # write repairs to Supabase

After --apply, re-run export_markers.py (and refresh the PostGIS geom column)
so the map picks the new positions up.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from shapely.geometry import Point, shape

# pipeline.py loads .env and creates the Supabase client at import time
from pipeline import fetch_csv, clean_facreg, supabase

CLIENT_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")

TH_LAT = (5.0, 21.0)
TH_LNG = (95.0, 106.0)


def execute_with_retry(query, attempts=4):
    """Retry on Supabase statement timeouts (first page often hits a cold cache)."""
    for attempt in range(attempts):
        try:
            return query.execute()
        except Exception as e:  # noqa: BLE001
            if attempt == attempts - 1 or "57014" not in str(e):
                raise
            wait = 2 ** attempt
            print(f"  ⏳ statement timeout, retrying in {wait}s...")
            time.sleep(wait)


def load_province_polygons() -> dict:
    """Thai province name → shapely geometry (prepared from the app's GeoJSON)."""
    with open(os.path.join(CLIENT_DATA, "thailand-provinces.json"), encoding="utf-8") as f:
        geo = json.load(f)
    with open(os.path.join(CLIENT_DATA, "province-counts.json"), encoding="utf-8") as f:
        th_by_en = {p["name_en"]: p["name_th"] for p in json.load(f)}

    polygons = {}
    for feature in geo["features"]:
        name_en = (feature.get("properties") or {}).get("NAME_1")
        name_th = th_by_en.get(name_en)
        if name_th:
            polygons[name_th] = shape(feature["geometry"])
    print(f"🗺️  Loaded {len(polygons)} province polygons")
    return polygons


def parse_raw(value) -> float | None:
    try:
        f = float(str(value).strip().strip('"').replace(",", ""))
        return f if f != 0 else None
    except (ValueError, TypeError):
        return None


def scale_into(value: float, lo: float, hi: float) -> float | None:
    """Divide by powers of 10 until the value fits the range (missing decimal point)."""
    v = abs(value)
    for _ in range(8):
        if lo <= v <= hi:
            return v
        v /= 10
    return None


def repair_candidates(raw_lat: float, raw_lng: float):
    """Yield plausible (lat, lng) repairs, most-likely first."""
    for a, b in ((raw_lat, raw_lng), (raw_lng, raw_lat)):  # as-is, then swapped
        lat = a if TH_LAT[0] <= a <= TH_LAT[1] else scale_into(a, *TH_LAT)
        lng = b if TH_LNG[0] <= b <= TH_LNG[1] else scale_into(b, *TH_LNG)
        if lat is not None and lng is not None:
            yield lat, lng


def fetch_missing() -> list[dict]:
    """All active factories without coordinates (keyset pagination)."""
    missing, last_id = [], None
    while True:
        q = (
            supabase.table("factories")
            .select("id,registration_display,province")
            .eq("is_active", True)
            .eq("status", "ดำเนินการ")  # operating factories — what the map shows
            .is_("lat", "null")
            .order("id")
            .limit(1000)
        )
        if last_id is not None:
            q = q.gt("id", last_id)
        batch = execute_with_retry(q).data
        if not batch:
            break
        missing.extend(batch)
        last_id = batch[-1]["id"]
    print(f"🔍 {len(missing)} active factories missing coordinates")
    return missing


def build_raw_lookup() -> dict:
    """Cleaned registration id → (raw LAT, raw LNG) from the government CSVs."""
    lookup = {}
    for endpoint, id_col in (("Factory_Data", "FACREG"), ("Business_Location", "DISPFACREG")):
        df = fetch_csv(endpoint)
        if df is None:
            print(f"⚠️  Could not fetch {endpoint}, skipping")
            continue
        n = 0
        for _, row in df.iterrows():
            reg = clean_facreg(str(row.get(id_col, "")))
            lat, lng = parse_raw(row.get("LAT")), parse_raw(row.get("LNG"))
            if reg and lat is not None and lng is not None and reg not in lookup:
                lookup[reg] = (lat, lng)
                n += 1
        print(f"📥 {endpoint}: {n} raw coordinate pairs")
    return lookup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write repairs to Supabase")
    args = parser.parse_args()

    polygons = load_province_polygons()
    missing = fetch_missing()
    raw = build_raw_lookup()

    stats = {"no_raw": 0, "no_province_polygon": 0, "unrepairable": 0, "repaired": 0}
    repairs = []

    for factory in missing:
        keys = [factory["id"], clean_facreg(factory.get("registration_display") or "")]
        pair = next((raw[k] for k in keys if k and k in raw), None)
        if pair is None:
            stats["no_raw"] += 1
            continue

        polygon = polygons.get((factory.get("province") or "").strip())
        if polygon is None:
            stats["no_province_polygon"] += 1
            continue

        fixed = next(
            (
                (lat, lng)
                for lat, lng in repair_candidates(*pair)
                # buffer(0.02) ≈ 2 km tolerance for coastline/border imprecision
                if polygon.buffer(0.02).contains(Point(lng, lat))
            ),
            None,
        )
        if fixed is None:
            stats["unrepairable"] += 1
            continue

        stats["repaired"] += 1
        repairs.append({"id": factory["id"], "lat": fixed[0], "lng": fixed[1]})

    print("\n📊 Tier 1 repair results")
    print(f"   recoverable (validated in province): {stats['repaired']}")
    print(f"   raw CSV has no coordinates either:   {stats['no_raw']}")
    print(f"   unrepairable raw values:             {stats['unrepairable']}")
    print(f"   province polygon not found:          {stats['no_province_polygon']}")

    if not args.apply:
        print("\nDry run — re-run with --apply to write repairs.")
        return

    print(f"\n✍️  Applying {len(repairs)} repairs...")
    for i, r in enumerate(repairs):
        supabase.table("factories").update(
            {"lat": r["lat"], "lng": r["lng"], "coord_source": "repaired", "coord_precision": "exact"}
        ).eq("id", r["id"]).execute()
        if (i + 1) % 200 == 0:
            print(f"   ... {i + 1}/{len(repairs)}")
    print("✅ Done. Now refresh geom + re-export markers:")
    print("   UPDATE factories SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)")
    print("   WHERE coord_source = 'repaired' AND geom IS NULL;")
    print("   python export_markers.py && python export_dashboard.py")


if __name__ == "__main__":
    main()
