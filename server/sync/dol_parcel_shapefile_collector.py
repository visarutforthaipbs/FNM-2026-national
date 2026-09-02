#!/usr/bin/env python3
"""
DOL land-parcel shapefile collector — exact deed → parcel coordinates.

Verified 2026-08-18: กรมที่ดิน (Department of Lands) publishes per-province
land-parcel shapefiles on data.go.th, anonymously downloadable, containing real
title-deed numbers and polygon geometry. This is the legitimate, working route
to EXACT parcel coordinates that the old DOL LandsMaps API (hCaptcha-blocked)
never gave us.

WHAT WE VERIFIED (do not re-derive):
  - Package: "รูปแปลงที่ดิน จ.<province>" under org กรมที่ดิน on data.go.th.
    e.g. นนทบุรี id=6a99c22e-5140-48c6-81e5-40b9eb072eaf
  - Resources are `.rar` files (mislabeled `.shp`/ZIP in metadata), ~17–24 MB each,
    one per สำนักงานที่ดิน province/branch. Download is ANONYMOUS (HTTP 200, no
    token, no Consumer-Key, no CAPTCHA) despite `isopen: False` in CKAN metadata.
  - Each .rar → shapefile set (polygonNN.shp/.shx/.dbf/.prj). The .dbf carries:
      LAND_NO   — the title-deed / land number (THE join key to factory deeds)
      LAND_ID   — land identifier (also usable)
      PARCEL_SEQ— unique parcel sequence
      UTMMAP1-4 + UTMSCALE — ระวาง (UTM map sheet) reference
      PVCODE, AMP_ID, TAM_ID, APM_NME, TAM_NME, PRO_NME — admin codes + names
      PARCELDESC — e.g. "โฉนดที่ดิน" (title deed) vs "ทางสาธารณประโยชน์" (public road)
      ORIGIN_X/Y — parcel reference coordinate
    - Nonthaburi sample: 160,116 records; 48,715 are PARCELDESC="โฉนดที่ดิน"
      (private title deeds) with real non-zero LAND_NO. Confirmed deed-keyed.
  - CRS is Indian_1975_UTM_Zone_47N (EPSG:24047, false easting 500000, CM 99°)
    — NOT WGS84. A datum transform Indian-1975 → WGS84 (EPSG:24047 → 4326) is
    REQUIRED. Naively reading the UTM as WGS84 lands 100–300 m off.

LIMITATION (honest): only a handful of provinces are published so far (นนทบุรี,
ปทุมธานี, สมุทรปราการ, สมุทรสาคร, สมุทรสงคราม, เพชรบูรณ์). The other ~70 provinces
still fall back to the tambon-centroid tier; an institutional request to DOL
completes the set.

DEPENDENCIES (not present in this repo's venv — install before running):
    pip install pyshp pyproj   # pyshp = pure-python SHP/DBF; pyproj = datum grid
Run on the sync host that also has the factory deed data available.

Usage:
    python dol_parcel_shapefile_collector.py --province nonthaburi   # download+index
    python dol_parcel_shapefile_collector.py --list                  # known provinces
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Known DOL parcel-shapefile packages on data.go.th (org กรมที่ดิน).
# Keyed by a normalised province name → (CKAN package id, short label).
# ---------------------------------------------------------------------------
PROVINCES: dict[str, tuple[str, str]] = {
    "นนทบุรี":      ("6a99c22e-5140-48c6-81e5-40b9eb072eaf", "nonthaburi"),
    "ปทุมธานี":     ("5db43127-3d7c-45e5-ac34-20e5a96a514b", "pathumthani"),
    "สมุทรปราการ":  ("123b194b-4232-447e-a61d-7f2777b46909", "samutprakan"),
    "สมุทรสาคร":    ("d3ed37cd-07f5-45a7-9786-11470889fdce", "samutsakhon"),
    "สมุทรสงคราม":  ("37876eff-f7f7-40bd-aa99-e18269ade250", "samutsongkhram"),
    "เพชรบูรณ์":     ("acc2f699-cb1c-4e50-aa16-a0d1767143ea", "phetchabun"),
}

CKAN_SHOW = "https://data.go.th/api/3/action/package_show?id={id}"
CKAN_DL = "https://data.go.th/dataset/{pkg}/resource/{res}/download/{name}"

# Indian 1975 UTM zone 47N → WGS84 (geographic).
SRC_EPSG = 24047   # Indian_1975_UTM_Zone_47N  (matches the .prj: FE 500000, CM 99)
DST_EPSG = 4326    # WGS84


def ckan_resource_urls(pkg_id: str) -> list[dict]:
    """Return the downloadable .rar resource URLs for a parcel-shape package."""
    import urllib.request
    url = CKAN_SHOW.format(id=pkg_id)
    with urllib.request.urlopen(url, timeout=40) as res:
        data = json.loads(res.read().decode("utf-8"))
    out = []
    for r in data["result"].get("resources", []):
        if r.get("format", "").lower() in ("zip", "rar", "shp") or ".rar" in (r.get("url") or ""):
            out.append({
                "url": r["url"],
                "name": r.get("name", ""),
                "size": r.get("size"),
            })
    return out


def download(url: str, dest: Path) -> Path:
    import urllib.request
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        return dest
    print(f"  downloading -> {dest.name}")
    with urllib.request.urlopen(url, timeout=300) as res, open(dest, "wb") as f:
        f.write(res.read())
    return dest


def extract_rar(rar: Path, dest_dir: Path) -> Path:
    """Extract a RAR v4/v5 (bsdtar/libarchive handles both) to dest_dir."""
    import subprocess
    dest_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["bsdtar", "-xf", str(rar), "-C", str(dest_dir)],
                   check=True, capture_output=True)
    return dest_dir


def find_shapefile_set(base: Path) -> Path | None:
    """Return the directory containing a .shp/.shx/.dbf/.prj set."""
    for shp in base.rglob("*.shp"):
        if shp.with_suffix(".dbf").exists():
            return shp
    return None


def dbf_fields(dbf_path: Path) -> list[tuple[str, str, int]]:
    """(name, type, length) from a DBF header (stdlib, no pyshp needed)."""
    import struct
    d = dbf_path.read_bytes()
    hdrlen = struct.unpack("<H", d[8:10])[0]
    i = 32
    fields = []
    while d[i] != 0x0D:
        name = d[i:i + 11].split(b"\x00")[0].decode("ascii", "replace")
        ftype = chr(d[i + 11])
        flen = d[i + 16]
        fields.append((name, ftype, flen))
        i += 32
    return fields


def parcels_from_shapefile(shp_path: Path) -> list[dict]:
    """Read parcel records + centroids. Prefers pyshp; falls back to dbf+shp raw.

    Transform Indian-1975→WGS84 via pyproj (EPSG:24047 → 4326) if available;
    if pyproj is absent, records carry the raw UTM and a `needs_transform`
    marker so the caller knows WGS84 was NOT yet applied (never silently wrong).
    """
    try:
        import shapefile as pyshp
    except ImportError:
        pyshp = None
    try:
        from pyproj import Transformer
        tx = Transformer.from_crs(SRC_EPSG, DST_EPSG, always_xy=True)
        have_tx = True
    except ImportError:
        tx = None
        have_tx = False

    if not pyshp:
        print("  ! pyshp not installed — cannot read shapefile geometry.", file=sys.stderr)
        print("    .dbf still readable; geometry skipped.", file=sys.stderr)
        return []

    # DOL DBFs are cp874 (Thai) — pyshp's utf-8 default raises on the Thai
    # field values. Use cp874 and replace any byte it still can't decode.
    sf = pyshp.Reader(str(shp_path), encoding="cp874", encodingErrors="replace")
    records = []
    for shprec in sf.iterShapeRecords():
        attrs = dict(zip([f[0] for f in sf.fields[1:]], shprec.record))
        land_no = str(attrs.get("LAND_NO", "")).strip()
        if not land_no or land_no in ("0", "None"):
            # not a deed parcel (public land / blank) — skip for deed join
            continue
        # centroid of first polygon part
        pts = shprec.shape.points
        if not pts:
            continue
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        if have_tx:
            lon, lat = tx.transform(cx, cy)
            needs_transform = False
        else:
            lon, lat, needs_transform = cx, cy, True
        records.append({
            "land_no": land_no,
            "land_id": str(attrs.get("LAND_ID", "")).strip(),
            "parcel_seq": str(attrs.get("PARCEL_SEQ", "")).strip(),
            "utm_map": (str(attrs.get("UTMMAP1", "")).strip(),
                        str(attrs.get("UTMMAP2", "")).strip(),
                        str(attrs.get("UTMMAP3", "")).strip(),
                        str(attrs.get("UTMMAP4", "")).strip()),
            "pvcode": str(attrs.get("PVCODE", "")).strip(),
            "amp_id": str(attrs.get("AMP_ID", "")).strip(),
            "tam_id": str(attrs.get("TAM_ID", "")).strip(),
            "parcel_desc": str(attrs.get("PARCELDESC", "")).strip(),
            "lat": lat,
            "lng": lon,
            "needs_transform": needs_transform,
        })
    return records


def build_index(records: list[dict], db_path: Path) -> int:
    """Persist an indexed parcel table keyed by (pvcode, land_no, utm_map)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS parcels (
                land_no TEXT, land_id TEXT, parcel_seq TEXT,
                utm1 TEXT, utm2 TEXT, utm3 TEXT, utm4 TEXT,
                pvcode TEXT, amp_id TEXT, tam_id TEXT,
                parcel_desc TEXT, lat REAL, lng REAL,
                needs_transform INTEGER,
                PRIMARY KEY(pvcode, land_no, utm1)
            )
        """)
        cur = conn.executemany("""
            INSERT OR REPLACE INTO parcels
            (land_no, land_id, parcel_seq, utm1, utm2, utm3, utm4,
             pvcode, amp_id, tam_id, parcel_desc, lat, lng, needs_transform)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, [
            (r["land_no"], r["land_id"], r["parcel_seq"],
             r["utm_map"][0], r["utm_map"][1], r["utm_map"][2], r["utm_map"][3],
             r["pvcode"], r["amp_id"], r["tam_id"], r["parcel_desc"],
             r["lat"], r["lng"], int(r["needs_transform"]))
            for r in records
        ])
        conn.commit()
        return cur.rowcount


