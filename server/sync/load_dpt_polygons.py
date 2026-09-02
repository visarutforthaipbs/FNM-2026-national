#!/usr/bin/env python3
"""
Load DPT town-planning polygons into PostGIS on the government database.

Three tiers, from three DPT sources:

  municipal         ผังเมืองรวมเมือง/ชุมชน — 42,219 polygons harvested into
                    server/data/dpt_geodatabase.db by download_dpt_geodatabase.py.
                    Carries a land-use code, so it says what a point is zoned.

  province_landuse  ผังเมืองรวมจังหวัด — 32,193 polygons collected into
                    server/data/dpt_provincial.db by collect_dpt_provincial.py,
                    from PLLU_VIEW layer 5. Also carries a land-use code, plus
                    the numbered PL_BLOCK from DPT's printed plans.

  province          ผังเมืองรวมจังหวัด *footprints* from TOWNPLAN/TP_MAIN layer 2.
                    No land use at all — one polygon per plan, covering the whole
                    province. Kept only as the fallback for anywhere PLLU_PROV
                    publishes no polygon.

Precedence, applied by export_zoning.py: municipal, then province_landuse, then
province, then absence. The tiers overlap by construction — a provincial plan
covers the whole province including its town-plan areas — so they are consulted
in order and their counts are never summed.

Why the provincial tiers exist at all
-------------------------------------
`export_zoning.py` once reported 48,170 of 62,656 mapped factories (76.9%) as
having no DPT plan data, and nine provinces — ชลบุรี and ระยอง among them — as
having no coverage whatsoever. That was true of PLLU_ALL and false of DPT. We
were publishing our own harvest scope as an absence in the world.

Usage (runs on lighthouse-sev01 — Postgres is bound to loopback there):

    ./venv/bin/python load_dpt_polygons.py --tier province_landuse
    ./venv/bin/python load_dpt_polygons.py --tier all --dry-run
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import socket

import psycopg2
from psycopg2.extras import execute_batch
from dotenv import load_dotenv


def force_ipv4() -> None:
    """
    Resolve hostnames to IPv4 only, for the lifetime of this process.

    lighthouse-sev01 holds a public IPv6 address but has no working route to
    DPT over it: a connection to onedpt.dpt.go.th:443 sits in SYN-SENT until it
    times out. `curl` hides this — it implements Happy Eyeballs and falls back
    to IPv4 in ~0.12 s — so the host looks perfectly healthy from the shell
    while `urllib` hangs, because urllib tries the first address getaddrinfo
    returns and never tries the second.

    That is the same shape as COLLECTORS.md §2.4: the check that looks like it
    passed. Verified on 2026-09-02 — `curl -4` 200 in 0.12 s, `curl -6` never
    connects — and it cost a stalled harvest to find, so any future collector
    reaching a government service from this host should call this first.
    """
    original = socket.getaddrinfo

    def ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        return original(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = ipv4_only

REPO = Path(__file__).resolve().parents[2]
SQLITE_DB = REPO / "server" / "data" / "dpt_geodatabase.db"
ARCHIVE = REPO / "server" / "data" / "dpt-archive"

TP_MAIN_LAYER = (
    "https://onedpt.dpt.go.th/arcgis/rest/services/TOWNPLAN/TP_MAIN/MapServer/2"
)

# One request per second. DPT's ArcGIS is unauthenticated and has never blocked
# us, which is exactly why it deserves the same courtesy as the sources that
# did — COLLECTORS.md §2.1: one limiter, expressed as requests per second, not
# a sleep scattered through the callers.
REQUEST_INTERVAL = 1.0
REQUEST_TIMEOUT = 120
RETRIES = 3

# Circuit-breaker floors handed to dpt.promote_plan_polygons(). Set below the
# observed counts (42,219 municipal / 93 provincial) with room for ordinary
# movement, but far enough above zero that a service answering 200-with-no-
# features cannot promote an empty tier.
MIN_ROWS = {"municipal": 30_000, "province": 60, "province_landuse": 25_000}

# Built by collect_dpt_provincial.py, then coloured by derive_dpt_palette.py.
PROVINCIAL_DB = REPO / "server" / "data" / "dpt_provincial.db"

UA = "Mozilla/5.0 (compatible; factory-near-me/1.0; civic transparency)"

_last_request = 0.0


def _throttle() -> None:
    global _last_request
    wait = REQUEST_INTERVAL - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()


def fetch_json(url: str) -> dict:
    """
    Fetch one ArcGIS JSON response, refusing anything that is not JSON.

    A gateway's answer is not the service's answer (COLLECTORS.md §2.4): both
    DBD and DOL return HTTP 200 with an HTML challenge page, and code that
    checks only the status code believes it succeeded. DPT has never done this
    to us, but the cost of checking is one branch and the cost of not checking
    was weeks of a harvester reporting success while writing zero rows.
    """
    last_error = None
    for attempt in range(RETRIES):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                ctype = (res.headers.get("Content-Type") or "").lower()
                body = res.read()
            if "html" in ctype or body[:1] in (b"<",):
                raise RuntimeError(
                    f"expected JSON, got {ctype or 'unknown'} — a gateway answered, not the service"
                )
            payload = json.loads(body.decode("utf-8"))
            # ArcGIS reports application errors inside a 200.
            if isinstance(payload, dict) and "error" in payload:
                raise RuntimeError(f"ArcGIS error: {payload['error']}")
            return payload
        except Exception as e:  # noqa: BLE001 — retried, then re-raised below
            last_error = e
            if attempt < RETRIES - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"{url} failed after {RETRIES} attempts: {last_error}")


def archive(name: str, payload: dict) -> Path:
    """
    Write the raw response to disk before anything reads it.

    COLLECTORS.md §2.2, and DPT is the source that most needs it: HANDOFF §12.4
    records that `pipeline.py` archives nothing, so there is no way to replay a
    past DIW feed or say when its oscillation began. Zoning had the same gap.
    Re-scoring a rules change should cost seconds and zero requests, not a
    re-harvest of a government service that may not answer twice.
    """
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    path = ARCHIVE / f"{name}.json.gz"
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, path)  # atomic: a reader never sees a half-written archive
    return path


# ---------------------------------------------------------------------------
# Provincial tier — TOWNPLAN/TP_MAIN layer 2
# ---------------------------------------------------------------------------

# "ผังเมืองรวมจังหวัดระยอง (ปรับปรุงครั้งที่ 2)" -> "ระยอง"
PROVINCE_FROM_PLAN = re.compile(r"^ผังเมืองรวมจังหวัด\s*(.+?)\s*(?:\(.*\))?$")

# DPT's own test fixtures live under PROV_CODE 10, and shipping them would put
# a fake plan over the whole capital.
#
# The evidence, counted from a first harvest of all 93 features: 71 provinces
# hold exactly one plan each, with 71 distinct geometries. PROV_CODE 10 holds
# 22 records sharing ONE geometry — every combination of จัดทำ/ปรับปรุง/แก้ไข ×
# กรมฯ/อปท. × revisions 1-6. Four are named outright: three "ทดสอบสถานะ ไม่ใช้"
# ("test status, do not use") and one "ผังจัน". TP_MAIN's neighbouring layer 1
# is the same story for the same PROV_CODE — "ทดสอบ ไม่ใช้",
# "ผังนโยบายระดับจังหวัด (ทดสอบ)".
#
# It is also right on the law: Bangkok is planned under ผังเมืองรวม
# กรุงเทพมหานคร, made by the BMA, which is a different instrument from a
# ผังเมืองรวมจังหวัด. Bangkok factories keep their municipal zones from
# PLLU_ALL, which is the correct source for them.
TEST_FIXTURE_PROV_CODES = {"10"}


def province_of(plan_name: str) -> str | None:
    m = PROVINCE_FROM_PLAN.match((plan_name or "").strip())
    return m.group(1).strip() if m else None


def read_archived(oid: int) -> dict | None:
    path = ARCHIVE / f"tp_main_province_{oid}.json.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def fetch_province_footprints(from_archive: bool = False) -> list[dict]:
    """
    Fetch every ผังเมืองรวมจังหวัด footprint, one request per feature.

    Fetched individually rather than in one call because these are province
    outlines: ระยอง alone is 23,180 vertices / ~900 KB, so the whole layer is
    ~90 MB and a single request is a timeout waiting to happen. One feature per
    request also means one archive file per plan, which is the grain a later
    rules change wants to replay.

    `from_archive` replays those files instead of re-requesting. That is the
    whole point of archiving first (COLLECTORS.md §2.2): deciding that DPT's
    PROV_CODE 10 rows are test fixtures should cost seconds and zero requests,
    not another 93 calls to a government service.
    """
    if from_archive:
        object_ids = sorted(
            int(p.name.removeprefix("tp_main_province_").removesuffix(".json.gz"))
            for p in ARCHIVE.glob("tp_main_province_*.json.gz")
        )
        if not object_ids:
            raise SystemExit(f"no archive in {ARCHIVE} — run once without --from-archive")
        print(f"replaying {len(object_ids)} archived provincial plans (no requests)")
    else:
        ids = fetch_json(f"{TP_MAIN_LAYER}/query?where=1%3D1&returnIdsOnly=true&f=json")
        object_ids = sorted(ids.get("objectIds") or [])
        print(f"provincial plans published by DPT: {len(object_ids)}")

    records: list[dict] = []
    skipped_fixtures = 0
    for n, oid in enumerate(object_ids, 1):
        if from_archive:
            payload = read_archived(oid)
        else:
            url = (
                f"{TP_MAIN_LAYER}/query?where=OBJECTID%3D{oid}"
                "&outFields=*&returnGeometry=true&outSR=4326&f=geojson"
            )
            payload = fetch_json(url)
            archive(f"tp_main_province_{oid}", payload)
        feats = (payload or {}).get("features") or []
        if not feats:
            # Absence is a finding, not a row to invent (COLLECTORS.md §2.3).
            print(f"  [{n}/{len(object_ids)}] OBJECTID={oid}: no feature returned — skipped")
            continue
        for feat in feats:
            props = feat.get("properties") or {}
            plan_name = (props.get("TOWN_PLAN_NAME") or "").strip()
            prov_code = props.get("PROV_CODE") or None
            if prov_code in TEST_FIXTURE_PROV_CODES:
                skipped_fixtures += 1
                continue
            records.append(
                {
                    "tier": "province",
                    "source_id": str(props.get("OBJECTID") or oid),
                    "plan_name": plan_name or None,
                    "plan_code": (props.get("TOWN_PLAN_CODE") or None),
                    "prov_code": prov_code,
                    "province_th": province_of(plan_name),
                    "amphoe_th": None,
                    "plan_year": None,
                    "status_major": None,
                    # DOC_TYPE is the plan-making ACTION (จัดทำ / ปรับปรุง /
                    # แก้ไข), not a status. There is no field on this layer
                    # saying whether a plan is ประกาศบังคับใช้, so nothing
                    # downstream may claim one is in force.
                    "doc_type": (props.get("DOC_TYPE") or None),
                    "pl_use": None,
                    "pl_block": None,
                    "geometry": feat.get("geometry"),
                }
            )
        print(f"  [{n}/{len(object_ids)}] {plan_name or f'OBJECTID={oid}'}")
    if skipped_fixtures:
        print(f"  skipped {skipped_fixtures} DPT test-fixture rows "
              f"(PROV_CODE {'/'.join(sorted(TEST_FIXTURE_PROV_CODES))}) — see TEST_FIXTURE_PROV_CODES")
    return records


# ---------------------------------------------------------------------------
# Municipal tier — the SQLite geodatabase we already hold
# ---------------------------------------------------------------------------

def read_municipal() -> list[dict]:
    if not SQLITE_DB.exists():
        raise SystemExit(
            f"{SQLITE_DB} not found — run download_dpt_geodatabase.py first"
        )
    conn = sqlite3.connect(SQLITE_DB)
    rows = []
    bad_geometry = 0
    for (fid, pl_use, pl_block, name, cw_name, amphoe, year, status, geom_json) in conn.execute(
        """
        select fid, pl_use, pl_block, name, cw_name, amphoe_nam, year,
               status_maj, geometry_json
        from dpt_features
        """
    ):
        try:
            geom = json.loads(geom_json)
        except Exception:
            bad_geometry += 1
            continue

        def clean(v):
            # The geodatabase uses a single space where a value is absent —
            # 2,815 rows carry ' ' for NAME. Store null, so "we have no name"
            # and "the name is a space" stop being the same thing.
            s = (v or "").strip()
            return s or None

        rows.append(
            {
                "tier": "municipal",
                "source_id": str(fid),
                "plan_name": clean(name),
                "plan_code": None,
                "prov_code": None,
                "province_th": clean(cw_name),
                "amphoe_th": clean(amphoe),
                "plan_year": year or None,
                "status_major": clean(status),
                "doc_type": None,
                "pl_use": clean(pl_use),
                "pl_block": clean(pl_block),
                "geometry": geom,
            }
        )
    conn.close()
    if bad_geometry:
        print(f"  {bad_geometry} rows skipped: unparseable geometry")
    return rows


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------

def read_provincial_landuse() -> list[dict]:
    """
    ผังเมืองรวมจังหวัด with its land use, from the local collection.

    `plan_name` is left null: PLLU_PROV identifies a plan by `CB_ID`, not by
    name, and inventing "ผังเมืองรวมจังหวัด<province>" here would be writing a
    label DPT did not publish on this layer. The footprint tier already carries
    the real names, so the export joins them when it wants one.
    """
    if not PROVINCIAL_DB.exists():
        raise SystemExit(
            f"{PROVINCIAL_DB} not found — run collect_dpt_provincial.py first"
        )
    conn = sqlite3.connect(PROVINCIAL_DB)
    rows = []
    empty = 0
    for objectid, cb_id, pl_use, pl_block, geom_json in conn.execute(
        "select objectid, cb_id, pl_use, pl_block, geometry_json from provincial_features"
    ):
        try:
            geom = json.loads(geom_json)
        except Exception:
            empty += 1
            continue
        # Six of DPT's own rows are a Polygon with `coordinates: []` — verified
        # empty at full precision upstream, so this is their data quality, not
        # our generalisation. ST_GeomFromGeoJSON rejects them, so drop them
        # here and say how many rather than failing the load.
        if not geom.get("coordinates"):
            empty += 1
            continue
        rows.append({
            "tier": "province_landuse",
            "source_id": str(objectid),
            "plan_name": None,
            "plan_code": cb_id,
            "prov_code": None,
            "province_th": None,
            "amphoe_th": None,
            "plan_year": None,
            "status_major": None,
            "doc_type": None,
            "pl_use": pl_use,
            "pl_block": pl_block,
            "geometry": geom,
        })
    conn.close()
    if empty:
        print(f"  {empty} rows skipped: DPT published no geometry for them")
    return rows


def load_landuse_classes(conn) -> int:
    """DPT's own code -> label -> colour, from the collected legend swatches."""
    if not PROVINCIAL_DB.exists():
        return 0
    src = sqlite3.connect(PROVINCIAL_DB)
    try:
        classes = src.execute(
            "select pl_use, label, render_color, patterned from provincial_symbology"
        ).fetchall()
    except sqlite3.OperationalError:
        print("  provincial_symbology has no derived palette — run derive_dpt_palette.py")
        return 0
    src.close()

    payload = [
        {"pl_use": c, "label": lab or c, "color": col, "patterned": bool(pat)}
        for c, lab, col, pat in classes
    ]
    with conn.cursor() as cur:
        execute_batch(cur, """
            insert into dpt.landuse_class (pl_use, label, color, patterned)
            values (%(pl_use)s, %(label)s, %(color)s, %(patterned)s)
            on conflict (pl_use) do update set
                label = excluded.label, color = excluded.color,
                patterned = excluded.patterned, loaded_at = now()
        """, payload, page_size=200)
    conn.commit()
    print(f"  {len(payload)} land-use classes loaded into dpt.landuse_class")
    return len(payload)


