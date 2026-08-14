#!/usr/bin/env python3
"""
Tier 1.5 + 2 + 3 geocoding for factories without coordinates.
=============================================================
Tier 1.5 ("sibling"): inherit the exact position of another licence at the SAME
                     address. One plant often holds several ทะเบียนโรงงาน; when
                     only one carries a government coordinate the others used to
                     fall through to Longdo or the tambon centroid and land far
                     from their own address twin. Free, no API quota, and more
                     accurate than either fallback — so it runs first.
                     → coord_source='sibling', coord_precision='exact'
Tier 2 ("geocode"):  Longdo Map address geocoding (Thai-native address parsing).
                     A result is accepted ONLY if it falls inside the factory's
                     stated province polygon — a wrong pin is worse than none.
                     → coord_source='geocoded', coord_precision='street'
Tier 3 ("centroid"): tambon (ตำบล) centroid fallback from the open
                     thailand-geography-json gazetteer, ±2–5 km accuracy.
                     → coord_source='centroid', coord_precision='tambon'

Run Tier 1 (repair_coordinates.py) first — it's free and exact.

Usage:
    python geocode_missing.py --tier sibling              # dry run
    python geocode_missing.py --tier sibling --apply
    python geocode_missing.py --tier geocode              # dry run
    python geocode_missing.py --tier geocode --apply
    python geocode_missing.py --tier centroid --apply     # fallback for the rest
    python geocode_missing.py --tier both --apply         # geocode + centroid
    python geocode_missing.py --tier all --apply          # sibling first, then both

Env: LONGDO_API_KEY   (https://map.longdo.com/console — free tier available)

Every Longdo response is cached in geocode_cache.json, so re-runs after a
crash or a parsing fix cost no API quota. After --apply, refresh the PostGIS
geom column and re-run export_markers.py / export_dashboard.py.
"""
import argparse
import csv
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))

import requests
from shapely.geometry import Point, shape

from pipeline import supabase, SUPABASE_URL, SUPABASE_KEY
from supabase import create_client

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


def fetch_missing(include_centroid: bool = False, include_geocoded: bool = False) -> list[dict]:
    """Operating factories without coordinates. With include_centroid, also
    returns tambon-centroid rows so later Tier-2 runs can upgrade them to
    street-level positions. include_geocoded additionally returns street-level
    rows — only Tier 1.5 wants those, since an exact coordinate inherited from a
    co-located licence beats a geocoder guess, but re-geocoding them is a no-op."""
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
        approx = ["lat.is.null"]
        if include_centroid:
            approx.append("coord_source.eq.centroid")
        if include_geocoded:
            approx.append("coord_source.eq.geocoded")
        if len(approx) > 1:
            q = q.or_(",".join(approx))
        else:
            q = q.is_("lat", "null")
        if last_id is not None:
            q = q.gt("id", last_id)
        batch = execute_with_retry(q).data
        if not batch:
            break
        missing.extend(batch)
        last_id = batch[-1]["id"]
    label = ("missing or approximate" if include_centroid or include_geocoded
             else "still missing coordinates")
    print(f"🔍 {len(missing)} operating factories {label}")
    return missing


def apply_updates(rows: list[dict], source: str, precision: str, dry_run: bool):
    if dry_run:
        print(f"\nDry run — would set {len(rows)} factories to coord_source='{source}'. "
              "Re-run with --apply to write.")
        return
    print(f"\n✍️  Applying {len(rows)} updates (coord_source='{source}')...")
    # Supabase terminates the HTTP/2 connection after ~20k streams; recreate
    # the client and retry when that (or any transient error) happens.
    global supabase
    for i, r in enumerate(rows):
        payload = {"lat": r["lat"], "lng": r["lng"], "coord_source": source, "coord_precision": precision}
        for attempt in range(3):
            try:
                supabase.table("factories").update(payload).eq("id", r["id"]).execute()
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    raise
                print(f"   ♻️  reconnecting after: {type(e).__name__}")
                time.sleep(2)
                supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        if (i + 1) % 200 == 0:
            print(f"   ... {i + 1}/{len(rows)}", flush=True)
    print("✅ Done.")


# ── Tier 1.5: inherit a co-located licence's exact coordinate ──────────────

