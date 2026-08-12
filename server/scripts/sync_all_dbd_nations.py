#!/usr/bin/env python3
"""
Bulk Sync Script for DBD Shareholder Nationality Breakdown (/nations)
Populates nationality summary for all company-type profiles using a shared token pool across 10 workers.
"""

import sys
import os
import time
import json
import ssl
import threading
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Add DBD-collector to path for DBDClient
sys.path.insert(0, "/Users/lighthouse-control/Desktop/DBD-collector")
from dbd_client import DBDClient

CACHE_FILE = Path(__file__).resolve().parent.parent / "data" / "dbd_nations_cache.json"
CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2MjAyNDU5LCJleHAiOjE5NDM4ODI0NTl9.4vgmv631EGJu9MIZHZSRWAkjXDofaG7gBlaFGtGH46s"
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


class SharedDBDClient:
    """Thread-safe DBD Client sharing a single session token across workers to prevent 403 refresh rate-limiting."""
    def __init__(self):
        self.lock = threading.Lock()
        self.client = None
        self._get_client()

    def _get_client(self):
        with self.lock:
            now = time.time()
            if self.client is None or now > (self.client.token_exp - 60):
                print("🔑 Refreshing shared DBD session token...", flush=True)
                for attempt in range(1, 6):
                    try:
                        self.client = DBDClient()
                        print("✅ Shared DBD token refreshed successfully!", flush=True)
                        break
                    except Exception as e:
                        print(f"⚠️ Token refresh attempt {attempt}/5 failed ({e}). Retrying in 15s...", flush=True)
                        time.sleep(15)
            return self.client

    def get_nations(self, jp_type: str, jp_no: str) -> list:
        client = self._get_client()
        path = f"/api/v1/company-profiles/nations/{jp_type}/{jp_no}"
        try:
            return client._request("GET", path)
        except Exception as exc:
            if "401" in str(exc) or "403" in str(exc):
                print(f"⚠️ Rate limited / token expired on JP {jp_no}, backing off 2s...", flush=True)
                time.sleep(2.0)
                with self.lock:
                    self.client = DBDClient()
                return self._get_client()._request("GET", path)
            raise exc


SHARED_DBD = SharedDBDClient()


def load_existing_cache() -> dict:
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print("Warning loading cache:", e, flush=True)
    return {}


def save_cache(cache: dict):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def fetch_all_companies():
    print("📦 Fetching company list from Supabase...", flush=True)
    companies = []
    offset = 0
    limit = 1000
    q = urllib.parse.quote("*บริษัท*")

    while True:
        url = f"https://lighthouse-sev01.tail83945e.ts.net/rest/v1/factory_dbd_profile?select=jp_no,jp_type_desc,jp_name,registered_province&jp_type_desc=ilike.{q}&offset={offset}&limit={limit}"
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, context=ctx) as resp:
            rows = json.loads(resp.read().decode())
            if not rows:
                break
            companies.extend(rows)
            if len(rows) < limit:
                break
            offset += limit

    print(f"✅ Found {len(companies)} matched company-type profiles in database.", flush=True)
    return companies


def fetch_nations_worker(company):
    jp_no = company["jp_no"]
    jp_type_desc = company.get("jp_type_desc") or ""
    jp_type = "5" if "บริษัทจำกัด" in jp_type_desc else "6" if "มหาชน" in jp_type_desc else "3"

    # Ultra-polite rate limit per worker (0.5s delay = ~6 req/s total across 3 workers)
    time.sleep(0.5)

    try:
        nations = SHARED_DBD.get_nations(jp_type, jp_no)
        owners = []
        for item in nations:
            code = item.get("ntCode")
            if not code or code == "WORLD2":
                continue
            country_name = (item.get("nationality") or {}).get("ntName") or (item.get("nationality") or {}).get("countryName") or code
            qty = item.get("shareQty") or 1
            pct = item.get("sharePctVol") or item.get("sharePctQty") or None
            amt = item.get("shareAmt") or None

            for i in range(qty):
                owners.append({
                    "name": f"ผู้ถือหุ้นสัญชาติ{country_name}",
                    "nationality": code,
                    "shareAmount": amt if i == 0 else None,
                    "sharePercent": pct if i == 0 else None,
                })

        return jp_no, owners, None
    except Exception as exc:
        return jp_no, [], str(exc)


def main():
    print("🚀 Starting Ultra-Polite Tier-2 Bulk Sync for DBD Shareholder Nationalities", flush=True)
    cache = load_existing_cache()
    print(f"📊 Loaded existing cache with {len(cache)} companies.", flush=True)

    companies = fetch_all_companies()
    pending = [c for c in companies if c["jp_no"] not in cache]
    print(f"🔄 Pending companies to sync: {len(pending)}", flush=True)

    if not pending:
        print("🎉 All companies are already synced and cached!", flush=True)
        return

    t0 = time.time()
    success_count = 0
    error_count = 0
    processed = 0

    # Use 3 parallel workers for continuous sustained crawling
    with ThreadPoolExecutor(max_workers=3) as executor:
        future_to_jp = {executor.submit(fetch_nations_worker, comp): comp for comp in pending}

        for future in as_completed(future_to_jp):
            jp_no, owners, err = future.result()
            processed += 1

            if err is None:
                cache[jp_no] = owners
                success_count += 1
            else:
                error_count += 1

            # Periodically save cache & print progress every 25 requests
            if processed % 25 == 0 or processed == len(pending):
                save_cache(cache)
                elapsed = time.time() - t0
                rps = processed / max(1, elapsed)
                eta_min = (len(pending) - processed) / max(1, rps) / 60
                total_cached = len(cache)
                print(f"Progress: [{processed}/{len(pending)}] ({processed/len(pending)*100:.1f}%) | Synced Total: {total_cached} | Speed: {rps:.1f} req/s | ETA: {eta_min:.1f} min", flush=True)

    save_cache(cache)
    total_time = time.time() - t0
    print(f"\n🎉 BULK SYNC COMPLETE in {total_time/60:.2f} minutes!", flush=True)
    print(f"Total Cached Companies in {CACHE_FILE.name}: {len(cache)}", flush=True)


if __name__ == "__main__":
    main()
