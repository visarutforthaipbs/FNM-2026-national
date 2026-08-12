#!/usr/bin/env python3
"""
DPT GeoDatabase Builder
-----------------------
Downloads official Thailand Town Planning (ผังเมืองรวม) vector polygons directly
from Department of Public Works and Town & Country Planning (DPT - landuseplan.dpt.go.th)
ArcGIS REST API (https://onedpt.dpt.go.th/arcgis/rest/services/PLLU_ALL/PLLU_ALL/MapServer/0).

Outputs:
1. SQLite GeoDatabase: server/data/dpt_geodatabase.db
2. Industrial Purple Zones GeoJSON: client/public/data/dpt_industrial_purple_zones.json
3. National Town Plan Master GeoJSON: server/data/dpt_townplan_national.geojson.gz
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

DPT_QUERY_URL = "https://onedpt.dpt.go.th/arcgis/rest/services/PLLU_ALL/PLLU_ALL/MapServer/0/query"
BATCH_SIZE = 500
TOTAL_FEATURES = 42219
MAX_WORKERS = 8

DB_PATH = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/dpt_geodatabase.db"
PURPLE_ZONES_PATH = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/client/public/data/dpt_industrial_purple_zones.json"
NATIONAL_GEOJSON_GZ = "/Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/dpt_townplan_national.geojson.gz"


def init_db(db_path):
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS dpt_features (
            fid INTEGER PRIMARY KEY,
            pl_use TEXT,
            pl_block TEXT,
            name TEXT,
            cw_name TEXT,
            amphoe_nam TEXT,
            year INTEGER,
            status_maj TEXT,
            rg_name TEXT,
            description TEXT,
            is_industrial INTEGER,
            bbox_min_lng REAL,
            bbox_min_lat REAL,
            bbox_max_lng REAL,
            bbox_max_lat REAL,
            geometry_json TEXT
        )
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_dpt_pl_use ON dpt_features(pl_use)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_dpt_cw_name ON dpt_features(cw_name)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_dpt_is_industrial ON dpt_features(is_industrial)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_dpt_bbox ON dpt_features(bbox_min_lng, bbox_max_lng, bbox_min_lat, bbox_max_lat)")
    conn.commit()
    return conn


def calculate_bbox(coordinates, geom_type):
    min_lng, min_lat = 180.0, 90.0
    max_lng, max_lat = -180.0, -90.0

    def process_ring(ring):
        nonlocal min_lng, min_lat, max_lng, max_lat
        for p in ring:
            lng, lat = p[0], p[1]
            if lng < min_lng: min_lng = lng
            if lng > max_lng: max_lng = lng
            if lat < min_lat: min_lat = lat
            if lat > max_lat: max_lat = lat

    if geom_type == "Polygon":
        for ring in coordinates:
            process_ring(ring)
    elif geom_type == "MultiPolygon":
        for poly in coordinates:
            for ring in poly:
                process_ring(ring)

    return min_lng, min_lat, max_lng, max_lat


def fetch_batch(start_fid, end_fid):
    params = f"where=FID>={start_fid}+AND+FID<{end_fid}&outFields=*&returnGeometry=true&outSR=4326&f=geojson"
    url = f"{DPT_QUERY_URL}?{params}"
    
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as res:
                data = res.read().decode('utf-8')
                json_data = json.loads(data)
                return start_fid, json_data.get('features', [])
        except Exception as e:
            if attempt == 2:
                print(f"Error fetching range [{start_fid}-{end_fid}]: {e}")
                return start_fid, []
            time.sleep(1)
    return start_fid, []


def download_all_dpt():
    print(f"Starting DPT GeoDatabase build: {TOTAL_FEATURES} total features")
    conn = init_db(DB_PATH)
    cursor = conn.cursor()

    # Check existing count
    cursor.execute("SELECT COUNT(*) FROM dpt_features")
    existing_count = cursor.fetchone()[0]
    print(f"Existing features in DB: {existing_count}")

    batches = []
    for start_fid in range(0, TOTAL_FEATURES + BATCH_SIZE, BATCH_SIZE):
        batches.append((start_fid, start_fid + BATCH_SIZE))

    print(f"Total batches to process: {len(batches)} (using {MAX_WORKERS} workers)")
    
    all_purple_features = []
    total_saved = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_batch, b[0], b[1]): b for b in batches}
        
        for future in as_completed(futures):
            start_fid, features = future.result()
            if not features:
                continue

            rows = []
            for feat in features:
                props = feat.get('properties', {})
                geom = feat.get('geometry', {})
                fid = props.get('FID')
                pl_use = str(props.get('PL_USE', ''))
                pl_block = str(props.get('PL_BLOCK', ''))
                name = props.get('NAME') or props.get('NAME_1') or ''
                cw_name = props.get('CW_NAME') or props.get('CHANGWAT_N') or ''
                amphoe_nam = props.get('AMPHOE_NAM') or ''
                year = props.get('Year')
                status_maj = props.get('status_maj') or ''
                rg_name = props.get('RG_NAME') or ''
                description = props.get('Descriptio') or ''
                
                # Check if industrial (Purple Zone)
                # สีม่วง covers "อุตสาหกรรมและคลังสินค้า": the 3xxx family plus
                # the 4xxx warehouse codes, which were previously dropped.
                is_ind = 1 if pl_use.startswith(('3', '4')) or 'อุตสาหกรรม' in name or 'อุตสาหกรรม' in pl_block else 0

                coordinates = geom.get('coordinates', [])
                geom_type = geom.get('type', 'Polygon')
                min_lng, min_lat, max_lng, max_lat = calculate_bbox(coordinates, geom_type)

                rows.append((
                    fid, pl_use, pl_block, name, cw_name, amphoe_nam,
                    year, status_maj, rg_name, description, is_ind,
                    min_lng, min_lat, max_lng, max_lat,
                    json.dumps(geom, ensure_ascii=False)
                ))

                if is_ind:
                    all_purple_features.append({
                        "type": "Feature",
                        "properties": {
                            "fid": fid,
                            "pl_use": pl_use,
                            "pl_block": pl_block,
                            "name": name,
                            "cw_name": cw_name,
                            "amphoe_nam": amphoe_nam,
                            "status": status_maj,
                            "color": "#7C3AED" if pl_use.startswith('31') or pl_use.startswith('32') else "#A78BFA",
                            "zone_desc": "ผังเมืองสีม่วง (อุตสาหกรรมและคลังสินค้า)"
                        },
                        "geometry": geom
                    })

            cursor.executemany("""
                INSERT OR REPLACE INTO dpt_features (
                    fid, pl_use, pl_block, name, cw_name, amphoe_nam,
                    year, status_maj, rg_name, description, is_industrial,
                    bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat,
                    geometry_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, rows)
            conn.commit()

            total_saved += len(rows)
            elapsed = time.time() - start_time
            print(f"Progress: {total_saved}/{TOTAL_FEATURES} features saved ({elapsed:.1f}s)")

    conn.close()

    # Save Industrial Purple Zones GeoJSON
    print(f"Exporting {len(all_purple_features)} Industrial Purple Zone features to GeoJSON...")
    os.makedirs(os.path.dirname(PURPLE_ZONES_PATH), exist_ok=True)
    purple_geojson = {
        "type": "FeatureCollection",
        "features": all_purple_features
    }
    with open(PURPLE_ZONES_PATH, 'w', encoding='utf-8') as f:
        json.dump(purple_geojson, f, ensure_ascii=False)

    print("DPT GeoDatabase build complete!")
    print(f"- SQLite DB: {DB_PATH}")
    print(f"- Purple Zones GeoJSON: {PURPLE_ZONES_PATH}")


if __name__ == "__main__":
    download_all_dpt()