# Sources trusted as a donor position. 'geocoded'/'centroid' are excluded on
# purpose — inheriting an approximation would launder it into a pin the UI
# renders as exact.
DONOR_SOURCES = ("gov", "repaired", "admin", "community")
# Donors for one address that disagree by more than this are treated as
# unresolvable rather than guessed between. Real cases exist: พี.แอล.ซีเมนต์ has
# two 'gov' rows at 888 ม.13 คลองนารายณ์ whose longitudes differ by almost
# exactly 1.000° (101.145 vs 102.145) — a digit error in the government feed.
DONOR_DISAGREE_KM = 0.5
# A donor further than this from the centroid of the tambon it claims is not
# credibly inside that tambon — most Thai tambons fit within a ~15 km radius, and
# the outliers we measured (ลาดตะเคียน, ~29 km tall) still pass. Rejecting costs
# nothing: the row simply falls through to the centroid tier, exactly as today.
# Accepting a bad donor pins a factory tens of km away and renders it as exact,
# so the asymmetry favours rejection. Observed hits: solar/power (code 88) rows
# registered at a head office rather than the plant.
MAX_DONOR_TAMBON_KM = 15

MOO_RE = re.compile(r"ม\.\s*\d+")
ROAD_RE = re.compile(r"ถ\.\S*")
HOUSE_NO_RE = re.compile(r"\d")


def norm_addr(addr: str) -> str:
    """Normalize the street part of an address for exact matching. Deliberately
    conservative — over-normalizing invents matches between different plots."""
    addr = (addr or "").strip()
    addr = re.sub(r"หมู่ที่|หมู่", "ม.", addr)
    addr = re.sub(r"\s+", " ", addr)
    return addr.strip(" ,.-")


def has_house_number(addr: str) -> bool:
    """A usable address needs a house/plot number, not just a moo or a road.
    'ม.7' alone is a whole village; '98, 99 ม.7' is a specific plot."""
    rest = ROAD_RE.sub("", MOO_RE.sub("", addr))
    return bool(HOUSE_NO_RE.search(rest))


def addr_key(factory: dict) -> tuple | None:
    address = norm_addr(factory.get("address_full"))
    if not address or not has_house_number(address):
        return None
    return (
        norm(factory.get("province")),
        norm(factory.get("district")),
        norm(factory.get("sub_district")),
        address,
    )


def haversine_km(a: tuple, b: tuple) -> float:
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def fetch_coord_donors() -> list[dict]:
    """Operating factories carrying a trustworthy coordinate, to donate from."""
    donors, last_id = [], None
    while True:
        q = (
            supabase.table("factories")
            .select("id,address_full,province,district,sub_district,coord_source,lat,lng")
            .eq("is_active", True)
            .eq("status", "ดำเนินการ")
            .in_("coord_source", list(DONOR_SOURCES))
            .not_.is_("lat", "null")
            .order("id")
            .limit(1000)
        )
        if last_id is not None:
            q = q.gt("id", last_id)
        batch = execute_with_retry(q).data
        if not batch:
            break
        donors.extend(batch)
        last_id = batch[-1]["id"]
    print(f"🔗 {len(donors)} operating factories carry a donor-grade coordinate")
    return donors


