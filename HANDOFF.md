# Handoff — 2026-08-08

Written for a fresh agent/session picking this up cold. Read this before touching
`server/sync/pipeline.py`, the admin API, or anything coordinate-related — there's
live incident context here that isn't obvious from the code alone.

**For the data collectors specifically — DIW, DBD, DPT, DOL — read
[`COLLECTORS.md`](COLLECTORS.md) first.** It covers what each one does, what
state it's in, the rate-limiting and archive patterns that made them work, and
which routes are closed so you don't re-derive a dead end.

## TL;DR state of the world

- Citizen impact reporting + admin moderation + coordinate recovery (4 tiers) +
  an admin "unmapped factories" tool all shipped and are live in production.
- Map coordinate coverage: 61.4% → 98.3% of operating factories.
- **A production data-corruption incident happened and was repaired tonight
  (2026-08-08).** Root cause fixed in code and pushed. One residual gap
  remains (~317 factories) that could not be precisely repaired — see below.
- **One manual step is still outstanding**: a GitHub repo setting needs to be
  flipped by a human with the web UI (agents can't do it via API/CLI token
  scope — confirmed, not just untried). Until then the nightly sync workflow
  will keep failing at its last step (harmlessly).
- One open research question needs domain knowledge neither the code nor I
  could resolve: what do the DIW fields `FFLAG` and `STATUS` actually encode?
  See "Open question" below.

---

## 1. What shipped this session

### Citizen impact reporting (moderated, anonymous)
- `supabase/migrations/20260807000000_citizen_reports.sql` — `reports` table,
  RLS (anon INSERT-only), `approved_reports`/`report_counts` public views,
  IP-hash rate limiting via trigger (5/hour).
- Client: `hooks/useReports.ts`, `components/ReportSection.tsx` (3-step chip
  form in the sidebar factory detail view), report-count badge on
  `FactoryCard.tsx`.
- Disclaimer text lives in `types/report.ts` (`REPORT_DISCLAIMER`) — always
  render it next to report data; it's the main defamation-risk mitigation
  (citizen testimony, not verified fact).

### Admin moderation (`/admin` route)
- `server/index.js`: `GET/POST /api/admin/reports[/:id]`,
  `GET/POST /api/admin/corrections[/:id]`. Static bearer token
  (`ADMIN_TOKEN` env var, both in Vercel and `server/.env`). The pg pool
  connects as table owner, bypassing RLS — this is the only place reporter
  contact info is ever visible.
- `client/src/pages/AdminPage.tsx` — three tabs: reports, location
  corrections, unmapped factories (see below). Token stored in
  sessionStorage, gated behind a simple entry screen.

### Coordinate recovery (4 tiers) + citizen/admin correction
`supabase/migrations/20260807010000_coords_and_corrections.sql` +
`20260808010000_admin_coord_source.sql` added `factories.coord_source`
(`gov`/`repaired`/`geocoded`/`centroid`/`community`/`admin`) and
`coord_precision`. Tiers, in `server/sync/`:
1. **`repair_coordinates.py`** — recovers swapped/mis-scaled raw values from
   the gov CSV, validated against province polygons. Yielded almost nothing
   (4 factories) — turned out most missing-coordinate factories simply have
   no coordinates in the raw feed at all, not malformed ones.
2. **`geocode_missing.py --tier geocode`** — Longdo Map address geocoding,
   province-validated, responses cached in `server/sync/geocode_cache.json`
   (committed — don't delete, it's paid-for API responses). **Free tier is
   ~3,000 requests/day** — hits `"Too many requests"` (HTTP 400) when
   exhausted; the script has a `--cache-only` mode to apply what's cached
   without burning quota. Threaded (6 workers).
3. **`geocode_missing.py --tier centroid`** — tambon centroid fallback from
   `server/sync/gazetteer/` (kongvut/thai-province-data, committed locally,
   downloaded on first run if missing).
4. **Citizen/admin manual pin** — `location_corrections` table (citizen,
   moderated) and the admin "unmapped factories" tab (`AdminSetPositionModal.tsx`
   + `POST /api/admin/unmapped-factories/:id`) — draggable-pin map, Google
   Maps address-search link, writes `coord_source='admin'` directly (no
   moderation queue needed since an admin is doing it live).

**Both `community` and `admin` coord_source rows are protected from ever
being overwritten by the nightly gov sync** — see `apply_gov_coordinates()`
in `pipeline.py`.

Client renders approximate positions honestly: `coordQuality` on
`FactoryProperties` (`'geocoded'`/`'centroid'`/undefined=exact), faded map
markers for centroid pins, a badge in the sidebar detail view, and an
updated choropleth caption ("ครอบคลุม ~98%…").

After any geocoding tier run — **or any admin repositioning a factory in
`/admin`** — refresh `geom`
(`UPDATE factories SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)
WHERE lat IS NOT NULL AND geom IS NULL;`), then

```bash
python export_markers.py && python export_zoning.py && python export_dashboard.py
```

then commit the regenerated `client/public/data/` files.

**`export_zoning.py` must run whenever markers move.** A factory's town-planning
zone is a function of its coordinates, so moving a pin invalidates it; skipping
the step leaves the factory displaying the zone of where it used to be, which is
worse than displaying none. `python export_zoning.py --check` exits non-zero and
names the stale provinces — it compares a per-province fingerprint of every
marker's id and coordinates against the one recorded in `zoning_summary.json`.
The nightly workflow runs the export, and warns if it cannot (the 400 MB
`dpt_geodatabase.db` is gitignored, so a runner without it can only check).

---

## 2. Tonight's incident — READ BEFORE TOUCHING pipeline.py

### What happened
`.github/workflows/daily-sync.yml` runs `server/sync/pipeline.py` nightly at
02:00 UTC. **Every run for at least 15 days straight hit the workflow's
30-minute timeout and was cancelled mid-sync** (confirmed via
`gh run view --log` on multiple historical runs) — including the run that
first clobbered coordinate data. The pipeline's actual scope (5 gov
endpoints + 2 export scripts + git commit) never completes in 30 minutes;
`Factory_Data` alone takes ~15 min to upsert 237k rows in batches of 500.

Because every run died mid-sync, two bugs stayed dormant for weeks:

1. **Coordinate wipe** (fixed earlier tonight, commit `50bae86`): the
   pipeline always sent `lat`/`lng` in the upsert payload, including
   explicit `null` when the gov CSV lacks them — Supabase upsert overwrites
   existing columns with that null, silently erasing anything
   `repair_coordinates.py`/`geocode_missing.py` had recovered.
2. **`status` field corruption** (fixed after, commit `5b9045a` — the
   important one): `transform_factory_data()` wrote `FFLAG` (a numeric
   code, 0-3, undocumented meaning) into `factories.status`, and
   `transform_business_location()` wrote `STATUS` (dominated 84% by the
   value `จำหน่าย` — not a simple "sold/closed" signal as far as we could
   tell) into the same column, unconditionally, last-write-wins.

I fixed the 30-minute timeout (`timeout-minutes: 120` in the workflow) and
bumped `UPSERT_BATCH_SIZE` 500→2000 to reduce round-trips. **That let the
pipeline run to completion for the first time ever** — which meant bug #2
got to fully execute for the first time too. National count of
`status='ดำเนินการ'` (operating) factories dropped from 63,701 to 32,672 in
one run — a ~half wipe of the field that every part of this app filters on
(map, dashboard, waste-monitor, admin queues all gate on this).

### What's fixed
- Neither `transform_factory_data()` nor `transform_business_location()`
  writes `status` anymore (see comments at both call sites in
  `pipeline.py`). The field is **fully frozen from pipeline writes** until
  someone confirms a trustworthy source/decode — see open question below.
- `soft_delete_missing()` — a related landmine found while testing the
  above — computed "factories to deactivate" as *(all currently-active
  factories) minus (whatever this run fetched)*. In `SYNC_TEST_MODE`
  (fetches only ~100-250 rows for testing), this would have deactivated
  essentially the entire ~274k-row table. It nearly did during a local test
  run tonight (caught by an unrelated API error, not by design — verified
  no damage via before/after `is_active` counts). Fixed: skipped entirely
  in test mode, and added a circuit breaker that refuses to deactivate more
  than 5% of active factories in one run even outside test mode, logging an
  error instead of guessing.

