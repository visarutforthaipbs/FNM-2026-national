# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a React + TypeScript + Vite civic tech application that displays **63,384 operating factories across Thailand** (62,656 of them mapped, 98.8%) on an interactive map. The application helps citizens find nearby factories with filtering capabilities, promoting industrial transparency for communities.

*Counted 2026-08-14 from `factories` on lighthouse-sev01. Recount before reuse — see the warning below.*

**Tagline**: "เปิดข้อมูลโรงงาน เพื่อชุมชนที่น่าอยู่" (Opening factory data for a livable community)

**Data Source**: Thai government OpenAPI endpoints (Department of Industrial Works, DIW)

## Repository Layout

- **`client/`** — the deployed frontend (React 18 + TypeScript + Vite). This is where almost all development happens.
- **`api/index.js`** — thin Vercel serverless wrapper around `server/index.js`. The Express + PostGIS API it exposes is **legacy — the client never calls `/api/*`**; the app runs on static JSON + direct Supabase queries instead.
- **`server/sync/`** — Python pipeline that produces the static data files (`export_markers.py`, `export_zoning.py`, `export_dbd_profiles.py`, `export_dashboard.py`, geocoding tiers). Run offline; outputs are committed into `client/public/data/`.
- **`server/collector/`** — the DBD ownership collectors (resolve → load → detail → nations → audit), archive helpers and their tests.
- **`vercel.json`** — static build of `client/` + the legacy API function; non-file routes fall back to `client/index.html` for SPA routing.

### Read before touching any data collector

- **[`COLLECTORS.md`](COLLECTORS.md)** — the four government sources (DIW, DBD, DPT, DOL), what state each collector is in, and the patterns that made them work: one central rate limiter (never a per-worker sleep), archive-first so a rules change replays instead of re-crawling, an explicit outcome per record, and telling a WAF's answer apart from the service's (both return **HTTP 200 with HTML** when blocking). Also records what is *closed* — DOL is blocked behind hCaptcha and PIPR is government-to-government — so nobody re-derives a dead end.
- **[`HANDOFF.md`](HANDOFF.md)** — live incident history for `pipeline.py`, the frozen `status` field, and the coordinate-corruption post-mortem.

Two facts that have bitten repeatedly: **`factories.is_active` is `true` for all 274,422 rows and filters nothing** — operating factories are `status = 'ดำเนินการ'` (63,384). And **any statistic shown to the public must be recounted from the artifact**, not carried over from a summary; several fabricated figures have reached production that way.

This file was itself an example: it claimed "~39,000 with map coordinates" and "38.6% lack coordinates" for a week after the geocoding tiers had taken coverage to 98.8%. The stale figure was exactly the `gov` count — written before the tiers existed and never recounted. Recount, don't carry over, including from here.

**Never write DIW's `STATUS` / `FFLAG` into `factories.status`.** The codes decode cleanly (`0` ได้รับใบอนุญาต, `1` ดำเนินการ, `2` จำหน่าย = struck off, `3` หยุดดำเนินการ — verified 1:1 across 241,349 rows), but the feed's `ดำเนินการ` count is **33,696 against DIW's own published 71,012** — 47%. Our 63,384 validates at 89–90% of the official figure on three independent measures, including จำพวก 1 matching exactly at 47. Applying the decode halves the map and moves it away from the truth. `status` is frozen deliberately; see HANDOFF §4. The official figures are at `http://reg.diw.go.th/executive/thailand3.asp`.

## Two databases

**Government data and citizen data live in separate Postgres instances.** Read [`supabase/README.md`](supabase/README.md) before writing a migration or a query that spans them, and [`DATA_LAYER.md`](DATA_LAYER.md) for the full inventory, the load path, the timer schedule, and every guard in the pipeline and why it exists.

