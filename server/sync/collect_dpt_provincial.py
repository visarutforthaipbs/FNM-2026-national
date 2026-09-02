#!/usr/bin/env python3
"""
Collect ผังเมืองรวมจังหวัด — DPT's provincial land-use polygons.

What this is, and why it exists
-------------------------------
DPT publishes town planning in two tiers. We already hold the municipal one
(PLLU_ALL — ผังเมืองรวมเมือง/ชุมชน, 42,219 polygons). This collects the other:
`PLLU_PROV`, **32,193 polygons across 76 plan areas**, carrying a real land-use
code (`PL_USE`) and the numbered block (`PL_BLOCK`) that appears on DPT's own
printed plans — 1.x ชุมชน, 2.x ชนบทและเกษตรกรรม, 3.x อนุรักษ์ชนบทและเกษตรกรรม,
4.x อนุรักษ์ป่าไม้, 5.x ที่โล่งเพื่อการรักษาคุณภาพสิ่งแวดล้อม.

It matters because 39,655 mapped factories — 63% of everything on the map — sit
inside a provincial plan whose zoning we could not read. They were being told
"ไม่มีข้อมูลผังเมือง" and then, after the footprint tier landed, "we know a plan
covers you but not what it says". This layer is what it says.

The route, and why the obvious one fails
----------------------------------------
The layer lives on `onedptgis.dpt.go.th` and answers `499 Token Required` when
called directly. DPT's own public viewer reaches it through a bare pass-through
proxy on `landuseplan.dpt.go.th`, which supplies the token server-side and
requires no credential from the caller:

    GET {PROXY}?{full upstream URL, query string and all, unencoded}

That is the documented-by-behaviour public path of a public land-use map, and
it is the one used here. Note what is NOT used: the viewer's bundle also ships a
`clientId`/`clientSecret` for its stored-procedure API. We do not touch it —
this needs no credential, so scraping one would be gratuitous.

A near-identical name on a different host is an empty decoy that cost a whole
session: `onedpt.dpt.go.th/.../DPT_LANDUSE_NON/PLLU_VIEW` exists, answers 200,
and reports `layers: []`. If you are getting no layers, check the host and the
`_NON` suffix before concluding the route is closed.

Design notes
------------
- **f=geojson, not f=json.** ArcGIS `rings` need ring-orientation logic to
  become valid GeoJSON; the service will emit GeoJSON itself, so we let it.
- **`maxAllowableOffset` is doing real work.** Raw geometry is ~309 KB/feature
  (~10 GB for the layer). Generalised to ~5.5 m it is ~15 KB/feature. Our
  factory coordinates are frequently tambon centroids at ±2–5 km, so 5.5 m of
  boundary generalisation is far below the noise floor of the question we ask
  of these polygons.
- **Fetch ids first, then geometry by id.** Slower than blind `resultOffset`
  paging, but it yields an exact expected count per plan area, so a short read
  is detectable instead of silent. HANDOFF §12.2 is the cautionary tale: an
  unordered OFFSET page over a table being rewritten returned 169,413 of
  274,422 rows and looked fine.

Usage:
    python collect_dpt_provincial.py                 # full collect
    python collect_dpt_provincial.py --limit 3       # first 3 plan areas
    python collect_dpt_provincial.py --from-archive  # rebuild db, no requests
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import socket
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ARCHIVE = REPO / "server" / "data" / "dpt-archive" / "provincial"
DB_PATH = REPO / "server" / "data" / "dpt_provincial.db"

PROXY = "https://landuseplan.dpt.go.th/webservices/api/appproxy"
LAYER = "https://onedptgis.dpt.go.th/arcgis/rest/services/DPT_LANDUSE/PLLU_VIEW/MapServer/5"
REFERER = "https://landuseplan.dpt.go.th/map/"
UA = "Mozilla/5.0 (compatible; factory-near-me/1.0; civic transparency)"

# ~5.5 m at this latitude. See the design note above.
MAX_ALLOWABLE_OFFSET = 0.00005

# Features per geometry request. 200 keeps a response around 3 MB, which is
# large enough to be efficient and small enough that one failure is cheap.
CHUNK = 200

# One request per second, one gate for the whole process — COLLECTORS.md §2.1.
# This is somebody's public map server and the whole job is a few hundred calls,
# so there is nothing to gain by going faster.
REQUEST_INTERVAL = 1.0
REQUEST_TIMEOUT = 180
RETRIES = 4

_last_request = 0.0


def force_ipv4() -> None:
    """
    Resolve to IPv4 only. lighthouse-sev01 has a public IPv6 address and no
    route to DPT over it, so urllib sits in SYN-SENT until timeout while curl
    (Happy Eyeballs) succeeds in 0.12 s and makes the host look healthy. Cost a
    stalled harvest once already; see COLLECTORS.md §5.
    """
    original = socket.getaddrinfo

    def ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        return original(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = ipv4_only


def _throttle() -> None:
    global _last_request
    wait = REQUEST_INTERVAL - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()


def proxied(upstream: str) -> str:
    """
    The proxy takes the target URL as its raw query string — target `?` and `&`
    stay literal. Encoding them turns the upstream's parameters into the
    proxy's own and it returns an HTML error page, not JSON.
    """
    return f"{PROXY}?{upstream}"


def fetch(upstream: str, expect_json: bool = True) -> dict:
    """
    One proxied request, with the gateway/service distinction COLLECTORS.md §2.4
    insists on: this proxy answers HTML on failure, and `res.status == 200` says
    nothing about whether the service was reached.
    """
    last_error = None
    for attempt in range(RETRIES):
        _throttle()
        try:
            req = urllib.request.Request(
                proxied(upstream), headers={"User-Agent": UA, "Referer": REFERER}
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as res:
                ctype = (res.headers.get("Content-Type") or "").lower()
                body = res.read()
            if not expect_json:
                return {"_raw": body}
            if "html" in ctype or body[:1] == b"<":
                raise RuntimeError(
                    f"expected JSON, got {ctype or 'unknown'} — the gateway answered, not the service"
                )
            payload = json.loads(body.decode("utf-8"))
            if isinstance(payload, dict) and "error" in payload:
                raise RuntimeError(f"ArcGIS error: {payload['error']}")
            return payload
        except Exception as e:  # noqa: BLE001 — retried, re-raised below
            last_error = e
            if attempt < RETRIES - 1:
                # Back off hard. A 000/connection reset from this proxy means we
                # are asking too often, and retrying immediately makes it worse.
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed after {RETRIES} attempts: {last_error}")


def archive(name: str, payload) -> Path:
    """Raw response to disk before anything reads it (COLLECTORS.md §2.2)."""
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    path = ARCHIVE / f"{name}.json.gz"
    tmp = path.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, path)   # atomic: never a half-written archive
    return path


def read_archive(name: str):
    path = ARCHIVE / f"{name}.json.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def q(params: dict) -> str:
    return f"{LAYER}/query?" + urllib.parse.urlencode(params)


# Polygons DPT publishes with no CB_ID. They belong to no plan area, but they
# are real land-use polygons and a factory can stand on one, so they are
# collected under this sentinel rather than dropped. Counted: 239, which is
# exactly the difference between the layer's own total (32,193) and the sum of
# the per-plan-area id lists (31,954) — so with these the collection is
# complete and the arithmetic closes.
UNASSIGNED = "__unassigned__"


def where_for(cb_id: str) -> str:
    return "CB_ID IS NULL OR CB_ID=' '" if cb_id == UNASSIGNED else f"CB_ID='{cb_id}'"


def discover_plan_areas(from_archive: bool) -> list[str]:
    """The CB_ID of every plan area in the layer. CB_ID is DPT's plan id."""
    name = "cb_ids"
    payload = read_archive(name) if from_archive else None
    if payload is None:
        payload = fetch(q({
            "where": "1=1",
            "outFields": "CB_ID",
            "returnDistinctValues": "true",
            "returnGeometry": "false",
            "f": "json",
        }))
        archive(name, payload)
    raw = {(f["attributes"].get("CB_ID") or "").strip() for f in payload.get("features", [])}
    ids = sorted(i for i in raw if i)
    if len(raw) > len(ids):          # a blank appeared in the distinct list
        ids.append(UNASSIGNED)
    return ids


