# Tambon-centroid fallback for deed-bearing factories — implementation plan

**Date:** 2026-08-18 · **Scope:** ~8,705 factories whose only location clue is a
deed number (โฉนด) + province/district/tambon, with DOL LandsMaps hCaptcha-blocked.

## TL;DR

The tambon-centroid fallback **already exists and is in production** — it does not
need to be built. It is Tier 3 of `server/sync/geocode_missing.py`
(`--tier centroid`), using the `kongvut/thai-province-data` gazetteer, and it
resolves **97.4%** of deed-bearing no-coordinate operating factories in the real
CSV. The only legitimate new work is (a) narrow the remaining 2.6% coverage gap
(Bangkok has zero gazetteer centroids), and (b) tighten the provenance label.

## What the data actually shows (measured, not carried over)

All numbers below were recomputed from `all_factories_export.csv` (274,340 rows)
and the committed gazetteer in `server/sync/gazetteer/` on 2026-08-18.

| Metric | Value |
|---|---|
| Operating factories in export | 59,678 |
| Operating, **no coordinate** | 22,183 |
| Of those, **deed-bearing** (โฉนด / น.ส.3 / เลขที่ดิน / ระวาง / หน้าสำรวจ in `address_full` or `name`) | **3,373** |
| Resolvable by tambon centroid | **3,284 (97.4%)** |
| Unresolvable | 89 (2.6%) |

Note on the "8,705": that figure is the live-Supabase count of *all* factories
with no position (COLLECTORS.md §6), including non-deed addresses. The export CSV
is an older/larger snapshot (22,183 operating no-coord). The deed-bearing subset
is the target here, and it is fully covered by the same mechanism.

### Address field coverage (the reason this works at all)

For operating no-coordinate factories, `province`, `district` and `sub_district`
are populated at **100%** (27,037/27,037 in `missing_coordinates.csv`;
`sub_district` 99.99%). `address_full` is populated ~99.6%. The deed numbers live
*inside* `address_full` (e.g. `โฉนดที่ดินเลขที่ 14444,14445 ม.6`) — there is no
separate deed column, so the fallback does not even need to parse the deed number:
the (province, district, tambon) triple is sufficient and is always present.

### Gazetteer completeness (kongvut/thai-province-data)

- 77 / 77 provinces present.
- 930 districts, 7,452 sub-districts; **7,124 (95.6%) carry a lat/long**.
- **Bangkok (กรุงเทพมหานคร) has 0 / 170 sub-district centroids** — every Bangkok
  lat/long is `NULL` in the gazetteer. This is the single largest hole.
- Scattered genuine omissions elsewhere: ระยอง (`ห้วยโป่ง`, `กะเฉด` = 29 factories),
  หนองคาย `โพนสว่าง`, a handful in พัทลุง/นครราชสีมา/ตรัง/นครปฐม/สตูล.

### Breakdown of the 89 unresolved (deed-bearing, operating, no-coord)

| Province | Count | Cause |
|---|---|---|
| ระยอง | 29 | tambons `ห้วยโป่ง`, `กะเฉด` have NULL centroid in gazetteer |
| กรุงเทพมหานคร | 24 | gazetteer has zero BKK centroids (systemic) |
| พัทลุง / นครราชสีมา / ตรัง / นครปฐม / หนองคาย / สตูล / สุราษฎร์ธานี / อุดรธานี / นครพนม / อยุธยา / เชียงใหม่ / ตาก | 36 | genuine gazetteer omissions |

## Answer to the three research questions

### (1) Tambon gazetteer — usable? YES, and already wired in.

`kongvut/thai-province-data` (`formats/json`) provides
`sub_districts.json` with `lat`/`long`, linked `district_id` →
`districts.json` → `province_id`. The `geocode_missing.py::load_gazetteer()`
already joins this into a `(province, district, tambon) → (lat, lon)` lookup,
normalising Thai prefixes (`ต.`/`อ.`/`แขวง`/`เขต`/`เมือง`). It is complete for
all 77 provinces **except Bangkok centroids**, and covers 95.6% of all tambons.

### (2) Free geocoder without Longdo quota? Nominatim is NOT a substitute.

Live-tested Nominatim/OSM on the exact tambons the gazetteer misses:

- `ห้วยโป่ง เมืองระยอง ระยอง` → returned a POI (`โรงไฟฟ้าระยอง`, an industrial
  power plant), **not** a tambon centroid/boundary.
