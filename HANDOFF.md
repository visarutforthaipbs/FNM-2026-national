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

**Status: unresolved. Nothing here is a breach; it is a thin margin.** Recorded
2026-08-13, verified against the live host the same day.

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
