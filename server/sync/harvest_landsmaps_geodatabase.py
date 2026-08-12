#!/usr/bin/env python3
"""
DOL LandsMaps land-title-deed parcel harvester.

Resolves a factory's title deed number to the parcel's coordinates, area and
appraised value, into a local SQLite geodatabase. Roughly 8,700 unmapped
factories carry a deed number in their DIW address, which is often the only
locating information they have.

Why the previous version collected nothing
------------------------------------------
Two faults compounded. LandsMaps sits behind Incapsula, whose challenge takes
about ten seconds to clear; the harvester waited exactly ten and then began. And
when the challenge has not cleared, `GetJWTAccessToken` answers **HTTP 200 with
an HTML challenge page** rather than an error — so `res.ok` is true, JSON.parse
quietly yields no token, no parcel request is ever sent, and the run reports
success having written nothing. A fixed sleep against a variable challenge, with
a failure mode that looks like success.

So this waits for the token endpoint to actually return JSON rather than
guessing, and treats an HTML answer as what it is: not yet through the gate.

Politeness
----------
One central RateLimiter shared by the whole run, the same gate used for the DBD
collectors — a request rate we choose, not a sleep between batches. The previous
version fired twenty requests inside one JS loop with a one-second pause between
batches, which is the burst pattern these gateways exist to stop.

Usage:
    python server/sync/harvest_landsmaps_geodatabase.py --limit 50
    python server/sync/harvest_landsmaps_geodatabase.py            # all of them
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[2]
# The proven rate limiter, rather than a second implementation that drifts.
sys.path.insert(0, str(REPO / "server" / "collector"))
from dbd_resolve import RateLimiter  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
logger = logging.getLogger("landsmaps")

DEFAULT_DB = REPO / "server" / "data" / "dol_parcels_geodatabase.db"
DEFAULT_INPUT = REPO / "server" / "data" / "landsmaps_resolved.json"
BASE = "https://landsmaps.dol.go.th"

# DOL is a smaller service than DBD and this is a bulk read of public records.
# Slow by default; the run is long but it only has to happen once.
DEFAULT_RATE = 0.5

# How long to let Incapsula's challenge run before giving up on this session.
CHALLENGE_TIMEOUT = 90


class Blocked(RuntimeError):
    """The gateway answered instead of the service."""


class Harvester:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS parcels (
                    key TEXT PRIMARY KEY,
                    factory_id TEXT, pvcode TEXT, amcode TEXT,
                    parcel_no TEXT, land_no TEXT, survey_no TEXT, utmmap TEXT,
                    province TEXT, district TEXT,
                    lat REAL, lng REAL,
                    area_rai INTEGER, area_ngan INTEGER, area_wa REAL,
                    appraisal_price REAL,
                    raw_json TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            # `outcome` is the column the previous schema lacked, and the reason
            # its rows would have been unreadable: without it a row with no
            # coordinates could equally mean "DOL has no such parcel" or "the
            # request failed", and the two need opposite follow-ups.
            cols = {r[1] for r in conn.execute("PRAGMA table_info(parcels)")}
            if "outcome" not in cols:
                conn.execute("ALTER TABLE parcels ADD COLUMN outcome TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_factory_id ON parcels(factory_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_parcel ON parcels(pvcode, amcode, parcel_no)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_coords ON parcels(lat, lng)")
            conn.commit()

    def settled(self) -> set[str]:
        """
        Factory ids that need no further request.

        An error is not settled: a failed request means we do not know, and
        baking that in as a permanent gap is how a transient block becomes a
        missing factory forever.
        """
        with sqlite3.connect(self.db_path) as conn:
            return {r[0] for r in conn.execute(
                "SELECT factory_id FROM parcels WHERE outcome IN ('found','not_found')"
            )}

    def save(self, item: dict, outcome: str, parcel: dict | None, raw) -> None:
        key = f"{item['id']}_{item['pvcode']}_{item['amcode']}_{item['deed_no']}"
        parcel = parcel or {}
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT INTO parcels (key, factory_id, pvcode, amcode, parcel_no,
                    land_no, survey_no, utmmap, province, district, lat, lng,
                    area_rai, area_ngan, area_wa, appraisal_price, raw_json, outcome)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(key) DO UPDATE SET
                    lat = excluded.lat, lng = excluded.lng,
                    area_rai = excluded.area_rai, area_ngan = excluded.area_ngan,
                    area_wa = excluded.area_wa,
                    appraisal_price = excluded.appraisal_price,
                    raw_json = excluded.raw_json, outcome = excluded.outcome
            """, (
                key, item["id"], item["pvcode"], item["amcode"], item["deed_no"],
                item.get("land_no"), item.get("survey_no"),
                parcel.get("utm") or item.get("utm_map"),
                item.get("province"), item.get("district"),
                _f(parcel.get("parcellat")), _f(parcel.get("parcellon")),
                _i(parcel.get("rai")), _i(parcel.get("ngan")), _f(parcel.get("wa")),
                _f(parcel.get("price")),
                json.dumps(raw, ensure_ascii=False) if raw is not None else None,
                outcome,
            ))
            conn.commit()

    def stats(self) -> dict:
        with sqlite3.connect(self.db_path) as conn:
            rows = dict(conn.execute(
                "SELECT COALESCE(outcome,'?'), COUNT(*) FROM parcels GROUP BY 1"))
            coords = conn.execute(
                "SELECT COUNT(*) FROM parcels WHERE lat IS NOT NULL").fetchone()[0]
        rows["with_coordinates"] = coords
        return rows


