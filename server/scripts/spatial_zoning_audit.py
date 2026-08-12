#!/usr/bin/env python3
"""
High-Performance Point-in-Polygon (PIP) Spatial Zoning Audit Engine
------------------------------------------------------------------
Uses SQLite BBOX spatial indexing to perform fast spatial compliance checks for all factories
against DPT's official Town Planning master dataset (42,219 polygons).
"""

import csv
import json
import sqlite3
import sys
import time

DB_PATH = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/dpt_geodatabase.db"
FACTORY_CSV = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/active_factories_for_dbd_match.csv"
REPORT_JSON = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/zoning_audit_report.json"


def point_in_polygon(lng, lat, polygon_rings):
    """Ray-Casting Point-in-Polygon test for WGS84 coordinates."""
    if not polygon_rings:
        return False

    outer_ring = polygon_rings[0]
    n = len(outer_ring)
    if n < 3:
        return False

    inside = False
    p1x, p1y = outer_ring[0][0], outer_ring[0][1]

    for i in range(n + 1):
        p2x, p2y = outer_ring[i % n][0], outer_ring[i % n][1]
        if lat > min(p1y, p2y):
            if lat <= max(p1y, p2y):
                if lng <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (lat - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or lng <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y

    if not inside:
        return False

    # Check holes
    for hole in polygon_rings[1:]:
        hn = len(hole)
        if hn < 3: continue
        hole_inside = False
        hp1x, hp1y = hole[0][0], hole[0][1]
        for j in range(hn + 1):
            hp2x, hp2y = hole[j % hn][0], hole[j % hn][1]
            if lat > min(hp1y, hp2y):
                if lat <= max(hp1y, hp2y):
                    if lng <= max(hp1x, hp2x):
                        if hp1y != hp2y:
                            hxinters = (lat - hp1y) * (hp2x - hp1x) / (hp2y - hp1y) + hp1x
                        if hp1x == hp2x or lng <= hxinters:
                            hole_inside = not hole_inside
            hp1x, hp1y = hp2x, hp2y
        if hole_inside:
            return False

    return True


def run_audit():
    print(f"Connecting to SQLite GeoDatabase at {DB_PATH}...")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Pre-cache Purple Industrial Zones into memory for instant checking
    cursor.execute("""
        SELECT fid, pl_use, pl_block, name, cw_name, amphoe_nam,
               bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat, geometry_json
        FROM dpt_features
        WHERE is_industrial = 1
    """)
    purple_rows = cursor.fetchall()
    purple_polygons = []
    for r in purple_rows:
        fid, pl_use, pl_block, name, cw_name, amphoe_nam, b_min_x, b_min_y, b_max_x, b_max_y, geom_str = r
        try:
            geom = json.loads(geom_str)
            coords = geom.get('coordinates', [])
            geom_type = geom.get('type', 'Polygon')
            rings_list = [coords] if geom_type == "Polygon" else coords
            purple_polygons.append({
                "fid": fid, "pl_use": str(pl_use), "pl_block": str(pl_block),
                "name": name, "cw_name": cw_name, "amphoe_nam": amphoe_nam,
                "bbox": (b_min_x, b_min_y, b_max_x, b_max_y),
                "rings_list": rings_list
            })
        except Exception:
            pass

    print(f"Cached {len(purple_polygons):,} Purple Industrial Zones in memory.")

    # Read active factories
    print(f"Reading factory records from {FACTORY_CSV}...")
    factories = []
    with open(FACTORY_CSV, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            lat_str = row.get('lat')
            lng_str = row.get('lng')
            if lat_str and lng_str:
                try:
                    lat = float(lat_str)
                    lng = float(lng_str)
                    if 5.0 <= lat <= 21.0 and 97.0 <= lng <= 106.0:
                        row['lat_f'] = lat
                        row['lng_f'] = lng
                        factories.append(row)
                except ValueError:
                    pass

    total_factories = len(factories)
    print(f"Loaded {total_factories:,} factories with valid coordinates.")
    print("Executing Point-in-Polygon spatial audit...")

    t0 = time.time()

    purple_matches = 0
    dpt_master_matches = 0
    unmapped_zoning = 0

    landuse_counts = {
        "purple_industrial": 0,    # PL_USE 3xxx
        "yellow_residential": 0,   # PL_USE 11xx
        "orange_residential": 0,   # PL_USE 12xx/13xx
        "brown_residential": 0,    # PL_USE 14xx/15xx
        "red_commercial": 0,       # PL_USE 2xxx
        "green_agriculture": 0,    # PL_USE 4xxx/5xxx
        "blue_government": 0,      # PL_USE 7xxx
        "other_zone": 0
    }

    province_stats = {}
    hazard_mismatches = []

    for idx, f in enumerate(factories):
        lng = f['lng_f']
        lat = f['lat_f']
        prov = f.get('province', 'ไม่ระบุ')
        fac_name = f.get('name', 'ไม่ระบุชื่อ')
        reg_id = f.get('registration_display', '')
        fac_type = f.get('factory_type', '0')

        if prov not in province_stats:
            province_stats[prov] = {"total": 0, "purple": 0, "agriculture": 0, "residential": 0, "commercial": 0}
        province_stats[prov]["total"] += 1

        # 1. Fast check against memory-cached Purple Industrial Zones
        hit_purple = False
        matched_poly_info = None

        for poly in purple_polygons:
            bx1, by1, bx2, by2 = poly['bbox']
            if bx1 <= lng <= bx2 and by1 <= lat <= by2:
                for rings in poly['rings_list']:
                    if point_in_polygon(lng, lat, rings):
                        hit_purple = True
                        matched_poly_info = poly
                        break
            if hit_purple:
                break

        if hit_purple:
            purple_matches += 1
            dpt_master_matches += 1
            landuse_counts["purple_industrial"] += 1
            province_stats[prov]["purple"] += 1
        else:
            # 2. Query SQLite BBOX index for general DPT zones covering this point
            cursor.execute("""
                SELECT fid, pl_use, pl_block, name, cw_name, geometry_json
                FROM dpt_features
                WHERE is_industrial = 0
                  AND bbox_min_lng <= ? AND bbox_max_lng >= ?
                  AND bbox_min_lat <= ? AND bbox_max_lat >= ?
            """, (lng, lng, lat, lat))
            candidates = cursor.fetchall()

            hit_general = False
            for cand in candidates:
                c_fid, c_pl_use, c_pl_block, c_name, c_cw, c_geom_str = cand
                try:
                    c_geom = json.loads(c_geom_str)
                    c_coords = c_geom.get('coordinates', [])
                    c_type = c_geom.get('type', 'Polygon')
                    c_rings_list = [c_coords] if c_type == "Polygon" else c_coords

                    for rings in c_rings_list:
                        if point_in_polygon(lng, lat, rings):
                            hit_general = True
                            matched_poly_info = {
                                "fid": c_fid, "pl_use": str(c_pl_use),
                                "pl_block": str(c_pl_block), "name": c_name
                            }
                            break
                    if hit_general:
                        break
                except Exception:
                    continue

            if hit_general and matched_poly_info:
                dpt_master_matches += 1
                pl_use = matched_poly_info['pl_use']

                if pl_use.startswith('11'):
                    landuse_counts["yellow_residential"] += 1
                    province_stats[prov]["residential"] += 1
                elif pl_use.startswith('12') or pl_use.startswith('13'):
                    landuse_counts["orange_residential"] += 1
                    province_stats[prov]["residential"] += 1
                elif pl_use.startswith('1'):
                    landuse_counts["brown_residential"] += 1
                    province_stats[prov]["residential"] += 1
                elif pl_use.startswith('2'):
                    landuse_counts["red_commercial"] += 1
                    province_stats[prov]["commercial"] += 1
                elif pl_use.startswith('4') or pl_use.startswith('5'):
                    landuse_counts["green_agriculture"] += 1
                    province_stats[prov]["agriculture"] += 1
                elif pl_use.startswith('7'):
                    landuse_counts["blue_government"] += 1
                else:
                    landuse_counts["other_zone"] += 1

                # Track Type 3 Hazardous Factories in Residential/Agricultural Zones
                if fac_type == '3.0' or 'เคมี' in fac_name or 'รีไซเคิล' in fac_name or 'ขยะ' in fac_name:
                    if pl_use.startswith('1') or pl_use.startswith('4') or pl_use.startswith('5'):
                        hazard_mismatches.append({
                            "reg_id": reg_id,
                            "name": fac_name,
                            "province": prov,
                            "district": f.get('district', ''),
                            "lat": lat,
                            "lng": lng,
                            "zone_type": "ที่อยู่อาศัย" if pl_use.startswith('1') else "เกษตรกรรม/อนุรักษ์",
                            "dpt_plan_name": matched_poly_info['name'],
                            "dpt_block": matched_poly_info['pl_block']
                        })
            else:
                unmapped_zoning += 1

        if (idx + 1) % 5000 == 0:
            print(f" Audited {idx + 1:,}/{total_factories:,} factories...")

    conn.close()
    t1 = time.time()
    audit_time = t1 - t0

    print(f"\nSpatial Audit Completed in {audit_time:.2f} seconds ({total_factories / audit_time:.0f} factories/sec)")

    report_summary = {
        "audit_timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_factories_audited": total_factories,
        "execution_time_seconds": round(audit_time, 2),
        "overall_summary": {
            "purple_industrial_zone_matches": purple_matches,
            "purple_industrial_zone_pct": round(purple_matches / total_factories * 100, 2),
            "dpt_master_plan_matches": dpt_master_matches,
            "dpt_master_plan_pct": round(dpt_master_matches / total_factories * 100, 2),
            "outside_dpt_polygons": unmapped_zoning,
            "outside_dpt_pct": round(unmapped_zoning / total_factories * 100, 2)
        },
        "landuse_distribution": landuse_counts,
        "hazard_mismatch_count": len(hazard_mismatches),
        "sample_hazard_mismatches": hazard_mismatches[:15],
        "top_provinces": []
    }

    sorted_provs = sorted(province_stats.items(), key=lambda x: x[1]['total'], reverse=True)
    for p_name, p_data in sorted_provs[:20]:
        report_summary["top_provinces"].append({
            "province": p_name,
            "total_factories": p_data["total"],
            "purple_zone_count": p_data["purple"],
            "purple_zone_pct": round(p_data["purple"] / p_data["total"] * 100, 1) if p_data["total"] > 0 else 0,
            "agriculture_zone_count": p_data["agriculture"],
            "residential_zone_count": p_data["residential"]
        })

    with open(REPORT_JSON, 'w', encoding='utf-8') as f:
        json.dump(report_summary, f, ensure_ascii=False, indent=2)

    print(f"Audit report saved to {REPORT_JSON}")


if __name__ == "__main__":
    run_audit()
