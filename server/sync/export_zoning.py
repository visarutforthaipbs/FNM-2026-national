#!/usr/bin/env python3
"""
Export each factory's town-planning zone, from the DPT polygons we hold.

What this replaces
------------------
The zone shown beside a factory used to be inferred in the browser from seven
hand-drawn rectangles, the registration year, and a regular expression over the
factory's name — and it was phrased as a legal finding ("เสี่ยงขัดผังเมือง",
"ถูกต้องตามเขตอุตสาหกรรมผังเมือง") about a named business. The 42,219 DPT
polygons sitting in the geodatabase were never consulted.

This does the point-in-polygon properly, once, offline, and writes the answer
into the static province files the map already loads. The client then states
what DPT's map says and nothing more.

Absence is the common case and is exported as such
--------------------------------------------------
PLLU_ALL contains 203 ผังเมืองรวมเมือง/ชุมชน — town and community plans — and no
province-wide plan at all. Those plans cover built-up areas, roughly three per
province against 878 districts nationally, so most of the country lies outside
every polygon in this layer. About 77% of mapped factories do.

That absence is genuinely ambiguous and must be reported as such: a factory
outside these polygons may sit outside any town plan, or inside a
ผังเมืองรวมจังหวัด this layer does not carry. Nine provinces — Chonburi and
Rayong among them — have no matching polygon at all. A factory with no match
therefore gets no zone rather than a guess, and the UI says only that we have
no plan data for the point.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO / "server" / "data" / "dpt_geodatabase.db"
DEFAULT_OUT = REPO / "client" / "public" / "data" / "zoning"
COUNTS = REPO / "client" / "public" / "data" / "province-counts.json"
MARKERS = REPO / "client" / "public" / "data" / "markers"

# DPT land-use code -> category.
#
# Derived from the data, not from the leading digit. `pl_block` carries the
# Thai zone letter (ย. residential, พ. commercial, อ. industrial, ก. rural and
# agricultural, ล. open space, ส. government, ษ./ศ. education, ศน. religious),
# and grouping the 42,219 polygons by code against that letter gives the real
# meaning of each code. Guessing from the first digit got several badly wrong:
# 8600 is the single most common code in the country and is ก. — rural and
# agricultural — not the "8 = religious/special" a digit rule implies, and the
# 6xxx family splits three ways (6100 education, 6200 religious, 6300
# government) rather than being conservation.
#
# The count after each entry is how many polygons carry that code, and the
# letter is what its labelled rows say.
CODE_FAMILIES = {
    "8600": ("rural_agricultural", "ชนบทและเกษตรกรรม", "#22C55E"),        # ก. · 9,199
    "8700": ("rural_agricultural", "ชนบทและเกษตรกรรม", "#22C55E"),        # ก. · 765
    "1110": ("residential", "ที่อยู่อาศัย", "#FACC15"),                     # ย. · 7,569
    "1120": ("residential", "ที่อยู่อาศัย", "#FACC15"),                     # ย. · 3,406
    "1130": ("residential", "ที่อยู่อาศัย", "#FACC15"),                     # ย. · 192
    "7350": ("open_space", "ที่โล่งเพื่อนันทนาการและรักษาคุณภาพสิ่งแวดล้อม", "#86EFAC"),  # ล. · 4,485
    "6200": ("religious", "สถาบันศาสนา", "#A8A29E"),                       # ศน. · 4,255
    "6300": ("government", "สถาบันราชการ สาธารณูปโภคและสาธารณูปการ", "#3B82F6"),  # ส. · 4,195
    "6100": ("education", "สถาบันการศึกษา", "#94A3B8"),                    # ษ. · 3,048
    "2000": ("commercial", "พาณิชยกรรม", "#EF4444"),                       # พ. · 2,075
    "3200": ("industrial", "อุตสาหกรรมและคลังสินค้า", "#7C3AED"),           # อ. · 318
    "3300": ("industrial", "อุตสาหกรรมและคลังสินค้า", "#7C3AED"),           # อ. · 37
}

# Codes with no labelled row to learn from. The family prefix is still the best
# available signal for these, but they are a small minority and are labelled
# with DPT's own generic wording rather than a category we cannot evidence.
PREFIX_FALLBACK = {
    "1": ("residential", "ที่อยู่อาศัย", "#FACC15"),
    "2": ("commercial", "พาณิชยกรรม", "#EF4444"),
    "3": ("industrial", "อุตสาหกรรมและคลังสินค้า", "#7C3AED"),
    "4": ("warehouse", "คลังสินค้า", "#A78BFA"),
    "8": ("rural_agricultural", "ชนบทและเกษตรกรรม", "#22C55E"),
}

UNKNOWN = ("other", "ประเภทอื่นตามผังเมืองรวม", "#CBD5E1")


def classify(pl_use: str) -> tuple[str, str, str]:
    code = (pl_use or "").strip()
    if code in CODE_FAMILIES:
        return CODE_FAMILIES[code]
    return PREFIX_FALLBACK.get(code[:1], UNKNOWN)


def point_in_ring(lng: float, lat: float, ring) -> bool:
    """Ray casting over one linear ring."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and \
           (lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def point_in_geometry(lng: float, lat: float, geom: dict) -> bool:
    """Polygon or MultiPolygon, honouring holes."""
    gtype = geom.get("type")
    polys = geom.get("coordinates") or []
    if gtype == "Polygon":
        polys = [polys]
    elif gtype != "MultiPolygon":
        return False
    for poly in polys:
        if not poly:
            continue
        if point_in_ring(lng, lat, poly[0]):
            # A point inside a hole is outside the polygon.
            if not any(point_in_ring(lng, lat, hole) for hole in poly[1:]):
                return True
    return False


