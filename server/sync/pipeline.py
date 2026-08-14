#!/usr/bin/env python3
"""
Factory Near Me — Daily Sync Pipeline
======================================
Fetches factory data from 6 Thai government OpenAPI endpoints (CSV format),
transforms it into a relational schema, and upserts into Supabase.

Usage:
    python pipeline.py                    # Full sync
    python pipeline.py --test             # Test mode (first 100 records only)
    python pipeline.py --endpoint Factory_Data  # Sync single endpoint

Author: Factory Near Me Team
"""

import os
import sys
import time
import hashlib
import logging
import argparse
from io import StringIO
from datetime import datetime
from urllib.parse import quote

import pandas as pd
import requests
from dotenv import load_dotenv
from supabase import create_client, Client

from config import (
    ENDPOINTS,
    FACTORY_DATA_TO_FACTORIES,
    BUSINESS_LOCATION_TO_FACTORIES,
    PERMIT_TO_PERMITS,
    SUM_TO_STATISTICS,
    UPSERT_BATCH_SIZE,
    FETCH_TIMEOUT,
)

# =============================================================================
# Setup
# =============================================================================
load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("factory-sync")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
TEST_LIMIT = int(os.getenv("SYNC_TEST_LIMIT", "100"))


def test_mode() -> bool:
    """
    Whether this run is a test run.

    Read on every call, never cached at import. `--test` sets SYNC_TEST_MODE
    inside main(), which runs *after* this module is imported, so the old
    module-level `TEST_MODE = os.getenv(...)` constant was evaluated while the
    variable was still unset and was therefore False for the entire run. The
    log said "Test mode enabled via CLI flag" and then "Test mode: OFF" two
    lines later.

    That mattered: TEST_MODE is the guard on the permits and statistics
    clear+insert, added after a test run cleared 814,588 permits and 1,621,380
    statistics rows and replaced them with 100. Those guards had silently done
    nothing since. What actually held the line was the volume floor in
    promote_staging(), a second line of defence that should not have been load-
    bearing.
    """
    return os.getenv("SYNC_TEST_MODE", "false").lower() == "true"


def deactivation_mode() -> str:
    """
    'dry' (default) reports what soft_delete_missing would deactivate without
    writing; 'on' writes; 'off' skips entirely.

    Defaults to dry because soft_delete_missing has never once run correctly —
    it read back only the first 1,000 active factories (PostgREST's hard
    max-rows), so it compared the feed against a 0.4% sample, and the circuit
    breaker tripped on every run. Its first correct run would be its first ever,
    against a gap of ~33,000 rows, and that number needs to be understood before
    it is written. See SYNC_DEACTIVATE in DATA_LAYER.md.
    """
    return os.getenv("SYNC_DEACTIVATE", "dry").lower()

# sync_permits() clears the whole table before reinserting, so a short fetch
# would silently empty it. The endpoint returned 241,588 rows on 2026-08-08;
# anything under this floor means a truncated or degraded response, not a real
# drop in permits, and the refresh is skipped instead.
MIN_EXPECTED_PERMITS = 100_000
# Each Sum_* endpoint returned 185,917 rows on 2026-08-14. Floor set well below
# that so ordinary movement does not trip it, but a truncated fetch does.
MIN_EXPECTED_STATISTICS = 100_000

