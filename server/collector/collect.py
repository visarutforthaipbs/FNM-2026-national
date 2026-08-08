#!/usr/bin/env python3
"""
DIW raw snapshot collector.

Downloads each DIW OpenAPI endpoint verbatim and archives it, unmodified,
before anything interprets it. This is deliberately the dumbest component in
the system: it does not transform, it does not touch the application database,
and it has no opinion about what the data means.

Why it exists
-------------
Every data incident in this project shares one root cause: fetch, transform and
load were a single irreversible step that kept no raw record.

  * `factories.status` was populated from DIW's FFLAG/STATUS fields under an
    interpretation that turned out to be wrong. By the time that was noticed
    there was no archive to recompute from, so the field had to be frozen and
    a ~317-factory gap became permanent.
  * The long-trusted "63,701 operating factories" baseline came from a one-time
    seed nobody can reproduce.
  * When a sync produced surprising numbers there was no way to answer the only
    question that matters: did DIW change, or did we?

An archive answers all three. It also makes the open FFLAG/STATUS question
*empirical* rather than speculative — collect for a few weeks, diff the
snapshots, and watch which records transition.

What the transport actually gives us (measured 2026-08-08)
----------------------------------------------------------
  * Factory_Data is ~164 MB / 241,917 lines / 46 columns, ~16s from Thailand.
  * No Content-Length, no Last-Modified, no ETag on any endpoint.
  * Query parameters are silently ignored — `limit=10` still returns everything.

Two consequences drive the validation below. Without Content-Length, a
truncated download is indistinguishable from a small successful one at the HTTP
layer, so integrity has to be judged from the parsed content. And without
caching headers there is no conditional request: every collection is an
unconditional full pull, and "did this change?" can only be answered by hashing
what arrived.

Storage
-------
Snapshots are content-addressed: identical payloads are stored once and later
dates point at the same blob. DIW data changes slowly, so most days cost only a
manifest entry. Factory_Data compresses 164 MB -> ~27 MB.

Usage
-----
    python collect.py                    # collect every endpoint
    python collect.py --endpoint Factory_Data
    python collect.py --dry-run          # fetch + validate, store nothing
    python collect.py --list             # show what has been collected
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sync"))
from config import ENDPOINTS, FETCH_TIMEOUT  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("diw-collector")

ARCHIVE_ROOT = Path(os.getenv("DIW_ARCHIVE_ROOT", Path.home() / "diw-archive"))
BLOBS = ARCHIVE_ROOT / "blobs"
MANIFEST = ARCHIVE_ROOT / "manifest.jsonl"

# A snapshot is rejected if its parsed row count falls below this fraction of
# the previous accepted snapshot. DIW sends no Content-Length, so a truncated
# response arrives looking like a successful one — a sudden shortfall is the
# only signal we get. Growth is never suspicious; only collapse is.
MIN_ROW_RATIO = 0.90

# Guard against a stray HTML error page being archived as if it were data.
MIN_PLAUSIBLE_BYTES = 10_000

# Measured 2026-08-08 by fetching each endpoint twice, seconds apart.
#
# The three detail endpoints are byte-identical between calls — Factory_Data
# returned the same sha256 with zero differing lines — so deduplication works
# and a changed hash genuinely means DIW changed something.
#
# The two Sum_* endpoints are computed live and drift on every request:
# Sum_Factory_Local differed by 7 of 186,507 lines between back-to-back fetches.
# They will therefore never deduplicate, and a nonzero diff against them is not
# by itself evidence of anything. Worth knowing before someone reads 0.004%
# aggregate noise as a real-world signal.
STABLE_ENDPOINTS = {
    "Factory_Data": True,
    "Business_Location": True,
    "Factory_Operation_Permit": True,
    "Sum_Factory_Local": False,
    "Sum_Status_Factory_Local": False,
}

CHUNK = 1 << 20  # 1 MiB streaming chunks; never load 164 MB into memory at once


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_manifest() -> list[dict]:
    """Every accepted collection, oldest first. Append-only, one JSON per line."""
    if not MANIFEST.exists():
        return []
    entries = []
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                logger.warning("skipping malformed manifest line")
    return entries


def last_accepted(endpoint: str, entries: list[dict] | None = None) -> dict | None:
    entries = read_manifest() if entries is None else entries
    matches = [e for e in entries if e.get("endpoint") == endpoint and e.get("status") == "ok"]
    return matches[-1] if matches else None


def inspect_csv(path: Path) -> tuple[int, list[str]]:
    """
    Return (record count, column names) by actually parsing the CSV.

    Deliberately not a line count: DIW quotes fields containing newlines, so
    Factory_Data reports 241,917 lines for 241,588 records. Validating on lines
    would drift from what the loader eventually sees.
    """
    with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        try:
            header = next(reader)
        except StopIteration:
            return 0, []
        return sum(1 for _ in reader), [c.strip() for c in header]


def download(url: str, dest: Path) -> tuple[str, int, float]:
    """Stream to disk, hashing as we go. Returns (sha256, bytes, seconds)."""
    digest = hashlib.sha256()
    total = 0
    started = time.time()
    with requests.get(url, stream=True, timeout=FETCH_TIMEOUT) as resp:
        resp.raise_for_status()
        with gzip.open(dest, "wb", compresslevel=6) as out:
            for chunk in resp.iter_content(CHUNK):
                if not chunk:
                    continue
                digest.update(chunk)
                out.write(chunk)
                total += len(chunk)
    return digest.hexdigest(), total, time.time() - started


def collect_one(name: str, spec: dict, dry_run: bool = False) -> dict:
    """
    Collect a single endpoint.

    The snapshot is validated before it is allowed into the archive, because an
    archive that quietly accepts a truncated file is worse than no archive: it
    launders bad data into something that looks authoritative.
    """
    url = spec.get("download_url") or spec["url"]
    started_at = _utc_now()
    logger.info(f"📥 {name}: {url}")

    staging = ARCHIVE_ROOT / "staging" / f"{name}.csv.gz"
    staging.parent.mkdir(parents=True, exist_ok=True)

    try:
        sha, raw_bytes, seconds = download(url, staging)
    except Exception as exc:
        logger.error(f"❌ {name}: download failed: {exc}")
        staging.unlink(missing_ok=True)
        return {"endpoint": name, "collected_at": started_at, "status": "fetch_error", "error": str(exc)}

    stored = staging.stat().st_size
    logger.info(
        f"   {raw_bytes:,} B raw -> {stored:,} B gz ({raw_bytes / max(stored, 1):.1f}x) "
        f"in {seconds:.1f}s  sha256={sha[:12]}…"
    )

    if raw_bytes < MIN_PLAUSIBLE_BYTES:
        logger.error(f"❌ {name}: only {raw_bytes} B — an error page, not data. Rejected.")
        staging.unlink(missing_ok=True)
        return {"endpoint": name, "collected_at": started_at, "status": "too_small", "bytes": raw_bytes}

    try:
        rows, columns = inspect_csv(staging)
    except Exception as exc:
        logger.error(f"❌ {name}: not parseable as CSV: {exc}. Rejected.")
        staging.unlink(missing_ok=True)
        return {"endpoint": name, "collected_at": started_at, "status": "parse_error", "error": str(exc)}

    logger.info(f"   {rows:,} records, {len(columns)} columns")

    entries = read_manifest()
    previous = last_accepted(name, entries)
    result = {
        "endpoint": name,
        "collected_at": started_at,
        "url": url,
        "sha256": sha,
        "raw_bytes": raw_bytes,
        "stored_bytes": stored,
        "rows": rows,
        "columns": columns,
        "duration_s": round(seconds, 1),
    }

    if previous:
        # Schema drift is reported, never rejected: if DIW adds or renames a
        # column we want that snapshot captured — it is the evidence needed to
        # update the loader. Rejecting it would discard the only record of the
        # change.
        before, now = set(previous.get("columns") or []), set(columns)
        if before != now:
            added, removed = sorted(now - before), sorted(before - now)
            logger.warning(f"⚠️  {name}: SCHEMA CHANGE — added={added} removed={removed}")
            result["schema_change"] = {"added": added, "removed": removed}

        # Truncation, by contrast, is rejected. A short file is not evidence of
        # anything except a bad transfer, and archiving it would poison the
        # baseline that every later collection is compared against.
        floor = int((previous.get("rows") or 0) * MIN_ROW_RATIO)
        if rows < floor:
            logger.error(
                f"❌ {name}: {rows:,} records vs {previous['rows']:,} previously "
                f"(floor {floor:,}). Looks truncated — rejected, archive untouched."
            )
            staging.unlink(missing_ok=True)
            result.update({"status": "truncated", "previous_rows": previous["rows"]})
            if not dry_run:
                append_manifest(result)
            return result

    if dry_run:
        logger.info(f"🔎 {name}: dry run, discarding")
        staging.unlink(missing_ok=True)
        result["status"] = "dry_run"
        return result

    # Content-addressed: an unchanged day costs a manifest line, not 27 MB.
    blob = BLOBS / sha[:2] / f"{sha}.csv.gz"
    blob.parent.mkdir(parents=True, exist_ok=True)
    if blob.exists():
        logger.info(f"♻️  {name}: identical to an existing snapshot, deduplicated")
        staging.unlink(missing_ok=True)
        result["deduplicated"] = True
    else:
        shutil.move(str(staging), str(blob))
        result["deduplicated"] = False

    result["status"] = "ok"
    result["stable_source"] = STABLE_ENDPOINTS.get(name)
    result["blob"] = str(blob.relative_to(ARCHIVE_ROOT))
    if previous:
        result["rows_delta"] = rows - previous["rows"]
        result["changed"] = sha != previous.get("sha256")
    append_manifest(result)
    logger.info(f"✅ {name}: archived ({'changed' if result.get('changed', True) else 'unchanged'})")
    return result


def append_manifest(entry: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with MANIFEST.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def show_listing() -> None:
    entries = read_manifest()
    if not entries:
        print("No snapshots collected yet.")
        return
    print(f"{'collected (UTC)':<22} {'endpoint':<28} {'status':<11} {'rows':>10} {'delta':>9}  sha")
    print("-" * 100)
    for e in entries:
        delta = e.get("rows_delta")
        print(
            f"{e.get('collected_at','')[:19]:<22} {e.get('endpoint',''):<28} "
            f"{e.get('status',''):<11} {e.get('rows',0):>10,} "
            f"{('' if delta is None else format(delta, '+,')):>9}  {(e.get('sha256') or '')[:12]}"
        )
    total = sum(p.stat().st_size for p in BLOBS.rglob("*.csv.gz")) if BLOBS.exists() else 0
    blobs = len(list(BLOBS.rglob("*.csv.gz"))) if BLOBS.exists() else 0
    print(f"\n{len(entries)} manifest entries · {blobs} unique blobs · {total / 1e6:,.1f} MB on disk")


def main() -> int:
    ap = argparse.ArgumentParser(description="Archive raw DIW CSV snapshots.")
    ap.add_argument("--endpoint", help="Collect only this endpoint")
    ap.add_argument("--dry-run", action="store_true", help="Fetch and validate, store nothing")
    ap.add_argument("--list", action="store_true", help="Show collection history")
    args = ap.parse_args()

    if args.list:
        show_listing()
        return 0

    targets = {args.endpoint: ENDPOINTS[args.endpoint]} if args.endpoint else ENDPOINTS
    if args.endpoint and args.endpoint not in ENDPOINTS:
        logger.error(f"Unknown endpoint {args.endpoint!r}. Known: {', '.join(ENDPOINTS)}")
        return 2

    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    logger.info(f"📚 archive: {ARCHIVE_ROOT}")

    results = [collect_one(name, spec, args.dry_run) for name, spec in targets.items()]

    ok = [r for r in results if r["status"] in ("ok", "dry_run")]
    bad = [r for r in results if r["status"] not in ("ok", "dry_run")]
    logger.info("=" * 60)
    for r in results:
        icon = {"ok": "✅", "dry_run": "🔎"}.get(r["status"], "❌")
        logger.info(f"  {icon} {r['endpoint']}: {r['status']} ({r.get('rows', 0):,} rows)")
    logger.info(f"  {len(ok)}/{len(results)} collected")
    logger.info("=" * 60)

    # Non-zero exit so the systemd unit and any wrapper notice a bad night.
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
