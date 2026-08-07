#!/usr/bin/env python3
"""
Tier 2 + 3 geocoding for factories without coordinates.
=======================================================
Tier 2 ("geocode"):  Longdo Map address geocoding (Thai-native address parsing).
                     A result is accepted ONLY if it falls inside the factory's
                     stated province polygon — a wrong pin is worse than none.
                     → coord_source='geocoded', coord_precision='street'
Tier 3 ("centroid"): tambon (ตำบล) centroid fallback from the open
                     thailand-geography-json gazetteer, ±2–5 km accuracy.
                     → coord_source='centroid', coord_precision='tambon'

Run Tier 1 (repair_coordinates.py) first — it's free and exact.

Usage:
    python geocode_missing.py --tier geocode              # dry run
    python geocode_missing.py --tier geocode --apply
    python geocode_missing.py --tier centroid --apply     # fallback for the rest
    python geocode_missing.py --tier both --apply

Env: LONGDO_API_KEY   (https://map.longdo.com/console — free tier available)

Every Longdo response is cached in geocode_cache.json, so re-runs after a
crash or a parsing fix cost no API quota. After --apply, refresh the PostGIS
geom column and re-run export_markers.py / export_dashboard.py.
"""
import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))

import requests
from shapely.geometry import Point, shape

from pipeline import supabase

CLIENT_DATA = os.path.join(os.path.dirname(__file__), "..", "..", "client", "public", "data")
CACHE_PATH = os.path.join(os.path.dirname(__file__), "geocode_cache.json")
# kongvut/thai-province-data — verified 2026-08: sub_districts.json carries
# lat/long centroids for 7,124 of 7,452 tambons, linked by district_id/province_id
GAZETTEER_DIR = os.path.join(os.path.dirname(__file__), "gazetteer")
GAZETTEER_BASE = "https://raw.githubusercontent.com/kongvut/thai-province-data/master/formats/json"
GAZETTEER_FILES = ("provinces.json", "districts.json", "sub_districts.json")

LONGDO_KEY = os.getenv("LONGDO_API_KEY")
LONGDO_URL = "https://search.longdo.com/addresslookup/api/addr/geocoding"
WORKERS = 6  # concurrent Longdo requests — back off if 429s appear in errors


# ── Shared helpers ─────────────────────────────────────────────────────────

def execute_with_retry(query, attempts=4):
    """Retry on Supabase statement timeouts (first page often hits a cold cache)."""
    for attempt in range(attempts):
        try:
            return query.execute()
        except Exception as e:  # noqa: BLE001
            if attempt == attempts - 1 or "57014" not in str(e):
                raise
            wait = 2 ** attempt
            print(f"  ⏳ statement timeout, retrying in {wait}s...")
            time.sleep(wait)


def load_province_polygons() -> dict:
    with open(os.path.join(CLIENT_DATA, "thailand-provinces.json"), encoding="utf-8") as f:
        geo = json.load(f)
    with open(os.path.join(CLIENT_DATA, "province-counts.json"), encoding="utf-8") as f:
        th_by_en = {p["name_en"]: p["name_th"] for p in json.load(f)}
    polygons = {}
    for feature in geo["features"]:
        name_th = th_by_en.get((feature.get("properties") or {}).get("NAME_1"))
        if name_th:
            polygons[name_th] = shape(feature["geometry"]).buffer(0.02)  # ~2 km tolerance
    return polygons


def fetch_missing(include_centroid: bool = False) -> list[dict]:
    """Operating factories without coordinates. With include_centroid, also
    returns tambon-centroid rows so later Tier-2 runs can upgrade them to
    street-level positions."""
    missing, last_id = [], None
    while True:
        q = (
            supabase.table("factories")
            .select("id,address_full,province,district,sub_district,coord_source")
            .eq("is_active", True)
            .eq("status", "ดำเนินการ")  # operating factories — what the map shows
            .order("id")
            .limit(1000)
        )
        if include_centroid:
            q = q.or_("lat.is.null,coord_source.eq.centroid")
        else:
            q = q.is_("lat", "null")
        if last_id is not None:
            q = q.gt("id", last_id)
        batch = execute_with_retry(q).data
        if not batch:
            break
        missing.extend(batch)
        last_id = batch[-1]["id"]
    label = "missing or centroid-approximate" if include_centroid else "still missing coordinates"
    print(f"🔍 {len(missing)} operating factories {label}")
    return missing


def apply_updates(rows: list[dict], source: str, precision: str, dry_run: bool):
    if dry_run:
        print(f"\nDry run — would set {len(rows)} factories to coord_source='{source}'. "
              "Re-run with --apply to write.")
        return
    print(f"\n✍️  Applying {len(rows)} updates (coord_source='{source}')...")
    for i, r in enumerate(rows):
        supabase.table("factories").update(
            {"lat": r["lat"], "lng": r["lng"], "coord_source": source, "coord_precision": precision}
        ).eq("id", r["id"]).execute()
        if (i + 1) % 200 == 0:
            print(f"   ... {i + 1}/{len(rows)}")
    print("✅ Done.")


