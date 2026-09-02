#!/usr/bin/env python3
"""
Export each factory's town-planning situation, from the DPT polygons we hold.

What this replaces
------------------
The zone shown beside a factory used to be inferred in the browser from seven
hand-drawn rectangles, the registration year, and a regular expression over the
factory's name — and it was phrased as a legal finding ("เสี่ยงขัดผังเมือง",
"ถูกต้องตามเขตอุตสาหกรรมผังเมือง") about a named business. The DPT polygons
sitting in the geodatabase were never consulted.

This does the point-in-polygon properly, once, offline, and writes the answer
into the static province files the map already loads. The client then states
what DPT's map says and nothing more.

Two tiers, and the difference is the whole point
------------------------------------------------
`municipal` — ผังเมืองรวมเมือง/ชุมชน, 204 town and community plans. These carry
  a land-use code, so a hit says what a point is *zoned*.

`province` — ผังเมืองรวมจังหวัด, plan footprints from TOWNPLAN/TP_MAIN. These
  carry no land-use attribute whatsoever. A hit says only that a provincial
  plan *covers* the point, and this file must never dress that up as a zone.

The tiers overlap — the provincial footprint is the whole province, not the
province minus its town plans (measured on เชียงใหม่: 335 of 336 municipally
zoned factories also fall inside the provincial footprint). So municipal wins
wherever both contain a point, and the provincial tier is consulted only where
the municipal tier has no answer. Never add the two counts together.

Why the provincial tier was added
---------------------------------
This export used to report 48,170 of 62,656 factories (76.9%) as having no DPT
plan data, and nine provinces — ชลบุรี and ระยอง among them — as having none at
all. That was true of the layer we had harvested and false of DPT: every one of
those nine has a ผังเมืองรวมจังหวัด, together covering 8,366 factories. We were
publishing our own harvest scope as an absence in the world, which is exactly
what COLLECTORS.md §5 warns against.

Absence is still the honest answer where it is the answer
---------------------------------------------------------
A factory in neither tier gets no entry at all, and the client reads that as
"DPT publishes no plan we hold for this point" — never as "unzoned", and never
as a compliance verdict. Whether a factory may operate where it stands depends
on its จำพวก, its machinery, the annex schedules of that specific ministerial
regulation, and whether it predates the plan. We hold none of those.

Where the polygons live
-----------------------
`dpt.plan_polygon` on the government database, loaded by load_dpt_polygons.py.
They used to live only in a gitignored 398 MB SQLite file on two machines, and
the point-in-polygon was a Python ray-cast over a hand-rolled degree grid
because SQLite could not do better. PostGIS is already installed, and
`factories.geom` is already trigger-maintained, so it is now one indexed join.

Postgres on sev01 is bound to loopback, so this runs there (as the nightly
does). To run it from a laptop, tunnel first:
    ssh -N -L 5432:127.0.0.1:5432 lighthouse-sev01
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

# psycopg2 is imported lazily inside main(), not here. `--check` only reads
# JSON on disk, and it is the guard a developer or the nightly runs to notice
# that zoning has gone stale — so it has to work on a machine that has no
# Postgres driver installed. A module-level import made the check die with
# ModuleNotFoundError on the laptop it exists to protect. `dotenv` is deferred
# for the same reason.

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "client" / "public" / "data" / "zoning"
COUNTS = REPO / "client" / "public" / "data" / "province-counts.json"
MARKERS = REPO / "client" / "public" / "data" / "markers"

# DPT land-use code -> category.
#
# Derived from the data, not from the leading digit. `pl_block` carries the
# Thai zone letter (ย. residential, พ. commercial, อ. industrial, ก. rural and
# agricultural, ล. open space, ส. government, ษ./ศ. education, ศน. religious),
# and grouping the polygons by code against that letter gives the real meaning
# of each code. Guessing from the first digit got several badly wrong: 8600 is
# the single most common code in the country and is ก. — rural and
# agricultural — not the "8 = religious/special" a digit rule implies, and the
# 6xxx family splits three ways (6100 education, 6200 religious, 6300
# government) rather than being conservation.
CODE_FAMILIES = {
    "8600": ("rural_agricultural", "ชนบทและเกษตรกรรม", "#22C55E"),
    "8700": ("rural_agricultural", "ชนบทและเกษตรกรรม", "#22C55E"),
    "1110": ("residential", "ที่อยู่อาศัย", "#FACC15"),
    "1120": ("residential", "ที่อยู่อาศัย", "#FACC15"),
    "1130": ("residential", "ที่อยู่อาศัย", "#FACC15"),
    "7350": ("open_space", "ที่โล่งเพื่อนันทนาการและรักษาคุณภาพสิ่งแวดล้อม", "#86EFAC"),
    "6200": ("religious", "สถาบันศาสนา", "#A8A29E"),
    "6300": ("government", "สถาบันราชการ สาธารณูปโภคและสาธารณูปการ", "#3B82F6"),
    "6100": ("education", "สถาบันการศึกษา", "#94A3B8"),
    "2000": ("commercial", "พาณิชยกรรม", "#EF4444"),
    "3200": ("industrial", "อุตสาหกรรมและคลังสินค้า", "#7C3AED"),
    "3300": ("industrial", "อุตสาหกรรมและคลังสินค้า", "#7C3AED"),
}

# Codes with no labelled row to learn from. The family prefix is still the best
# available signal for these, but they are a small minority.
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


# Provincial land-use code -> family, for dashboard aggregation only. The label
# and colour a reader sees come from DPT's own `dpt.landuse_class`, not here.
#
# Written out explicitly, never derived from the leading digit. `4400` is
# ชุมชน, and the prefix rule would file it under "4 = warehouse" — the exact
# mistake CODE_FAMILIES exists to avoid, where `8600` (the commonest code in
# the country) is ก. ชนบทและเกษตรกรรม rather than the "religious/special" an
# `8` implies. Every entry below is keyed to the label DPT publishes for it.
PROVINCIAL_FAMILIES = {
    "4400": "community",            # ชุมชน
    "8600": "rural_agricultural",   # ชนบทและเกษตรกรรม
    "8700": "rural_agricultural",   # อนุรักษ์ชนบทและเกษตรกรรม
    "8900": "rural_agricultural",   # ชนบทและปศุสัตว์
    "7110": "rural_agricultural",   # ปฏิรูปที่ดินเพื่อเกษตรกรรม
    "9700": "rural_agricultural",   # จัดรูปที่ดินเพื่อเกษตรกรรม
    "8001": "rural_agricultural",   # ส่งเสริมเกษตรกรรม EEC
    "7111": "rural_agricultural",   # เขตปฏิรูปที่ดิน EEC
    "7180": "conservation",         # อนุรักษ์ป่าไม้
    "7420": "conservation",         # สงวนไว้เพื่อรักษาสภาพป่าชายเลน
    "7190": "conservation",         # อนุรักษ์สภาพแวดล้อมเพื่อการท่องเที่ยว
    "7181": "conservation",         # อนุรักษ์ทรัพยากรธรรมชาติฯ
    "7200": "conservation",         # อนุรักษ์เอกลักษณ์ศิลปวัฒนธรรมไทย
    "1600": "residential",          # อนุรักษ์เพื่อการอยู่อาศัย
    "7350": "open_space",           # ที่โล่งเพื่อนันทนาการฯ
    "7351": "open_space",
    "7352": "open_space",
    "7360": "open_space",
    "7370": "open_space",
    "7380": "open_space",
    "7390": "open_space",
    "7410": "open_space",
    "5500": "open_space",           # รักษาคุณภาพและสิ่งแวดล้อม
    "3100": "industrial",           # อุตสาหกรรม
    "3101": "industrial",
    "3102": "industrial",
    "3200": "industrial",           # อุตสาหกรรมและคลังสินค้า
    "3300": "warehouse",            # คลังสินค้า
    "3310": "warehouse",
    "3400": "industrial",           # อุตสาหกรรมเฉพาะกิจ
    "3500": "industrial",
    "3600": "industrial",
    "6900": "industrial",           # เขตส่งเสริมเศรษฐกิจพิเศษ EEC
    "6901": "industrial",
    "1110": "residential",
    "1120": "residential",
    "1130": "residential",
    "4403": "community",            # ชุมชนเมือง EEC
    "4404": "community",
    "4405": "community",
    "2000": "commercial",
    "2001": "commercial",
    "2100": "commercial",
    "6100": "education",
    "6200": "religious",
    "6300": "government",
    "6700": "military",             # เขตทหาร
    "9520": "flood_risk",           # เสี่ยงอุทกภัย
    "9810": "flood_risk",
    "9994": "infrastructure",       # โครงการคมนาคมและขนส่ง
}


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


# ---------------------------------------------------------------------------
# The spatial pass, in PostGIS
# ---------------------------------------------------------------------------

STAGE_POINTS = """
create temp table zone_point (
    slug       text not null,
    factory_id text not null,
    lng        double precision not null,
    lat        double precision not null
) on commit drop
"""

# `distinct on` with an explicit order makes the answer deterministic when a
# point falls inside more than one polygon of the same tier. Smallest polygon
# first: where plans nest, the more specific one is the one that governs. The
# source-id tiebreak keeps two equal-area polygons from alternating between
# runs. For provincial exact-geometry conflicts, the higher DPT OBJECTID is the
# later replacement in every audited case (including 9900 -> 8600).
MUNICIPAL_HITS = """
select distinct on (zp.slug, zp.factory_id)
       zp.slug, zp.factory_id, p.pl_use, p.pl_block, p.plan_name, p.plan_year