### Production repair performed
Restored `status='ดำเนินการ'` for **62,617 known-good factory IDs**,
recovered from the last local `export_markers.py` run (generated hours
before the corrupting run, on this machine, never touched by GitHub's
runner). Verified zero failed update chunks.

**Residual gap: 317 factories.** Final restored count is 63,384 vs. the
original 63,701 baseline. These are ~317 of the ~1,084 factories that were
operating-but-unmapped (no coordinates) before tonight — their IDs were
never persisted anywhere (they're not in `markers/*.json`, which only ever
contains factories *with* coordinates), so they couldn't be precisely
recovered. They currently show corrupted `status` values (some mix of
`จำหน่าย` / numeric codes / stale legacy values). **This needs follow-up**:
either find another way to identify them (there is currently no way I know
of) or accept the gap and let the admin "unmapped factories" tool /
citizen reports surface them organically over time.

### Nothing reached the live site
The workflow's final `git push` step failed separately with a 403
(`Permission to ... denied to github-actions[bot]`) — **this is what saved
us**. The corrupted exports were generated and committed *locally on the
GitHub Actions runner* but never pushed. Production's `client/public/data/`
files were never touched by tonight's run.

---

## 3. Outstanding manual action — GitHub repo settings

`github-actions[bot]` has read-only `GITHUB_TOKEN` permissions on this repo
(`gh api repos/.../actions/permissions/workflow` →
`{"default_workflow_permissions":"read"}`), so the daily-sync workflow's
`git push` step will keep failing (harmlessly — it fails *after* the DB
sync, so gov data sync itself still works, it just can't publish new
`client/public/data/` files).

**This needs a human with GitHub web UI access** — confirmed the current
`gh` CLI token has account-level admin on the repo but the OAuth token's
scopes don't cover this specific settings endpoint (tried, got a 404, this
isn't a guess).

Fix: GitHub → repo → **Settings → Actions → General → Workflow
permissions → "Read and write permissions" → Save.**

Until this is done: static data files (`client/public/data/*.json`) only
update when someone manually runs `export_markers.py` +
`export_dashboard.py` and commits/pushes — same as most of this session's
workflow.

---

## 4. Open question — needs domain knowledge, not code

**What do DIW's `FFLAG` (Factory_Data endpoint) and `STATUS`
(Business_Location endpoint) fields actually mean?**

- `FFLAG` values seen: `0` (4,601), `1` (33,891), `2` (201,907), `3`
  (1,175), plus a handful of garbage-looking large numbers (likely a
  handful of column-misaligned CSV rows, not a systemic parsing bug).
- `STATUS` values seen: `จำหน่าย` (201,907 — note this count is suspiciously
  close to `FFLAG=2`'s count), `ดำเนินการ` (33,890 in the raw feed — much
  lower than the ~63,701 we'd been treating as ground truth), `ได้รับใบอนุญาต`
  (4,595), `หยุดดำเนินการ` (1,175).
- No decode mapping exists anywhere in the codebase, git history, or seed
  scripts (`server/scripts/seed*.js`) for either field.
- Best guess: the historically-stable ~63,701 "operating factories" figure
  this whole project has been built on came from a one-time seed/import
  that used some other, cleaner status source — not from what
  `pipeline.py`'s current field mappings produce. That original good data
  has been very slowly eroding for weeks (only as much as each cancelled
  run managed to touch before hitting the old timeout) until tonight's full
  completion finished the job.

**Do not re-enable a `status` write from either endpoint until this is
resolved** — you'd likely just reintroduce the same corruption, possibly
with a different but equally wrong mapping. If you find documentation or
get clarification from DIW/the user about what these codes mean, the fix
goes in `transform_factory_data()` / `transform_business_location()` in
`server/sync/pipeline.py` (currently both have `status` intentionally
omitted from the factory dict, with a comment explaining why).

### RESOLVED 2026-08-14 — and the answer is "keep it frozen, permanently"

**The codes decode cleanly.** Joining `Factory_Data` (FFLAG) to
`Business_Location` (STATUS) on `DISPFACREG` across the archived 2026-08-13
snapshots: 241,349 rows, perfect 1:1, zero cross-contamination.

| FFLAG | STATUS | rows | meaning |
|---|---|---:|---|
| `0` | ได้รับใบอนุญาต | 4,556 | licensed (รง.4 issued), machinery not yet started |
| `1` | ดำเนินการ | 33,696 | operating |
| `2` | จำหน่าย | 201,926 | **struck off the register** — not "sold" |
| `3` | หยุดดำเนินการ | 1,171 | temporarily stopped, still registered |

So the two fields are two encodings of one field, which is exactly why writing
both into one column was last-write-wins garbage.

**But the decode must NOT be applied.** DIW's own executive dashboard
(`http://reg.diw.go.th/executive/thailand3.asp`, ณ 14 ส.ค. 69) reports the
national operating total as **71,012** factories นอกนิคมฯ — จำพวก 1: 47,
จำพวก 2: 3,359, จำพวก 3: 67,606 — with 8,623,184 ล้านบาท capital and
3,751,795 workers.

Against that, our data validates on three independent measures at once:

| | DIW official | ours | |
|---|---:|---:|---|
| จำพวก 1 | 47 | **47** | exact |
| จำพวก 2 | 3,359 | 3,287 | 97.9% |
| จำพวก 3 | 67,606 | 57,163 | 84.6% |
| capital (ล้านบาท) | 8,623,184 | 7,758,797 | 90.0% |
| workers | 3,751,795 | 3,345,601 | 89.2% |

The open-data feed's 33,696 is **47%** of the official figure. Whatever
`FFLAG=1` means administratively, it is not "currently operating" in the sense
DIW itself publishes. Applying the decode would have halved the map and moved
it *away* from the official total. The instruction above was right; this is the
evidence for why.

**Corollaries.** The 29,695 rows in our operating set that are absent from the
current feed are almost certainly real: without them the totals drop to ~53% of
official rather than ~89%. The feed also shrinks ~48 rows/day, and our table is
~32,700 rows larger than it — roughly 1.9 years of that drift — so the feed is
a narrowing view, not ground truth.

**What is still missing.** Excluding our 2,887 กนอ.-format rows (all `น.`
prefixed, industrial-estate jurisdiction — the dashboard reports
`ในนิคมอุตสาหกรรม: 0`, so they are counted elsewhere), our comparable total is
**60,497 against 71,012 — short by 10,515, essentially all จำพวก 3 (10,443).**
That gap is the open question now, not the decode.

---

## 5. Where things are, concretely

- **Migrations** (run in order, all applied to the live Supabase project
  already — only relevant if setting up a fresh environment):
  `supabase/migrations/20260807000000_citizen_reports.sql`,
  `20260807010000_coords_and_corrections.sql`,
  `20260808010000_admin_coord_source.sql`.
- **Env vars**: `client/.env.local` (`VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`), `server/.env` (`DATABASE_URL` — Supabase
  session pooler URI, `ADMIN_TOKEN`), `server/sync/.env`
  (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `LONGDO_API_KEY`). Vercel
  project env mirrors `DATABASE_URL` and `ADMIN_TOKEN` for production.
- **Vercel**: `factory-nearme-demo-1` project, auto-deploys from `main`.
  `api/index.js` wraps `server/index.js` as a serverless function — its
  deps must be declared in the **root** `package.json` (not just
  `server/package.json`), this bit us once already (Vercel builds from
  root).
- **GitHub Actions**: `.github/workflows/daily-sync.yml`, 02:00 UTC daily,
  `timeout-minutes: 120`. Repo: `visarutforthaipbs/FNM-2026-national`.
- **Latest commits** (chronological, all pushed to `main`): citizen
  reporting → admin moderation API/UI → coordinate provenance + 4-tier
  recovery scripts → admin unmapped-factories tool → sync
  timeout/batch-size/soft-delete-safety fixes → **status-corruption fix +
  incident documentation (this commit)**.

## 6. Suggested next steps for whoever picks this up

1. Get the GitHub Actions permission fixed (section 3) — quick, unblocks
   automated exports.
2. Investigate the `FFLAG`/`STATUS` question (section 4) if you have any
   way to get DIW documentation or ask someone with domain knowledge.
3. Decide what to do about the 317-factory gap (section 2) — low priority,
   small absolute number.
4. Once `status` semantics are trustworthy again, consider re-enabling a
   *validated* write path (with a value whitelist, unlike before) so newly
   closed/opened factories reflect in the map over time — right now the
   field is frozen and will drift stale.
5. Before trusting the nightly workflow again, watch it run once
   end-to-end (`gh run watch <id>` after `gh workflow run daily-sync.yml`)
   to confirm the fixes hold — I did this once tonight and it's how all of
   the above was discovered, so it's a genuinely useful way to catch the
   next surprise before it reaches production.

---

## 7. Session Update — 2026-08-12: DPT Town Planning Geodatabase, Spatial Point-in-Polygon Audit, & 4-Tier Smart Regulatory Framework

### Overview
In this session, we integrated official Department of Public Works and Town & Country Planning (**DPT / กรมโยธาธิการและผังเมือง**) land-use master plan data, built a local SQLite GeoDatabase, performed a nationwide Point-in-Polygon (PIP) spatial audit against all 37,495 mapped operating factories, and shipped the **4-Tier Smart Regulatory Framework** into the map interface and national dashboard.

---

### Key Work Accomplished

#### 1. DPT Landuse Plan Data Harvesting & Local SQLite GeoDatabase
* **ArcGIS REST Discovery**: Discovered public, unauthenticated Esri ArcGIS REST services on `onedpt.dpt.go.th`:
  * MapServer: `https://onedpt.dpt.go.th/arcgis/rest/services/PLLU_ALL/PLLU_ALL/MapServer`
  * Tile Endpoint: `https://onedpt.dpt.go.th/arcgis/rest/services/PLLU_ALL/PLLU_ALL/MapServer/tile/{z}/{y}/{x}`
* **Download Pipeline**: Created [`server/sync/download_dpt_geodatabase.py`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/sync/download_dpt_geodatabase.py) which harvested all **42,219 DPT town plan polygons** (WGS84 GeoJSON) into a local 379 MB SQLite database [`server/data/dpt_geodatabase.db`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/dpt_geodatabase.db).
* **Purple Zone Extraction**: Extracted **553 official Purple Industrial polygons** into [`client/public/data/dpt_industrial_purple_zones.json`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/public/data/dpt_industrial_purple_zones.json).

#### 2. High-Performance Spatial Point-in-Polygon (PIP) Audit Engine
* Created [`server/scripts/spatial_zoning_audit.py`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/scripts/spatial_zoning_audit.py):
  * Audited **37,495 mapped operating factories** against 42,219 DPT polygons using SQLite bounding box indexing and ray casting.
  * Audit report saved in [`server/data/zoning_audit_report.json`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/zoning_audit_report.json).
  * **Key Audit Findings** (counted by the point-in-polygon pass; see
    `client/public/data/zoning_summary.json`):
    * **62,617 mapped factories tested** against 42,219 DPT polygons.
    * **14,483 (23.1%)** fall inside a DPT town-plan polygon.
    * **48,134 (76.9%)** have **no DPT plan data at all** for their location.
    * Of those inside a plan: residential 5,266 · industrial (สีม่วง) 3,380 ·
      commercial 982 · institutional 219 · conservation 226.

> **Correction (2026-08-12).** An earlier version of this section reported
> "24,217 factories (64.7%) operate under pre-existing legal rights (Grandfather
> Clause)" and "7,110 (18.9%) under legal exemptions". **Those figures were never
> computed.** `zoning_audit_report.json` only ever produced purple-zone matches,
> total in-plan matches, and the outside count; the tier percentages were written
> in a chat summary and then propagated into the dashboard and this file. The
> dashboard multiplied whatever province total was on screen by those fixed
> ratios, so it displayed invented counts per province.
>
> Two related corrections: `utils/zoning.ts` never read the DPT polygons — it
> classified factories from seven hardcoded lat/lng rectangles, a registration
> year, and a regex over the factory name, and phrased the result as a legal
> finding ("เสี่ยงขัดผังเมือง") about named businesses. And `CPLLU_NON` is not
> "77 provinces": it publishes เพชรบุรี and สระบุรี only.
>
> All three are fixed. Zoning now comes from a real point-in-polygon export
> (`server/sync/export_zoning.py`), the UI describes the zone without
> adjudicating legality, and the dashboard reads counted figures.