# ── Tier 2: Longdo address geocoding ───────────────────────────────────────

def load_cache() -> dict:
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        # Drop cached failures (timeouts/429s) so they get retried
        stale = [k for k, v in cache.items() if isinstance(v, dict) and "_error" in v]
        for k in stale:
            del cache[k]
        if stale:
            print(f"♻️  Purged {len(stale)} cached error responses for retry")
        return cache
    return {}


def save_cache(cache: dict):
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def longdo_geocode(address: str, cache: dict, lock: threading.Lock, cache_only: bool) -> dict | None:
    """Geocode via Longdo; successful raw responses are cached so parsing
    fixes and re-runs cost no quota. Errors are NOT cached → retried.
    cache_only skips the API entirely (for applying results after the free
    daily quota — ~3k requests — is exhausted)."""
    with lock:
        if address in cache:
            return cache[address]
    if cache_only:
        return None
    try:
        res = requests.get(
            LONGDO_URL, params={"text": address, "key": LONGDO_KEY}, timeout=20
        )
        raw = res.json() if res.ok else {"_error": res.status_code}
    except Exception as e:  # noqa: BLE001
        raw = {"_error": str(e)}
    if "_error" not in raw:
        with lock:
            cache[address] = raw
    time.sleep(0.1)  # per-worker pacing
    return raw


def extract_point(raw: dict) -> tuple[float, float] | None:
    """Pull (lat, lng) out of a Longdo addresslookup response.

    Verified shape (2026-08): {"data": [{"confidence": 1, "location": {...},
    "point": [{"lon": ..., "lat": ...}]}]} — point is a LIST of coordinates.
    Candidates are tried best-confidence first; older dict shapes tolerated.
    """
    if not isinstance(raw, dict) or "_error" in raw:
        return None
    candidates = raw.get("data") or raw.get("result") or []
    if isinstance(candidates, dict):
        candidates = [candidates]
    candidates = sorted(
        (c for c in candidates if isinstance(c, dict)),
        key=lambda c: c.get("confidence") or 0,
        reverse=True,
    )
    for c in candidates:
        point = c.get("point")
        if isinstance(point, list) and point:
            point = point[0]
        if isinstance(point, dict) and "lat" in point and ("lon" in point or "lng" in point):
            return float(point["lat"]), float(point.get("lon") or point.get("lng"))
        if "lat" in c and ("lon" in c or "lng" in c):
            return float(c["lat"]), float(c.get("lon") or c.get("lng"))
    return None


def compose_address(factory: dict) -> str:
    """address_full holds only the street part — append tambon/district/province
    or Longdo matches the street name anywhere in Thailand (แขวง/เขต for BKK)."""
    province = (factory.get("province") or "").strip()
    is_bkk = province == "กรุงเทพมหานคร"
    parts = [(factory.get("address_full") or "").strip()]
    if factory.get("sub_district"):
        parts.append(("แขวง" if is_bkk else "ต.") + factory["sub_district"].strip())
    if factory.get("district"):
        parts.append(("เขต" if is_bkk else "อ.") + factory["district"].strip())
    if province:
        parts.append(province if is_bkk else "จ." + province)
    return " ".join(p for p in parts if p)


def tier_geocode(missing: list[dict], polygons: dict, limit: int, dry_run: bool, cache_only: bool = False):
    if not LONGDO_KEY:
        print("❌ LONGDO_API_KEY not set — skipping Tier 2. Get a key at map.longdo.com/console")
        return
    cache = load_cache()
    accepted, rejected_outside, no_result, errors = [], 0, 0, 0
    todo = [m for m in missing if (m.get("address_full") or "").strip()][:limit]
    mode = "cache only, no API calls" if cache_only else f"{WORKERS} workers"
    print(f"🌐 Geocoding {len(todo)} addresses via Longdo, {mode} (cached: {len(cache)})")

    lock = threading.Lock()
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {
            pool.submit(longdo_geocode, compose_address(f), cache, lock, cache_only): f
            for f in todo
        }
        for future in as_completed(futures):
            factory = futures[future]
            raw = future.result()
            done += 1
            if done % 500 == 0:
                with lock:
                    save_cache(cache)
                print(f"   ... {done}/{len(todo)} ({len(accepted)} accepted)", flush=True)

            if raw is None:  # cache_only miss — untouched, retry another day
                no_result += 1
                continue
            if isinstance(raw, dict) and "_error" in raw:
                errors += 1
                continue
            point = extract_point(raw)
            if point is None:
                no_result += 1
                continue
            lat, lng = point
            polygon = polygons.get((factory.get("province") or "").strip())
            if polygon is None or not polygon.contains(Point(lng, lat)):
                rejected_outside += 1  # wrong province → discard, don't guess
                continue
            accepted.append({"id": factory["id"], "lat": lat, "lng": lng})

    save_cache(cache)
    if errors:
        print(f"   ⚠️ {errors} request errors (not cached — a re-run retries them)")
    print("\n📊 Tier 2 (Longdo) results")
    print(f"   accepted (inside stated province): {len(accepted)}")
    print(f"   rejected (outside province):       {rejected_outside}")
    print(f"   no geocoder result:                {no_result}")
    apply_updates(accepted, "geocoded", "street", dry_run)