def collect_metadata(from_archive: bool) -> dict:
    """
    The layer definition and legend, which together carry DPT's own
    code -> label -> colour mapping. Taking the palette from the publisher
    rather than inventing one is the difference between reporting a plan and
    illustrating it.
    """
    meta = read_archive("layer5") if from_archive else None
    if meta is None:
        meta = fetch(f"{LAYER}?f=json")
        archive("layer5", meta)

    legend = read_archive("legend") if from_archive else None
    if legend is None:
        legend = fetch(f"{LAYER.rsplit('/', 1)[0]}/legend?f=json")
        archive("legend", legend)
    return {"layer": meta, "legend": legend}


def strip_code_prefix(label: str, code: str) -> str:
    """DPT labels its classes "4400 ชุมชน"; we store the code separately."""
    label = (label or "").strip()
    if code and label.startswith(code):
        label = label[len(code):].strip()
    return label


def extract_symbology(meta: dict) -> list[dict]:
    """
    code -> label, plus everything we know about how DPT draws it.

    Both the renderer and the legend are kept, because they disagree and the
    disagreement matters. `drawingInfo.renderer` calls 7180 อนุรักษ์ป่าไม้ a
    solid white fill; DPT's own `export` draws it as a green diagonal hatch, and
    8700 likewise. So the renderer is NOT what the map paints — the legend
    swatch is, since the service rasterises it from the symbology actually in
    use.

    Rather than pick one now and be wrong, this stores the renderer's fill and
    outline *and* the base64 swatch. The swatch is the ground truth for any
    palette we build, and having it on disk means settling that question costs
    an image decode rather than another round of requests against someone
    else's map server.
    """
    out: dict[str, dict] = {}

    renderer = ((meta.get("layer") or {}).get("drawingInfo") or {}).get("renderer") or {}
    for info in renderer.get("uniqueValueInfos") or []:
        code = str(info.get("value") or "").strip()
        if not code:
            continue
        sym = info.get("symbol") or {}

        def as_hex(rgba):
            if isinstance(rgba, list) and len(rgba) >= 3:
                return "#{:02X}{:02X}{:02X}".format(*rgba[:3])
            return None

        out[code] = {
            "code": code,
            "label": strip_code_prefix(info.get("label") or "", code) or None,
            "color": as_hex(sym.get("color")),
            "style": sym.get("style"),
            "outline_color": as_hex((sym.get("outline") or {}).get("color")),
            "swatch": None,
        }

    for lyr in (meta.get("legend") or {}).get("layers", []):
        if lyr.get("layerId") != 5:
            continue
        for item in lyr.get("legend", []):
            label = (item.get("label") or "").strip()
            if not label:
                continue
            code, _, text = label.partition(" ")
            code = code.strip()
            if not code:
                continue
            entry = out.setdefault(code, {
                "code": code, "label": None, "color": None,
                "style": None, "outline_color": None, "swatch": None,
            })
            if not entry.get("label"):
                entry["label"] = text.strip() or label
            # What the service actually rasterises for this class.
            entry["swatch"] = item.get("imageData")
    return sorted(out.values(), key=lambda e: e["code"])


