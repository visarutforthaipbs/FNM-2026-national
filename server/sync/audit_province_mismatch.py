#!/usr/bin/env python3
"""
Find factories whose coordinates fall outside the province they are tagged with.

Why it matters
--------------
The province tag drives everything a citizen sees: which file the map loads,
what the sidebar badge says, which province the dashboard counts it under, and
which marker file it lives in. A factory tagged สมุทรปราการ but plotted in
นนทบุรี is wrong in both directions at once — it is missing from the province a
neighbour would look in, and present in one it has nothing to do with.

Method
------
Point-in-polygon against the same province boundaries the map already ships
(client/public/data/thailand-provinces.json), with holes honoured.

Border cases are separated from real mismatches. Province polygons are
generalised, and a factory legitimately sited a few metres from a boundary can
fall on the wrong side of the drawn line without anything being wrong. Only
points well clear of their tagged province are reported as errors; the rest are
counted as boundary noise and listed separately.

Reads the marker files, so it audits exactly what the map publishes.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROVINCES = REPO / "client" / "public" / "data" / "thailand-provinces.json"
MARKERS = REPO / "client" / "public" / "data" / "markers"
COUNTS = REPO / "client" / "public" / "data" / "province-counts.json"

# How far outside its tagged province a point must be before we call it an
# error rather than an artefact of a generalised boundary.
BORDER_TOLERANCE_KM = 2.0


def point_in_ring(lng: float, lat: float, ring) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def point_in_geometry(lng: float, lat: float, geom: dict) -> bool:
    gtype = geom.get("type")
    polys = geom.get("coordinates") or []
    if gtype == "Polygon":
        polys = [polys]
    elif gtype != "MultiPolygon":
        return False
    for poly in polys:
        if poly and point_in_ring(lng, lat, poly[0]):
            if not any(point_in_ring(lng, lat, hole) for hole in poly[1:]):
                return True
    return False


def rings_of(geom: dict):
    polys = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        polys = [polys]
    for poly in polys:
        for ring in poly:
            yield ring


def km_to_boundary(lng: float, lat: float, geom: dict) -> float:
    """
    Rough distance from a point to a province's outline.

    Vertex distance rather than true segment distance: this only has to
    separate "just over a line" from "in another province", and the polygons
    are dense enough that the difference does not change that verdict.
    """
    best = float("inf")
    cos_lat = math.cos(math.radians(lat))
    for ring in rings_of(geom):
        for x, y in ring:
            dx = (x - lng) * 111.32 * cos_lat
            dy = (y - lat) * 110.57
            d = dx * dx + dy * dy
            if d < best:
                best = d
    return math.sqrt(best)


def main() -> int:
    ap = argparse.ArgumentParser(description="Audit province tag vs actual coordinates.")
    ap.add_argument("--markers", type=Path, default=MARKERS)
    ap.add_argument("--out", type=Path,
                    default=REPO / "server" / "data" / "province_mismatch_report.json")
    ap.add_argument("--tolerance", type=float, default=BORDER_TOLERANCE_KM)
    args = ap.parse_args()

    # Key the polygons by English name and translate through
    # province-counts.json, the same mapping the client uses. The Thai field in
    # the polygon file cannot be trusted for this: it is "จังหวัดX" for most,
    # bare for บึงกาฬ, and "อำเภอเมืองกาญจนบุรี" — a district — for three of
    # them, which silently dropped 9,068 factories from an earlier run.
    gj = json.loads(PROVINCES.read_text(encoding="utf-8"))
    th_by_en = {p["name_en"].strip(): p["name_th"].strip()
                for p in json.loads(COUNTS.read_text(encoding="utf-8"))}
    provinces = {}
    for f in gj["features"]:
        en = (f["properties"].get("NAME_1") or "").strip()
        th = th_by_en.get(en)
        if th:
            provinces[th] = f["geometry"]
    missing = sorted(set(th_by_en.values()) - set(provinces))
    print(f"loaded {len(provinces)} province polygons"
          + (f" (no polygon for: {', '.join(missing)})" if missing else ""))

    # Bucket provinces by integer degree so each point tests only its own cell.
    grid = defaultdict(list)
    for name, geom in provinces.items():
        xs, ys = [], []
        for ring in rings_of(geom):
            for x, y in ring:
                xs.append(x); ys.append(y)
        for gx in range(int(min(xs)), int(max(xs)) + 1):
            for gy in range(int(min(ys)), int(max(ys)) + 1):
                grid[(gx, gy)].append((name, geom))

    total = matched = no_polygon = 0
    border = []
    mismatched = []

    for mf in sorted(args.markers.glob("*.json")):
        for m in json.loads(mf.read_text(encoding="utf-8")):
            lng, lat = m["a"][0], m["a"][1]
            tagged = (m.get("p") or "").strip()
            total += 1
            geom = provinces.get(tagged)
            if geom is None:
                no_polygon += 1
                continue
            if point_in_geometry(lng, lat, geom):
                matched += 1
                continue

            # Outside its tag. Which province is it actually in, and how far out?
            actual = None
            for name, g in grid.get((int(lng), int(lat)), ()):
                if name != tagged and point_in_geometry(lng, lat, g):
                    actual = name
                    break
            dist = km_to_boundary(lng, lat, geom)
            row = {
                "id": m["i"], "name": m.get("n") or "", "tagged": tagged,
                "actual": actual, "lng": lng, "lat": lat,
                "km_outside": round(dist, 2),
                "coord_quality": m.get("q") or "gov",
            }
            (border if dist <= args.tolerance else mismatched).append(row)

    print()
    print(f"factories on the map           {total:>8,}")
    print(f"  inside their tagged province {matched:>8,}  ({matched/total:.2%})")
    print(f"  within {args.tolerance:g} km of the border  {len(border):>8,}  "
          f"(generalised boundary, not counted as errors)")
    print(f"  ✗ in a different province    {len(mismatched):>8,}  "
          f"({len(mismatched)/total:.2%})")
    if no_polygon:
        print(f"  province name not in polygons {no_polygon:>7,}")

    if mismatched:
        by_source = Counter(r["coord_quality"] for r in mismatched)
        print()
        print("by coordinate source:")
        labels = {"gov": "gov feed (exact)", "g": "geocoded from address",
                  "c": "tambon centroid"}
        for k, v in by_source.most_common():
            print(f"  {labels.get(k, k):<24}{v:>7,}")

        pairs = Counter((r["tagged"], r["actual"] or "(outside Thailand)")
                        for r in mismatched)
        print()
        print("most common tagged -> actual:")
        for (tag, act), n in pairs.most_common(12):
            print(f"  {tag:<18} -> {act:<20}{n:>6,}")

        print()
        print("furthest from where they claim to be:")
        for r in sorted(mismatched, key=lambda r: -r["km_outside"])[:10]:
            print(f"  {r['km_outside']:>7.0f} km  {r['tagged']:<14} -> "
                  f"{str(r['actual']):<16} {r['name'][:38]}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "factories_checked": total,
        "inside_tagged_province": matched,
        "within_border_tolerance": len(border),
        "border_tolerance_km": args.tolerance,
        "mismatched": len(mismatched),
        "rows": sorted(mismatched, key=lambda r: -r["km_outside"]),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print()
    print(f"report -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