INSERT = """
insert into dpt.plan_polygon_staging (
    tier, source_id, plan_name, plan_code, prov_code, province_th,
    amphoe_th, plan_year, status_major, doc_type, pl_use, pl_block, geom
) values (
    %(tier)s, %(source_id)s, %(plan_name)s, %(plan_code)s, %(prov_code)s, %(province_th)s,
    %(amphoe_th)s, %(plan_year)s, %(status_major)s, %(doc_type)s, %(pl_use)s, %(pl_block)s,
    -- ST_MakeValid before ST_Multi: DPT polygons contain self-intersections,
    -- and ST_Contains on an invalid geometry is undefined rather than merely
    -- wrong. Force2D because some rows carry a Z ordinate the column rejects.
    --
    -- ST_CollectionExtract(..., 3) is not optional. Repairing a bow-tie leaves
    -- a GeometryCollection of the polygons plus the degenerate lines and points
    -- that the self-intersection collapsed to, and ST_Multi does not coerce a
    -- collection — the load fails with "Geometry type (GeometryCollection) does
    -- not match column type (MultiPolygon)". Extracting type 3 keeps the areal
    -- parts, which are the only parts a point-in-polygon test can use; the
    -- discarded slivers have zero area and could never contain a factory.
    ST_Multi(ST_CollectionExtract(
        ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(%(geometry)s), 4326))), 3))
)
"""


