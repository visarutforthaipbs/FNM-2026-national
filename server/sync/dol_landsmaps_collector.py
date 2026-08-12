"""
DOL LandsMaps Land Title Deed Geocoder & Collector
Department of Lands (กรมที่ดิน) - landsmaps.dol.go.th

Extracts title deed parameters (เลขที่โฉนด, เลขที่ดิน, หน้าสำรวจ, ระวาง) from unmapped factory addresses
and resolves exact WGS84 GPS latitude & longitude coordinates using DOL API/GeoServer.
"""

import sys
import os
import json
import re
import time
import argparse
import urllib.request
import ssl
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

class DOLLandsMapsCollector:
    def __init__(self, data_dir: str = "server/data"):
        self.data_dir = Path(data_dir)
        self.province_file = self.data_dir / "dol_province.json"
        self.amphur_file = self.data_dir / "dol_amphur.json"
        self.cookies_file = Path("server/sync/landsmaps_cookies.json")

        self.province_map: Dict[str, str] = {}
        self.amphur_map: Dict[Tuple[str, str], str] = {}
        self.jwt_token: Optional[str] = None
        self.cookies_str: str = ""

        self._load_administrative_mappings()
        self._load_session_cookies()

    def _load_administrative_mappings(self):
        """Loads province and amphoe code mappings from local JSON files."""
        if self.province_file.exists():
            with open(self.province_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                result = data.get("result", []) if isinstance(data, dict) else data
                for item in result:
                    name = item.get("pvnamethai", "").strip()
                    code = item.get("pvcode", "").strip()
                    if name and code:
                        # Clean prefix "จังหวัด"
                        clean_name = re.sub(r"^จังหวัด", "", name).strip()
                        self.province_map[clean_name] = code
                        self.province_map[name] = code

        if self.amphur_file.exists():
            with open(self.amphur_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                result = data.get("result", []) if isinstance(data, dict) else data
                for item in result:
                    pv_code = item.get("pvcode", "").strip()
                    am_name = item.get("amnamethai", "").strip()
                    am_code = item.get("amcode", "").strip()
                    if pv_code and am_name and am_code:
                        clean_am = re.sub(r"^(อำเภอ|เขต)", "", am_name).strip()
                        self.amphur_map[(pv_code, clean_am)] = am_code
                        self.amphur_map[(pv_code, am_name)] = am_code

    def _load_session_cookies(self):
        """Loads WAF session cookies if available."""
        if self.cookies_file.exists():
            try:
                with open(self.cookies_file, "r", encoding="utf-8") as f:
                    cookies = json.load(f)
                    self.cookies_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
            except Exception as e:
                print(f"Warning: Failed to load cookies file: {e}")

    def parse_deed_text(self, text: str) -> Dict[str, Optional[str]]:
        """Parses land title deed numbers, land numbers, survey numbers, and UTM map codes from text."""
        if not text:
            return {"deed_no": None, "land_no": None, "survey_no": None, "utm_map": None}

        # 1. Deed Number (เลขที่โฉนด)
        deed_match = re.search(r'(โฉนด|เลขที่โฉนด|โฉนดที่ดิน)\s*เลขที่?\s*(\d+[\d/|-]*)', text)
        # 2. Land Number (เลขที่ดิน)
        land_match = re.search(r'(เลขที่ดิน|ดินเลขที่)\s*(\d+[\d/|-]*)', text)
        # 3. Survey Number (หน้าสำรวจ)
        survey_match = re.search(r'(หน้าสำรวจ)\s*(\d+)', text)
        # 4. UTM Map Sheet (ระวาง)
        utm_match = re.search(r'(ระวาง|เลขระวาง)\s*([\d\sI-V/-]+)', text)

        return {
            "deed_no": deed_match.group(2) if deed_match else None,
            "land_no": land_match.group(2) if land_match else None,
            "survey_no": survey_match.group(2) if survey_match else None,
            "utm_map": utm_match.group(2).strip() if utm_match else None
        }

    def resolve_pv_am_codes(self, province: str, district: str) -> Tuple[Optional[str], Optional[str]]:
        """Resolves Thai province and district names to DOL pvcode and amcode."""
        clean_pv = re.sub(r"^จังหวัด", "", province or "").strip()
        pv_code = self.province_map.get(clean_pv) or self.province_map.get(province)

        if not pv_code:
            return None, None

        clean_am = re.sub(r"^(อำเภอ|เขต)", "", district or "").strip()
        am_code = self.amphur_map.get((pv_code, clean_am)) or self.amphur_map.get((pv_code, district))

        return pv_code, am_code

    def query_parcel(self, pvcode: str, amcode: str, parcel_no: str) -> Optional[Dict]:
        """Queries DOL LandsMaps API for parcel location details."""
        url = "https://landsmaps.dol.go.th/apiService/LandsMaps/GetParcelByParcelNo/"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Cookie": self.cookies_str,
            "Referer": "https://landsmaps.dol.go.th/",
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json, text/plain, */*"
        }

        if self.jwt_token:
            headers["Authorization"] = f"Bearer {self.jwt_token}"

        payload = {
            "pvcode": str(pvcode),
            "amcode": str(amcode),
            "parcel_no": str(parcel_no)
        }

        try:
            body_bytes = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")
            with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
                resp_json = json.loads(res.read().decode("utf-8"))
                if resp_json.get("status") == 200 and resp_json.get("result"):
                    return resp_json["result"]
        except Exception as e:
            # Silent fallback / log error
            pass

        return None


if __name__ == "__main__":
    collector = DOLLandsMapsCollector()
    print("DOL LandsMaps Collector Initialized.")
    print(f"Loaded {len(collector.province_map)} provinces and {len(collector.amphur_map)} districts.")

    # Sample test text parsing
    sample_text = "โฉนดที่ดินเลขที่ 5419 เลขที่ดิน 130 ม.2 ต.ห้วยน้ำขาว"
    parsed = collector.parse_deed_text(sample_text)
    print("\nParsed Sample Deed Info:", parsed)

    pv, am = collector.resolve_pv_am_codes("ร้อยเอ็ด", "เสลภูมิ")
    print(f"Resolved Codes for ร้อยเอ็ด / เสลภูมิ: pvcode={pv}, amcode={am}")