from   zone_point zp
join   dpt.plan_polygon p
       on p.tier = 'municipal'
      and ST_Contains(p.geom, ST_SetSRID(ST_MakePoint(zp.lng, zp.lat), 4326))
order  by zp.slug, zp.factory_id, ST_Area(p.geom) asc, p.id asc
"""

# ผังเมืองรวมจังหวัด with its land use. Same shape as the municipal join, but
# the label and colour come from DPT's own class table rather than from
# CODE_FAMILIES — these are DPT's published words for its own plan.
PROVINCE_LANDUSE_HITS = """
select distinct on (zp.slug, zp.factory_id)
       zp.slug, zp.factory_id, p.pl_use, p.pl_block, p.plan_code,
       c.label, c.color, c.patterned
from   zone_point zp
join   dpt.plan_polygon p
       on p.tier = 'province_landuse'
      and ST_Contains(p.geom, ST_SetSRID(ST_MakePoint(zp.lng, zp.lat), 4326))
left join dpt.landuse_class c on c.pl_use = p.pl_use
order  by zp.slug, zp.factory_id, ST_Area(p.geom) asc,
          p.source_id::bigint desc, p.id desc
"""

PROVINCE_HITS = """
select distinct on (zp.slug, zp.factory_id)
       zp.slug, zp.factory_id, p.plan_name
