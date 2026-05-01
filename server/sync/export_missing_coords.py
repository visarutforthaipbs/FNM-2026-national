import csv
import os
import sys

# Add parent path for imports
sys.path.insert(0, os.path.dirname(__file__))

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not found in .env")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def export_missing_coords():
    print("🔍 Fetching active factories with missing coordinates...")
    
    offset = 0
    batch_size = 1000
    all_missing = []
    
    while True:
        # Assuming that if lat is null, it lacks coordinates.
        # Supabase API limits batch sizes, so we paginate.
        response = supabase.table("factories") \
            .select("id,registration_display,name,factory_type,address_full,province,district,sub_district,status") \
            .eq("is_active", True) \
            .is_("lat", "null") \
            .range(offset, offset + batch_size - 1) \
            .execute()
            
        batch = response.data
        if not batch:
            break
            
        all_missing.extend(batch)
        offset += batch_size
        print(f"  ... fetched {len(all_missing)} so far")
        
    output_file = os.path.join(os.path.dirname(__file__), "missing_coordinates.csv")
    
    if not all_missing:
        print("No missing coordinates found.")
        return
        
    # Write to CSV
    keys = ["id", "registration_display", "name", "factory_type", "address_full", "district", "province", "status"]
    # Adjust based on what is actually returned
    if all_missing:
        keys = all_missing[0].keys()
        
    with open(output_file, 'w', newline='', encoding='utf-8-sig') as f:
        dict_writer = csv.DictWriter(f, fieldnames=keys)
        dict_writer.writeheader()
        dict_writer.writerows(all_missing)
        
    print(f"✅ Exported {len(all_missing)} records to:")
    print(f"   {output_file}")

if __name__ == "__main__":
    export_missing_coords()