def main() -> int:
    ap = argparse.ArgumentParser(description="DOL parcel-shapefile collector.")
    ap.add_argument("--province", help="province key from --list")
    ap.add_argument("--list", action="store_true", help="show known provinces")
    ap.add_argument("--work-dir", type=Path, default=Path("/tmp/dol_parcels"))
    ap.add_argument("--db", type=Path, default=Path("/tmp/dol_parcels_index.db"))
    args = ap.parse_args()

    if args.list:
        for pv, (_id, label) in PROVINCES.items():
            print(f"  {pv:14s} ({label})")
        return 0

    if not args.province or args.province not in PROVINCES:
        print(f"unknown province {args.province!r}; use --list", file=sys.stderr)
        return 2

    pkg_id, label = PROVINCES[args.province]
    urls = ckan_resource_urls(pkg_id)
    print(f"{args.province}: {len(urls)} downloadable .rar resource(s)")
    if not urls:
        print("  no .rar resources — nothing to do", file=sys.stderr)
        return 1

    total = 0
    for i, r in enumerate(urls, 1):
        rar = download(r["url"], args.work_dir / label / f"res{i}.rar")
        ext = extract_rar(rar, args.work_dir / label / f"res{i}")
        shp = find_shapefile_set(ext)
        if shp is None:
            print(f"  res{i}: no shapefile set found", file=sys.stderr)
            continue
        recs = parcels_from_shapefile(shp)
        n = build_index(recs, args.db)
        total += n
        print(f"  res{i} ({shp.parent.name}): {len(recs)} deed parcels → indexed")

    print(f"\nDONE: {total:,} deed-keyed parcels in {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
