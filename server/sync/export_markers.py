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
            .select("id,name,lat,lng,factory_type,province") \
            .eq("is_active", True) \
            .eq("status", "ดำเนินการ") \
            .not_.is_("lat", "null") \
            .not_.is_("lng", "null") \
            .order("id") \
            .limit(batch_size)
        if last_id is not None:
            query = query.gt("id", last_id)
        response = query.execute()

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
    compact = []
    for m in all_markers:
        compact.append({
            "i": m["id"],                          # id
            "n": (m["name"] or "")[:80],           # name (truncated)
            "a": [m["lng"], m["lat"]],              # coordinates [lng, lat]
            "t": m.get("factory_type") or "",       # type
            "p": m.get("province") or "",           # province
        })
    
    # Write to client/public for direct static serving
    output_dir = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")
    os.makedirs(output_dir, exist_ok=True)
    
    output_path = os.path.join(output_dir, "markers.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(compact, f, ensure_ascii=False, separators=(",", ":"))
    
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"💾 Saved to {output_path}")
    print(f"📦 File size: {file_size_mb:.2f} MB")
    print(f"🗺️  Ready to serve at /data/markers.json")

    # Regenerate province-counts.json so the dropdown/choropleth stay in sync
    # with the markers (reuses the existing file for the th→en name mapping)
    counts_path = os.path.join(output_dir, "province-counts.json")
    th_to_en = {}
    if os.path.exists(counts_path):
        with open(counts_path, encoding="utf-8") as f:
            th_to_en = {p["name_th"]: p["name_en"] for p in json.load(f)}

    counts = {}
    for m in compact:
        prov = m["p"]
        if prov:
            counts[prov] = counts.get(prov, 0) + 1

    unmapped = [p for p in counts if p not in th_to_en]
    if unmapped:
        print(f"⚠️  Provinces missing an English name mapping (add manually): {unmapped}")

    province_counts = [
        {"name_en": th_to_en.get(p, p), "name_th": p, "count": c}
        for p, c in sorted(counts.items(), key=lambda x: th_to_en.get(x[0], x[0]))
    ]
    with open(counts_path, "w", encoding="utf-8") as f:
        json.dump(province_counts, f, ensure_ascii=False, indent=1)
    print(f"💾 Saved {len(province_counts)} provinces to {counts_path}")

if __name__ == "__main__":
    export_markers()
