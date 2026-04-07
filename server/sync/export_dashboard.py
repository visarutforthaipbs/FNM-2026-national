"""
Export dashboard statistics to a static JSON file.
This includes ALL active factories, even those missing lat/lng coordinates.
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

def export_dashboard_stats():
    print("📊 Fetching all active factories for dashboard stats...")
    
    # Paginate through all records
    offset = 0
    batch_size = 1000
    
    total = 0
    high_risk_count = 0
    total_capital = 0.0
    total_workers = 0
    count_by_type = {}
    count_by_province = {}
    
    while True:
        # Note: We omit .not_.is_("lat", "null") to include ALL active factories
        response = supabase.table("factories") \
            .select("factory_type,province,capital_investment,total_workers") \
            .eq("is_active", True) \
            .eq("status", "ดำเนินการ") \
            .range(offset, offset + batch_size - 1) \
            .execute()
        
        batch = response.data
        if not batch:
            break
            
        total += len(batch)
        
        for item in batch:
            f_type = item.get("factory_type") or "-"
            f_prov = item.get("province") or "ไม่ระบุ"
            
            # Type counts
            count_by_type[f_type] = count_by_type.get(f_type, 0) + 1
            if f_type == "3":
                high_risk_count += 1
                
            # Province counts
            count_by_province[f_prov] = count_by_province.get(f_prov, 0) + 1
            
            # Capital and Workers
            try:
                cap = item.get("capital_investment")
                if cap:
                    total_capital += float(cap)
            except (ValueError, TypeError):
                pass
                
            try:
                workers = item.get("total_workers")
                if workers:
                    total_workers += int(workers)
            except (ValueError, TypeError):
                pass
            
        offset += batch_size
        print(f"  ... processed {total} so far")
    
    print(f"✅ Total Active Factories (incl. no coords): {total}")
    print(f"💰 Total Capital: {total_capital}")
    print(f"👷 Total Workers: {total_workers}")
    
    stats = {
        "total": total,
        "highRiskCount": high_risk_count,
        "totalCapital": total_capital,
        "totalWorkers": total_workers,
        "countByType": count_by_type,
        "countByProvince": count_by_province
    }
    
    # Write to client/public
    output_dir = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")
    os.makedirs(output_dir, exist_ok=True)
    
    output_path = os.path.join(output_dir, "dashboard_stats.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    
    print(f"💾 Saved dashboard stats to {output_path}")

if __name__ == "__main__":
    export_dashboard_stats()