def tier_sibling(missing: list[dict], polygons: dict, limit: int, dry_run: bool,
                 dump_path: str | None = None):
    """Fill missing/approximate coordinates from another licence at the same
    address. Three guards keep government errors from propagating: the donor must
    sit inside its stated province polygon, within MAX_DONOR_TAMBON_KM of the
    centroid of the tambon it claims, and donors for one address must agree with
    each other. Anything rejected is left to the geocode/centroid tiers."""
    gazetteer = load_gazetteer()
    index = {}
    outside_province = outside_tambon = 0
    for donor in fetch_coord_donors():
        key = addr_key(donor)
        if key is None:
            continue
        polygon = polygons.get((donor.get("province") or "").strip())
        point = (donor["lat"], donor["lng"])
        if polygon is not None and not polygon.contains(Point(point[1], point[0])):
            outside_province += 1  # corrupt gov row — never donate from it
            continue
        centroid = gazetteer.get(key[:3])
        if centroid is not None and haversine_km(centroid, point) > MAX_DONOR_TAMBON_KM:
            outside_tambon += 1  # too far from the tambon it claims to be in
            continue
        index.setdefault(key, []).append({"id": donor["id"], "point": point})

    accepted, proposals, no_match, ambiguous = [], [], 0, 0
    ambiguous_keys = set()
    for factory in missing[:limit]:
        key = addr_key(factory)
        donors = index.get(key) if key else None
        if not donors:
            no_match += 1
            continue
        if factory["id"] in {d["id"] for d in donors}:
            no_match += 1  # already the donor for this address
            continue
        points = [d["point"] for d in donors]
        spread = max((haversine_km(x, y) for x in points for y in points), default=0.0)
        if spread > DONOR_DISAGREE_KM:
            ambiguous += 1  # donors contradict each other — leave for a later tier
            ambiguous_keys.add(key)
            continue
        lat, lng = points[0]
        accepted.append({"id": factory["id"], "lat": lat, "lng": lng})
        proposals.append({
            "id": factory["id"],
            "old_source": factory.get("coord_source") or "none",
            "donor_id": donors[0]["id"],
            "donors": len(donors),
            "province": factory.get("province"),
            "district": factory.get("district"),
            "sub_district": factory.get("sub_district"),
            "address_full": factory.get("address_full"),
            "lat": lat,
            "lng": lng,
        })

    print("\n📊 Tier 1.5 (co-located licence) results")
    print(f"   inherited an exact coordinate:  {len(accepted)}")
    print(f"   no licence at the same address: {no_match}")
    print(f"   donors disagreed >{DONOR_DISAGREE_KM} km:      {ambiguous}"
          f" (across {len(ambiguous_keys)} addresses)")
    if outside_province:
        print(f"   donors rejected, outside province: {outside_province}")
    if outside_tambon:
        print(f"   donors rejected, >{MAX_DONOR_TAMBON_KM} km from own tambon: {outside_tambon}")
    by_source = {}
    for p in proposals:
        by_source[p["old_source"]] = by_source.get(p["old_source"], 0) + 1
    for source, n in sorted(by_source.items(), key=lambda kv: -kv[1]):
        print(f"     upgraded from {source:9}: {n}")

    if dump_path:
        with open(dump_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(proposals[0].keys())
                                    if proposals else ["id"])
            writer.writeheader()
            writer.writerows(proposals)
        print(f"   📄 wrote {len(proposals)} proposed moves to {dump_path}")

    apply_updates(accepted, "sibling", "exact", dry_run)
    return accepted


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
    parser.add_argument("--tier",
                        choices=["sibling", "geocode", "centroid", "both", "all"],
                        required=True,
                        help="'both' = geocode + centroid; 'all' = sibling first, then both")
    parser.add_argument("--apply", action="store_true", help="write results to Supabase")
    parser.add_argument("--cache-only", action="store_true",
                        help="Tier 2: use cached responses only, no API calls (quota exhausted)")
    parser.add_argument("--limit", type=int, default=100000)
    parser.add_argument("--dump", metavar="PATH",
                        help="Tier 1.5: write every proposed move to a CSV for review "
                             "(donor, distance moved, old source) before applying")
    args = parser.parse_args()

    polygons = load_province_polygons()

    if args.tier in ("sibling", "all"):
        # Widest recipient set: an inherited exact coordinate improves on a
        # geocoded pin too, not just on a blank or a tambon centroid
        tier_sibling(fetch_missing(include_centroid=True, include_geocoded=True),
                     polygons, args.limit, dry_run=not args.apply,
                     dump_path=args.dump)

    if args.tier == "sibling":
        missing = []
    else:
        # Tier 2 also targets centroid rows, so a street-level result upgrades them
        missing = fetch_missing(include_centroid=args.tier in ("geocode", "both", "all"))

    if args.tier in ("geocode", "both", "all"):
        tier_geocode(missing, polygons, args.limit, dry_run=not args.apply,
                     cache_only=args.cache_only)
    if args.tier in ("centroid", "both", "all"):
        # Re-fetch when earlier tiers ran with --apply, so Tier 3 only fills the rest
        if args.tier in ("both", "all") and args.apply:
            missing = fetch_missing()
        tier_centroid(missing, polygons, args.limit, dry_run=not args.apply)

    if args.apply:
        print("\nNext steps:")
        # NOT 'geom IS NULL' — the sibling and geocode tiers also MOVE rows that
        # already had a coordinate, leaving a stale geom behind. Rewrite any geom
        # that disagrees with lat/lng, not just the missing ones.
        print("   UPDATE factories SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)")
        print("   WHERE lat IS NOT NULL AND (geom IS NULL")
        print("      OR ABS(ST_X(geom) - lng) > 1e-9 OR ABS(ST_Y(geom) - lat) > 1e-9);")
        print("   python export_markers.py && python export_dashboard.py")


if __name__ == "__main__":
    main()