| | Government | Citizen |
|---|---|---|
| Where | `lighthouse-sev01`, self-hosted Supabase | cloud Supabase project |
| Holds | `factories`, `businesses`, `permits`, `factory_statistics`, `dbd.*` | `auth.users`, `user_profiles`, watchlists, `reports`, `location_corrections` |
| Migrations | `supabase/migrations/` | `supabase/migrations-citizen/` |
| Client | `supabaseGov` | `supabaseCitizen` |
| Rebuildable | yes — re-run the collectors | **no** |

The split is by recoverability, not subject: government data can be deleted and rebuilt, citizen data cannot be rebuilt from anything. **No foreign keys and no joins cross the boundary** — fetch ids from one, hydrate names from the other. Auth sits on the citizen side because it must: the Tailscale Funnel on sev01 exposes `/rest/v1` only, so `/auth/v1` answers 404 and GoTrue there is unreachable from a browser.

## Development Commands

Run these inside `client/`:

- `npm run dev` - Start development server
- `npm run build` - Build for production (runs TypeScript compiler first, then Vite build)
- `npm run lint` - Run ESLint
- `npm run preview` - Preview production build

Credentials go in `client/.env.local` — **Government** (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, sev01) and **Citizen** (`VITE_FIREBASE_*` credentials for dedicated project `factory-near-me`). See `client/.env.example`. Missing credentials degrade gracefully — detail fetches return null, sign-in and reporting are unavailable, the map still works.

The Firebase and Supabase variables must be configured in the Vercel project settings; the deployed Vite bundle inlines them at build time. `server/.env` connects to `DATABASE_URL` and uses `serviceAccountKey.json` for Firebase Admin moderation.

## Architecture

### Routes (`client/src/App.tsx`, react-router)
- **`/` — MapPage**: main map with sidebar. Overview mode shows a province choropleth; selecting a province loads its markers.
- **`/dashboard` — DashboardPage** (lazy-loaded): nationwide stats from `dashboard_stats.json` plus a per-province factory explorer querying Supabase directly (search, sort, pagination).
- **`/diary` — UserDiaryPage** (lazy-loaded): community impact reports diary and user watchlist.
- **`/admin` — AdminPage** (lazy-loaded): moderation UI for pending reports and location corrections.

### Core Components
- **App.tsx**: state for user location, selected factory, filters; shareable URL sync (`?province=`, `?factory=`, `?type=` query params)
- **pages/MapPage.tsx**: layout, welcome modal with "find near me" (geolocation + Turf point-in-polygon province detection)
- **components/Sidebar.tsx**: search, filters, factory list (sorted by distance when location is known, capped at 200)
- **components/MapWrapper.tsx**: Leaflet map — choropleth in overview mode, clustered markers in province mode, tile-style switcher (auto dark mode), fly-to controllers
- **components/FactoryCard.tsx**: individual factory display
- **components/Navbar.tsx**: top navigation between the three routes

### Data Flow (two-stage, static-first)
1. **Browse (static JSON in `client/public/data/`)**:
   - `province-counts.json` — tiny; loaded on mount, drives the choropleth
   - `markers/{province-slug}.json` — 77 per-province files (~50–500 KB each) lazy-loaded only when a province is selected, cached in memory. Markers use abbreviated keys: `i` (registration id), `n` (name), `p` (province), `t` (จำพวก), `a` ([lng, lat])
   - `thailand-provinces.json` — province polygons for choropleth + province detection
   - `dashboard_stats.json` — pre-aggregated nationwide stats
2. **Detail (PostgREST on sev01, direct from browser)**: selecting a factory fetches full properties (`fetchFactoryDetail` in `hooks/useFactoriesApi.ts`) with a stale-response guard so slow responses can't overwrite a newer selection. DashboardPage's explorer queries it directly too.

Both stages read the **government** database. Anything about the signed-in person — watchlist, their own reports, private notes — comes from the **citizen** database via `supabaseCitizen`. The static exports are generated from the government database, so a coordinate that exists in only one of the two will not appear on the map: that mismatch published one database's pins under the other's detail panel for six days (HANDOFF §11).