def _f(v) -> Optional[float]:
    try:
        return float(v) if v not in (None, "", "-") else None
    except (TypeError, ValueError):
        return None


def _i(v) -> Optional[int]:
    f = _f(v)
    return int(f) if f is not None else None


def lookup(session, item) -> tuple[str, dict | None, object]:
    """
    One parcel lookup: GET with the identifiers in the path.

    The previous version sent a POST with a JSON body, which this endpoint does
    not accept — one of the reasons it never returned anything.
    """
    url = (f"{BASE}/apiService/LandsMaps/GetParcelByParcelNo/"
           f"{item['pvcode']}/{item['amcode']}/{item['deed_no']}")
    r = session.get(url, timeout=45)
    ct = (r.headers.get("content-type") or "").lower()

    if r.status_code == 401:
        return "unauthorized", None, {"status": 401}
    if "application/json" not in ct:
        # Incapsula answers 200 with HTML; the body is the only honest signal.
        return "blocked", None, {"status": r.status_code, "ct": ct, "body": r.text[:400]}

    data = r.json()
    result = data.get("result") if isinstance(data, dict) else None
    parcel = result[0] if isinstance(result, list) and result else None
    if parcel and _f(parcel.get("parcellat")) is not None:
        return "found", parcel, data
    return "not_found", parcel, data


def run(limit: int, rate: float, headless: bool, db_path: Path, input_path: Path) -> int:
    import dol_session

    if not input_path.exists():
        logger.error(f"{input_path} not found — run geocode_by_landsmaps.py first")
        return 2
    records = json.loads(input_path.read_text(encoding="utf-8"))

    harvester = Harvester(db_path)
    done = harvester.settled()
    todo = [r for r in records
            if r.get("pvcode") and r.get("amcode") and r.get("deed_no")
            and r["id"] not in done]
    if limit > 0:
        todo = todo[:limit]

    logger.info(f"{len(records):,} deed records · {len(done):,} already settled · "
                f"{len(todo):,} to fetch at {rate} req/s")
    if not todo:
        logger.info(f"nothing to do — {harvester.stats()}")
        return 0

    session = dol_session.acquire(headless=headless)
    if session is None:
        logger.error("could not establish a session; nothing was written")
        return 1
    http = session.requests_session()

    limiter = RateLimiter(rate)
    counts = {"found": 0, "not_found": 0, "error": 0}
    remints = 0
    started = time.time()

    for n, item in enumerate(todo, 1):
        limiter.acquire()
        try:
            outcome, parcel, raw = lookup(http, item)
        except Exception as exc:
            counts["error"] += 1
            harvester.save(item, "error", None, {"exception": str(exc)[:300]})
            limiter.penalise()
            continue

        # A token lasts a while but not forever, and the gateway can step back
        # in. Either way the cure is a fresh session, which costs one browser
        # run — so it is done in the loop rather than ending the harvest.
        if outcome in ("unauthorized", "blocked"):
            limiter.penalise(hard=True)
            remints += 1
            logger.warning(f"{item['id']}: session {outcome} after {session.age()/60:.0f} min "
                           f"— re-establishing ({remints})")
            if remints > 8:
                logger.error("too many re-establishments; stopping rather than knocking harder")
                harvester.save(item, "error", None, {"gave_up_after": outcome})
                break
            session = dol_session.acquire(headless=headless, reuse=False)
            if session is None:
                logger.error("could not re-establish; progress is saved, rerun later")
                break
            http = session.requests_session()
            limiter.acquire()
            try:
                outcome, parcel, raw = lookup(http, item)
            except Exception as exc:
                counts["error"] += 1
                harvester.save(item, "error", None, {"exception": str(exc)[:300]})
                continue
            if outcome in ("unauthorized", "blocked"):
                counts["error"] += 1
                harvester.save(item, "error", None, raw)
                continue

        counts[outcome if outcome in counts else "error"] += 1
        harvester.save(item, outcome, parcel, raw)
        limiter.ok()

        if n % 25 == 0:
            speed = n / max(time.time() - started, 1e-9)
            eta = (len(todo) - n) / max(speed, 1e-9) / 60
            logger.info(f"  {n:,}/{len(todo):,} — {speed:.2f}/s — ETA {eta:.0f} min — "
                        f"found={counts['found']:,} none={counts['not_found']:,} "
                        f"err={counts['error']:,}")

    logger.info("=" * 56)
    for k, v in counts.items():
        logger.info(f"  {k:<10}{v:>8,}")
    logger.info(f"  {'re-mints':<10}{remints:>8,}")
    logger.info(f"database: {harvester.stats()}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Harvest DOL land-title-deed parcels.")
    ap.add_argument("--limit", type=int, default=0, help="0 = everything outstanding")
    ap.add_argument("--rate", type=float, default=DEFAULT_RATE, help="requests/sec")
    ap.add_argument("--headless", action="store_true",
                    help="No visible window. The challenge often needs a real one.")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    args = ap.parse_args()
    return run(args.limit, args.rate, args.headless, args.db, args.input)


if __name__ == "__main__":
    sys.exit(main())