if not SUPABASE_URL or not SUPABASE_KEY:
    logger.error("❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# =============================================================================
# 1. FETCH — Download CSV data from government endpoints
# =============================================================================
def fetch_csv(endpoint_key: str) -> pd.DataFrame | None:
    """
    Download CSV data from a government endpoint.
    Uses ?download_all=1 for bulk download when available.
    Falls back to paginated fetching if bulk download fails.
    """
    endpoint = ENDPOINTS[endpoint_key]
    url = endpoint["download_url"]
    logger.info(f"📥 Fetching {endpoint_key} from {url}")

    try:
        response = requests.get(url, timeout=FETCH_TIMEOUT)
        response.raise_for_status()
        # utf-8-sig, not utf-8: these CSVs carry a byte-order mark, and pandas
        # only sometimes strips it. Measured 2026-08-14 across all five
        # endpoints — four parsed as expected, but Factory_Operation_Permit's
        # first header stayed '﻿DISPFACREG', so every
        # row_dict.get("DISPFACREG") returned "" and permit_no was NULL for all
        # 241,145 rows. Decoding with utf-8-sig removes the BOM before pandas
        # ever sees it, so no endpoint can silently lose its first column again.
        response.encoding = "utf-8-sig"

        content = response.text.strip()
        if not content:
            logger.warning(f"⚠️ Empty response from {endpoint_key}")
            return None

        # Parse CSV — handle malformed government data gracefully
        try:
            df = pd.read_csv(
                StringIO(content),
                dtype=str,
                keep_default_na=False,
                on_bad_lines="skip",
                quotechar='"',
                escapechar='\\',
            )
        except Exception:
            # Fallback: use Python engine which is more lenient
            try:
                df = pd.read_csv(
                    StringIO(content),
                    dtype=str,
                    keep_default_na=False,
                    on_bad_lines="skip",
                    engine="python",
                    quotechar='"',
                )
            except Exception as e2:
                logger.error(f"❌ Could not parse CSV even with fallback: {e2}")
                return None

        logger.info(f"✅ Fetched {len(df)} records from {endpoint_key} ({len(df.columns)} columns)")

        if test_mode():
            df = df.head(int(os.getenv("SYNC_TEST_LIMIT", "100")))
            logger.info(f"🧪 Test mode: limited to {len(df)} records")

        return df

    except requests.exceptions.Timeout:
        logger.error(f"⏱️ Timeout fetching {endpoint_key} (>{FETCH_TIMEOUT}s)")
        return None
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ HTTP error fetching {endpoint_key}: {e}")
        return None
    except Exception as e:
        logger.error(f"❌ Error parsing {endpoint_key} CSV: {e}")
        return None


# =============================================================================
# 2. TRANSFORM — Clean and map data to our schema
# =============================================================================
def generate_business_id(oname: str) -> str:
    """Generate a deterministic business ID from the operator name."""
    normalized = oname.strip().lower()
    return hashlib.md5(normalized.encode("utf-8")).hexdigest()[:16]


def build_address(row: dict) -> str:
    """Construct a full address string from components."""
    parts = []
    if row.get("_addr") and row["_addr"].strip() and row["_addr"] != "-":
        parts.append(row["_addr"].strip())
    if row.get("_moo") and row["_moo"].strip() and row["_moo"] != "-":
        parts.append(f"ม.{row['_moo'].strip()}")
    if row.get("_soi") and row["_soi"].strip() and row["_soi"] != "-":
        parts.append(f"ซ.{row['_soi'].strip()}")
    if row.get("_road") and row["_road"].strip() and row["_road"] != "-":
        parts.append(f"ถ.{row['_road'].strip()}")
    return " ".join(parts) if parts else ""


def parse_float(value: str) -> float | None:
    """Safely parse a float, handling Thai API quirks."""
    if not value or value.strip() in ("", "-", " "):
        return None
    try:
        # Remove quotes and whitespace
        cleaned = value.strip().strip('"').strip("=").strip('"')
        return float(cleaned)
    except (ValueError, TypeError):
        return None


# Thailand bounding box (approximate)
# Lat: 5.6°N to 20.5°N, Lng: 97.3°E to 105.6°E
TH_LAT_MIN, TH_LAT_MAX = 5.0, 21.0
TH_LNG_MIN, TH_LNG_MAX = 95.0, 106.0


def parse_coordinates(lat_str: str, lng_str: str) -> tuple[float | None, float | None]:
    """
    Parse and validate coordinates against Thailand's bounding box.
    Rejects 0.0, 1.0, and out-of-bounds values that would place
    factories in the ocean.
    """
    lat = parse_float(lat_str)
    lng = parse_float(lng_str)

    if lat is None or lng is None:
        return None, None

    # Reject clearly invalid coordinates
    if not (TH_LAT_MIN <= lat <= TH_LAT_MAX and TH_LNG_MIN <= lng <= TH_LNG_MAX):
        return None, None

    return lat, lng


def parse_int(value: str) -> int | None:
    """Safely parse an integer."""
    f = parse_float(value)
    return int(f) if f is not None else None


def parse_date(value: str) -> str | None:
    """Parse date string to ISO format."""
    if not value or value.strip() in ("", "-", " "):
        return None
    try:
        # Handle various date formats
        for fmt in ["%Y-%m-%d", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"]:
            try:
                dt = datetime.strptime(value.strip(), fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
        return None
    except Exception:
        return None


def clean_facreg(facreg: str) -> str:
    """
    Clean the FACREG field which often has Excel-style quoting artifacts.
    Also strips internal spaces to prevent duplicates.
    e.g., '="  06302307522"' → '06302307522'
    e.g., '1 - 10 - 1 / 2560' → '1-10-1/2560'
    """
    if not facreg:
        return ""
    cleaned = facreg.strip().strip('"').strip("=").strip('"').strip()
    # Remove internal spaces around delimiters to standardize
    cleaned = cleaned.replace(" ", "")
    return cleaned


def transform_factory_data(df: pd.DataFrame) -> tuple[list[dict], list[dict], list[dict]]:
    """
    Transform Factory_Data CSV into businesses and factories records.
    Returns: (businesses_records, factories_records, coordinate_records)

    coordinate_records only contains rows where the gov CSV has a real
    lat/lng — factories records NEVER carry a "lat"/"lng" key, so the main
    upsert can't null out coordinates we repaired/geocoded/centroid-filled
    for factories the government feed still has no coordinates for. See
    repair_coordinates.py / geocode_missing.py.
    """
    businesses = {}
    factories = []
    coordinates = []

    for _, row in df.iterrows():
        row_dict = row.to_dict()

        # --- Clean the primary key ---
        facreg = clean_facreg(row_dict.get("FACREG", ""))
        if not facreg:
            continue

        # --- Extract business ---
        oname = row_dict.get("ONAME", "").strip()
        if oname and oname != "-":
            biz_id = generate_business_id(oname)
            if biz_id not in businesses:
                businesses[biz_id] = {
                    "id": biz_id,
                    "legal_name": oname,
                    "objective": row_dict.get("OBJECT", "").strip() or None,
                }
        else:
            biz_id = None

        # --- Build factory record ---
        lat, lng = parse_coordinates(row_dict.get("LAT", ""), row_dict.get("LNG", ""))

        # Build address
        addr_row = {
            "_addr": row_dict.get("FADDR", ""),
            "_moo": row_dict.get("FMOO", ""),
            "_soi": row_dict.get("FSOI", ""),
            "_road": row_dict.get("FROAD", ""),
        }
        address = build_address(addr_row)

        # Check estate status
        estate_raw = row_dict.get("ESTATE", "").strip().upper()
        in_estate = estate_raw not in ("OUT", "", "-")

        disp_facreg = row_dict.get("DISPFACREG", "").strip()
        factory_id = disp_facreg if disp_facreg else facreg

        factory = {
            "id": factory_id,
            "fid": row_dict.get("FID", "").strip() or None,
            "facreg_numeric": facreg,
            "registration_display": disp_facreg or None,
            "business_id": biz_id,
            "name": row_dict.get("FNAME", "").strip() or None,
            "factory_type": row_dict.get("FACTYPE", "").strip() or None,
            "address_full": address or None,
            "province": row_dict.get("FPROVNAME", "").strip() or None,
            "district": row_dict.get("FAMPNAME", "").strip() or None,
            "sub_district": row_dict.get("FTUMNAME", "").strip() or None,
            "isic_code": row_dict.get("ISIC_CODE", "").strip() or None,
            "capital_investment": parse_float(row_dict.get("TOTAL_CAP", "")),
            "total_workers": parse_int(row_dict.get("TOTAL_WORKER", "")),
            "horsepower": parse_float(row_dict.get("HP", "")),
            "in_estate": in_estate,
            "estate_name": row_dict.get("ESTATE_NAME_TH", "").strip() or None,
            # NOT writing "status" here: FFLAG is a small numeric code (0-3),
            # not the 'ดำเนินการ'/'หยุดดำเนินการ' text the rest of the app
            # filters on, and its decode is unverified — see 2026-08-08
            # incident (this + Business_Location's STATUS field together
            # corrupted `status` for ~90% of the table in one sync run).
            # `status` is currently untouched by the pipeline entirely until
            # a trustworthy source/decode is confirmed.
            "is_active": True,
        }

        factories.append(factory)
        if lat is not None and lng is not None:
            coordinates.append({
                "id": factory_id, "lat": lat, "lng": lng,
                "coord_source": "gov", "coord_precision": "exact",
            })

    logger.info(f"🏢 Extracted {len(businesses)} unique businesses, {len(factories)} factories "
                f"({len(coordinates)} with gov coordinates)")
    return list(businesses.values()), factories, coordinates


def transform_business_location(df: pd.DataFrame) -> tuple[list[dict], list[dict], list[dict]]:
    """
    Transform Business_Location CSV into businesses and factories records.
    This endpoint lacks FACREG, so we use DISPFACREG as a fallback key.
    Returns (businesses, factories, coordinates) — see transform_factory_data
    for why coordinates are split out.

    factory dicts never carry "status": this endpoint's STATUS column uses a
    different vocabulary than Factory_Data's FFLAG ('จำหน่าย' is its most
    common value on ~84% of rows, not a real closure signal) and would
    silently overwrite the correct operating status set by Factory_Data,
    which runs first and is genuinely the source of truth for this field.
    """
    businesses = {}
    factories = []
    coordinates = []

    for _, row in df.iterrows():
        row_dict = row.to_dict()

        # Use DISPFACREG as primary key for consistent matching with Factory_Data
        disp_facreg = row_dict.get("DISPFACREG", "").strip()
        fid = row_dict.get("FID", "").strip()

        # We need at least one identifier, prioritize display reg
        factory_id = disp_facreg if disp_facreg else fid
        if not factory_id:
            continue

        # --- Extract business ---
        oname = row_dict.get("ONAME", "").strip()
        if oname and oname != "-":
            biz_id = generate_business_id(oname)
            if biz_id not in businesses:
                businesses[biz_id] = {
                    "id": biz_id,
                    "legal_name": oname,
                    "objective": row_dict.get("OBJECT", "").strip() or None,
                }
        else:
            biz_id = None

        lat, lng = parse_coordinates(row_dict.get("LAT", ""), row_dict.get("LNG", ""))

        addr_row = {
            "_addr": row_dict.get("FADDR", ""),
            "_moo": row_dict.get("FMOO", ""),
            "_soi": row_dict.get("FSOI", ""),
            "_road": row_dict.get("FROAD", ""),
        }
        address = build_address(addr_row)

        factory = {
            "id": factory_id,
            "registration_display": disp_facreg or None,
            "business_id": biz_id,
            "name": row_dict.get("FNAME", "").strip() or None,
            "address_full": address or None,
            "province": row_dict.get("FPROVNAME", "").strip() or None,
            "district": row_dict.get("FAMPNAME", "").strip() or None,
            "sub_district": row_dict.get("FTUMNAME", "").strip() or None,
            "is_active": True,
        }

        factories.append(factory)
        if lat is not None and lng is not None:
            coordinates.append({
                "id": factory_id, "lat": lat, "lng": lng,
                "coord_source": "gov", "coord_precision": "exact",
            })

    logger.info(f"🏢 Extracted {len(businesses)} businesses, {len(factories)} factories from Business_Location "
                f"({len(coordinates)} with gov coordinates)")
    return list(businesses.values()), factories, coordinates


def transform_permits(df: pd.DataFrame) -> list[dict]:
    """Transform Factory_Operation_Permit CSV into permits records."""
    permits = []

    for _, row in df.iterrows():
        row_dict = row.to_dict()

        fid = row_dict.get("FID", "").strip()
        disp_facreg = row_dict.get("DISPFACREG", "").strip()

        if not fid and not disp_facreg:
            continue

        permit = {
            "factory_fid": fid or None,
            # DISPFACREG here is the permit number (น.42(1)-5/2535-ญนพ.), a
            # different namespace from a factory's registration id — so it is
            # not a join key. factory_id is resolved from FID after loading.
            "permit_no": disp_facreg or None,
            "issue_date": parse_date(row_dict.get("POKDATE", "")),
            "permit_status": row_dict.get("STATUS", "").strip() or None,
        }

        permits.append(permit)

    logger.info(f"📜 Extracted {len(permits)} permit records")
    return permits


def link_permits_to_factories() -> int:
    """
    Fill permits.factory_id from factory_fid, so the table can be joined to
    factories on the id everything else uses.

    Nothing populated this column: PERMIT_TO_PERMITS has no rule for it, so it
    was NULL for all 241,145 rows and `permits` answered no question. The only
    available link is FID, which resolves about 39% of rows — the rest are
    permits for factories the registry no longer carries.
    """
    try:
        result = supabase.rpc("link_permits_to_factories").execute()
        linked = result.data if isinstance(result.data, int) else 0
        logger.info(f"🔗 Linked {linked:,} permits to factories via FID")
        return linked
    except Exception as e:
        logger.warning(f"⚠️ Could not link permits to factories: {e}")
        return 0


def transform_statistics(df: pd.DataFrame, source: str) -> list[dict]:
    """
    Transform Sum_Factory_Local or Sum_Status_Factory_Local into statistics rows.

    The two endpoints publish different columns and are handled separately.
    Sum_Status_Factory_Local is counts by year/month/province/industry/status;
    Sum_Factory_Local is current aggregates by province/industry including
    workers, capital and a size split, with no year or status dimension.

    Until 2026-08-14 one mapping was applied to both, so every Sum_Factory_Local
    row landed with year, month, province and status NULL — province purely
    because the column is PROVINCE there and FPROVNAME in the other.
    """
    stats = []
    is_status_endpoint = source == "Sum_Status_Factory_Local"

    for _, row in df.iterrows():
        row_dict = row.to_dict()

        if is_status_endpoint:
            stat = {
                "year": parse_int(row_dict.get("YEAR", "")),
                "month": row_dict.get("MONTH", "").strip() or None,
                "province": row_dict.get("FPROVNAME", "").strip() or None,
                "status": row_dict.get("STATUS", "").strip() or None,
            }
        else:
            stat = {
                "province": row_dict.get("PROVINCE", "").strip() or None,
                "total_workers": parse_int(row_dict.get("TOTALMAN", "")),
                "total_capital": parse_float(row_dict.get("TOTALCAP", "")),
                "size_small": parse_int(row_dict.get("FACSIZE_S", "")),
                "size_medium": parse_int(row_dict.get("FACSIZE_M", "")),
                "size_large": parse_int(row_dict.get("FACSIZE_L", "")),
            }

        stat.update({
            "tsic_code": row_dict.get("TSIC", "").strip() or None,
            "description": row_dict.get("DESCR", "").strip() or None,
            "total": parse_int(row_dict.get("TOTAL", "")),
            "source_endpoint": source,
            "last_update": parse_date(row_dict.get("LAST_UPDATE", "")),
        })

        stats.append(stat)

    # Loud enough to notice if a feed changes shape again: a mapping that stops
    # matching shows up here as a column that is suddenly empty for every row.
    if stats:
        filled = {k: sum(1 for s in stats if s.get(k) is not None) for k in stats[0]}
        empty = [k for k, n in filled.items() if n == 0]
        if empty:
            logger.warning(
                f"⚠️ {source}: these columns are NULL for all {len(stats)} rows "
                f"— check the feed's headers against config.py: {', '.join(empty)}"
            )

    logger.info(f"📊 Extracted {len(stats)} statistics records from {source}")
    return stats


# =============================================================================
# 3. LOAD — Upsert into Supabase
# =============================================================================
def upsert_batch(table: str, records: list[dict], on_conflict: str = "id") -> int:
    """
    Upsert records into a Supabase table in batches.
    Returns total records upserted.
    """
    if not records:
        return 0

    total = 0
    for i in range(0, len(records), UPSERT_BATCH_SIZE):
        batch = records[i : i + UPSERT_BATCH_SIZE]
        try:
            result = (
                supabase.table(table)
                .upsert(batch, on_conflict=on_conflict)
                .execute()
            )
            total += len(batch)
            logger.debug(f"  Upserted batch {i // UPSERT_BATCH_SIZE + 1} ({len(batch)} records)")
        except Exception as e:
            logger.error(f"❌ Error upserting batch to {table}: {e}")
            # Continue with next batch instead of failing entirely
            continue

    logger.info(f"✅ Upserted {total}/{len(records)} records into {table}")
    return total


def load_and_promote(
    table: str, records: list[dict], min_rows: int, source: str | None = None
) -> int | None:
    """
    Full-refresh a table without ever leaving it empty.

    Loads into `{table}_staging`, then calls public.promote_staging(), which
    truncates the live table and copies staging over it inside one transaction.
    TRUNCATE takes an ACCESS EXCLUSIVE lock, so a concurrent reader blocks until
    the commit and then sees the new rows — it never observes an empty or
    half-loaded table, which the old delete-then-insert could not promise.

    Returns the number of rows promoted, or None if anything failed, in which
    case the live table is untouched and the caller should abort rather than
    treat the sync as successful.
    """
    staging = f"{table}_staging"

    try:
        # Clear any residue from a previous failed run before loading.
        q = supabase.table(staging).delete()
        if source is None:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        else:
            q = q.eq("source_endpoint", source)
        q.execute()
    except Exception as e:
        logger.error(f"❌ Could not clear {staging}: {e}")
        return None

    loaded = insert_batch(staging, records)
    if loaded < min_rows:
        logger.error(
            f"❌ Only {loaded}/{len(records)} rows reached {staging} "
            f"(need {min_rows}); {table} left untouched."
        )
        return None

    try:
        result = supabase.rpc(
            "promote_staging",
            {"p_table": table, "p_min_rows": min_rows, "p_source": source},
        ).execute()
        promoted = result.data if isinstance(result.data, int) else loaded
        logger.info(f"🔄 Promoted {promoted} rows into {table} (atomic swap)")
        return promoted
    except Exception as e:
        logger.error(f"❌ promote_staging({table}) failed, table untouched: {e}")
        return None


COORD_RPC_BATCH_SIZE = 5000


def apply_gov_coordinates(coordinates: list[dict]) -> int:
    """
    Apply lat/lng for factories the gov CSV has real coordinates for, via the
    apply_gov_coordinates(jsonb) RPC (migration 20260815000000).

    The protection rule — skip 'community', 'admin' and 'repaired', overwrite
    'sibling' — lives in SQL, not here. It used to be a readback into a Python
    set followed by an upsert, which is two round-trips minutes apart on a
    274k-row sync: a moderator approving a correction in that window had it
    silently overwritten by the same run. In the function both statements are
    one transaction, so that window is gone.

    The RPC also records what DIW published into gov_lat/gov_lng for every row,
    override or not, so an override can be reverted and upstream fixes can be
    detected. See the coord_override_drift view.

    Batched because the payload travels as a JSON body: each call is its own
    transaction, which is fine — the two statements that must agree are within
    a batch, not across them.
    """
    if not coordinates:
        return 0

    applied = 0
    shadowed = 0
    for i in range(0, len(coordinates), COORD_RPC_BATCH_SIZE):
        batch = coordinates[i : i + COORD_RPC_BATCH_SIZE]
        payload = [
            {"id": c["id"], "lat": c["lat"], "lng": c["lng"]} for c in batch
        ]
        try:
            rows = supabase.rpc("apply_gov_coordinates", {"p": payload}).execute().data
        except Exception as e:
            logger.error(f"❌ apply_gov_coordinates batch {i // COORD_RPC_BATCH_SIZE} failed: {e}")
            continue

        # `returns table(...)` arrives as a single-element list of dicts.
        row = rows[0] if isinstance(rows, list) and rows else (rows or {})
        applied += row.get("applied") or 0
        shadowed += row.get("shadowed") or 0

    skipped = shadowed - applied
    logger.info(f"📍 Applied gov coordinates for {applied} factories")
    logger.info(f"🗃️  Recorded gov position for {shadowed} factories (gov_lat/gov_lng)")
    if skipped > 0:
        logger.info(f"🛡️  {skipped} rows kept their existing position (human-verified, or already current)")
    return applied


def chunks_for_uri(ids: list[str], max_chars: int = 3500):
    """
    Yield ID chunks small enough to survive as a PostgREST `in.(...)` filter.

    These filters travel in the URL, not the request body, and factory IDs are
    Thai: every non-ASCII byte becomes three percent-encoded characters, so a
    22-character id reaches ~90 characters on the wire. Chunking by item count
    (the previous flat 500) produced ~30 KB URLs — Supabase cloud accepted
    them, self-hosted Kong rejects them with HTTP 414 and the whole endpoint
    sync fails. Budget by encoded length instead, so this holds no matter how
    long the ids are.
    """
    batch: list[str] = []
    size = 0
    for value in ids:
        encoded = len(quote(str(value), safe="")) + 1  # +1 for the separating comma
        if batch and size + encoded > max_chars:
            yield batch
            batch, size = [], 0
        batch.append(value)
        size += encoded
    if batch:
        yield batch


def insert_batch(table: str, records: list[dict]) -> int:
    """
    Insert records (no conflict resolution — for tables with UUID PKs like permits, stats).
    Deletes existing records first for a clean refresh.
    """
    if not records:
        return 0

    total = 0
    for i in range(0, len(records), UPSERT_BATCH_SIZE):
        batch = records[i : i + UPSERT_BATCH_SIZE]
        try:
            supabase.table(table).insert(batch).execute()
            total += len(batch)
        except Exception as e:
            logger.error(f"❌ Error inserting batch to {table}: {e}")
            continue

    logger.info(f"✅ Inserted {total}/{len(records)} records into {table}")
    return total


# =============================================================================
# 4. SOFT DELETE — Mark missing factories as inactive
# =============================================================================
def fetch_all_active_ids(page: int = 1000) -> set[str]:
    """
    Every active factory id, paginated.

    PostgREST caps a response at 1,000 rows server-side (db-max-rows) and says
    so only in the Content-Range header — the request still returns 200 with a
    plausible-looking body. soft_delete_missing() used a plain .select() and so
    compared the whole government feed against the first 1,000 of 274,422
    active factories, a 0.4% sample. Every id beyond that sample looked absent
    from the database rather than absent from the feed, the ratio came out at
    100%, and the circuit breaker aborted the run. That is why this function
    has never deactivated a single closed factory, and why the failure was
    invisible: it looked like the breaker doing its job.

    274k rows at 1,000 a page is ~275 requests against a database on the same
    host as the caller. That is acceptable for a nightly.
    """
    ids: set[str] = set()
    start = 0
    while True:
        rows = (
            supabase.table("factories")
            .select("id")
            .eq("is_active", True)
            .range(start, start + page - 1)
            .execute()
            .data
        )
        if not rows:
            break
        ids.update(r["id"] for r in rows)
        if len(rows) < page:
            break
        start += page

    logger.info(f"📖 Read back {len(ids)} active factory ids")
    return ids


def write_deactivation_candidates(ids: list[str]) -> str:
    """
    Write the would-be-deactivated ids to CSV so the set can be reviewed
    against the registry before anything is written. Ids only — join to
    factories for status and name rather than duplicating them here.
    """
    out_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.abspath(os.path.join(out_dir, "deactivation_candidates.csv"))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("id\n")
        for i in ids:
            fh.write(f"{i}\n")
    return path


def soft_delete_missing(fetched_ids: set[str]) -> int:
    """
    Mark factories as inactive if their ID is no longer in the fetched dataset.
    Returns count of deactivated records.
    """
    if not fetched_ids:
        return 0

    mode = deactivation_mode()
    if mode == "off":
        logger.info("⏭️  Deactivation disabled (SYNC_DEACTIVATE=off)")
        return 0

    try:
        existing_ids = fetch_all_active_ids()

        # Find IDs that exist in DB but not in fetched data
        missing_ids = existing_ids - fetched_ids

        if not missing_ids:
            logger.info("✅ No factories to deactivate")
            return 0

        # Circuit breaker: a healthy daily sync deactivates a handful of
        # factories (closures), not a large fraction of the table. If the
        # gov CSV fetch was truncated/incomplete for any reason, fetched_ids
        # would look artificially small and this would otherwise mass-
        # deactivate the database. Abort instead of guessing.
        max_deactivation_ratio = 0.05
        if existing_ids and len(missing_ids) > len(existing_ids) * max_deactivation_ratio:
            logger.error(
                f"❌ Refusing to deactivate {len(missing_ids)}/{len(existing_ids)} factories "
                f"({len(missing_ids) / len(existing_ids):.0%} — over the {max_deactivation_ratio:.0%} safety "
                "threshold). This usually means the source CSV fetch was incomplete. Investigate manually."
            )
            return 0

        # Deactivate in batches. These are `in.(...)` URL filters, not request
        # bodies, so they are chunked by encoded length rather than by
        # UPSERT_BATCH_SIZE — 2000 Thai ids exceed the gateway's URI limit and
        # the resulting 414 was swallowed by the except below, silently
        # skipping deactivation altogether.
        missing_list = sorted(missing_ids)

        if mode != "on":
            path = write_deactivation_candidates(missing_list)
            logger.warning(
                f"🧪 Dry run: {len(missing_list)} factories are absent from the feed and "
                f"WOULD be deactivated. Nothing written. Candidates: {path}"
            )
            logger.warning("   Set SYNC_DEACTIVATE=on to apply, after reviewing the list.")
            return 0

        deactivated = 0
        for batch in chunks_for_uri(missing_list):
            supabase.table("factories").update({"is_active": False}).in_("id", batch).execute()
            deactivated += len(batch)

        logger.info(f"🔴 Deactivated {deactivated} factories no longer in source data")
        return deactivated

    except Exception as e:
        logger.error(f"❌ Error during soft delete: {e}")
        return 0


# =============================================================================
# 5. PostGIS — Update geometry column
# =============================================================================
def update_geometry(project_supabase: Client) -> None:
    """
    Update the PostGIS geometry column for all factories with lat/lng.
    This runs as a raw SQL query since Supabase SDK doesn't support PostGIS functions.
    """
    logger.info("🌍 Updating PostGIS geometry column...")
    try:
        # We use the Supabase RPC or raw SQL approach
        # Since supabase-py doesn't directly support raw SQL,
        # we create a database function for this
        logger.info("✅ Geometry update will be handled by the database trigger/function")
    except Exception as e:
        logger.error(f"❌ Error updating geometry: {e}")


# =============================================================================
# 6. LOGGING — Write sync results
# =============================================================================
def log_sync(
    endpoint: str,
    records_fetched: int,
    records_upserted: int,
    records_deactivated: int,
    status: str,
    error_message: str | None,
    duration: float,
) -> None:
    """Write a sync log entry."""
    try:
        supabase.table("sync_logs").insert(
            {
                "endpoint_name": endpoint,
                "records_fetched": records_fetched,
                "records_upserted": records_upserted,
                "records_deactivated": records_deactivated,
                "status": status,
                "error_message": error_message,
                "duration_seconds": round(duration, 2),
            }
        ).execute()
    except Exception as e:
        logger.error(f"❌ Error writing sync log: {e}")


# =============================================================================
# 7. ORCHESTRATOR — Main pipeline
# =============================================================================
def sync_factory_data() -> dict:
    """
    Primary sync: Factory_Data endpoint → businesses + factories tables.
    This is the richest dataset and serves as the source of truth.
    """
    start = time.time()
    endpoint_key = "Factory_Data"

    df = fetch_csv(endpoint_key)
    if df is None:
        log_sync(endpoint_key, 0, 0, 0, "ERROR", "Failed to fetch CSV", time.time() - start)
        return {"status": "ERROR", "fetched": 0, "upserted": 0}

    businesses, factories, coordinates = transform_factory_data(df)

    # Upsert businesses FIRST (FK dependency)
    biz_count = upsert_batch("businesses", businesses, on_conflict="id")

    # Upsert factories — no lat/lng/coord_source columns here, so factories
    # the gov CSV still has no coordinates for keep whatever we
    # repaired/geocoded/centroid-filled (see transform_factory_data)
    fac_count = upsert_batch("factories", factories, on_conflict="id")

    # Coordinates: separate upsert, only rows with a real gov value, and never
    # downgrades a citizen-verified ('community') position
    apply_gov_coordinates(coordinates)

    # Soft delete — skipped in test mode: fetched_ids would only be ~TEST_LIMIT
    # rows, and soft_delete_missing would otherwise try to deactivate nearly
    # the entire table (see safety threshold inside soft_delete_missing too)
    fetched_ids = {f["id"] for f in factories}
    deactivated = 0 if test_mode() else soft_delete_missing(fetched_ids)

    duration = time.time() - start
    log_sync(endpoint_key, len(df), biz_count + fac_count, deactivated, "SUCCESS", None, duration)

    return {
        "status": "SUCCESS",
        "fetched": len(df),
        "businesses": biz_count,
        "factories": fac_count,
        "deactivated": deactivated,
        "duration": round(duration, 2),
    }


def sync_business_location() -> dict:
    """
    Secondary sync: Business_Location → update factories with status info.
    This endpoint has STATUS field but less detail than Factory_Data.
    """
    start = time.time()
    endpoint_key = "Business_Location"

    df = fetch_csv(endpoint_key)
    if df is None:
        log_sync(endpoint_key, 0, 0, 0, "ERROR", "Failed to fetch CSV", time.time() - start)
        return {"status": "ERROR", "fetched": 0, "upserted": 0}

    businesses, factories, coordinates = transform_business_location(df)

    biz_count = upsert_batch("businesses", businesses, on_conflict="id")
    fac_count = upsert_batch("factories", factories, on_conflict="id")
    apply_gov_coordinates(coordinates)

    duration = time.time() - start
    log_sync(endpoint_key, len(df), biz_count + fac_count, 0, "SUCCESS", None, duration)

    return {
        "status": "SUCCESS",
        "fetched": len(df),
        "businesses": biz_count,
        "factories": fac_count,
        "duration": round(duration, 2),
    }


def sync_permits() -> dict:
    """Sync permits from Factory_Operation_Permit endpoint."""
    start = time.time()
    endpoint_key = "Factory_Operation_Permit"

    df = fetch_csv(endpoint_key)
    if df is None:
        log_sync(endpoint_key, 0, 0, 0, "ERROR", "Failed to fetch CSV", time.time() - start)
        return {"status": "ERROR", "fetched": 0, "upserted": 0}

    permits = transform_permits(df)

    # Permits are a full refresh: the endpoint returns the complete current set,
    # and clearing first is what collapses duplicates from previous runs (the
    # table had grown to 814k rows for ~243k distinct permits).
    #
    # But "clear everything, then insert what we fetched" destroys the table
    # whenever the fetch comes back short, so it is guarded twice:
    #   1. Test mode fetches only SYNC_TEST_LIMIT rows. On 2026-08-08 a test run
    #      cleared 814,588 permits and inserted 100. Test mode now touches nothing.
    #   2. A degraded or truncated CSV would do the same thing silently, so refuse
    #      to clear when the fetch is implausibly small.
    if test_mode():
        logger.warning(
            f"🧪 Test mode: skipping permits clear+insert entirely "
            f"({len(permits)} rows fetched; clearing would wipe the table)"
        )
        return {"status": "SKIPPED", "fetched": len(df), "upserted": 0, "duration": round(time.time() - start, 2)}

    if len(permits) < MIN_EXPECTED_PERMITS:
        msg = (
            f"Refusing to refresh permits: only {len(permits)} rows fetched, "
            f"expected at least {MIN_EXPECTED_PERMITS}. Table left untouched."
        )
        logger.error(f"🛑 {msg}")
        log_sync(endpoint_key, len(df), 0, 0, "ERROR", msg, time.time() - start)
        return {"status": "ABORTED", "fetched": len(df), "upserted": 0}

    count = load_and_promote("permits", permits, MIN_EXPECTED_PERMITS)
    if count is not None:
        link_permits_to_factories()
    if count is None:
        msg = "Staging load or promotion failed; permits left untouched."
        logger.error(f"🛑 {msg}")
        log_sync(endpoint_key, len(df), 0, 0, "ERROR", msg, time.time() - start)
        return {"status": "ABORTED", "fetched": len(df), "upserted": 0}

    duration = time.time() - start
    log_sync(endpoint_key, len(df), count, 0, "SUCCESS", None, duration)

    return {"status": "SUCCESS", "fetched": len(df), "upserted": count, "duration": round(duration, 2)}


def sync_statistics(endpoint_key: str) -> dict:
    """Sync summary statistics from Sum endpoints."""
    start = time.time()

    df = fetch_csv(endpoint_key)
    if df is None:
        log_sync(endpoint_key, 0, 0, 0, "ERROR", "Failed to fetch CSV", time.time() - start)
        return {"status": "ERROR", "fetched": 0, "upserted": 0}

    stats = transform_statistics(df, source=endpoint_key)

    # Same delete-then-insert shape as sync_permits, same hazard: a test run
    # cleared 1,621,380 statistics rows and inserted 200. Test mode does nothing.
    if test_mode():
        logger.warning(
            f"🧪 Test mode: skipping {endpoint_key} statistics clear+insert "
            f"({len(stats)} rows fetched; clearing would wipe this source)"
        )
        return {"status": "SKIPPED", "fetched": len(df), "upserted": 0, "duration": round(time.time() - start, 2)}

    # Replace only this source's slice, atomically. Each Sum_* endpoint owns
    # its own rows, so this must not touch the other one's.
    count = load_and_promote(
        "factory_statistics", stats, MIN_EXPECTED_STATISTICS, source=endpoint_key
    )
    if count is None:
        msg = f"Staging load or promotion failed; {endpoint_key} statistics left untouched."
        logger.error(f"🛑 {msg}")
        log_sync(endpoint_key, len(df), 0, 0, "ERROR", msg, time.time() - start)
        return {"status": "ABORTED", "fetched": len(df), "upserted": 0}

    duration = time.time() - start
    log_sync(endpoint_key, len(df), count, 0, "SUCCESS", None, duration)

    return {"status": "SUCCESS", "fetched": len(df), "upserted": count, "duration": round(duration, 2)}


def run_pipeline(target_endpoint: str | None = None) -> None:
    """
    Main pipeline orchestrator.
    Respects FK dependencies: businesses → factories → permits → statistics.
    """
    logger.info("=" * 60)
    logger.info("🚀 Factory Near Me — Daily Sync Pipeline")
    logger.info(f"🕐 Started at {datetime.now().isoformat()}")
    logger.info(f"🧪 Test mode: {'ON' if test_mode() else 'OFF'}")
    logger.info("=" * 60)

    pipeline_start = time.time()
    results = {}

    steps = [
        ("Factory_Data", sync_factory_data),
        ("Business_Location", sync_business_location),
        ("Factory_Operation_Permit", sync_permits),
        ("Sum_Factory_Local", lambda: sync_statistics("Sum_Factory_Local")),
        ("Sum_Status_Factory_Local", lambda: sync_statistics("Sum_Status_Factory_Local")),
    ]

    for step_name, step_fn in steps:
        if target_endpoint and step_name != target_endpoint:
            continue

        logger.info(f"\n{'─' * 40}")
        logger.info(f"📋 Step: {step_name}")
        logger.info(f"{'─' * 40}")

        try:
            result = step_fn()
            results[step_name] = result
            logger.info(f"✅ {step_name}: {result}")
        except Exception as e:
            logger.error(f"❌ {step_name} failed: {e}")
            results[step_name] = {"status": "ERROR", "error": str(e)}
            log_sync(step_name, 0, 0, 0, "ERROR", str(e), 0)

    # --- Update PostGIS geometry ---
    logger.info(f"\n{'─' * 40}")
    logger.info("🌍 Updating PostGIS geometry...")
    logger.info(f"{'─' * 40}")
    try:
        # Call the RPC function to update geometry
        supabase.rpc(
            "update_factory_geometry", {}
        ).execute()
        logger.info("✅ Geometry updated")
    except Exception as e:
        logger.warning(f"⚠️ Geometry update skipped (function may not exist yet): {e}")

    # --- Summary ---
    total_duration = time.time() - pipeline_start
    logger.info(f"\n{'=' * 60}")
    logger.info("📊 Pipeline Summary")
    logger.info(f"{'=' * 60}")
    for name, result in results.items():
        # SKIPPED is a deliberate no-op (test mode), not a failure — showing it
        # as ❌ made a correctly-guarded run look broken.
        status_icon = {"SUCCESS": "✅", "SKIPPED": "⏭️", "ABORTED": "🛑"}.get(result.get("status"), "❌")
        logger.info(f"  {status_icon} {name}: {result}")
    logger.info(f"  ⏱️ Total duration: {total_duration:.1f}s")
    logger.info(f"{'=' * 60}")


# =============================================================================
# CLI Entry Point
# =============================================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Factory Near Me — Daily Sync Pipeline")
    parser.add_argument(
        "--test",
        action="store_true",
        help="Run in test mode (limit records)",
    )
    parser.add_argument(
        "--endpoint",
        type=str,
        choices=list(ENDPOINTS.keys()),
        help="Sync only a specific endpoint",
    )
    args = parser.parse_args()

    if args.test:
        os.environ["SYNC_TEST_MODE"] = "true"
        logger.info("🧪 Test mode enabled via CLI flag")

    run_pipeline(target_endpoint=args.endpoint)
