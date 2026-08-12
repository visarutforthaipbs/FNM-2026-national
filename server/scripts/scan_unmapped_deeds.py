import csv
import re

def scan_file(fpath):
    print(f"\n--- Scanning {fpath} ---")
    matched = []
    total = 0
    with open(fpath, mode="r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total += 1
            addr = row.get("address_full", "") or ""
            name = row.get("name", "") or ""
            text = f"{name} {addr}"

            # Check for land title deed terms: โฉนด, เลขที่ดิน, หน้าสำรวจ, ระวาง, น.ส.3
            deed_match = re.search(r'(โฉนด|เลขที่โฉนด|โฉนดที่ดิน)\s*เลขที่?\s*(\d+[\d/|-]*)', text)
            land_match = re.search(r'(เลขที่ดิน|ดินเลขที่)\s*(\d+[\d/|-]*)', text)
            utm_match = re.search(r'(ระวาง|เลขระวาง)\s*([\d\sI-V/-]+)', text)
            survey_match = re.search(r'(หน้าสำรวจ)\s*(\d+)', text)

            if deed_match or land_match or utm_match or survey_match:
                matched.append({
                    "id": row.get("id") or row.get("registration_display"),
                    "name": name.strip(),
                    "address": addr.strip(),
                    "deed_no": deed_match.group(2) if deed_match else None,
                    "land_no": land_match.group(2) if land_match else None,
                    "utm_map": utm_match.group(2).strip() if utm_match else None,
                    "survey_no": survey_match.group(2) if survey_match else None,
                    "province": row.get("province", ""),
                    "district": row.get("district", "")
                })

    print(f"Total records in {fpath}: {total:,}")
    print(f"Matches with Land Title Deed patterns: {len(matched):,}")
    return matched

if __name__ == "__main__":
    m1 = scan_file("missing_coordinates.csv")
    m2 = scan_file("all_factories_export.csv")

    print("\n=== SAMPLE MATCHED LAND TITLE DEED RECORDS ===")
    for idx, item in enumerate((m1 + m2)[:20]):
        print(f"\n[{idx+1}] ID: {item['id']} | Name: {item['name'] or '(NO NAME)'}")
        print(f"     Province: {item['province']} | District: {item['district']}")
        print(f"     Deed No: {item['deed_no']} | Land No: {item['land_no']} | UTM: {item['utm_map']} | Survey: {item['survey_no']}")
        print(f"     Address: {item['address'][:120]}")
