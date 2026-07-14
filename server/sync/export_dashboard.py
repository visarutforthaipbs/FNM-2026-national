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

import re
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
            print(f"  ⏳ statement timeout, retrying in {wait}s...")
            time.sleep(wait)

def parse_industry_code(reg_id):
    """DIW industry code (ลำดับที่ 1-107) from a registration number.
    Same logic as client/src/utils/hazard.ts — keep the two in sync."""
    if not reg_id:
        return None
    segments = reg_id.split("-")
    if len(segments) < 2:
        return None
    # Standard format: code in second segment, e.g. "จ3-52(3)-54/58ยล"
    m = re.match(r"^(\d{1,3})(?:\(\d+\))?$", segments[1])
    # Industrial-estate format: code in first segment, e.g. "น.10(1)-1/2548-ญนช."
    if not m:
        m = re.match(r"^[^\d]*(\d{1,3})(?:\(\d+\))?$", segments[0])
    if not m:
        return None
    code = int(m.group(1))
    return code if 1 <= code <= 107 else None

def export_dashboard_stats():
    print("📊 Fetching all active factories for dashboard stats...")
    
    # Keyset pagination (id > last, ordered by id). Unordered .range() paging
    # previously let Postgres return overlapping/missing rows across pages,
    # inflating the totals by ~57%.
    batch_size = 1000
    last_id = None

    total = 0
    high_risk_count = 0
    total_capital = 0.0
    total_workers = 0
    count_by_type = {}
    count_by_province = {}
    count_by_industry = {}  # DIW ลำดับที่ 1-107, parsed from the registration id

    while True:
        # Note: We omit .not_.is_("lat", "null") to include ALL active factories
        query = supabase.table("factories") \
            .select("id,factory_type,province,capital_investment,total_workers") \
            .eq("is_active", True) \
            .eq("status", "ดำเนินการ") \
            .order("id") \
            .limit(batch_size)
        if last_id is not None:
            query = query.gt("id", last_id)
        response = execute_with_retry(query)

        batch = response.data
        if not batch:
            break

        last_id = batch[-1]["id"]
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

            # Industry type counts (ลำดับที่)
            code = parse_industry_code(item.get("id") or "")
            key = str(code) if code is not None else "unknown"
            count_by_industry[key] = count_by_industry.get(key, 0) + 1
            
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
        "countByProvince": count_by_province,
        "countByIndustry": count_by_industry
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