from   zone_point zp
join   dpt.plan_polygon p
       on p.tier = 'province'
      and ST_Contains(p.geom, ST_SetSRID(ST_MakePoint(zp.lng, zp.lat), 4326))
order  by zp.slug, zp.factory_id, p.id asc
"""

PROVINCE_PLANS = """
select province_th, plan_name
from   dpt.plan_polygon
where  tier = 'province' and province_th is not null
order  by province_th
"""


def write_province_plan_index(conn, out_parent: Path, slug_map_en: dict[str, str]) -> int:
    """
    Write which provinces a ผังเมืองรวมจังหวัด covers, for the map overlay.

    Deliberately a lookup and not geometry. The plan footprint *is* the
    province boundary — measured against `thailand-provinces.json`, the areas
    agree to a ratio of 1.01 and overlap 98.8%, the remainder being ordinary
    digitisation differences between two sources. Shipping the real footprints
    would cost 460 KB simplified (60 MB raw) to redraw borders the client
    already has in `thailand-provinces.json`, and would imply the plan extent
    is a distinct shape when it is not. So the map styles the province polygons
    it already loads, and this file only says which ones a plan covers and what
    it is called.

    Keyed by English province name because that is what the map joins on:
    `provinceGeo` features carry `NAME_1`, matched against `name_en` from
    province-counts.json.
    """
    with conn.cursor() as cur:
        cur.execute(PROVINCE_PLANS)
        by_th = dict(cur.fetchall())

    plans = {en: by_th[th] for th, en in slug_map_en.items() if th in by_th}
    uncovered = sorted(th for th in slug_map_en if th not in by_th)

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "DPT TOWNPLAN/TP_MAIN layer 2 (ผังเมืองรวมจังหวัด), via dpt.plan_polygon",
        # Said out loud because the layer invites exactly the wrong reading:
        # it publishes plan EXTENTS and carries no land-use attribute at all.
        "note": "ขอบเขตผังเมืองรวมจังหวัดเท่านั้น ไม่มีรายละเอียดการใช้ประโยชน์ที่ดินรายแปลง",
        "plans": plans,
        "provinces_without_province_plan": uncovered,
    }
    (out_parent / "dpt_province_plans.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  province plan index: {len(plans)} covered, "
          f"{len(uncovered)} without ({', '.join(uncovered)})")
    return len(plans)


def stage_points(cur, points: list[tuple[str, str, float, float]]) -> None:
    cur.execute(STAGE_POINTS)
    buf = io.StringIO()
    writer = csv.writer(buf)
    for row in points:
        writer.writerow(row)
    buf.seek(0)
    cur.copy_expert("copy zone_point from stdin with (format csv)", buf)
    cur.execute("analyze zone_point")


def main() -> int:
    ap = argparse.ArgumentParser(description="Export per-factory DPT zoning to static JSON.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--markers", type=Path, default=MARKERS)
    ap.add_argument("--dsn", default=None,
                    help="Postgres DSN (defaults to DATABASE_URL in server/.env)")
    ap.add_argument("--check", action="store_true",
                    help="Exit non-zero if any province's markers changed since the last export")
    args = ap.parse_args()

    if args.check:
        return check_freshness(args.out, args.markers)

    import psycopg2  # noqa: PLC0415 — see the note at the top of the imports
    from dotenv import load_dotenv

    load_dotenv(REPO / "server" / ".env")
    dsn = args.dsn or os.getenv("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set (server/.env) and --dsn was not given", file=sys.stderr)
        return 2

    province_counts = json.loads(COUNTS.read_text(encoding="utf-8"))
    slug_map = {p["name_th"]: province_slug(p["name_en"]) for p in province_counts}
    # name_th -> name_en, the key the map's GeoJSON (NAME_1) joins on.
    name_en_map = {p["name_th"]: p["name_en"] for p in province_counts}

    # Read the published markers, not the factories table: the markers are what
    # the site actually draws, and keying off them is what lets the fingerprint
    # detect a moved pin.
    points: list[tuple[str, str, float, float]] = []
    fingerprints: dict[str, str] = {}
    markers_per_slug: dict[str, int] = {}
    for marker_file in sorted(args.markers.glob("*.json")):
        slug = marker_file.stem
        markers = json.loads(marker_file.read_text(encoding="utf-8"))
        fingerprints[slug] = marker_fingerprint(markers)
        markers_per_slug[slug] = len(markers)
        for m in markers:
            points.append((slug, m["i"], m["a"][0], m["a"][1]))
    print(f"{len(points):,} markers across {len(markers_per_slug)} provinces")

    started = time.time()
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("select tier, count(*) from dpt.plan_polygon group by tier order by tier")
            tiers = dict(cur.fetchall())
            if not tiers.get("municipal"):
                print("dpt.plan_polygon holds no municipal polygons — run "
                      "load_dpt_polygons.py --tier municipal first", file=sys.stderr)
                return 2
            for tier, n in tiers.items():
                print(f"  {tier:<10} {n:>7,} polygons")

            stage_points(cur, points)

            cur.execute(MUNICIPAL_HITS)
            municipal = cur.fetchall()
            print(f"  municipal hits: {len(municipal):,}  ({time.time() - started:.0f}s)")

            cur.execute(PROVINCE_LANDUSE_HITS)
            province_landuse = cur.fetchall()
            print(f"  provincial land-use hits: {len(province_landuse):,}"
                  f"  ({time.time() - started:.0f}s)")

            cur.execute(PROVINCE_HITS)
            province = cur.fetchall()
            print(f"  provincial footprint hits (fallback tier): {len(province):,}"
                  f"  ({time.time() - started:.0f}s)")

        args.out.mkdir(parents=True, exist_ok=True)
        write_province_plan_index(conn, args.out.parent, name_en_map)
    finally:
        conn.rollback()   # nothing here writes; the temp table dies with it
        conn.close()

    by_province: dict[str, dict] = defaultdict(dict)
    for slug, factory_id, pl_use, pl_block, plan_name, plan_year in municipal:
        family, label, colour = classify(pl_use)
        entry = {"u": pl_use, "k": family, "l": label, "c": colour}
        if pl_block:
            entry["b"] = pl_block          # zoning block, e.g. อ.1-3
        if plan_name:
            entry["n"] = plan_name
        if plan_year:
            entry["y"] = plan_year
        by_province[slug][factory_id] = entry

    # Tier precedence: municipal, then provincial land use, then the bare
    # provincial footprint. The tiers overlap by construction — a provincial
    # plan covers the whole province including its town-plan areas — so the
    # more specific plan wins and the counts are never summed.
    landuse_count = 0
    for slug, factory_id, pl_use, pl_block, plan_code, label, colour, patterned in province_landuse:
        if factory_id in by_province[slug]:
            continue
        # `t: "pl"` — a real zone, from ผังเมืองรวมจังหวัด rather than from a
        # town plan. The distinction is kept because the two are different legal
        # instruments and the sidebar says which one it is reading.
        entry = {
            "t": "pl",
            "u": pl_use,
            "k": PROVINCIAL_FAMILIES.get(pl_use, "other"),
            "l": label or f"ไม่ระบุประเภทการใช้ประโยชน์ที่ดิน (รหัส {pl_use or 'ว่าง'})",
            "c": colour or "#CBD5E1",
        }
        if pl_block:
            entry["b"] = pl_block          # DPT's numbered block, e.g. 1.14
        if patterned:
            entry["h"] = 1                 # DPT draws this class as a hatch
        by_province[slug][factory_id] = entry
        landuse_count += 1

    provincial_only = 0
    for slug, factory_id, plan_name in province:
        if factory_id in by_province[slug]:
            continue
        # `t: "p"` marks an entry that names a plan but knows no zone. The
        # client must render it as coverage, never as a land-use category —
        # there is no code, label or colour here to render one from.
        entry = {"t": "p"}
        if plan_name:
            entry["n"] = plan_name
        by_province[slug][factory_id] = entry
        provincial_only += 1

    args.out.mkdir(parents=True, exist_ok=True)
    for existing in args.out.glob("*.json"):
        existing.unlink()
    covered = set()
    for slug, entries in sorted(by_province.items()):
        if not entries:
            continue
        covered.add(slug)
        (args.out / f"{slug}.json").write_text(
            json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        mun = sum(1 for e in entries.values() if e.get("t") is None)
        plu = sum(1 for e in entries.values() if e.get("t") == "pl")
        only = sum(1 for e in entries.values() if e.get("t") == "p")
        print(f"  {slug:<28} {mun:>6,} municipal  {plu:>6,} provincial  "
              f"{only:>5,} extent-only  of {markers_per_slug.get(slug, 0):,}")

    # A summary the dashboard can display without re-deriving anything. The
    # previous dashboard multiplied whatever total was on screen by hardcoded
    # national ratios, so every province showed invented counts; these are
    # counted from the same spatial pass that produced the files.
    # Families span both zoned tiers; "k" is absent only on extent-only entries.
    families: dict[str, int] = defaultdict(int)
    for entries in by_province.values():
        for e in entries.values():
            if "k" in e:
                families[e["k"]] += 1
    total = len(points)
    zoned_total = len(municipal)
    zoned_any = zoned_total + landuse_count
    summary = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "DPT PLLU_ALL (municipal) + PLLU_VIEW/PLLU_PROV (provincial land use) + TOWNPLAN/TP_MAIN (provincial extents), via dpt.plan_polygon",
        "factories_tested": total,
        "inside_a_dpt_zone": zoned_any,
        "zoned_by_municipal_plan": zoned_total,
        "zoned_by_province_plan": landuse_count,
        # Renamed from the old no_dpt_plan_data, which conflated two different
        # answers. Kept alongside so nothing reading the old key breaks.
        "no_dpt_plan_data": total - zoned_any - provincial_only,
        "inside_province_plan_only": provincial_only,
        "by_family": dict(sorted(families.items(), key=lambda kv: -kv[1])),
        "marker_fingerprints": fingerprints,
        "provinces_without_dpt_coverage": sorted(
            {th for th, sl in slug_map.items() if sl not in covered}
        ),
    }
    (args.out.parent / "zoning_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")

    size = sum(p.stat().st_size for p in args.out.glob("*.json"))
    print(f"\n{zoned_total:,} zoned by a town plan · {landuse_count:,} zoned by a provincial plan · "
          f"{provincial_only:,} plan extent only · {total - zoned_any - provincial_only:,} no plan data")
    print(f"{len(covered)} province files, {size / 1e6:.1f} MB, in {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