def load(conn, tier: str, records: list[dict], dry_run: bool) -> int:
    if not records:
        print(f"  nothing to load for tier={tier}")
        return 0

    payload = [dict(r, geometry=json.dumps(r["geometry"])) for r in records]

    with conn.cursor() as cur:
        cur.execute("delete from dpt.plan_polygon_staging where tier = %s", (tier,))
        execute_batch(cur, INSERT, payload, page_size=500)
        cur.execute(
            "select count(*) from dpt.plan_polygon_staging where tier = %s", (tier,)
        )
        staged = cur.fetchone()[0]
        print(f"  staged {staged:,} polygons")

        if dry_run:
            conn.rollback()
            print("  dry run — staging rolled back, live table untouched")
            return 0

        cur.execute(
            "select dpt.promote_plan_polygons(%s, %s)", (tier, MIN_ROWS[tier])
        )
        promoted = cur.fetchone()[0]
    conn.commit()
    print(f"  promoted {promoted:,} polygons into dpt.plan_polygon (tier={tier})")
    return promoted


def report_provinces(conn) -> None:
    """Say plainly what each tier now covers, counted from the table."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select tier, count(*), count(distinct province_th)
            from dpt.plan_polygon group by tier order by tier
            """
        )
        for tier, n, provinces in cur.fetchall():
            print(f"  {tier:<10} {n:>7,} polygons across {provinces} provinces")

        # A provincial plan whose name we could not parse into a province is a
        # row we cannot join to anything. Surface it rather than let it sit.
        cur.execute(
            "select plan_name from dpt.plan_polygon where tier='province' and province_th is null"
        )
        unparsed = [r[0] for r in cur.fetchall()]
        if unparsed:
            print(f"  ⚠️  {len(unparsed)} provincial plans with no parseable province:")
            for name in unparsed:
                print(f"       {name!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--tier",
                    choices=["municipal", "province", "province_landuse", "all"],
                    default="all")
    ap.add_argument("--dry-run", action="store_true",
                    help="Stage and count, then roll back without promoting")
    ap.add_argument("--from-archive", action="store_true",
                    help="Replay the archived DPT responses instead of re-requesting them")
    ap.add_argument("--dsn", default=None,
                    help="Postgres DSN (defaults to DATABASE_URL in server/.env)")
    args = ap.parse_args()

    force_ipv4()
    load_dotenv(REPO / "server" / ".env")
    dsn = args.dsn or os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set (server/.env) and --dsn was not given", file=sys.stderr)
        return 1

    tiers = (["municipal", "province", "province_landuse"]
             if args.tier == "all" else [args.tier])

    conn = psycopg2.connect(dsn)
    try:
        for tier in tiers:
            print(f"\n── {tier} ──")
            if tier == "municipal":
                records = read_municipal()
            elif tier == "province_landuse":
                records = read_provincial_landuse()
                load_landuse_classes(conn)
            else:
                records = fetch_province_footprints(from_archive=args.from_archive)
            print(f"  {len(records):,} polygons read")
            load(conn, tier, records, args.dry_run)

        print("\n── coverage now in dpt.plan_polygon ──")
        report_provinces(conn)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