# ---------------------------------------------------------------------------
# Harvest
# ---------------------------------------------------------------------------

def object_ids_for(cb_id: str, from_archive: bool) -> list[int]:
    name = f"ids_{cb_id}"
    payload = read_archive(name) if from_archive else None
    if payload is None:
        payload = fetch(q({
            "where": where_for(cb_id),
            "returnIdsOnly": "true",
            "f": "json",
        }))
        archive(name, payload)
    return sorted(payload.get("objectIds") or [])


def features_for(cb_id: str, oids: list[int], from_archive: bool) -> list[dict]:
    """Geometry in id-keyed chunks, so a short read is arithmetic, not a guess."""
    features: list[dict] = []
    for i in range(0, len(oids), CHUNK):
        chunk = oids[i : i + CHUNK]
        name = f"geo_{cb_id}_{i // CHUNK:03d}"
        payload = read_archive(name) if from_archive else None
        if payload is None:
            payload = fetch(q({
                "objectIds": ",".join(str(o) for o in chunk),
                "outFields": "OBJECTID,CB_ID,PL_USE,PL_BLOCK",
                "returnGeometry": "true",
                "outSR": "4326",
                "maxAllowableOffset": str(MAX_ALLOWABLE_OFFSET),
                "f": "geojson",
            }))
            archive(name, payload)
        features.extend(payload.get("features") or [])
    return features


# ---------------------------------------------------------------------------
# Local store
# ---------------------------------------------------------------------------

SCHEMA = """
create table if not exists provincial_features (
    objectid       integer primary key,
    cb_id          text,
    pl_use         text,
    pl_block       text,
    bbox_min_lng   real,
    bbox_min_lat   real,
    bbox_max_lng   real,
    bbox_max_lat   real,
    geometry_json  text
);
create index if not exists idx_prov_cb    on provincial_features(cb_id);
create index if not exists idx_prov_use   on provincial_features(pl_use);
create index if not exists idx_prov_bbox  on provincial_features(
    bbox_min_lng, bbox_max_lng, bbox_min_lat, bbox_max_lat);

create table if not exists provincial_symbology (
    pl_use        text primary key,
    label         text,
    color         text,   -- renderer fill; see extract_symbology, it can lie
    style         text,
    outline_color text,
    swatch        text    -- base64 PNG the service actually rasterises
);

-- One row per plan area per run: what we asked for, what we got, and how it
-- ended. An outcome column is the difference between "DPT publishes nothing
-- here" and "our request failed", which need opposite follow-ups
-- (COLLECTORS.md §2.3).
create table if not exists provincial_collect_log (
    cb_id      text primary key,
    expected   integer,
    stored     integer,
    outcome    text,
    detail     text,
    collected_at text
);
"""