# ── Tier 3: tambon centroid fallback ───────────────────────────────────────

PREFIXES = re.compile(r"^(ต\.|อ\.|ตำบล|อำเภอ|แขวง|เขต|เมือง)\s*")


def norm(name: str) -> str:
    return PREFIXES.sub("", (name or "").strip().replace(" ", ""))


def load_gazetteer() -> dict:
    """(province, district, subdistrict) → (lat, lng), normalized Thai names."""
    os.makedirs(GAZETTEER_DIR, exist_ok=True)
    data = {}
    for filename in GAZETTEER_FILES:
        path = os.path.join(GAZETTEER_DIR, filename)
        if not os.path.exists(path):
            url = f"{GAZETTEER_BASE}/{filename}"
            print(f"📥 Downloading {url}")
            res = requests.get(url, timeout=60)
            res.raise_for_status()
            with open(path, "w", encoding="utf-8") as f:
                f.write(res.text)
        with open(path, encoding="utf-8") as f:
            data[filename] = json.load(f)

    provinces = {p["id"]: norm(p["name_th"]) for p in data["provinces.json"]}
    districts = {
        d["id"]: (provinces.get(d["province_id"], ""), norm(d["name_th"]))
        for d in data["districts.json"]
    }

    lookup = {}
    for row in data["sub_districts.json"]:
        lat, lng = row.get("lat"), row.get("long")
        if lat is None or lng is None:
            continue
        prov, dist = districts.get(row["district_id"], ("", ""))
        lookup.setdefault((prov, dist, norm(row["name_th"])), (float(lat), float(lng)))
    print(f"🗺️  Gazetteer: {len(lookup)} tambon centroids with coordinates")
    return lookup


def tier_centroid(missing: list[dict], polygons: dict, limit: int, dry_run: bool):
    gazetteer = load_gazetteer()
    accepted, no_match = [], 0

    for factory in missing[:limit]:
        key = (
            norm(factory.get("province")),
            norm(factory.get("district")),
            norm(factory.get("sub_district")),
        )
        point = gazetteer.get(key)
        if point is None:
            no_match += 1
            continue
        lat, lng = point
        polygon = polygons.get((factory.get("province") or "").strip())
        if polygon is not None and not polygon.contains(Point(lng, lat)):
            no_match += 1  # gazetteer/name mismatch — skip rather than mislead
            continue
        accepted.append({"id": factory["id"], "lat": lat, "lng": lng})

    print("\n📊 Tier 3 (tambon centroid) results")
    print(f"   matched to a tambon centroid: {len(accepted)}")
    print(f"   no gazetteer match:           {no_match}")
    apply_updates(accepted, "centroid", "tambon", dry_run)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=["geocode", "centroid", "both"], required=True)
    parser.add_argument("--apply", action="store_true", help="write results to Supabase")
    parser.add_argument("--cache-only", action="store_true",
                        help="Tier 2: use cached responses only, no API calls (quota exhausted)")
    parser.add_argument("--limit", type=int, default=100000)
    args = parser.parse_args()

    polygons = load_province_polygons()
    # Tier-2 runs also target centroid rows so street-level results upgrade them
    missing = fetch_missing(include_centroid=args.tier in ("geocode", "both"))

    if args.tier in ("geocode", "both"):
        tier_geocode(missing, polygons, args.limit, dry_run=not args.apply,
                     cache_only=args.cache_only)
    if args.tier in ("centroid", "both"):
        # Re-fetch when both ran with --apply, so Tier 3 only fills what Tier 2 left
        if args.tier == "both" and args.apply:
            missing = fetch_missing()
        tier_centroid(missing, polygons, args.limit, dry_run=not args.apply)

    if args.apply:
        print("\nNext steps:")
        print("   UPDATE factories SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)")
        print("   WHERE lat IS NOT NULL AND geom IS NULL;")
        print("   python export_markers.py && python export_dashboard.py")


if __name__ == "__main__":
    main()
