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
import html
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

    # Deed / land / survey / UTM number regexes, compiled once.
    # Grounded in the real DIW address corpus (all_factories_export.csv,
    # 13,767 deed-bearing rows) — see COLLECTORS.md §6 and the parse-diff below.
    #
    # The previous regexes had two defects, both visible in the corpus:
    #  1. `(เลขที่ดิน|ดินเลขที่)` matched the tail of "โฉนดที่**ดินเลขที่** <deed>",
    #     so `land_no` was set to the *deed* number in 8,283 of 13,767 rows
    #     (60%) where a deed was present — a silent corruption that would have
    #     fed garbage `parcel_no`/`land_no` joins downstream.
    #  2. The deed keyword alternation `(โฉนด|...|โฉนดที่ดิน)` plus a rigid
    #     `เลขที่?` meant several real spellings were missed: "โฉนดที่ดิน เลขที่",
    #     "โฉนดที่ ฉ.12233", "ฉ.40213" (bare ฉ.), space/'-'/comma-separated lists
    #     ("14420-14430, 43511-43512"), and HTML-encoded "'" separators.
    #
    # A "number" is a run of digits joined by `,` (with optional spaces), `-`
    # (range, e.g. 22816-9, 224856-224857) or `/` (e.g. 12778,1617/1864). The
    # optional `ฉ.` (โฉนด abbreviation) marker is discarded. A bare space then a
    # digit ("62074 62075") is a *list separator*, so the first number is kept.
    _NUM = r'(\d+(?:(?:\s*,\s*|/|\-)\d+)*)'

    _DEED_RE = re.compile(
        r'(?:โฉนดที่ดินเลขที่|โฉนดเลขที่|เลขที่โฉนด|โฉนดที่ดินแปลงที่|โฉนดที่ดิน|โฉนด)\s*'
        r'(?:เลขที่\s*|แปลงที่\s*|ที่\s*|[:：]\s*)?(?:ฉ\.\s*)?' + _NUM)
    # "เลขที่ดิน" only, and not preceded by a stray "ที่ดิน" (which would land us
    # on the tail of "โฉนดที่ดินเลขที่"). Also match a colon separator.
    _LAND_RE = re.compile(r'(?<![ที่]ดิน)เลขที่ดิน\s*[:：]?\s*' + _NUM)
    _SURVEY_RE = re.compile(r'หน้าสำรวจ\s*(?:\:\s*)?(\d+)')
    _UTM_RE = re.compile(
        r'ระวาง\s*(?:หมายเลข\s*|เลขที่\s*|ที่\s*)?'
        r'([A-Z0-9]+(?:\s+[IV]+)?(?:\s*\d+)?)')
    # Bare `ฉ.` deed with no โฉนด keyword, e.g. "ฉ.40213 เลขที่ดิน 49 ม.6".
    # Range/list support matches _NUM (comma, slash, hyphen), not comma-only.
    _BARE_CHOR_RE = re.compile(
        r'(?<!โฉนด)(?:^|[\s,()])ฉ\.\s*' + _NUM)

    def parse_deed_text(self, text: str) -> Dict[str, Optional[str]]:
        """Parses land title deed numbers, land numbers, survey numbers, and UTM map codes from text.

        Returns:
            {"deed_no", "land_no", "survey_no", "utm_map"} — each a string or None.
        """
        if not text:
            return {"deed_no": None, "land_no": None, "survey_no": None, "utm_map": None}

        # Normalise HTML entities (&#39; — an apostrophe used to separate deed
        # numbers, e.g. "นส.3 เลขที่ 380&#39;381&#39;38") and treat the
        # apostrophe as a list comma.
        t = html.unescape(text).replace("'", ",")

        # A digit run may be Thai numerals (๑๒๓๔๕) — DOL's API needs Arabic.
        _THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")

        def _digits(token: str) -> str:
            return (re.sub(r"\s+", "", token).strip(",./-")
                    .translate(_THAI_DIGITS))

        deed_no = None
        m = self._DEED_RE.search(t)
        if m:
            deed_no = _digits(m.group(1))

        land_no = None
        m = self._LAND_RE.search(t)
        if m:
            land_no = _digits(m.group(1))

        survey_no = None
        m = self._SURVEY_RE.search(t)
        if m:
            survey_no = _digits(m.group(1))

        utm_map = None
        m = self._UTM_RE.search(t)
        if m:
            utm_map = m.group(1).strip()

        # Fallback: a standalone ฉ.<number> is a deed number (ฉ. = โฉนด).
        if deed_no is None:
            m = self._BARE_CHOR_RE.search(t)
            if m:
                deed_no = _digits(m.group(1))

        return {
            "deed_no": deed_no,
            "land_no": land_no,
            "survey_no": survey_no,
            "utm_map": utm_map,
        }

    def resolve_pv_am_codes(self, province: str, district: str) -> Tuple[Optional[str], Optional[str]]:
        """Resolves Thai province and district names to DOL pvcode and amcode.

        In the DIW corpus the province/district columns are already clean (no
        อำเภอ/เขต/อ. prefixes, province spelled in full), so the strip is
        defensive only. One real edge exists: a handful of rows carry a *merged*
        district like "เสนา, ลาดบัวหลวง" — two districts joined by ", ". Only
        the first is usable against a single-parcel lookup, so we split and try
        each part in turn before giving up.
        """
        clean_pv = re.sub(r"^จังหวัด", "", province or "").strip()
        pv_code = self.province_map.get(clean_pv) or self.province_map.get(province)

        if not pv_code:
            return None, None

        # Try the district as a whole first, then each comma-part.
        candidates = [district] if district else []
        candidates += [p.strip() for p in re.split(r"[,/]", district or "") if p.strip()]

        for candidate in candidates:
            clean_am = re.sub(r"^(อำเภอ|เขต|อ\.)", "", candidate).strip()
            am_code = (self.amphur_map.get((pv_code, clean_am))
                       or self.amphur_map.get((pv_code, candidate)))
            if am_code:
                return pv_code, am_code

        return pv_code, None

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
