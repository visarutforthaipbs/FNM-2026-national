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
    
    # Paginate through all records (Supabase limits to 1000 per request)
    all_markers = []
    offset = 0
    batch_size = 1000
    
    while True:
        response = supabase.table("factories") \
            .select("id,name,lat,lng,factory_type,province") \
            .eq("is_active", True) \
            .eq("status", "ดำเนินการ") \
            .not_.is_("lat", "null") \
            .not_.is_("lng", "null") \
            .range(offset, offset + batch_size - 1) \
            .execute()
        
        batch = response.data
        if not batch:
            break
            
        all_markers.extend(batch)
        offset += batch_size
        print(f"  ... fetched {len(all_markers)} so far")
    
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

if __name__ == "__main__":
    export_markers()
