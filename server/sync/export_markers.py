"""
Export all operating factory markers to a static JSON file.
The frontend loads this file directly → no Supabase timeout issues.
"""
import json
import os
import sys

# Add parent path for imports
sys.path.insert(0, os.path.dirname(__file__))

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

import time

def execute_with_retry(query, attempts=4):
    """Retry on Supabase statement timeouts (first page often hits a cold cache)."""
    for attempt in range(attempts):
        try:
            return query.execute()
        except Exception as e:
            if attempt == attempts - 1 or "57014" not in str(e):
                raise
            wait = 2 ** attempt
            print(f"  waiting {wait}s after statement timeout...")
            time.sleep(wait)

def export_markers():
    """Fetch all operating factories and save as lightweight JSON."""
    print("📥 Fetching all operating factories...")
    
    # Keyset pagination (id > last, ordered by id). Unordered .range() paging
    # previously let Postgres return overlapping/missing rows across pages
    # (~7k duplicate markers), and ordered offset paging hits the statement
    # timeout on deep pages — keyset is both correct and fast.
    all_markers = []
    batch_size = 1000
    last_id = None

    while True:
        query = supabase.table("factories") \
            .select("id,name,lat,lng,factory_type,province,coord_source") \
            .eq("is_active", True) \
            .eq("status", "ดำเนินการ") \
            .not_.is_("lat", "null") \
            .not_.is_("lng", "null") \
            .order("id") \
            .limit(batch_size)
        if last_id is not None:
            query = query.gt("id", last_id)
        response = execute_with_retry(query)

        batch = response.data
        if not batch:
            break

        all_markers.extend(batch)
        last_id = batch[-1]["id"]
        print(f"  ... fetched {len(all_markers)} so far")
    
    # Safety net: drop duplicate rows even if pagination misbehaves
    seen_ids = set()
    unique_markers = []
    for m in all_markers:
        if m["id"] not in seen_ids:
            seen_ids.add(m["id"])
            unique_markers.append(m)
    if len(unique_markers) != len(all_markers):
        print(f"⚠️  Removed {len(all_markers) - len(unique_markers)} duplicate rows")
    all_markers = unique_markers

    print(f"✅ Total: {len(all_markers)} operating factories with coordinates")

    # Compact format: minimize JSON size
    # "q" flags approximate positions so the UI can render them honestly:
    #   'g' = geocoded from address (street-level), 'c' = tambon centroid.
    # Absent means an exact position (gov feed / repaired / community-verified).
    QUALITY_FLAGS = {"geocoded": "g", "centroid": "c"}
    compact = []
    for m in all_markers:
        entry = {
            "i": m["id"],                          # id
            "n": (m["name"] or "")[:80],           # name (truncated)
            "a": [m["lng"], m["lat"]],              # coordinates [lng, lat]
            "t": m.get("factory_type") or "",       # type
            "p": m.get("province") or "",           # province
        }
        q = QUALITY_FLAGS.get(m.get("coord_source") or "")
        if q:
            entry["q"] = q
        compact.append(entry)
    
    output_dir = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")
    os.makedirs(output_dir, exist_ok=True)

    # Load th→en province name mapping from the existing counts file
    counts_path = os.path.join(output_dir, "province-counts.json")
    th_to_en = {}
    if os.path.exists(counts_path):
        with open(counts_path, encoding="utf-8") as f:
            th_to_en = {p["name_th"]: p["name_en"] for p in json.load(f)}

    counts = {}
    by_province = {}
    for m in compact:
        prov = m["p"]
        if prov:
            counts[prov] = counts.get(prov, 0) + 1
            by_province.setdefault(prov, []).append(m)

    unmapped = [p for p in counts if p not in th_to_en]
    if unmapped:
        print(f"⚠️  Provinces missing an English name mapping (add manually): {unmapped}")

    # Write one marker file per province (client fetches /data/markers/{slug}.json
    # — ~50–500 KB each instead of the full 7 MB nationwide file)
    markers_dir = os.path.join(output_dir, "markers")
    os.makedirs(markers_dir, exist_ok=True)
    for old_file in os.listdir(markers_dir):
        os.remove(os.path.join(markers_dir, old_file))
    for prov, items in by_province.items():
        slug = th_to_en.get(prov, prov).lower().replace(" ", "-")
        with open(os.path.join(markers_dir, f"{slug}.json"), "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, separators=(",", ":"))
    print(f"💾 Saved {len(by_province)} per-province marker files to {markers_dir}")

    # Regenerate province-counts.json so the dropdown/choropleth stay in sync
    province_counts = [
        {"name_en": th_to_en.get(p, p), "name_th": p, "count": c}
        for p, c in sorted(counts.items(), key=lambda x: th_to_en.get(x[0], x[0]))
    ]
    with open(counts_path, "w", encoding="utf-8") as f:
        json.dump(province_counts, f, ensure_ascii=False, indent=1)
    print(f"💾 Saved {len(province_counts)} provinces to {counts_path}")

if __name__ == "__main__":
    export_markers()