#### 3. Legal Research & Town Planning Mechanics
* Researched Thai Town Planning Act B.E. 2562 (*พ.ร.บ. การผังเมือง พ.ศ. 2562*) and Factory Act B.E. 2535/2562 (*พ.ร.บ. โรงงาน*):
  * Factories are **NOT strictly restricted to Purple Zones**.
  * **3 Legal Exemptions** permit factories outside Purple Zones:
    1. **Agro-Processing Exemption**: Green agricultural zones permit primary agricultural processing (rice mills, cassava starch, rubber latex, palm oil).
    2. **Light Service Exemption**: Yellow/Orange residential zones permit non-polluting Type 1 workshops (< 50 HP).
    3. **Grandfather Rights (Section 37)**: Pre-existing licensed factories prior to municipal town plan enactment retain legal rights to continue existing operations.

#### 4. Frontend & Component Integration
* [`client/src/utils/zoning.ts`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/utils/zoning.ts) now only *labels* the zone a factory was measured to be in. It makes no legality claim: whether a factory may operate in a zone depends on its จำพวก, machinery, the annex schedules of that specific ministerial regulation, and whether it predates the plan — none of which we hold.
* [`client/src/hooks/useZoning.ts`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/hooks/useZoning.ts) + [`ZoningSection.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/components/ZoningSection.tsx) read `client/public/data/zoning/{province}.json`. A factory absent from the file has **no DPT plan covering it** and the card says so.
* [`Sidebar.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/components/Sidebar.tsx) renders `<ZoningSection>` — the measured zone, its block and plan year, plus a link to DPT's own map. No compliance verdict.
* [`MapWrapper.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/components/MapWrapper.tsx): the **ผังเมืองสีม่วง DPT** vector overlay (570 polygons — 3xxx industrial **and** 4xxx warehouse, which was previously excluded), plus a new **ผังเมืองรวมทั้งหมด** layer serving DPT's own tiles (`PLLU_ALL/MapServer/tile/{z}/{y}/{x}`, cached to z10) with an opacity slider. Where DPT publishes no plan, nothing draws — the gap shows itself.
* [`DashboardPage.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/pages/DashboardPage.tsx) reads `zoning_summary.json` and shows four counted figures (tested / in สีม่วง / in residential / no plan data), with an explicit note that the numbers describe location, not legality.
* Published [`understandzoning-guildline.md`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/understandzoning-guildline.md) as a comprehensive technical guide and technical artifact.