- `โพนสว่าง เมืองหนองคาย หนองคาย` → **no result**.

OSM has no systematic Thai sub-district (ตำบล) boundary gazetteer, so Nominatim
cannot geocode Thai factory addresses at tambon/amphoe granularity. Longdo's paid
quota (`geocode_missing.py --tier geocode`, ~3k req/day free) remains the only
real *street-level* option, and its results are already province-validated and
cached. For the deed-bearing set specifically, tambon-centroid is both free and
more appropriate than street geocoding, because `address_full` frequently holds
only a deed number + ม. — there is no street to geocode.

**Verdict:** tambon centroid from the gazetteer is the right, honest, free
fallback. Nominatim/OSM adds nothing at this granularity. Do not build a
nominatim tier.

### (3) Minimum provenance label

The schema already enforces the honest taxonomy. Recommended minimum for a
tambon-centroid position:

- `coord_source = 'centroid'` and `coord_precision = 'tambon'` (both already
  constrained by CHECK in
  `supabase/migrations/20260807010000_coords_and_corrections.sql`).
- Client `coordQuality='centroid'` → **faded marker** + a **"ตำแหน่งโดยประมาณ"
  badge** in the sidebar, and it MUST render in the DIW section (coordinates are
  DIW-derived data), labelled with the literal uncertainty "ระดับตำบล ±2–5 กม.",
  never a bare lat/lng that could read as surveyed.

The one thing missing today: the badge says "โดยประมาณ" but does not say *which
approximation*. For a deed-bearing factory the honest label is specifically
"ประมาณจากใจกลางตำบล (ไม่ได้มาจากแปลงที่ดิน / โฉนด)" — i.e. explicitly disclaim
that this is NOT the parcel. That wording string is the concrete addition, not a
new mechanism.

## Concrete implementation plan

The work is already 95% done. Remaining steps, in order of value:

1. **Confirm the tambon-centroid tier has been re-run over the deed-bearing set.**
   `python geocode_missing.py --tier centroid --apply` (dry-run first, no
   `--limit`). It will resolve ~3,284 of 3,373 deed-bearing no-coord rows to
   `coord_source='centroid'`, `coord_precision='tambon'`, writing `lat/lng`.

2. **Patch the Bangkok gap (24 factories)** — the only fixable significant hole.
   The gazetteer stores Bangkok districts with an embedded `เขต` prefix
   (`เขตพระนคร`) while all other provinces store bare names. Two options:
   - *Preferred:* enrich the gazetteer with Bangkok tambon centroids from another
     source (e.g. OSM `admin_level=10` relations for Bangkok's 180 แขวง, or the
     DPT/one-map administrative layer) and add them to the lookup. Small, one-off,
     ~180 rows.
   - *Fallback:* for Bangkok only, degrade to **district (เขต) centroid**, which
     the gazetteer *does* implicitly allow by matching `เขต*` → but since BKK
     sub-districts have NULL centroids entirely, a distrect-level centroid would
     need to be sourced separately too. Prefer the first option.

3. **Leave the remaining ~65 scattered omissions** (ระยอง ห้วยโป่ง/กะเฉด etc.)
   unresolved rather than force a district- or province-centroid guess. A blank
   pin is honest; a province-centroid dressed as a position is not. These can be
   picked up later by the DOL institutional route (COLLECTORS.md §6) or citizen
   pin (Tier 4).

4. **Add the provenance disclaim string.** In the sidebar's coordinate readout,
   when `coordQuality==='centroid'`, render "ประมาณจากใจกลางตำบล — ไม่ใช่แปลงที่ดิน
   (โฉนด) จริง" so a deed-bearing factory is never mistaken for a located parcel.

5. **Refresh derived artifacts** after applying: geom trigger fires automatically;
   run `python export_markers.py && python export_zoning.py && python
   export_dashboard.py`, commit `client/public/data/`.

## What NOT to do

- Do not build a Nominatim/OSM tier (tested: no Thai tambon resolution).
- Do not key off the deed number for the fallback — it is unnecessary and the
  deed numbers are non-unique across districts anyway (COLLECTORS.md notes land_no
  collisions). The (province, district, tambon) triple is the correct key.
- Do not "solve" DOL again — hCaptcha is a documented stop, not an obstacle.
- Do not downgrade the label. "ตำแหน่งโดยประมาณ" stays; add the *specific*
  "ไม่ใช่แปลงที่ดิน" nuance, never remove the approximation marker.
