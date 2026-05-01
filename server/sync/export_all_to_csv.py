"""
Export all factory data from Supabase to a CSV file.
"""
import os
import sys
import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

# Add parent path for imports if needed
sys.path.insert(0, os.path.dirname(__file__))

# Load environment variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ Error: SUPABASE_URL or SUPABASE_SERVICE_KEY not found in .env")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def export_all_to_csv():
    """Fetch all factory records and save as CSV."""
    print("📥 Starting export of all factory data...")
    
    all_records = []
    offset = 0
    batch_size = 1000
    
    while True:
        try:
            # Fetch batch of records
            # We use select("*") to get all columns
            response = supabase.table("factories") \
                .select("*") \
                .range(offset, offset + batch_size - 1) \
                .execute()
            
            batch = response.data
            if not batch:
                break
                
            all_records.extend(batch)
            offset += batch_size
            print(f"  ... fetched {len(all_records)} records")
            
            # If we got fewer records than batch_size, we've reached the end
            if len(batch) < batch_size:
                break
                
        except Exception as e:
            print(f"❌ Error fetching batch at offset {offset}: {e}")
            break
    
    if not all_records:
        print("⚠️ No records found to export.")
        return

    print(f"✅ Successfully fetched {len(all_records)} records.")
    
    # Convert to DataFrame
    df = pd.DataFrame(all_records)
    
    # Define output path
    output_filename = "all_factories_export.csv"
    output_path = os.path.join(os.getcwd(), output_filename)
    
    # Export to CSV
    print(f"💾 Saving to {output_path}...")
    df.to_csv(output_path, index=False, encoding="utf-8-sig")
    
    print(f"✨ Export complete! File saved as: {output_filename}")

if __name__ == "__main__":
    export_all_to_csv()