Client-side filtering (search, high-risk, type codes, 10 km radius) happens in `useFactoriesApi`, capped at 2,000 rendered markers.

### Citizen Impact Reports (รายงานผลกระทบ)
- Anonymous, moderated reporting of factory impacts (smell/noise/water/dust/vibration) — lives in the **citizen** database; schema in `supabase/migrations/20260807000000_citizen_reports.sql`, auth/watchlist layer in `supabase/migrations-citizen/`
- Anon role can only INSERT into `reports`; public reads go through `approved_reports` / `report_counts` views (approved rows only, never reporter contact). Moderation = flipping `status` via service key/Studio
- Rate-limited by a DB trigger (5/hour per IP hash); reporter location stored only as a coarse `distance_band`, never coordinates — keep it that way (reporter safety)
- Client: `hooks/useReports.ts` (submit + shared counts cache), `components/ReportSection.tsx` (3-step chip form in the sidebar detail view), count badge in `FactoryCard.tsx`
- Report data always renders with the disclaimer in `types/report.ts` (`REPORT_DISCLAIMER`) — citizen testimony, not verified fact. LINE OA intake is planned phase 2 (`source` column)

### Admin & Moderation
- `/admin` (client route) — moderation UI for pending reports and location corrections; static bearer token (`ADMIN_TOKEN` env on the server), stored in sessionStorage
- Endpoints in `server/index.js`: `GET/POST /api/admin/reports[/:id]`, `GET/POST /api/admin/corrections[/:id]`. Two pools — `pool` (government) and `citizenPool` (citizen) — both connecting as table owner and bypassing RLS. This is the only place reporter contact info is visible, which is why the service is tailnet-only on `:4443` (HANDOFF §8)
- The queues **cannot join**: reports and corrections come from `citizenPool`, factory names and current positions are hydrated from `pool` afterwards. An id the registry no longer knows leaves the name null rather than dropping the row — a moderator still needs to see the report
- Approving a location correction spans both databases, so it is **not** one transaction. It writes lat/lng to `factories` (`coord_source='community'`) first, then marks the correction. Re-approving is idempotent; the reverse order could mark a correction approved that was never applied. `geom` needs no manual write — the trigger maintains it

### Coordinate Provenance & Geocoding
**728 of 63,384 operating factories (1.1%) lack coordinates** — down from ~38.6% before the recovery tiers ran. Current provenance, counted 2026-08-14:

| source | count | meaning |
|---|---|---|
| `gov` | 39,035 | straight from the DIW feed |
| `centroid` | 19,960 | tambon centroid, ±2–5 km |
| `geocoded` | 3,045 | Longdo street geocode |
| `sibling` | 568 | inherited from a co-located licence, exact |
| `admin` | 36 | placed by a moderator in `/admin` |
| `repaired` | 12 | whole-degree gov error, corrected |
| *(none)* | 728 | still unmapped |

Recovery is tiered (`supabase/migrations/20260807010000_coords_and_corrections.sql` adds `factories.coord_source` / `coord_precision`):
1. **repaired** — two scripts write this source, both dry-run by default with `--apply` to write:
   - `server/sync/repair_coordinates.py` re-reads raw gov CSVs and fixes swapped/mis-scaled values for factories with **no** coordinate, accepted only if inside the stated province polygon
   - `server/sync/repair_province_mismatch.py` fixes factories that **have** a coordinate that lands outside their tagged province, by trying whole-degree shifts (a wrong digit in the degrees field moves a point exactly 1°). Because it rewrites existing positions it accepts a shift only if it lands inside the province **and** within 15 km of the stated tambon centroid **and** is the only shift that does both