def marker_fingerprint(markers) -> str:
    """
    Identify the exact set of coordinates a province's zoning was built from.

    Zoning is a function of position, so it goes stale the moment a factory
    moves — and an admin repositioning a factory in /admin does exactly that.
    Keying on the id alone would let a moved factory silently keep the zone of
    where it used to be, which is worse than having no zone at all. The
    fingerprint makes that detectable with --check.
    """
    parts = sorted(f"{m['i']}:{m['a'][0]:.6f},{m['a'][1]:.6f}" for m in markers)
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


def check_freshness(out: Path, markers_dir: Path) -> int:
    """Report provinces whose markers have changed since zoning was exported."""
    summary_path = out.parent / "zoning_summary.json"
    if not summary_path.exists():
        print("no zoning_summary.json — zoning has never been exported", file=sys.stderr)
        return 1
    saved = json.loads(summary_path.read_text(encoding="utf-8")).get("marker_fingerprints", {})
    if not saved:
        print("zoning_summary.json predates fingerprinting — re-run the export", file=sys.stderr)
        return 1

    stale, missing = [], []
    for mf in sorted(markers_dir.glob("*.json")):
        markers = json.loads(mf.read_text(encoding="utf-8"))
        current = marker_fingerprint(markers)
        was = saved.get(mf.stem)
        if was is None:
            missing.append(mf.stem)
        elif was != current:
            stale.append(mf.stem)

    if not stale and not missing:
        print(f"✅ zoning is current for all {len(saved):,} provinces")
        return 0
    if stale:
        print(f"⚠️  {len(stale)} province(s) moved since zoning was exported: "
              f"{', '.join(stale[:8])}{' …' if len(stale) > 8 else ''}", file=sys.stderr)
    if missing:
        print(f"⚠️  {len(missing)} province(s) have markers but no zoning fingerprint: "
              f"{', '.join(missing[:8])}", file=sys.stderr)
    print("   run: python server/sync/export_zoning.py", file=sys.stderr)
    return 1


def province_slug(name_en: str) -> str:
    return " ".join(name_en.split()).lower().replace(" ", "-")