def bbox_of(geom: dict) -> tuple[float, float, float, float] | tuple[None, None, None, None]:
    xs: list[float] = []
    ys: list[float] = []

    def walk(node):
        if not node:
            return
        if isinstance(node[0], (int, float)):
            xs.append(node[0])
            ys.append(node[1])
        else:
            for child in node:
                walk(child)

    walk(geom.get("coordinates") or [])
    if not xs:
        return (None, None, None, None)
    return (min(xs), min(ys), max(xs), max(ys))


def open_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    return conn


def store(conn: sqlite3.Connection, cb_id: str, features: list[dict]) -> int:
    rows = []
    for feat in features:
        props = feat.get("properties") or {}
        geom = feat.get("geometry")
        if not geom:
            continue
        x1, y1, x2, y2 = bbox_of(geom)
        pl_use = props.get("PL_USE")
        # PL_USE arrives as a float ("4400.0"); the municipal tier and DPT's own
        # legend both key on the integer string, so normalise here rather than
        # leaving two spellings of the same code in the data.
        if isinstance(pl_use, float):
            pl_use = str(int(pl_use))
        elif pl_use is not None:
            pl_use = str(pl_use).strip().removesuffix(".0")
        rows.append((
            props.get("OBJECTID"),
            ((props.get("CB_ID") or "").strip()
             or (None if cb_id == UNASSIGNED else cb_id)) or None,
            pl_use,
            (str(props.get("PL_BLOCK")).strip() if props.get("PL_BLOCK") is not None else None),
            x1, y1, x2, y2,
            json.dumps(geom, ensure_ascii=False, separators=(",", ":")),
        ))
    conn.executemany(
        "insert or replace into provincial_features values (?,?,?,?,?,?,?,?,?)", rows
    )
    conn.commit()
    return len(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description="Collect DPT provincial land-use polygons.")
    ap.add_argument("--limit", type=int, default=None, help="Only the first N plan areas")
    ap.add_argument("--from-archive", action="store_true",
                    help="Rebuild the local database from archived responses, no requests")
    ap.add_argument("--only", default=None, help="A single CB_ID, for testing")
    args = ap.parse_args()

    force_ipv4()
    started = time.time()

    meta = collect_metadata(args.from_archive)
    symbology = extract_symbology(meta)
    print(f"symbology: {len(symbology)} land-use classes from DPT's own renderer/legend")

    cb_ids = [args.only] if args.only else discover_plan_areas(args.from_archive)
    if args.limit:
        cb_ids = cb_ids[: args.limit]
    print(f"plan areas: {len(cb_ids)}")

    conn = open_db()
    # Named columns, not positional: derive_dpt_palette.py adds render_color /
    # render_ink / patterned to this table, and a positional INSERT silently
    # became a column-count error the moment it did.
    conn.executemany(
        """insert into provincial_symbology
               (pl_use, label, color, style, outline_color, swatch)
           values (:code, :label, :color, :style, :outline_color, :swatch)
           on conflict(pl_use) do update set
               label=excluded.label, color=excluded.color, style=excluded.style,
               outline_color=excluded.outline_color, swatch=excluded.swatch""",
        symbology,
    )
    conn.commit()

    totals = {"ok": 0, "short": 0, "empty": 0, "error": 0}
    grand = 0
    for n, cb_id in enumerate(cb_ids, 1):
        try:
            oids = object_ids_for(cb_id, args.from_archive)
            if not oids:
                outcome, detail, stored = "empty", "no features published", 0
            else:
                feats = features_for(cb_id, oids, args.from_archive)
                stored = store(conn, cb_id, feats)
                if stored == len(oids):
                    outcome, detail = "ok", None
                else:
                    # Never let a short read pass as success.
                    outcome, detail = "short", f"expected {len(oids)}, stored {stored}"
            expected = len(oids)
        except Exception as e:  # noqa: BLE001 — recorded, never fatal to the run
            outcome, detail, expected, stored = "error", str(e)[:300], -1, 0

        totals[outcome] = totals.get(outcome, 0) + 1
        grand += stored
        conn.execute(
            "insert or replace into provincial_collect_log values (?,?,?,?,?,?)",
            (cb_id, expected, stored, outcome, detail,
             time.strftime("%Y-%m-%d %H:%M:%S")),
        )
        conn.commit()
        flag = "" if outcome == "ok" else f"  <-- {outcome}: {detail}"
        print(f"  [{n}/{len(cb_ids)}] CB_ID {cb_id:<10} {stored:>6,} polygons{flag}")

    print(f"\n{grand:,} polygons stored in {DB_PATH}")
    print("outcomes: " + " · ".join(f"{k}={v}" for k, v in totals.items() if v))
    print(f"elapsed {time.time() - started:.0f}s")
    conn.close()
    return 0 if totals.get("error", 0) == 0 and totals.get("short", 0) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