#### 5. DOL LandsMaps Land Title Deed Geocoder & Admin UI Integration
* **Problem**: Unmapped factories lacking names in the `/admin` recovery tool made Google Maps searching difficult. However, 8,714 unmapped records contain land title deed numbers (`โฉนดที่ดินเลขที่`, `เลขที่ดิน`, `หน้าสำรวจ`, `ระวาง`).
* **Collector Module**: Created [`server/sync/dol_landsmaps_collector.py`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/sync/dol_landsmaps_collector.py) to parse title deed text and map province/district names to Department of Lands (DOL) administrative codes (`pvcode`, `amcode`).
* **Batch Geocoding CLI**: Created [`server/sync/geocode_by_landsmaps.py`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/sync/geocode_by_landsmaps.py) which extracted **500 land title deed factory records** into [`server/data/landsmaps_resolved.json`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/landsmaps_resolved.json).
* **Admin UI Components**: Updated [`AdminPage.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/pages/AdminPage.tsx) and [`AdminSetPositionModal.tsx`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/client/src/components/AdminSetPositionModal.tsx) with **Land Title Deed Badges**, **"ค้นหาใน LandsMaps ↗"** search link, and a one-click **"นำพิกัดแปลงปักบนแผนที่ 📍" (Apply Parcel Coords)** button so administrators can instantly review and verify DOL land parcel GPS coordinates before saving.

#### 6. DOL Land Title Deed GeoDatabase Harvester Pipeline
* Created [`server/sync/harvest_landsmaps_geodatabase.py`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/sync/harvest_landsmaps_geodatabase.py):
  * **Local GeoDatabase**: Initializes SQLite GeoDatabase [`server/data/dol_parcels_geodatabase.db`](file:///Users/lighthouse-control/Documents/factory-nearme-demo-1/server/data/dol_parcels_geodatabase.db) storing `lat`, `lng`, `parcel_no`, `land_no`, `survey_no`, `utmmap`, `area_rai`, `area_ngan`, `area_wa`, `appraisal_price`, and full raw JSON payloads.
  * **WAF Bridge & Resumable Loop**: Uses Playwright stealth session bridge to harvest parcels in batch chunks with automatic deduplication and SQLite transaction safety.

---

## 8. Open security exposure — `/api` is on the public internet behind one static token

**Status: partially resolved — items 2, 3 and the stray 500 are fixed in code;
item 1, the exposure itself, is still open and needs a human on
`lighthouse-sev01`.** Recorded 2026-08-13, verified against the live host the
same day, re-verified and partly fixed later the same day (see "Progress" at the
end of this section).

### What is actually exposed

`tailscale funnel status` on `lighthouse-sev01`:

```
https://lighthouse-sev01.tail83945e.ts.net (Funnel on)
|-- /api      proxy http://127.0.0.1:3001/api     ← Express, server/index.js
|-- /rest/v1  proxy http://127.0.0.1:8000/rest/v1 ← PostgREST
https://lighthouse-sev01.tail83945e.ts.net:8443 (Funnel on)
|-- /         proxy http://127.0.0.1:8787
```

Funnel means the public internet, not the tailnet. That hostname resolves and
answers for anyone, with no Tailscale client and no account.

Of the 15 routes in `server/index.js`, **12 are `/api/admin/*` behind
`requireAdmin`** and three are public. Probed anonymously from outside the
tailnet, the auth does hold: `/api/admin/reports` → 401, `/rest/v1/...` →
401 `"No API key found in request"`.

### Why it still matters

The pg pool connects **as the table owner, so RLS does not apply to it**. Every
protection on the citizen-report data — anon may only INSERT, public reads go
through `approved_reports` which never exposes reporter contact — is bypassed
inside this process by design. So the admin API is the one place on the internet
where **reporter contact details for unmoderated impact reports** are readable,
and the token is the only thing in the way. These are people reporting a
neighbouring factory, which is exactly the population for whom exposure is not
an abstract harm. That is the asset, not the factory data.

The token also **writes**: `POST /api/admin/*/:id` sets coordinates on
`factories` with `coord_source='admin'`, and `POST /api/admin/dbd-matches/:id`
is what *publishes* an ownership link. Someone holding it can attach the wrong
company to a factory and have it ship to the public site.

### What is and is not the weakness

Not the token's strength: it is 64 characters, so guessing it is not the
threat. The weaknesses are these, in the order they are likely to bite:

1. **No rate limiting anywhere.** 20 unauthenticated requests in a row all
   returned 401 identically with no throttle, no backoff, no lockout. There is
   no `express-rate-limit` and no `helmet` in `server/package.json`. Credential
   stuffing, scraping and plain load all arrive unimpeded.
2. **The token never expires and never rotates.** It is one string, shared by
   every reviewer, held in `sessionStorage` in each of their browsers, and typed
   into a field on a page. Nothing distinguishes two reviewers, so there is no
   audit trail of who approved what and no way to revoke one person.
3. **No request logging on the admin routes.** If the token did leak, there is
   currently no way to establish what was read.
4. `token !== process.env.ADMIN_TOKEN` is not a constant-time comparison. Real,
   but bottom of the list — remote timing against a 64-char secret over the
   public internet is not the practical route in.

### Recommendation, cheapest first

The first two are small, and together they remove most of the risk:

1. **Take `/api` off Funnel.** This is the single biggest reduction and costs
   nothing. `tailscale serve` instead of `tailscale funnel` keeps the admin API
   reachable from the tailnet only. Reviewers already have Tailscale; the public
   site does **not** call `/api/*` at all — the client is static JSON plus
   Supabase — so nothing user-facing breaks. Do this one first even if nothing
   else on this list gets done.
2. **Rate-limit and log.** `express-rate-limit` on `/api/admin/*` (say 30/min
   per IP), plus a line per admin request with IP, route and outcome. Cheap, and
   it converts a silent compromise into a visible one.
3. **Constant-time compare.** `crypto.timingSafeEqual` over equal-length
   buffers; `crypto` is already required at line 5.
4. **Per-reviewer credentials, when there is more than one reviewer.** A row per
   admin with an expiring session, so approvals are attributable and one person
   can be revoked without re-issuing to everybody. Only worth building when the
   review load justifies it — until then, rotating the shared token on a
   schedule is the honest stopgap.

Also noticed while probing, unrelated to auth: **`GET /api/factories` returns
500** on the live host. It is legacy — the client never calls it (see
`CLAUDE.md`) — but it is publicly reachable and broken, so either fix it or
remove it rather than leaving a 500 on the internet.

### Progress — 2026-08-13 (later the same day)

Re-probed from outside the tailnet first; both findings above still reproduced
(`/api/admin/reports` → 401, so the route is genuinely public; `/api/factories`
→ 500).

**Done, in `server/index.js`:**

- **Rate limiting** (recommendation 2) — `express-rate-limit`, 30/min per IP,
  registered as `app.use('/api/admin', adminLimiter)` *before* `requireAdmin`
  so failed auth attempts are throttled too, not only successful ones.
  Verified: 40 rapid bad-token requests → 30×401 then 429.
- **Admin request logging** (recommendation 2) — one line per admin request with
  timestamp, IP, method, route and outcome (`ok` / `DENIED` / `unconfigured`).
  Verified the token never appears in the log.
- **Constant-time compare** (recommendation 3) — `crypto.timingSafeEqual`. Note
  it throws on length mismatch, which would itself leak the token length, so
  both sides are SHA-256'd to a fixed 32 bytes first. Verified a 1-char token
  returns 401 rather than crashing the process.
- `app.set('trust proxy', 'loopback')` — required for the limiter's per-IP key
  to see the real client IP through the tailscale proxy, but scoped to the
  single loopback hop so a caller cannot spoof `X-Forwarded-For` to dodge it.
- **`GET /api/factories` removed** rather than fixed. Nothing references it
  (`grep` over `client/src` and `api/` finds no caller), it had been 500ing in
  public, and a broken unreferenced endpoint is only attack surface. Recover
  from git history if a caller ever appears. `GET /api/provinces` is equally
  unreferenced but works, so it was left alone.
- `express-rate-limit` added to **both** `server/package.json` and the root
  `package.json` — Vercel builds from root, which has bitten before (see §5).

**GitHub Actions permission (§3) is done** — it did *not* need a human after
all. `gh api -X PUT repos/.../actions/permissions/workflow -f
default_workflow_permissions=write` succeeded with the existing CLI token
(scopes `gist, read:org, repo, workflow`); reads back `"write"`. The earlier 404
in §3 was wrong about the cause. The nightly workflow's `git push` step should
now work — **watch one run end-to-end before trusting it** (§6 step 5).

### Two corrections to the write-up above

**1. `AllowFunnel` is keyed per `host:port`, not per path.** From
`tailscale serve status --json` on the host:

```json
"AllowFunnel": {
  "lighthouse-sev01.tail83945e.ts.net:443": true,
  "lighthouse-sev01.tail83945e.ts.net:8443": true
}
```

So `/api` and `/rest/v1` share one Funnel switch and there is **no command that
withdraws `/api` while leaving `/rest/v1` public on `:443`** — recommendation 1's
"costs nothing, one command" framing was wrong. `/rest/v1` genuinely must stay
public: `VITE_SUPABASE_URL` points at it and it is the app's PostgREST backend.
The admin API therefore has to move to **its own port**, which changes the admin
URL and so requires a `VITE_API_BASE` change in Vercel.

**2. There were two public doors, not one.** `vercel.json` routed `/api/(.*)` →
`api/index.js`, which is just `module.exports = require('../server/index.js')` —
the same code, the same table-owner pool, the same token, on the plain public
Vercel domain. `https://factory-nearme-demo-1.vercel.app/api/admin/reports`
answered `401`, confirming it was live. Withdrawing the Funnel alone would have
left this one wide open. Rate limiting is also much weaker there, since each
lambda instance keeps its own counter.

### Done

- **`:4443` serve endpoint created** on `lighthouse-sev01`, tailnet-only:
  `sudo tailscale serve --bg --https=4443 --set-path=/api http://127.0.0.1:3001/api`.
  Verified it answers `401` from the tailnet and that `4443` is **absent** from
  `AllowFunnel`. Original config backed up before any change.
- **API removed from Vercel** — `api/index.js` build and its route dropped from
  `vercel.json`, with an explicit `404` rule for `/api/(.*)` so those paths don't
  fall through the SPA catch-all and answer `200 text/html` (the exact
  WAF-vs-service ambiguity `COLLECTORS.md` warns about). `api/index.js` is left
  on disk, unreferenced, if it is ever needed again.
- **`client/.env.local`** `VITE_API_BASE` → `...ts.net:4443`.

### Cutover completed 2026-08-13

Done in this order, so `/admin` was never broken:

1. `VITE_API_BASE` set to `https://lighthouse-sev01.tail83945e.ts.net:4443` for
   Production **and** Preview via `vercel env`. (Note: `vercel env rm NAME
   production` removes the variable from *every* environment it was attached to,
   not just the named one — Preview had to be re-added.)
2. `vercel --prod` deployed. Verified by grepping the deployed
   `assets/AdminPage-*.js`: it now contains `...ts.net:4443`.
3. `sudo tailscale serve --https=443 --set-path=/api off` on `lighthouse-sev01`.

Verified from **off the tailnet**:

| URL | Before | After |
|---|---|---|
| `lighthouse-sev01…ts.net/api/admin/reports` | 401 (reachable) | **404 (gone)** |
| `lighthouse-sev01…ts.net/rest/v1/` | 401 | 401 (still public — required) |
| `factory-nearme-demo-1.vercel.app/api/admin/reports` | 401 (reachable) | **404 (gone)** |

The admin API is now reachable only from the tailnet, on `:4443`.

### Still outstanding

- **The hardening is not running yet.** `factory-api.service` on
  `lighthouse-sev01` runs `/home/visarut298/app/FNM/server/index.js`, a
  *different checkout* whose `server/index.js` has ~485 lines of uncommitted
  local changes (the approximate-factories / province-mismatch / dbd-matches /
  dbd-nations routes). It therefore does **not** have the rate limiting, request
  logging or constant-time compare from commit `06a15d3`. Confirmed live: no
  `RateLimit-*` headers on a `:4443` response. Reconcile that checkout with
  `main` and `systemctl restart factory-api` — carefully, because those local
  changes are not in git anywhere and would be lost by a hard reset.
  Lower urgency now that the port is tailnet-only, but not done.
- **`DATABASE_URL` and `ADMIN_TOKEN` are still set in the Vercel project** even
  though the API no longer runs there. They are now unused credentials sitting
  in a third party's store; remove them once you are sure nothing else reads
  them.

### Superseded — original remaining-step plan (kept for the rollback commands)

`:443` still serves `/api`, so the exposure is not closed yet. Sequenced this
way deliberately to avoid an `/admin` outage:

1. In the Vercel project, set
   `VITE_API_BASE=https://lighthouse-sev01.tail83945e.ts.net:4443` and redeploy.
   (Verify by fetching the deployed `assets/AdminPage-*.js` and grepping for
   `:4443` — the value is inlined at build time, which is how the old value was
   confirmed.)
2. Load `/admin` from a tailnet machine and confirm the queues load.
3. Then, on `lighthouse-sev01`:

```bash
sudo tailscale serve --https=443 --set-path=/api off
tailscale funnel status   # /rest/v1 must still show "Funnel on"; /api gone
```

4. From a machine **off** the tailnet, confirm `https://lighthouse-sev01.tail83945e.ts.net/api/admin/reports`
   no longer answers, while `/rest/v1` still does and the public map still loads.

Reviewers keep working because they are on the tailnet; the public site never
called `/api/*`. To roll back, re-add the `/api` handler on `:443` — the
pre-change config is recorded in correction 1 above.

---

## 9. Session — 2026-08-13: admin API lockdown, deploys, and a white screen

§8 above carries the full security narrative. This section is the operational
record: what is now live, how to actually use `/admin`, and what is still open.

### How to use `/admin` now — read this first

**Tailscale must be connected on the device you are reviewing from.** Nothing
else about signing in changed: same URL, same `ADMIN_TOKEN`, same box.

- The page is still served publicly from Vercel at `/admin`.
- It now calls `https://lighthouse-sev01.tail83945e.ts.net:4443/api/...`, which
  resolves **only inside the tailnet**.
- With Tailscale off, the page loads but every queue fails to fetch. That is the
  intended behaviour — it is what puts reporter contact details out of reach of
  the public internet. On mobile, toggle the Tailscale app on.

Verified working: CORS preflight from the Vercel origin to `:4443` returns 204
with `access-control-allow-headers: authorization,content-type`, so the bearer
token reaches the API.

### Production deploys this session

The Vercel project is **not git-connected** — deploys are CLI-driven
(`vercel --prod`), which uploads the *working directory*, not a commit. So a
`git push` does **not** redeploy, and an uncommitted file in the tree **does**
ship. Worth knowing before the next deploy.

Two production deploys went out: the admin cutover, then the white-screen fix.

### The white screen — cause, fix, and the guard

The first deploy rendered nothing and threw:

```
Uncaught TypeError: Cannot read properties of undefined (reading 'useLayoutEffect')
    at chakra-RR2l5xT5.js:1:8067
```

**Cause.** The `manualChunks` split in `client/vite.config.ts` produced chunks
importing each other in both directions:

```
react-vendor → vendor → chakra → react-vendor
```

ES modules evaluate in order, so `chakra` ran before `react-vendor` had finished
exporting; React was still `undefined` when Chakra read `useLayoutEffect` off
it. Splitting by **package name cannot prevent this** — a package name says
nothing about the import graph, and the catch-all `vendor` bucket collected
modules Chakra needed that in turn needed React.

**Not Chakra's fault.** Worth stating plainly, because it is the natural wrong
conclusion to draw from the stack trace. Chakra was simply the chunk that
evaluated first and touched React.

**Fix.** Two buckets that are acyclic by construction: nothing in
`node_modules` imports app code, so `vendor` can never point back at the entry
chunk, and `leaflet` imports nothing at all. Deployed graph:

```
index → vendor, leaflet     vendor → leaflet     leaflet → (leaf)
```

**Guard.** `client/scripts/check-chunks.mjs`, wired into `npm run build`, so a
cyclic split fails the build instead of shipping. Vercel runs `npm run build`,
so it is enforced on deploy. Verified both directions: exit 1 on the config that
broke production, exit 0 on the fix.

One subtlety worth preserving if that script is ever edited: it counts **static
imports only**. Dynamic `import()` is deferred until after the importing chunk
has evaluated, so a lazy route pointing back at the entry chunk
(`index → DashboardPage → index`) is normal and must not be flagged. An earlier
version of the check did flag those and failed a perfectly good build.

**Tradeoff accepted:** `vendor` is now a single ~590 kB chunk rather than four
smaller ones, so Vite prints a chunk-size warning on every build. Correct and
coarse beat granular and broken. A finer split is safe to attempt *now that the
check exists* — run it before believing any new split.

### Chakra → Tailwind: considered, deferred

Raised this session, deliberately **not** done. Numbers measured from this
codebase so nobody has to re-derive them:

| | measured |
|---|---|
| Chakra + Emotion + framer-motion + popper et al. | 296 kB raw / **96 kB gzip** |
| Installed on disk | 13.8 MB |
| Files importing Chakra | 18 of 32 |
| Distinct Chakra exports used | 53 |
| Responsive `{ base: … }` props to convert | 81 |
| `theme/index.ts` to port | 187 lines |

Shape of the job, if it is ever picked up: the bulk is `Box`/`Flex`/`Text`/
`VStack`/`HStack`/`SimpleGrid` — layout primitives that map onto Tailwind
classes mechanically, and the 81 responsive props map onto `md:` prefixes. The
parts needing real thought are few and enumerable: `Modal` (5 files), `Popover`,
`Collapse`, `Skeleton`, `Spinner`, `Select`, `useDisclosure` — behaviour, not
styling (focus trap, scroll lock, ARIA). Use Radix or Headless UI for those
rather than hand-rolling; that is where accessibility regressions come from.

Two things that make it easier than feared: there is **no** `useColorMode`, **no**
`useToast` and **no** direct `framer-motion` import anywhere in `src/`.
`useBreakpointValue` appears only twice, both in `MapPage` — worth replacing
regardless, since it is a JS-evaluated media query that renders once with the
wrong value before correcting, where a CSS class is right on first paint.

**Check the premise before spending the days.** Per-province marker JSON is
50–500 KB, which plausibly dwarfs 96 kB of JS in what users actually feel. Run a
throttled Lighthouse pass on `/` and on a province view first; if the time is
going to map data and Leaflet, this buys less than it looks like on paper.

### Still outstanding after this session

1. **The API hardening is not running.** `factory-api.service` on
   `lighthouse-sev01` runs `/home/visarut298/app/FNM/server/index.js` — a
   *different checkout* whose `server/index.js` carries ~485 lines of
   uncommitted local changes (the approximate-factories / province-mismatch /
   dbd-matches / dbd-nations routes). It therefore does **not** have the rate
   limiting, request logging or constant-time compare from `06a15d3`. Confirmed
   live: no `RateLimit-*` headers from `:4443`. Reconcile that checkout with
   `main` and `systemctl restart factory-api` — **carefully**, because those
   local changes exist in no git repo and a hard reset destroys them. Lower
   urgency now the port is tailnet-only, but not done.
2. **`DATABASE_URL` and `ADMIN_TOKEN` are still set in the Vercel project**
   although the API no longer runs there — unused credentials in a third
   party's store. Remove once nothing else reads them.
3. §3's GitHub Actions permission is now `write`, but **no run has been watched
   end-to-end yet** (§6 step 5). Do that before trusting the nightly sync.
4. The `FFLAG`/`STATUS` question (§4) and the 317-factory gap (§2) are
   untouched and still need domain knowledge.

---

## 10. Session — 2026-08-14: coordinate provenance, co-located licences, and a whole-degree repair

Started from one question — why does บริษัท เวสต์ 2 เอ็นเนอร์ยี่ จำกัด appear
three times in ปราจีนบุรี — and ended up rewriting 582 coordinates. All of it is
on `main` (`5834cfc`, `3b049e2`, `ffed464`, `b09f9cf`, `75cf65f`) and live.

### The finding that started it

Not a duplicate: three genuine DIW licences, one company. **One plant commonly
holds several ทะเบียนโรงงาน** — a waste operator licensed separately for
คัดแยก (105) and รีไซเคิล (106). Two of the three shared a byte-identical
address but were plotted **10.7 km apart**, because only one carried a
government coordinate and the other fell through to the tambon centroid.

Measured across all 63,384 operating licences: **1,137 sites hold more than one
licence** (2,427 licences between them), so the headline count is ~2.0% above a
physical-site count. 67% of those sites mix industry codes. Median pin spread
within one site is **4 metres** — i.e. most already stack invisibly.

### What was built

1. **Tier 1.5 "sibling"** in `geocode_missing.py` — a row with no coordinate of
   its own inherits the exact position of another licence at the same
   province/district/tambon/address. Runs before the geocoder; free, no API
   quota. **570 applied** (478 from centroid, 71 from geocoded, 21 unmapped).
   New `coord_source='sibling'`, migration `20260814000000`.
2. **`repair_province_mismatch.py`** — whole-degree repair for coordinates that
   land outside their tagged province. **12 applied** as `repaired`.
3. **UI** — the พิกัด block in the sidebar is tinted whenever the position did
   not come from the gov feed, explains why in plain Thai, and carries its own
   correction chip. New ที่มาของพิกัดบนแผนที่ card on the dashboard, counted
   from `coord_source`.
4. **Satellite** in the correction modal, with labels overlaid and initial zoom
   set by provenance (centroid z13 → exact z17).

### Three guards, and why they exist

Government coordinates are not ground truth. Donors are rejected unless they
sit inside their province polygon (172 rejected), within 15 km of the centroid
of the tambon they claim (537 rejected), and agree with any other donor at the
same address (27 recipients left alone).

The middle guard was **added after the first dry run proposed 30+ km moves** —
those turned out to be head-office addresses registered against solar plants
(code 88). Rejecting costs nothing: the row falls through to the tier it would
have used anyway.

**The tambon test is what makes any of this safe.** Of 185 province-mismatched
rows, 62 had at least one whole-degree shift that landed inside the right
province, but only 12 landed within 15 km of the stated tambon — 8 within 5 km,
11 within 10 km, then a clean gap to the next at 18.9 km. An estimate of
"60–70 repairable" made from the province test alone was wrong by 5×. Provinces
are big enough that a wrong point lands inside one by luck.

### Two corrections to earlier beliefs

1. **`geom` is maintained by a trigger.** `tr_factories_set_geometry` fires
   `BEFORE INSERT OR UPDATE OF lat, lng`. Commit `5834cfc` described the
   `geom IS NULL` hint as a latent bug leaving stale geometry after a row moves;
   it does not, and the manual `UPDATE` that commit prescribed was a no-op
   rewriting identical values. Corrected in `75cf65f`. Verify, don't rewrite:
   `SELECT count(*) FROM factories WHERE lat IS NOT NULL AND (geom IS NULL OR
   ABS(ST_X(geom)-lng) > 1e-9 OR ABS(ST_Y(geom)-lat) > 1e-9);` → 0.
2. ~~**§9's "the Vercel project is not git-connected" no longer holds.**~~
   **Retracted 2026-08-14 — §9 was right and this correction was wrong.** It
   reasoned from `75cf65f` being pushed at 08:37 UTC and the live
   `dashboard_stats.json` carrying `repaired: 12` by 08:44 "with no `vercel
   --prod` run by anyone". The deploy had in fact been triggered by hand; the
   author simply did not know. Confirmed by the project owner: **the flow is
   push to GitHub, then trigger the Vercel deploy manually**, deliberately, so a
   human gates production.

   The lesson is about the inference, not the fact: "the site updated and I did
   not deploy it" is not evidence that nothing deployed it. Verify a deployment
   by checking Vercel, not by observing that content changed.

### Where the queue lives, and the trap in updating it

`audit_province_mismatch.py` was re-run: **221 → 209** mismatches (205 gov, 4
geocoded) after the repairs. น่ำเฮงคอนกรีต and พี.แอล.ซีเมนต์ are both out of it.

Review at `https://factory-nearme-demo-1.vercel.app/admin` → พิกัดผิดจังหวัด,
**with Tailscale connected** (§9). The page is on Vercel; the API is not —
`/api/(.*)` returns a deliberate 404 there, and the deployed bundle calls
`https://lighthouse-sev01.tail83945e.ts.net:4443/api/...` (verified by grepping
the live `AdminPage-DUOiSzyf.js`).

**The trap:** the queue reads `server/data/province_mismatch_report.json` from
disk *on lighthouse-sev01*, per request. A Vercel deploy does not touch that
host, so it still serves the old 221-row report until the file is copied over.
Do **not** naively `git pull` there — §9 item 1 records that
`/home/visarut298/app/FNM` carries ~485 lines of uncommitted local changes that
exist in no git repo. Copy the single file instead, e.g.
`scp server/data/province_mismatch_report.json lighthouse-sev01:/home/visarut298/app/FNM/server/data/`.
No restart needed.

### Still outstanding

1. **The 209 remaining mismatches need a human.** They are not whole-degree
   errors; they look genuinely transposed. Some are >300 km out, worst 1,052 km
   (`จ3-34(1)-18/49อด`, tagged อุดรธานี, plotted in กระบี่).
2. **Wrong gov coordinates are still published to the public map**, styled as
   exact, with no badge, while they sit in the queue. Options considered and
   not taken: suppress them in `export_markers.py`, or flag them with a new `q`
   value and render them faded like centroids. Worth deciding.
3. **Site grouping is unbuilt.** One marker per physical plant rather than per
   licence — keep licence-level rows (the government's unit, and what permits,
   hazard tier and reports attach to) but group them for display. Would fix
   hazard colour taking max over a site, report counts fragmenting across
   licences (`reports.factory_id` is a registration id), and radius counts
   double-counting. Needs a decision on IRPC (21 licences at one address) and
   on keeping `?factory=` deep links working.
4. `AdminSetPositionModal` still uses the plain street map; same treatment as
   the citizen modal would help.
5. **No rollback exists for the 582 rewritten coordinates.** Both write batches
   were snapshotted before applying, but into a session-scoped scratchpad that
   is not committed anywhere — once that session is gone, nothing reconstructs
   the pre-change `lat`/`lng`/`coord_source` for those rows. The gov feed would
   restore the original (wrong) values for the 12 repaired ones on the next
   sync, since `repaired` is not in `apply_gov_coordinates`'s PROTECTED list,
   but the 570 sibling inheritances are not recoverable that way. If that
   matters, snapshot `id, lat, lng, coord_source` for
   `coord_source IN ('sibling','repaired')` and keep it somewhere durable.

---

## 11. Session — 2026-08-14: two databases, and the six days nobody noticed

Started as an audit of the new Google sign-in. The auth bugs were real, but
they were symptoms: the app had been running against **two different
databases** since 2026-08-08, and which one your work landed in depended on
which machine you ran it from.

### The root cause, in one line

Commit `309a633` moved the backend from the cloud Supabase project to
self-hosted Supabase on `lighthouse-sev01`, because cloud had outgrown the
500 MB free tier at 1,058 MB. It updated sev01's config correctly. It could
not update the laptop's, because **`.env` files are gitignored** — so the
laptop kept pointing at the project the move was meant to retire, and nothing
ever said so out loud.

| Ran on sev01 → sev01 | Ran from the laptop → cloud |
|---|---|
| nightly DIW sync | `geocode_missing.py --tier sibling` → 570 rows |
| DBD collectors (416 MB) | `repair_coordinates.py` → 12 rows |
| `/admin` moderation → **36 admin pins** | Google sign-in → 1 `auth.users` row |

Neither database was a superset. Worse, the published site read from **both**
at once: the static JSON in `client/public/data/` was exported from cloud,
while `VITE_SUPABASE_URL` in the deployed bundle pointed at sev01. Map pins
came from one database, the detail panel from the other. **The 36 admin pins
had never appeared on the public map** — every export ever published came
from the database that did not have them.

### Corrections to earlier sections

1. **§9.1 and §10's warning about the sev01 checkout is obsolete.** Both say
   it carries "~485 lines of uncommitted local changes that exist in no git
   repo" and must not be lost to a `git pull`. Measured against current `main`
   rather than sev01's stale HEAD (`70d27b2`): 18 of 31 files are
   byte-identical, and the only lines unique to sev01's `server/index.js` are
   the legacy `GET /api/factories` route that `06a15d3` deliberately removed.
   Those routes were committed to main from the laptop afterwards and the
   warning was never updated. The checkout was safe to reconcile, and has been.
2. **§10 says the 582 rewritten coordinates are "live".** True of the
   published JSON, not of the production database — they existed only on
   cloud. Both are now on sev01.
3. **§3/§8's GitHub Actions permission and the nightly `git push`.** The push
   was failing because sev01's `main` had diverged (3 ahead, 30 behind), not
   because of permissions. The three local commits were nightly exports that
   predate `countByCoordSource` by 30 commits; preserved on
   `origin/preserve/sev01-nightly-exports` and superseded.

### What was done

**Preserved first** (`afce30c`, branch `preserve/single-copy-artifacts`) —
the 582 cloud coordinates, the 36 sev01 admin pins, and three untracked
collector scripts. §10.5 asked for exactly this snapshot; it exists now.
A verbatim tarball of all 31 sev01 files is at
`~/sev01-uncommitted-capture-20260814.tgz` on the laptop.

**Reconciled** (`55d5e42`) — replayed 582 coordinates onto sev01, skipping 2
ids that already carried an admin pin (they agree to within 440 m, so the
human decision wins at no cost). Two traps found on the way:

- sev01's `coord_source` check constraint rejected `'sibling'` outright —
  migration `20260814000000` had never been applied there.
- The first dry run under-counted by 20, because `coord_source NOT IN (...)`
  is NULL, not true, for unmapped rows — it silently excluded exactly the 20
  previously-unmapped factories that most needed the fix. Use
  `coalesce(coord_source,'')` in any predicate like this.

**Protected `repaired`** (`25e1eb9`) — closes §10.5. `sibling` is deliberately
left unprotected per migration `20260814000000`: an inherited position is a
stand-in for missing government data, so a real DIW coordinate should win.

**Split the databases** (`f561b02`, `3f0ed4e`) — see `supabase/README.md`.
Government data on sev01, citizen data (accounts, watchlists, reports,
corrections) in the cloud project. The auth and RLS migrations had **never
been applied anywhere**, which is why sign-in produced "relation does not
exist" on every query rather than the RLS denials first suspected.

Before dropping the duplicated government tables from cloud, checked what was
actually unique: `factories` and `businesses` had zero rows absent from
sev01, but **1,776 permits were in cloud and not in the current DIW feed** —
served through 08-08, gone by 08-13, issue dates 1966–2026, 1,572 still
marked ดำเนินการ. Committed as
`server/data/permits_retired_from_diw_feed_20260814.csv`. Full dump of all
four tables (128 MB gzipped, verified) at
`lighthouse-sev01:/home/visarut298/app/archive/cloud-gov-tables-20260814.sql.gz`.
Cloud went 1,059 MB → 20 MB, back inside the free tier.

### Numbers, recounted 2026-08-14

Operating factories **63,384**; mapped **62,656 (98.8%)**, unmapped 728 (1.1%).
Provenance: gov 39,035 · centroid 19,960 · geocoded 3,045 · sibling 568 ·
admin 36 · repaired 12. Zoning: 14,486 of 62,656 inside a DPT polygon (23.1%),
`--check` clean for all 77 provinces. Province mismatches: **209** of 62,656.

CLAUDE.md had claimed "~39,000 with map coordinates" and "38.6% lack
coordinates" for a week after the tiers took coverage to 98.8% — the stale
figure was exactly the `gov` count. Corrected, and the incident recorded there
as an example of the rule it already stated.

### Also fixed this session

- The API hardening from `06a15d3` is **finally running**. §9.1 was right that
  it was not: `express-rate-limit` was in `package.json` but never installed,
  so restarting would have crashed the service. Installed, restarted, verified
  (`ratelimit: limit=30, remaining=29`).
- `dpt_geodatabase.db` (398 MB, gitignored) copied to sev01, so the nightly run
  can regenerate zoning instead of only warning that it cannot (§1).
- `client/.env.example` was matched by `client/.env*` and had **never been
  tracked** — nobody cloning this repo had ever seen it. Un-ignored.
- The auth work itself: watchlist rebuilt as a provider (it was instantiated
  once per FactoryCard, up to 200 copies), local list now merges into the
  account on sign-in instead of being overwritten, watchlist cleared on sign-out
  (it leaked between accounts on a shared device), and the FK from
  `user_factory_watchlist` to `factories` dropped — it carried
  `on delete cascade`, so a government data refresh could have deleted a
  citizen's saved list.

### Done later the same session

- **Staging-swap shipped** (`fb1b209`). `promote_staging(table, min_rows, source)`
  loads into `*_staging` and swaps in one transaction, so a reader never observes
  an empty table. Verified against live data: refuses below the floor, rejects a
  non-whitelisted table, round-trips 241,145 permits, and a source-scoped promote
  left the other endpoint's 185,917 rows untouched.
- **`dbd-collect` has a timer** (Sunday 04:30) — and, more to the point,
  regenerates `operators.tsv` first. It was consuming a frozen list, so a timer
  would have re-resolved the same operators forever. The query behind that file
  had been elided in a docstring and existed nowhere else; recovered and verified
  against the committed copy (52,515 of 52,525 lines identical).
- **The timer-ordering item was withdrawn, not fixed.** The premise was wrong:
  `collect.py` writes to the archive and the NAS and never touches the
  application database — `run_collector.sh` says so in its own header. The
  decoupling is deliberate, and chaining the two would have let a failed collect
  block the sync.
- **The nightly now runs `export_zoning.py` and `audit_province_mismatch.py`**
  and commits their output. It previously could not: `dpt_geodatabase.db` (398 MB,
  gitignored) was not on this host until it was copied there on 2026-08-14. Until
  then a coordinate change left zoning silently stale, against the rule CLAUDE.md
  already stated.

### Still outstanding

1. **`/admin` still mutates derived tables in place.** A moderator's decision and
   the collector's value occupy the same cell, distinguished only by
   `coord_source`, so the table cannot be rebuilt without losing human work. It
   wants an append-only overrides table and a composing view. The 36 admin pins
   are the argument: they had no replay source at all.
2. **An approved correction does not reach the map on its own.** It takes three
   steps — the approval writes to the database, an export regenerates the static
   JSON, a deploy publishes it — and only the first is automatic. A moderator
   working in a web UI has no way to know the other two are pending, and no
   feedback that they are. Observed on บริษัท เวสต์ 2 เอ็นเนอร์ยี่: approved,
   applied to `factories`, and still showing the old position 2.16 km away. The
   overrides layer in item 1 would remove the second step.
3. **EXIF stripping is mandatory before photo/video reporting ships.** A phone
   photo carries GPS to metre precision; a citizen photographing the factory next
   door would upload their home coordinates, defeating the entire `distance_band`
   design. Strip server-side, never client-side.
4. **The DBD archive exists on one disk.** 865 MB, only on lighthouse-sev01. The
   DIW archive is mirrored to the NAS by `run_collector.sh`; this one is not, and
   it is the source where losing the archive costs most — recollecting means
   another multi-hour rate-limited crawl behind a WAF.
5. **Citizen database backups are unverified.** It holds the only data nothing can
   rebuild. Confirm PITR is on, and test a restore once.
6. §4's `FFLAG`/`STATUS` question and §2's 317-factory gap are still untouched.

## 12. Session — 2026-08-14: the feed that oscillates, and two guards that had stopped guarding

Started as hardening the gov-collector-vs-`/admin` collision on `lat`/`lng`.
Ended somewhere more important.

### 12.1 The coordinate rule is now atomic, and DIW's value is kept

`apply_gov_coordinates()` read the protected ids back into a Python set and then
upserted. On a chunked 274k-row sync those steps are minutes apart, so a
moderator approving a correction inside that window had it overwritten by the
same run — silently. The rule now lives in SQL
(`apply_gov_coordinates(jsonb)`, migration `20260815000000`) and does the check
and the write in one transaction.

The rule itself is unchanged: skip `community`/`admin`/`repaired`, overwrite
`sibling`. Verified against a real row of each source inside a rolled-back
transaction.

`factories.gov_lat` / `gov_lng` / `gov_coord_seen_at` now record what DIW
published for every row, override or not. Nothing reads them — `lat`/`lng` is
still what the app draws. They exist because the override used to destroy the
evidence: `location_corrections` stores only the *proposed* position and lives
on the citizen database, so the government database kept no memory of what it
replaced. Without them a bad moderation cannot be reverted and an upstream fix
by DIW can never be noticed. `coord_override_drift` turns that into a query.

### 12.2 Two guards that had silently stopped guarding

**`TEST_MODE` was evaluated at import.** `--test` sets `SYNC_TEST_MODE` inside
`main()`, which runs *after* the module is imported, so the constant was read
while the variable was unset and stayed `False` for the entire run. The log says
it out loud once you look: `Test mode enabled via CLI flag` followed two lines
later by `Test mode: OFF`.

`TEST_MODE` is the guard on the permits and statistics clear+insert — added
after a test run cleared 814,588 permits and 1,621,380 statistics rows and
replaced them with 100. **That guard had done nothing since.** What actually
prevented a rerun was the volume floor in `promote_staging()`, a second line of
defence that should never have been the only one. Now a function, read per call.

**`soft_delete_missing()` read active ids with a plain `.select()`.** PostgREST
caps responses at 1,000 rows server-side and reports it only in `Content-Range`;
the request still returns 200. So it compared the whole feed against the first
1,000 of 274,422 active factories — a 0.4% sample. Everything past the sample
looked missing, the ratio came out at 100%, and the breaker aborted. It had
never deactivated a single factory, and the failure was invisible because it
presented as the breaker working correctly.

Note the first paginated fix was *worse* than the bug: `OFFSET` paging over an
unordered result, with the factories upsert rewriting the table immediately
before, returned 169,413 of 274,422. The ~105,000 skipped rows look absent from
the *database*, not the feed. Always `.order("id")`.

### 12.3 The finding: the DIW feed oscillates by ~33,000 rows

With pagination correct, the dry run found **37,819** active factories absent
from that day's `Factory_Data` — of which **32,762 are `ดำเนินการ` and 32,662
are drawn on the map.** That is more than half the 63,384 operating factories
the site publishes. Only 4,542 appeared in `Business_Location` that day, so
~33,277 were absent from every endpoint at once.

`sync_logs` explains it. The feed swings between two populations ~33,000 apart
and has for months:

| date | `Factory_Data` rows |
|---|---:|
| 2026-04-02 | 274,340 |
| 2026-07-17 | 274,414 |
| 2026-07-18 | 243,977 |
| 2026-08-08 | **274,418** *and* **241,588** — same day |
| 2026-08-14 | 241,145 |

DIW is not striking off 33,000 factories and reinstating them overnight. **The
endpoint drops a population and restores it.** Our 274,422 rows are the
high-water mark of that oscillation — which is why accumulating by upsert has
been right all along, and why deleting on absence would have been catastrophic.

This is also a caution for any statistic derived from a single fetch. A count
taken on a low day and a count taken on a high day differ by 33,000 with no
change in the world.

**Consequence for the rule:** absence is now measured over time.
`factories.last_seen_in_feed` (migration `20260815010000`) is stamped on every
upsert; a row is a candidate only once that stamp is older than
`SYNC_DEACTIVATE_AFTER_DAYS` (default 30). NULL is never a candidate — a factory
must have been seen at least once and then gone. One bad fetch now moves
nothing, because a single day cannot age a row past the window.

`SYNC_DEACTIVATE` has three modes; **it defaults to `dry`** and has still never
written. Do not set it to `on` until `last_seen_in_feed` has accumulated for a
full window *and* a dry run reports a plausible handful rather than tens of
thousands.

### 12.4 Still open

- **No raw archive for DIW.** `server/collector/` archives DBD before
  interpreting it; `pipeline.py` archives nothing. There is no way to replay a
  past DIW feed or to say when the oscillation began — the table above is
  reconstructed from `sync_logs` row counts, which is all we have. This is the
  clearest gap left in the load path.
- **`status` holds raw `FFLAG` codes on ~3,240 rows** — 1,544 `'0'`, 1,285
  `'3'`, 415 `'1'`, 95 `'2'`, and one `'5000000'` — leftovers of the 2026-08-08
  corruption that were never cleaned. They are excluded from every
  `ดำเนินการ` count, so they are invisible rather than wrong, but they are
  factories missing from the map.
- The `/admin` drift queue and publish-visibility work (steps 3 and 4 of the
  plan) were not started.