def main() -> int:
    ap = argparse.ArgumentParser(description="Export per-factory DPT zoning to static JSON.")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--markers", type=Path, default=MARKERS)
    ap.add_argument("--check", action="store_true",
                    help="Exit non-zero if any province's markers changed since the last export")
    args = ap.parse_args()

    if args.check:
        return check_freshness(args.out, args.markers)

    if not args.db.exists():
        print(f"{args.db} not found — run download_dpt_geodatabase.py first", file=sys.stderr)
        return 2

    slug_map = {p["name_th"]: province_slug(p["name_en"])
                for p in json.loads(COUNTS.read_text(encoding="utf-8"))}

    # Load polygons with their bounding boxes; the bbox is the cheap rejection
    # test that makes 42,219 polygons tractable per point.
    conn = sqlite3.connect(args.db)
    polys = []
    for row in conn.execute("""
        select pl_use, pl_block, name, cw_name, amphoe_nam, year, status_maj,
               bbox_min_lng, bbox_min_lat, bbox_max_lng, bbox_max_lat, geometry_json
        from dpt_features
    """):
        try:
            geom = json.loads(row[11])
        except Exception:
            continue
        polys.append((row[:11], geom))
    conn.close()
    print(f"loaded {len(polys):,} DPT polygons")

    # Bucket polygons by integer degree so each factory only tests its own cell.
    grid: dict[tuple[int, int], list] = defaultdict(list)
    for meta, geom in polys:
        x1, y1, x2, y2 = meta[7], meta[8], meta[9], meta[10]
        if None in (x1, y1, x2, y2):
            continue
        for gx in range(int(x1), int(x2) + 1):
            for gy in range(int(y1), int(y2) + 1):
                grid[(gx, gy)].append((meta, geom))

    started = time.time()
    by_province: dict[str, dict] = defaultdict(dict)
    fingerprints: dict[str, str] = {}
    total = matched = 0

    for marker_file in sorted(args.markers.glob("*.json")):
        slug = marker_file.stem
        markers = json.loads(marker_file.read_text(encoding="utf-8"))
        fingerprints[slug] = marker_fingerprint(markers)
        for m in markers:
            lng, lat = m["a"][0], m["a"][1]
            total += 1
            hit = None
            for meta, geom in grid.get((int(lng), int(lat)), ()):
                x1, y1, x2, y2 = meta[7], meta[8], meta[9], meta[10]
                if not (x1 <= lng <= x2 and y1 <= lat <= y2):
                    continue
                if point_in_geometry(lng, lat, geom):
                    hit = meta
                    break
            if hit is None:
                continue    # no plan here — exported by omission, never guessed
            matched += 1
            family, label, colour = classify(hit[0])
            entry = {"u": hit[0], "k": family, "l": label, "c": colour}
            if hit[1] and str(hit[1]).strip():
                entry["b"] = str(hit[1]).strip()      # zoning block, e.g. อ.1-3
            if hit[2] and str(hit[2]).strip():
                entry["n"] = str(hit[2]).strip()      # plan name
            if hit[5]:
                entry["y"] = hit[5]                   # plan year (พ.ศ.)
            by_province[slug][m["i"]] = entry
        print(f"  {slug:<28} {len(by_province.get(slug, {})):>6,} of {len(markers):,} matched")

    args.out.mkdir(parents=True, exist_ok=True)
    for existing in args.out.glob("*.json"):
        existing.unlink()
    # A province with no matches gets no file: the client reads a 404 as
    # "DPT publishes nothing here", which is exactly what it means.
    covered = set()
    for slug, entries in sorted(by_province.items()):
        if not entries:
            continue
        covered.add(slug)
        (args.out / f"{slug}.json").write_text(
            json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # A summary the dashboard can display without re-deriving anything. The
    # previous dashboard multiplied whatever total was on screen by hardcoded
    # national ratios, so every province showed invented counts; these are
    # counted from the same point-in-polygon pass that produced the files.
    families: dict[str, int] = defaultdict(int)
    for entries in by_province.values():
        for e in entries.values():
            families[e["k"]] += 1
    summary = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "DPT PLLU_ALL town-planning polygons",
        "factories_tested": total,
        "inside_a_dpt_zone": matched,
        "no_dpt_plan_data": total - matched,
        "by_family": dict(sorted(families.items(), key=lambda kv: -kv[1])),
        "marker_fingerprints": fingerprints,
        "provinces_without_dpt_coverage": sorted(
            {th for th, sl in slug_map.items() if sl not in covered}
        ),
    }
    (args.out.parent / "zoning_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

    size = sum(p.stat().st_size for p in args.out.glob("*.json"))
    elapsed = time.time() - started
    print()
    print(f"✅ {matched:,} of {total:,} mapped factories fall inside a DPT polygon "
          f"({matched/max(total,1):.1%}) in {elapsed:.0f}s")
    print(f"   {total - matched:,} have no plan data and are exported with no zone")
    print(f"   -> {args.out} ({size/1024/1024:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
