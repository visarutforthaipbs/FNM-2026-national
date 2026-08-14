# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a React + TypeScript + Vite civic tech application that displays **63,800+ operating factories across Thailand** (~39,000 with map coordinates) on an interactive map. The application helps citizens find nearby factories with filtering capabilities, promoting industrial transparency for communities.

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

Two facts that have bitten repeatedly: **`factories.is_active` is `true` for all 274,421 rows and filters nothing** — operating factories are `status = 'ดำเนินการ'` (63,384). And **any statistic shown to the public must be recounted from the artifact**, not carried over from a summary; several fabricated figures have reached production that way.

## Development Commands

Run these inside `client/`:

- `npm run dev` - Start development server
- `npm run build` - Build for production (runs TypeScript compiler first, then Vite build)
- `npm run lint` - Run ESLint
- `npm run preview` - Preview production build

Supabase credentials go in `client/.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`); see `client/.env.example`. Missing credentials degrade gracefully (detail fetches return null).

## Architecture

### Routes (`client/src/App.tsx`, react-router)
- **`/` — MapPage**: main map with sidebar. Overview mode shows a province choropleth; selecting a province loads its markers.
- **`/dashboard` — DashboardPage** (lazy-loaded): nationwide stats from `dashboard_stats.json` plus a per-province factory explorer querying Supabase directly (search, sort, pagination).
- **`/waste-monitor` — WasteMonitorPage** (lazy-loaded): waste-handling factories (DIW types 101/105/106) across DIW watch provinces.

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
2. **Detail (Supabase REST, direct from browser)**: selecting a factory fetches full properties (`fetchFactoryDetail` in `hooks/useFactoriesApi.ts`) with a stale-response guard so slow responses can't overwrite a newer selection. DashboardPage's explorer also queries Supabase directly.

Client-side filtering (search, high-risk, type codes, 10 km radius) happens in `useFactoriesApi`, capped at 2,000 rendered markers.

### Citizen Impact Reports (รายงานผลกระทบ)
- Anonymous, moderated reporting of factory impacts (smell/noise/water/dust/vibration) — schema in `supabase/migrations/20260807000000_citizen_reports.sql`
- Anon role can only INSERT into `reports`; public reads go through `approved_reports` / `report_counts` views (approved rows only, never reporter contact). Moderation = flipping `status` via service key/Studio
- Rate-limited by a DB trigger (5/hour per IP hash); reporter location stored only as a coarse `distance_band`, never coordinates — keep it that way (reporter safety)
- Client: `hooks/useReports.ts` (submit + shared counts cache), `components/ReportSection.tsx` (3-step chip form in the sidebar detail view), count badge in `FactoryCard.tsx`
- Report data always renders with the disclaimer in `types/report.ts` (`REPORT_DISCLAIMER`) — citizen testimony, not verified fact. LINE OA intake is planned phase 2 (`source` column)

### Admin & Moderation
- `/admin` (client route) — moderation UI for pending reports and location corrections; static bearer token (`ADMIN_TOKEN` env on the server), stored in sessionStorage
- Endpoints in `server/index.js`: `GET/POST /api/admin/reports[/:id]`, `GET/POST /api/admin/corrections[/:id]`. The pg pool connects as table owner, bypassing RLS — this is the only place reporter contact info is visible
- Approving a location correction applies lat/lng + PostGIS geom to `factories` with `coord_source='community'` in one transaction

### Coordinate Provenance & Geocoding
~38.6% of operating factories lack coordinates. Recovery is tiered (`supabase/migrations/20260807010000_coords_and_corrections.sql` adds `factories.coord_source` / `coord_precision`):
1. **repaired** — `server/sync/repair_coordinates.py` re-reads raw gov CSVs and fixes swapped/mis-scaled values, accepted only if inside the stated province polygon (dry-run by default, `--apply` to write)
2. **sibling** (exact) — `geocode_missing.py --tier sibling`, inherits the exact position of another licence at the same address. ~2% of operating licences sit on a site holding several ทะเบียนโรงงาน (one plant, separate licences per industry code); when only one carried a gov coordinate the rest used to fall through to the geocoder or the centroid and land up to 99 km from their own address twin. Free — no API quota. `--dump PATH` writes every proposed move to CSV for review first
3. **geocoded** (street) — `--tier geocode`, Longdo API (`LONGDO_API_KEY`), province-validated, responses cached in `geocode_cache.json`
4. **centroid** (tambon, ±2–5 km) — `--tier centroid`, thailand-geography-json gazetteer
5. **community** — citizens drag a pin (`LocationCorrectionModal.tsx` → `location_corrections` table → admin approval)

**Government coordinates are not automatically trustworthy** — some `coord_source='gov'` rows are corrupt (e.g. พี.แอล.ซีเมนต์ has two licences at one address whose longitudes differ by almost exactly 1.000°, a digit error). The sibling tier therefore validates every donor three ways: inside its province polygon, within 15 km of the centroid of the tambon it claims, and in agreement with any other donor at the same address. Rejected donors just fall through to the next tier. Apply the same suspicion to any new coordinate source.

`export_markers.py` emits a `q` flag ('g'/'c') for approximate positions → `coordQuality` on `FactoryProperties`. Centroid pins render faded on the map; both kinds get a "ตำแหน่งโดยประมาณ" badge in the sidebar. Never present approximate positions as exact. After any geocoding run: refresh `geom`, re-run `export_markers.py` + `export_dashboard.py`

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
- Markers only render in province mode (never all ~39,000 at once); clustered, max 2,000
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