2. **sibling** (exact) — `geocode_missing.py --tier sibling`, inherits the exact position of another licence at the same address. ~2% of operating licences sit on a site holding several ทะเบียนโรงงาน (one plant, separate licences per industry code); when only one carried a gov coordinate the rest used to fall through to the geocoder or the centroid and land up to 99 km from their own address twin. Free — no API quota. `--dump PATH` writes every proposed move to CSV for review first
3. **geocoded** (street) — `--tier geocode`, Longdo API (`LONGDO_API_KEY`), province-validated, responses cached in `geocode_cache.json`
4. **centroid** (tambon, ±2–5 km) — `--tier centroid`, thailand-geography-json gazetteer
5. **community** — citizens drag a pin (`LocationCorrectionModal.tsx` → `location_corrections` table → admin approval)

**Government coordinates are not automatically trustworthy** — some `coord_source='gov'` rows are corrupt (e.g. พี.แอล.ซีเมนต์ had two licences at one address whose longitudes differed by almost exactly 1.000°, a digit error; น่ำเฮงคอนกรีต was tagged ปราจีนบุรี and plotted in Bangkok for the same reason). Both are repaired now, but ~209 mismatches remain. The sibling tier therefore validates every donor three ways: inside its province polygon, within 15 km of the centroid of the tambon it claims, and in agreement with any other donor at the same address. Rejected donors just fall through to the next tier. Apply the same suspicion to any new coordinate source.

**Landing inside the right province is weak evidence on its own** — provinces are large enough that a wrong point often falls inside one by luck. The tambon-centroid test is what separates a real fix from a coincidence: of 185 mismatched rows, 62 had at least one in-province whole-degree shift but only 12 landed within 15 km of their stated tambon. Any new repair heuristic needs the tambon check too, or it will look 5× more effective than it is.

`export_markers.py` emits a `q` flag → `coordQuality` on `FactoryProperties`: `'g'` geocoded, `'c'` centroid, `'s'` sibling. Centroid pins render faded; `g`/`c` get a "ตำแหน่งโดยประมาณ" badge in the sidebar, while `s` is labelled by origin ("อ้างอิงจากใบอนุญาตที่อยู่เดียวกัน") because it is exact, not approximate. Absent = straight from the gov feed. Never present approximate positions as exact. `export_dashboard.py` publishes `countByCoordSource`, which drives the ที่มาของพิกัดบนแผนที่ card — recount it, never carry a figure over.

Whenever a coordinate changes: re-run `export_markers.py`, `export_dashboard.py`, `export_zoning.py` (zoning is a function of position — `--check` reports which provinces drifted) and `audit_province_mismatch.py`. **`geom` needs no manual step**: the `tr_factories_set_geometry` trigger fires `BEFORE INSERT OR UPDATE OF lat, lng` and maintains it.

**Nothing validates a gov coordinate against its province at export time.** `export_markers.py` groups markers by the province *text field* (`by_province.setdefault`), so a factory with a corrupt coordinate is still published into its tagged province's file and drawn outside the polygon. The geocoding tiers all validate, which is why every mismatch in the queue is a gov coordinate. Detected by `audit_province_mismatch.py` → `server/data/province_mismatch_report.json` → `/admin` พิกัดผิดจังหวัด, but still shown to the public meanwhile.

