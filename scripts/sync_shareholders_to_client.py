#!/usr/bin/env python3
"""
Sync extracted DBD shareholder registry data from high_risk_shareholders.jsonl
into client-ready JSON artifacts in client/public/data/dbd/
"""

import os
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENT_DBD_DIR = REPO_ROOT / "client" / "public" / "data" / "dbd"
SHAREHOLDERS_DIR = CLIENT_DBD_DIR / "shareholders"
SOURCE_JSONL = Path("/Users/lighthouse-control/Documents/Personal-Project/DBD-collector/high_risk_shareholders.jsonl")

NAT_CODE_MAP = {
    "ไทย": "TH",
    "จีน": "CN",
    "ญี่ปุ่น": "JP",
    "สาธารณรัฐจีน(ไต้หวัน)": "TW",
    "ไต้หวัน": "TW",
    "ฮ่องกง": "HK",
    "เกาหลีใต้": "KR",
    "สิงคโปร์": "SG",
    "มาเลเซีย": "MY",
    "อินโดนีเซีย": "ID",
    "ฟิลิปปินส์": "PH",
    "เวียดนาม": "VN",
    "ลาว": "LA",
    "กัมพูชา": "KH",
    "พม่า": "MM",
    "เมียนมา": "MM",
    "อินเดีย": "IN",
    "อเมริกัน": "US",
    "สหรัฐอเมริกา": "US",
    "อังกฤษ": "GB",
    "สหราชอาณาจักร": "GB",
    "เยอรมัน": "DE",
    "เยอรมนี": "DE",
    "ฝรั่งเศส": "FR",
    "เนเธอร์แลนด์": "NL",
    "สวิส": "CH",
    "สวิตเซอร์แลนด์": "CH",
    "อิตาลี": "IT",
    "สเปน": "ES",
    "สวีเดน": "SE",
    "เดนมาร์ก": "DK",
    "นอร์เวย์": "NO",
    "เบลเยียม": "BE",
    "ออสเตรีย": "AT",
    "รัสเซีย": "RU",
    "ออสเตรเลีย": "AU",
    "นิวซีแลนด์": "NZ",
    "แคนาดา": "CA",
    "สหรัฐอาหรับเอมิเรตส์": "AE",
    "อิสราเอล": "IL",
    "ตุรกี": "TR",
    "บราซิล": "BR",
    "แอฟริกาใต้": "ZA",
    "หมู่เกาะเคย์แมน": "KY",
    "เคย์แมน": "KY",
    "บริติชเวอร์จิน": "VG",
    "เบอร์มิวดา": "BM",
    "ไซปรัส": "CY",
    "บาฮามาส": "BS",
    "ปานามา": "PA",
    "ซามัว": "WS",
    "เซเชลส์": "SC",
    "ประเทศอื่น": "OT",
}

OFFSHORE_CODES = {"KY", "VG", "BM", "CY", "BS", "PA", "WS", "SC"}

CORPORATE_PREFIXES = [
    "บริษัท", "บจ.", "บมจ.", "หจก.", "ห้างหุ้นส่วน",
    "Holding", "Holdings", "Corp", "Corporation", "Ltd", "Limited",
    "LLC", "Inc", "Co.,", "Co.", "GmbH", "การเคหะแห่งชาติ", "กองทุน"
]

def is_corporate(name: str) -> bool:
    name_clean = name.strip()
    return any(p in name_clean for p in CORPORATE_PREFIXES)

