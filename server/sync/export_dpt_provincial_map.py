#!/usr/bin/env python3
"""Export the downloaded DPT provincial land-use polygons for the web map.

This is intentionally an offline build step. The browser never calls DPT: it
loads one small, static GeoJSON file after a reader selects a province and
turns the layer on.

Province membership is spatial, not inferred from ``CB_ID``. DPT does not
publish a province field on PLLU_PROV, and the identifier has exceptions. We
locate representative points against the province boundaries already shipped
by the client, determine each plan area's province by majority, and handle the
239 blank-CB_ID features individually.

Exact duplicate geometries occur upstream. For drawing, keep the row with the
highest OBJECTID. That is deterministic and, in the audited conflicts, the
higher id consistently represents the later replacement (notably 9900 -> 8600
in CB_ID 8500000). The raw SQLite archive remains untouched and complete.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from audit_province_mismatch import km_to_boundary, point_in_geometry, rings_of

REPO = Path(__file__).resolve().parents[2]
DB = REPO / "server" / "data" / "dpt_provincial.db"
PROVINCES = REPO / "client" / "public" / "data" / "thailand-provinces.json"
COUNTS = REPO / "client" / "public" / "data" / "province-counts.json"
DEFAULT_OUT = REPO / "client" / "public" / "data" / "dpt-province-landuse"
UNKNOWN_COLOR = "#CBD5E1"


def slug(name_en: str) -> str:
    return " ".join(name_en.split()).lower().replace(" ", "-")


def geometry_bbox(geom: dict) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for ring in rings_of(geom):
        for point in ring:
            if len(point) >= 2:
                xs.append(float(point[0]))
                ys.append(float(point[1]))
    if not xs:
        raise ValueError("empty geometry")
    return min(xs), min(ys), max(xs), max(ys)


def ring_centroid(ring) -> tuple[float, float] | None:
    """Area-weighted centroid; may be outside a concave ring, so callers test it."""
    if len(ring) < 4:
        return None
    twice_area = cx = cy = 0.0
    for a, b in zip(ring, ring[1:]):
        cross = float(a[0]) * float(b[1]) - float(b[0]) * float(a[1])
        twice_area += cross
        cx += (float(a[0]) + float(b[0])) * cross
        cy += (float(a[1]) + float(b[1])) * cross
    if abs(twice_area) < 1e-15:
        return None
    return cx / (3 * twice_area), cy / (3 * twice_area)


def representative_points(geom: dict) -> list[tuple[float, float]]:
    """Return interior-first candidates, followed by vertices for coastal cases."""
    exterior = []
    polys = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        polys = [polys]
    for poly in polys:
        if poly and poly[0]:
            exterior.append(poly[0])
    if not exterior:
        return []

    # Use the ring with the widest bbox; tiny islands should not decide which
    # province owns a multi-part zoning polygon.
    ring = max(
        exterior,
        key=lambda r: (max(p[0] for p in r) - min(p[0] for p in r))
        * (max(p[1] for p in r) - min(p[1] for p in r)),
    )
    candidates: list[tuple[float, float]] = []
    centroid = ring_centroid(ring)
    if centroid and point_in_geometry(centroid[0], centroid[1], geom):
        candidates.append(centroid)
    min_x, min_y, max_x, max_y = geometry_bbox(geom)
    centre = ((min_x + max_x) / 2, (min_y + max_y) / 2)
    if point_in_geometry(centre[0], centre[1], geom):
        candidates.append(centre)

    # Vertices are useful where DPT and the simplified province coastline do
    # not line up exactly. Sample at most 20 to keep the 32k-feature pass fast.
    step = max(1, (len(ring) - 1) // 20)
    candidates.extend((float(p[0]), float(p[1])) for p in ring[:-1:step])
    return candidates


def province_for_feature(geom: dict, province_rows: list[dict]) -> str | None:
    min_x, min_y, max_x, max_y = geometry_bbox(geom)
    candidates = [
        p for p in province_rows
        if not (
            p["bbox"][2] < min_x or p["bbox"][0] > max_x
            or p["bbox"][3] < min_y or p["bbox"][1] > max_y
        )
    ]
    votes: Counter[str] = Counter()
    for lng, lat in representative_points(geom):
        for province in candidates:
            if point_in_geometry(lng, lat, province["geometry"]):
                votes[province["name_th"]] += 1
                break
    if votes:
        return votes.most_common(1)[0][0]

    # A generalized coastline can miss a tiny offshore polygon even though it
    # is visibly adjacent to the right province. Accept only a very close
    # nearest boundary; OBJECTID 26415 on Ko Kut is 0.77 km from Trat's line.
    lng, lat = representative_points(geom)[0]
    nearest = min(
        (km_to_boundary(lng, lat, row["geometry"]), row["name_th"])
        for row in province_rows
    )
    return nearest[1] if nearest[0] <= 2.0 else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build selected-province DPT land-use GeoJSON from local SQLite"
    )
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    if not args.db.exists():
        print(f"missing {args.db}; run collect_dpt_provincial.py first", file=sys.stderr)
        return 2

    count_rows = json.loads(COUNTS.read_text(encoding="utf-8"))
    by_en = {row["name_en"]: row for row in count_rows}
    province_geo = json.loads(PROVINCES.read_text(encoding="utf-8"))
    province_rows: list[dict] = []
    for feature in province_geo["features"]:
        name_en = (feature.get("properties", {}).get("NAME_1") or "").strip()
        match = by_en.get(name_en)
        if not match:
            continue
        province_rows.append({
            "name_en": name_en,
            "name_th": match["name_th"],
            "slug": slug(name_en),
            "geometry": feature["geometry"],
            "bbox": geometry_bbox(feature["geometry"]),
        })
    if len(province_rows) != len(count_rows):
        print(
            f"province join is incomplete: {len(province_rows)} boundaries for "
            f"{len(count_rows)} province rows",
            file=sys.stderr,
        )
        return 2

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    palette = {
        str(row["pl_use"]): {
            "label": row["label"] or f"ไม่ระบุประเภท (รหัส {row['pl_use']})",
            "color": row["render_color"] or UNKNOWN_COLOR,
            "patterned": bool(row["patterned"]),
        }
        for row in conn.execute(
            "select pl_use, label, render_color, patterned from provincial_symbology"
        )
    }
    source_collected_at = conn.execute(
        "select max(collected_at) from provincial_collect_log"
    ).fetchone()[0]

    source_rows: list[dict] = []
    empty = 0
    for row in conn.execute(
        "select objectid, cb_id, pl_use, pl_block, geometry_json "
        "from provincial_features order by objectid"
    ):
        geom = json.loads(row["geometry_json"])
        if not geom.get("coordinates"):
            empty += 1
            continue
        source_rows.append({
            "objectid": int(row["objectid"]),
            "cb_id": (row["cb_id"] or "").strip(),
            "pl_use": str(row["pl_use"] or "").strip(),
            "pl_block": (row["pl_block"] or "").strip(),
            "geometry": geom,
            "geometry_key": row["geometry_json"],
        })
    conn.close()

    # Spatially identify every feature once, then use the plan-area majority.
    # This is both more robust at generalized coastlines and independently
    # validates that a CB_ID really behaves like one provincial plan area.
    direct: dict[int, str | None] = {}
    plan_votes: dict[str, Counter[str]] = defaultdict(Counter)
    started = time.time()
    for index, row in enumerate(source_rows, 1):
        province = province_for_feature(row["geometry"], province_rows)
        direct[row["objectid"]] = province
        if row["cb_id"] and province:
            plan_votes[row["cb_id"]][province] += 1
        if index % 5000 == 0:
            print(f"  located {index:,}/{len(source_rows):,} polygons")

    plan_province = {
        cb_id: votes.most_common(1)[0][0]
        for cb_id, votes in plan_votes.items()
        if votes
    }

    unmatched = []
    assigned: dict[str, list[dict]] = defaultdict(list)
    for row in source_rows:
        province = plan_province.get(row["cb_id"]) if row["cb_id"] else direct[row["objectid"]]
        if not province:
            unmatched.append(row["objectid"])
            continue
        assigned[province].append(row)

    # Deduplicate only the published rendering. Raw evidence stays untouched.
    # Dict replacement while iterating OBJECTID ascending makes the winner the
    # highest source id, including the 75 exact-shape classification conflicts.
    duplicate_rows = conflict_groups = 0
    deduped: dict[str, list[dict]] = {}
    for province, rows in assigned.items():
        by_geometry: dict[str, dict] = {}
        uses_by_geometry: dict[str, set[str]] = defaultdict(set)
        for row in rows:
            if row["geometry_key"] in by_geometry:
                duplicate_rows += 1
            uses_by_geometry[row["geometry_key"]].add(row["pl_use"])
            by_geometry[row["geometry_key"]] = row
        conflict_groups += sum(1 for uses in uses_by_geometry.values() if len(uses) > 1)
        deduped[province] = list(by_geometry.values())

    args.out.mkdir(parents=True, exist_ok=True)
    for existing in args.out.glob("*.json"):
        existing.unlink()

    province_lookup = {row["name_th"]: row for row in province_rows}
    summary_provinces = {}
    total_written = unknown_written = 0
    for province in sorted(deduped):
        meta = province_lookup[province]
        features = []
        unknown = 0
        for row in sorted(deduped[province], key=lambda item: item["objectid"]):
            style = palette.get(row["pl_use"])
            is_unknown = style is None or not style.get("color")
            if is_unknown:
                unknown += 1
                style = {
                    "label": f"ไม่ระบุประเภทการใช้ประโยชน์ที่ดิน (รหัส {row['pl_use'] or 'ว่าง'})",
                    "color": UNKNOWN_COLOR,
                    "patterned": False,
                }
            props = {
                "i": row["objectid"],
                "u": row["pl_use"],
                "l": style["label"],
                "c": style["color"],
            }
            if row["pl_block"]:
                props["b"] = row["pl_block"]
            if style["patterned"]:
                props["h"] = 1
            if is_unknown:
                props["x"] = 1
            features.append({
                "type": "Feature",
                "properties": props,
                "geometry": row["geometry"],
            })
        payload = {
            "type": "FeatureCollection",
            "metadata": {
                "province_th": province,
                "province_en": meta["name_en"],
                "source": "DPT PLLU_VIEW layer 5 PLLU_PROV; local archived export",
                "feature_count": len(features),
                "unknown_class_count": unknown,
            },
            "features": features,
        }
        path = args.out / f"{meta['slug']}.json"
        path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        total_written += len(features)
        unknown_written += unknown
        summary_provinces[meta["slug"]] = {
            "name_th": province,
            "features": len(features),
            "unknown_classes": unknown,
            "bytes": path.stat().st_size,
        }

    summary = {
        # Tie provenance to the immutable local collection rather than wall
        # clock time, so rebuilding the same archive produces no spurious diff.
        "source_collected_at": source_collected_at,
        "source_database": str(args.db.relative_to(REPO)),
        "source_rows": len(source_rows) + empty,
        "empty_geometries_skipped": empty,
        "exact_duplicate_rows_removed": duplicate_rows,
        "conflicting_duplicate_groups": conflict_groups,
        "features_written": total_written,
        "unknown_class_features": unknown_written,
        "unmatched_objectids": unmatched,
        "province_assignment": "spatial representative points; CB_ID majority; blank CB_ID individually",
        "duplicate_precedence": "highest numeric OBJECTID",
        "provinces": summary_provinces,
    }
    summary_path = args.out / "index.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    print()
    print(f"source rows                 {len(source_rows) + empty:>8,}")
    print(f"empty geometries skipped   {empty:>8,}")
    print(f"duplicate rows removed     {duplicate_rows:>8,}")
    print(f"conflicting duplicate sets {conflict_groups:>8,}")
    print(f"features written           {total_written:>8,}")
    print(f"unknown-class features     {unknown_written:>8,}")
    print(f"unmatched features         {len(unmatched):>8,}")
    print(f"province files             {len(summary_provinces):>8,}")
    print(f"elapsed                    {time.time() - started:>7.1f}s")
    print(f"output -> {args.out}")
    return 1 if unmatched else 0


if __name__ == "__main__":
    sys.exit(main())