### Hazard Classification (`client/src/utils/hazard.ts`)
The key domain logic. Parses the DIW industry code (ลำดับที่ 1–107) out of registration numbers like `จ3-52(3)-54/58ยล` (second segment; กนอ. format falls back to the first) and classifies into three tiers:
- **`hazard`** (red #EF4444) — hazardous industries: chemicals, petroleum, metal smelting, power, waste (codes in `HAZARD_GROUPS`)
- **`type3`** (amber #F59E0B) — จำพวก 3 licensed, non-hazardous industry
- **`general`** (green #10B981) — จำพวก 1–2 / small operations

This replaced the old red/green จำพวก split because ~90% of factories are จำพวก 3. `utils/factoryTypes.ts` maps industry codes to Thai names.

### Key Technologies
- **React 18** with TypeScript
- **Chakra UI v2** for UI components
- **Leaflet + React-Leaflet v4** with **react-leaflet-cluster** for marker clustering
- **Turf.js** for geospatial calculations (point-in-polygon, distance)
- **react-router-dom v6** for routing
- **Vite** for build tooling
- **Supabase** (REST, anon key) for factory detail data

### State Management
- React useState hooks in App.tsx, passed down as props
- Main state: user location, selected factory, filters (`FilterState` in `src/types/factory.ts`)
- Filters: search term, factory type codes, high-risk toggle, 10 km radius toggle, selected province

### Geolocation
- Attempts to get user's current location (10 s timeout, 5 min cache)
- Falls back to Prachinburi coordinates (14.0504, 101.3678) if geolocation fails
- Thai-language error messages per failure mode; manual lat/lng entry available in the sidebar

### Map Performance
- Markers only render in province mode (never all 62,656 at once); clustered, max 2,000
- Pre-created `divIcon` instances (6 combinations: 3 hazard levels × selected/normal)
- `React.memo` on MapWrapper; memoized GeoJSON construction in App.tsx

## Design System

Palette ("Industrial-Eco", defined in `client/src/theme/index.ts`):
- **primary** #F05223 (Thai PBS Orange) — brand, CTAs, selection accents
- **slate** grays — backgrounds (#f8fafc), borders, text
- **accent.green** #10B981 / **accent.crimson** #EF4444 — hazard semantics only
- Choropleth density ramp: #E8F1F4 → #0B3558 (dark navy)
- Fonts: 'IBM Plex Sans Thai' (Thai), 'Inter' (English/numbers)

This project follows the **Signal 39 Cognitive Design Framework** — a systematic approach to minimizing cognitive load and maximizing information value.

### Core Principles
- **39 bps conscious bandwidth**: Users process conscious meaning at 39 bits per second
- **184 KB daily budget**: Respect users' finite cognitive capacity
- **3-Layer Architecture**: Every UI component must work across three layers:
  1. **Subconscious Hook (Layer 1)**: Color, spatial grouping, motion — zero conscious tax
  2. **Chunked Gateway (Layer 2)**: Max 3 primary options, semantic grouping — low tax
  3. **Deep Dive (Layer 3)**: Progressive disclosure, high-surprisal insights only — high tax

### When Designing or Reviewing UI
Use the **signal39-design** skill (`.agents/skills/signal39-design/SKILL.md`) when:
- Creating new components or features
- Reviewing PRs for "too complex" or "too busy"
- Optimizing for mobile or low-bandwidth users
- Making UX decisions about layout, color, or typography
- User reports "can't find X" (indicates failed Layer 1/2)

### Quick Design Checklist
Before any UI change:
1. ✅ **Blur Test**: Can users identify priority/status when text is blurred?
2. ✅ **Rule of Three**: Are choices grouped into max 3 categories?
3. ✅ **Surprisal ROI**: Does this element deliver non-obvious value?
4. ✅ **5-Second Test**: Can new users grasp purpose in 5 seconds?

### Applied to Factory Near Me
- **Layer 1**: 3-tier hazard marker colors (red/amber/green), choropleth density, selected factory pulse
- **Layer 2**: Max 3 filters (Province, High-Risk, Radius), distance labels
- **Layer 3**: Factory owner, capital investment (progressive disclosure)

See [design_system.md](design_system.md) and [39design.md](client/39design.md) for detailed guidelines.

## Important Notes

- This is a Thai-language application with Thai text content; `FactoryProperties` uses Thai property keys (เลขทะเบียน, ชื่อโรงงาน, จังหวัด, …)
- Factory data contains sensitive business information (addresses, phone numbers, etc.)
- Factory coordinates use GeoJSON order: `geometry.coordinates[0]` = lng, `geometry.coordinates[1]` = lat
- Uses CARTO / OpenStreetMap / Esri tile providers for map display
- Query params on `/` are the sharing mechanism — keep them working when changing filter or selection state
