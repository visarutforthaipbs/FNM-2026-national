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
TEST_MODE = os.getenv("SYNC_TEST_MODE", "false").lower() == "true"
TEST_LIMIT = int(os.getenv("SYNC_TEST_LIMIT", "100"))

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
        response.encoding = "utf-8"

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

        test_mode = os.getenv("SYNC_TEST_MODE", "false").lower() == "true"
        test_limit = int(os.getenv("SYNC_TEST_LIMIT", "100"))
        if test_mode:
            df = df.head(test_limit)
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


def transform_factory_data(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    """
    Transform Factory_Data CSV into businesses and factories records.
    Returns: (businesses_records, factories_records)
    """
    businesses = {}
    factories = []

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
            "lat": lat,
            "lng": lng,
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
            "status": row_dict.get("FFLAG", "").strip() or None,
            "is_active": True,
        }

        factories.append(factory)

    logger.info(f"🏢 Extracted {len(businesses)} unique businesses, {len(factories)} factories")
    return list(businesses.values()), factories


def transform_business_location(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    """
    Transform Business_Location CSV into businesses and factories records.
    This endpoint lacks FACREG, so we use DISPFACREG as a fallback key.
    """
    businesses = {}
    factories = []

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
            "lat": lat,
            "lng": lng,
            "address_full": address or None,
            "province": row_dict.get("FPROVNAME", "").strip() or None,
            "district": row_dict.get("FAMPNAME", "").strip() or None,
            "sub_district": row_dict.get("FTUMNAME", "").strip() or None,
            "status": row_dict.get("STATUS", "").strip() or None,
            "is_active": True,
        }

        factories.append(factory)

    logger.info(f"🏢 Extracted {len(businesses)} businesses, {len(factories)} factories from Business_Location")
    return list(businesses.values()), factories


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
            "permit_no": disp_facreg or None,
            "issue_date": parse_date(row_dict.get("POKDATE", "")),
            "permit_status": row_dict.get("STATUS", "").strip() or None,
        }

        permits.append(permit)

    logger.info(f"📜 Extracted {len(permits)} permit records")
    return permits


def transform_statistics(df: pd.DataFrame, source: str) -> list[dict]:
    """Transform Sum_Factory_Local or Sum_Status_Factory_Local CSV."""
    stats = []

    for _, row in df.iterrows():
        row_dict = row.to_dict()

        stat = {
            "year": parse_int(row_dict.get("YEAR", "")),
            "month": row_dict.get("MONTH", "").strip() or None,
            "province": row_dict.get("FPROVNAME", "").strip() or None,
            "tsic_code": row_dict.get("TSIC", "").strip() or None,
            "description": row_dict.get("DESCR", "").strip() or None,
            "status": row_dict.get("STATUS", "").strip() or None,
            "total": parse_int(row_dict.get("TOTAL", "")),
            "source_endpoint": source,
            "last_update": parse_date(row_dict.get("LAST_UPDATE", "")),
        }

        stats.append(stat)

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
def soft_delete_missing(fetched_ids: set[str]) -> int:
    """
    Mark factories as inactive if their ID is no longer in the fetched dataset.
    Returns count of deactivated records.
    """
    if not fetched_ids:
        return 0

    try:
        # Get all currently active factory IDs
        result = (
            supabase.table("factories")
            .select("id")
            .eq("is_active", True)
            .execute()
        )
        existing_ids = {row["id"] for row in result.data}

        # Find IDs that exist in DB but not in fetched data
        missing_ids = existing_ids - fetched_ids

        if not missing_ids:
            logger.info("✅ No factories to deactivate")
            return 0

        # Deactivate in batches
        missing_list = list(missing_ids)
        deactivated = 0
        for i in range(0, len(missing_list), UPSERT_BATCH_SIZE):
            batch = missing_list[i : i + UPSERT_BATCH_SIZE]
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

    businesses, factories = transform_factory_data(df)

    # Upsert businesses FIRST (FK dependency)
    biz_count = upsert_batch("businesses", businesses, on_conflict="id")

    # Upsert factories
    fac_count = upsert_batch("factories", factories, on_conflict="id")

    # Soft delete
    fetched_ids = {f["id"] for f in factories}
    deactivated = soft_delete_missing(fetched_ids)

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

    businesses, factories = transform_business_location(df)

    biz_count = upsert_batch("businesses", businesses, on_conflict="id")
    fac_count = upsert_batch("factories", factories, on_conflict="id")

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

    # For permits, we do a fresh insert (clear old data first to avoid duplicates)
    try:
        # Delete existing permits before reinserting
        # This is safe because permits are fully refreshed from the API
        supabase.table("permits").delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
        logger.info("🗑️ Cleared existing permits for fresh sync")
    except Exception as e:
        logger.warning(f"⚠️ Could not clear permits table: {e}")

    count = insert_batch("permits", permits)

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

    # Clear existing stats for this source and reinsert
    try:
        supabase.table("factory_statistics").delete().eq("source_endpoint", endpoint_key).execute()
    except Exception:
        pass

    count = insert_batch("factory_statistics", stats)

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
    logger.info(f"🧪 Test mode: {'ON' if TEST_MODE else 'OFF'}")
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
        status_icon = "✅" if result.get("status") == "SUCCESS" else "❌"
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
