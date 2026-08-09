#!/usr/bin/env python3
"""
DBD DataWarehouse API Client
Reverse-engineered client for datawarehouse.dbd.go.th internal API.

The API uses:
  1. POST /api/refresh -> JWT with encKey claim (ANONYMOUS provider, ~15min expiry)
  2. Cookies set by /api/refresh (__Host-bdw_session etc.)
  3. All data endpoints return AES-GCM-256 encrypted payloads:
     - key = HKDF-SHA256(ikm=encKey, salt=body.salt, info="bdw|v{kid}|{path}", 32 bytes)
     - decrypt(iv=body.iv, ct=body.ct, aad=info)
     - plaintext is gzip-compressed JSON
"""

import json
import base64
import gzip
import zlib
import time
from typing import Optional

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes


class DBDClient:
    BASE = "https://datawarehouse.dbd.go.th"

    # requests waits forever by default. Without this the crawler does not
    # crash when a connection goes unanswered — it hangs, which is worse:
    # systemd still reports the service active while every worker thread sits
    # blocked on a socket. That cost 5h24m of silent nothing on 2026-08-09.
    # (connect timeout, read timeout)
    REQUEST_TIMEOUT = (10, 30)
    UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": self.UA,
            "Accept": "application/json",
            "Origin": self.BASE,
            "Referer": f"{self.BASE}/",
        })
        self.token: Optional[str] = None
        self.enc_key: Optional[bytes] = None
        self.token_exp: float = 0
        self._refresh_token()

    @staticmethod
    def _b64d(s: str) -> bytes:
        s += '=' * (-len(s) % 4)
        return base64.urlsafe_b64decode(s)

    def _refresh_token(self):
        r = self.session.post(f"{self.BASE}/api/refresh", timeout=self.REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        self.token = data["idToken"]
        payload = json.loads(self._b64d(self.token.split('.')[1]))
        self.enc_key = self._b64d(payload["encKey"])
        self.token_exp = payload.get("exp", 0)
        self.session.headers["Authorization"] = f"Bearer {self.token}"

    def _ensure_token(self):
        if time.time() > self.token_exp - 30:
            self._refresh_token()

    def _decrypt(self, obj: dict, path: str) -> bytes:
        salt = self._b64d(obj["salt"])
        iv = self._b64d(obj["iv"])
        ct = self._b64d(obj["ct"])
        kid = obj["kid"]
        info = f"bdw|v{kid}|{path}".encode()
        hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info)
        key = hkdf.derive(self.enc_key)
        pt = AESGCM(key).decrypt(iv, ct, info)
        if pt[:2] == b'\x1f\x8b':
            return gzip.decompress(pt)
        try:
            return zlib.decompress(pt, -15)
        except zlib.error:
            return pt

    def _request(self, method: str, path: str, **kwargs) -> dict:
        self._ensure_token()
        kwargs.setdefault("timeout", self.REQUEST_TIMEOUT)
        r = self.session.request(method, f"{self.BASE}{path}", **kwargs)
        r.raise_for_status()
        obj = r.json()
        if "ct" in obj:
            pt = self._decrypt(obj, path)
            return json.loads(pt)
        return obj

    # === Search ===
    def search(self, keyword: str, sort_by: str = "jpName", page: int = 1,
               search_type: str = "", filters: Optional[dict] = None) -> dict:
        body = {"keyword": keyword, "type": search_type, "sortBy": sort_by, "currentPage": page}
        if filters:
            body.update(filters)
        return self._request("POST", "/api/v1/company-profiles/infos", json=body)

    # === Company profile ===
    def get_profile(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/info/{jp_type}/{jp_no}")

    def get_committees(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/committees/{jp_type}/{jp_no}")

    def get_sign_committees(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/committee-signs/{jp_type}/{jp_no}")

    def get_descriptions(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/descriptions/{jp_type}/{jp_no}")

    def get_partners(self, jp_type: str, jp_no: str) -> dict:
        """Shareholders / partners list."""
        return self._request("GET", f"/api/v1/company-profiles/partners/{jp_type}/{jp_no}")

    def get_mergers(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/mergers/{jp_type}/{jp_no}")

    def get_liquidators(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/liquidators/{jp_type}/{jp_no}")

    def get_name_history(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/names/{jp_type}/{jp_no}")

    def get_capital_history(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/capitals/{jp_type}/{jp_no}")

    def get_nations(self, jp_type: str, jp_no: str) -> dict:
        return self._request("GET", f"/api/v1/company-profiles/nations/{jp_type}/{jp_no}")

    # === Commons ===
    def get_params(self) -> list:
        return self._request("GET", "/api/v1/commons/params")


if __name__ == "__main__":
    import sys
    dbd = DBDClient()

    if len(sys.argv) > 1:
        keyword = sys.argv[1]
    else:
        keyword = "SCB"

    print(f"=== Searching: {keyword} ===")
    results = dbd.search(keyword)
    contents = results.get("contents", [])
    meta = results.get("meta", {})
    print(f"Total: {meta.get('totalItems')} | Pages: {meta.get('totalPages')}\n")

    for c in contents[:5]:
        print(f"  {c['jpName']} ({c.get('jpNameE','')})")
        print(f"    jpNo={c['jpNo']} jpTypeCode={c['jpTypeCode']} status={c['jpStatus']['jpStatDescE']}")
        print(f"    capital={c.get('capAmt')} province={c['locationProvince']['pvDescE']}")
        print()

    if contents:
        first = contents[0]
        print(f"=== Profile: {first['jpName']} ===")
        profile = dbd.get_profile(first["jpTypeCode"], first["jpNo"])
        print(json.dumps({k: v for k, v in profile.items() if not isinstance(v, dict)},
                         ensure_ascii=False, indent=2)[:2000])