#!/usr/bin/env python3
"""
Repair coordinates that fall outside the province they are tagged with.
=======================================================================
Some government coordinates carry a single wrong digit in the DEGREES field, so
the point lands a whole degree from where it belongs — บริษัท น่ำเฮงคอนกรีต
(1992) จำกัด is tagged ศรีมหาโพธิ ปราจีนบุรี but published at 100.55036 E, which
is in Bangkok; 101.55036 E puts it 5.7 km from the centroid of หนองโพรง, the
tambon its own registration names. พี.แอล.ซีเมนต์ shows the same signature.

That class is mechanically repairable: try shifting latitude and/or longitude by
whole degrees and see whether the point comes home. The rest of the mismatches
look genuinely transposed and are left for the admin queue.

This is deliberately conservative, because it rewrites positions that already
exist rather than filling blanks. A candidate is accepted only when ALL of:

  * it lands inside the stated province polygon, and
  * it lands within MAX_TAMBON_KM of the centroid of the stated tambon, and
  * it is the ONLY whole-degree shift that satisfies both.

Anything ambiguous is reported and left alone — a wrong pin presented as exact
is worse than a pin the admin queue already flags.

Usage:
    python repair_province_mismatch.py                    # dry run
    python repair_province_mismatch.py --dump repairs.csv # review the proposals
    python repair_province_mismatch.py --apply

After --apply: refresh geom for the repaired rows, then re-run
export_markers.py, export_dashboard.py, export_zoning.py and
audit_province_mismatch.py.
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from shapely.geometry import Point

from geocode_missing import (
    execute_with_retry,
    load_province_polygons,
    load_gazetteer,
    haversine_km,
    norm,
    apply_updates,
    MAX_DONOR_TAMBON_KM,
)
from pipeline import supabase

# Same threshold the sibling tier uses for "is this point credibly in the tambon
# it claims" — see geocode_missing.MAX_DONOR_TAMBON_KM for how it was chosen.
MAX_TAMBON_KM = MAX_DONOR_TAMBON_KM

# Whole-degree shifts to try. A wrong digit in the degrees field moves the point
# by exactly 1°; larger errors are not this failure mode and are left alone.
SHIFTS = [
    (dlat, dlng)
    for dlat in (0, 1, -1)
    for dlng in (0, 1, -1)
    if not (dlat == 0 and dlng == 0)
]


def fetch_mapped() -> list[dict]:
    """Operating factories that currently have a position on the map."""
    rows, last_id = [], None
    while True:
        q = (
            supabase.table("factories")
            .select("id,name,province,district,sub_district,lat,lng,coord_source")
            .eq("is_active", True)
            .eq("status", "ดำเนินการ")
            .not_.is_("lat", "null")
            .order("id")
            .limit(1000)
        )
        if last_id is not None:
            q = q.gt("id", last_id)
        batch = execute_with_retry(q).data
        if not batch:
            break
        rows.extend(batch)
        last_id = batch[-1]["id"]
    print(f"🔍 {len(rows):,} operating factories currently on the map")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write repairs to Supabase")
    ap.add_argument("--dump", metavar="PATH", help="write proposed repairs to CSV")
    ap.add_argument("--limit", type=int, default=100000)
    args = ap.parse_args()

    polygons = load_province_polygons()
    gazetteer = load_gazetteer()
    rows = fetch_mapped()

    # Only rows that are actually outside their stated province are candidates.
    # load_province_polygons() already buffers by ~2 km, so points sitting on a
    # generalised boundary are not treated as errors.
    mismatched = []
    for r in rows:
        polygon = polygons.get((r.get("province") or "").strip())
        if polygon is None:
            continue
        if not polygon.contains(Point(r["lng"], r["lat"])):
            mismatched.append(r)
    print(f"⚠️  {len(mismatched):,} outside their stated province polygon")

    repairs, proposals = [], []
    ambiguous = no_shift_works = no_tambon = 0

    for r in mismatched[:args.limit]:
        polygon = polygons[(r.get("province") or "").strip()]
        centroid = gazetteer.get(
            (norm(r.get("province")), norm(r.get("district")), norm(r.get("sub_district")))
        )
        if centroid is None:
            # Without a tambon centroid only the province test is available, and
            # a province is far too coarse to accept a rewrite on. Leave it for
            # the admin queue.
            no_tambon += 1
            continue

        accepted = []
        for dlat, dlng in SHIFTS:
            lat, lng = r["lat"] + dlat, r["lng"] + dlng
            if not polygon.contains(Point(lng, lat)):
                continue
            km = haversine_km(centroid, (lat, lng))
            if km > MAX_TAMBON_KM:
                continue
            accepted.append((dlat, dlng, lat, lng, km))

        if not accepted:
            no_shift_works += 1
            continue
        if len(accepted) > 1:
            ambiguous += 1  # two shifts both look plausible — a human decides
            continue

        dlat, dlng, lat, lng, km = accepted[0]
        repairs.append({"id": r["id"], "lat": lat, "lng": lng})
        proposals.append({
            "id": r["id"],
            "name": r["name"],
            "province": r["province"],
            "district": r["district"],
            "sub_district": r["sub_district"],
            "shift": f"lat{dlat:+d} lng{dlng:+d}",
            "old_lat": r["lat"], "old_lng": r["lng"],
            "new_lat": lat, "new_lng": lng,
            "km_from_tambon": round(km, 2),
            "moved_km": round(haversine_km((r["lat"], r["lng"]), (lat, lng)), 1),
            "old_coord_source": r["coord_source"],
        })

    print("\n📊 Whole-degree repair results")
    print(f"   repairable (exactly one shift works): {len(repairs)}")
    print(f"   no whole-degree shift brings it home: {no_shift_works}")
    print(f"   more than one shift plausible:        {ambiguous}")
    print(f"   no tambon centroid to verify against: {no_tambon}")
    if proposals:
        by_shift = {}
        for p in proposals:
            by_shift[p["shift"]] = by_shift.get(p["shift"], 0) + 1
        for shift, n in sorted(by_shift.items(), key=lambda kv: -kv[1]):
            print(f"     {shift}: {n}")

    if args.dump:
        with open(args.dump, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f, fieldnames=list(proposals[0].keys()) if proposals else ["id"])
            writer.writeheader()
            writer.writerows(proposals)
        print(f"   📄 wrote {len(proposals)} proposed repairs to {args.dump}")

    apply_updates(repairs, "repaired", "exact", dry_run=not args.apply)

    if args.apply:
        # geom needs no manual step — tr_factories_set_geometry maintains it on
        # any lat/lng update.
        print("\nNext steps:")
        print("   python export_markers.py && python export_dashboard.py")
        print("   python export_zoning.py && python audit_province_mismatch.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