def main():
    SHAREHOLDERS_DIR.mkdir(parents=True, exist_ok=True)
    if not SOURCE_JSONL.exists():
        print(f"Error: Source file {SOURCE_JSONL} does not exist.")
        return

    # Read latest records (de-duplicate by registration_no, keeping latest success)
    companies = {}
    with open(SOURCE_JSONL, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
                if rec.get("success"):
                    companies[rec["registration_no"]] = rec
            except Exception:
                pass

    print(f"Found {len(companies)} successful shareholder records in {SOURCE_JSONL}")

    index_summary = {}

    for reg, rec in companies.items():
        total_shares = rec.get("total_shares", 0)
        raw_holders = rec.get("holders", [])
        
        parsed_holders = []
        nat_agg = {}
        foreign_shares = 0
        has_offshore = False
        offshore_entities = []

        for h in raw_holders:
            name = h.get("name", "").strip()
            shares = h.get("shares", 0)
            nat_str = h.get("nationality", "").strip()
            nat_code = NAT_CODE_MAP.get(nat_str, "OT")
            
            percent = (shares / total_shares * 100.0) if total_shares > 0 else None
            is_corp = is_corporate(name)
            
            if nat_code != "TH":
                foreign_shares += shares
            if nat_code in OFFSHORE_CODES or "เคย์แมน" in name or "Cayman" in name:
                has_offshore = True
                offshore_entities.append(f"{name} ({nat_str})")

            nat_agg[nat_code] = nat_agg.get(nat_code, 0) + shares

            parsed_holders.append({
                "order": h.get("order", 0),
                "name": name,
                "shares": shares,
                "sharePercent": round(percent, 2) if percent is not None else None,
                "nationality": nat_str,
                "nationalityCode": nat_code,
                "isCorporate": is_corp,
            })

        foreign_percent = (foreign_shares / total_shares * 100.0) if total_shares > 0 else 0.0

        payload = {
            "registrationNo": reg,
            "companyName": rec.get("company_name", ""),
            "totalShares": total_shares,
            "shareValue": rec.get("share_value", 0.0),
            "holderCount": len(parsed_holders),
            "foreignPercent": round(foreign_percent, 2),
            "hasOffshore": has_offshore,
            "offshoreEntities": offshore_entities,
            "holders": parsed_holders,
            "fetchedAt": rec.get("fetched_at", ""),
        }

        out_file = SHAREHOLDERS_DIR / f"{reg}.json"
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        top_holder = parsed_holders[0] if parsed_holders else None
        index_summary[reg] = {
            "companyName": rec.get("company_name", ""),
            "totalShares": total_shares,
            "holderCount": len(parsed_holders),
            "foreignPercent": round(foreign_percent, 2),
            "hasOffshore": has_offshore,
            "topHolder": {
                "name": top_holder["name"],
                "percent": top_holder["sharePercent"],
                "nat": top_holder["nationalityCode"],
                "isCorp": top_holder["isCorporate"],
            } if top_holder else None
        }

    index_path = CLIENT_DBD_DIR / "shareholders_index.json"
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index_summary, f, ensure_ascii=False)
    print(f"Wrote {len(index_summary)} companies to {index_path}")

    juristic_to_factory = {}
    for f in CLIENT_DBD_DIR.glob("*.json"):
        if f.name.endswith(".detail.json") or f.name.startswith("shareholders"):
            continue
        prov_slug = f.stem
        try:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
                for fac_id, prof in data.items():
                    j = prof.get("j")
                    if j in companies:
                        if j not in juristic_to_factory:
                            juristic_to_factory[j] = []
                        juristic_to_factory[j].append((prov_slug, fac_id))
        except Exception:
            pass

    updated_provinces = set()
    for j, links in juristic_to_factory.items():
        summary = index_summary.get(j)
        if not summary:
            continue
        company_data = json.loads((SHAREHOLDERS_DIR / f"{j}.json").read_text(encoding="utf-8"))

        for prov_slug, fac_id in links:
            prov_json_path = CLIENT_DBD_DIR / f"{prov_slug}.json"
            if prov_json_path.exists():
                with open(prov_json_path, "r", encoding="utf-8") as fh:
                    prov_data = json.load(fh)
                if fac_id in prov_data:
                    nat_shares = {}
                    tot = company_data["totalShares"]
                    for h in company_data["holders"]:
                        c = h["nationalityCode"]
                        nat_shares[c] = nat_shares.get(c, 0) + h["shares"]
                    
                    nat_list = []
                    for c, sh in sorted(nat_shares.items(), key=lambda x: -x[1]):
                        p = round(sh / tot * 100.0, 2) if tot > 0 else 0
                        nat_list.append({"c": c, "p": p})
                    
                    prov_data[fac_id]["nat"] = nat_list
                    prov_data[fac_id]["hd"] = 1
                    prov_data[fac_id]["shc"] = 1
                    with open(prov_json_path, "w", encoding="utf-8") as fh:
                        json.dump(prov_data, fh, ensure_ascii=False)
                    updated_provinces.add(prov_slug)

            detail_json_path = CLIENT_DBD_DIR / f"{prov_slug}.detail.json"
            detail_data = {}
            if detail_json_path.exists():
                try:
                    with open(detail_json_path, "r", encoding="utf-8") as fh:
                        detail_data = json.load(fh)
                except Exception:
                    detail_data = {}
            
            if fac_id not in detail_data:
                detail_data[fac_id] = {}

            detail_data[fac_id]["o"] = [
                {
                    "n": h["name"],
                    "c": h["nationality"],
                    "p": h["sharePercent"],
                    "a": h["shares"],
                }
                for h in company_data["holders"]
            ]
            detail_data[fac_id]["sh"] = {
                "tot": company_data["totalShares"],
                "val": company_data["shareValue"],
                "for_pct": company_data["foreignPercent"],
                "offshore": company_data["hasOffshore"],
                "offshore_list": company_data["offshoreEntities"],
            }
            with open(detail_json_path, "w", encoding="utf-8") as fh:
                json.dump(detail_data, fh, ensure_ascii=False)

    print(f"Updated detail records across {len(updated_provinces)} provinces.")

if __name__ == "__main__":
    main()
