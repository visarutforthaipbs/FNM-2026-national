# 🏭 Factory Near Me

**เปิดข้อมูลโรงงาน เพื่อชุมชนที่น่าอยู่**
_Opening factory data for a livable community_

A civic tech application that puts Thailand's factory registry on a map, so anyone can
see what operates near them. Built on Thai government open data: **63,384 operating
factories**, **62,656 of them mapped (98.8%)**, across all 77 provinces — plus company
ownership, town-planning zones, and a channel for residents to report what they are
actually experiencing.

![React](https://img.shields.io/badge/React-18-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![Vite](https://img.shields.io/badge/Vite-6-purple) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17%20+%20PostGIS-blue) ![Python](https://img.shields.io/badge/Python-3.12-yellow)

> Counts are from 2026-08-14. They move — recount from the database rather than citing
> this file. Several fabricated figures have reached production by being copied from a
> summary instead of counted.

---

## What it does

**Find factories near you.** Geolocation or a manual pin, a province choropleth that
opens into clustered markers, and a three-tier hazard colour derived from the DIW
industry code — hazardous industries, licensed จำพวก 3, and everything else.

**See who owns them.** Company, directors, registered capital and shareholder
nationality, resolved from the Department of Business Development registry. Only exact
or human-verified matches are published; national ID numbers and contact details never
leave the database.

**See the zoning.** 42,219 town-planning polygons from DPT, matched by real
point-in-polygon. The app names the zone a factory sits in and makes no claim about
whether it is allowed to be there — that depends on its จำพวก, machinery and the
annexes of a specific ministerial regulation, none of which we hold.

**Report what you experience.** Smell, noise, water, dust or vibration, in a three-step
form with no free text required. Anonymous by default, moderated before publication,
rate-limited, and stored with only a coarse distance band — never the reporter's
coordinates.

**Keep your own record.** Sign in and you get a watchlist, a private impact diary with
notes only you can see, and a printable complaint dossier formatted for กรมโรงงาน,
ศูนย์ดำรงธรรม or your อบต.

**Fix the map.** Roughly one factory in three arrived from the government feed with no
coordinate, and some of the coordinates that did arrive are wrong. Residents can drag a
pin to the right place; a moderator reviews it.

---

## Two databases

Government data and citizen data live in **separate Postgres instances**, split by one
question: can a collector rebuild this from scratch?

|  | Government | Citizen |
|---|---|---|
| Holds | factories, businesses, permits, statistics, DBD ownership | accounts, watchlists, reports, location corrections |
| Rebuildable | yes — re-run the collectors | **no** |
| Backups | a convenience; the archive is the truth | the point |
| In an export | that is what it is for | **never** |

No foreign keys and no joins cross the boundary — fetch ids from one, hydrate names from
the other. Full detail in **[DATA_LAYER.md](DATA_LAYER.md)**.

## Architecture

```
DIW · DBD · DPT  ──►  collectors  ──►  raw archive  ──►  NAS
   (open data)         (archive-first, rate-limited)
                            │
                            ▼
                   government database  ──►  static JSON  ──►  CDN ──► browser
                   (self-hosted PG 17)       (~51 MB, 95% of reads)
                            │
                            └──────────────►  PostgREST ──► factory detail

                   citizen database  ──────►  PostgREST ──► sign-in, diary, reporting
                            ▲
                            └── Express admin API (moderation, tailnet-only)
```

The browser mostly does not touch a database. Browsing is served by static JSON —
per-province marker files, zoning, ownership profiles, dashboard aggregates — regenerated
by the nightly pipeline and served from a CDN. Live queries are only factory detail and
the signed-in features.

`api/index.js` and most of `server/index.js` are **legacy**: the client never calls
`/api/*`. What survives is the moderation API, which is reachable only from the tailnet.

## Where the data comes from

| Source | What it gives | State |
|---|---|---|
| **DIW** — Department of Industrial Works | the factory registry itself | ✅ nightly |
| **DBD** — Business Development | company, directors, financials, nationality | ✅ weekly |
| **DPT** — Public Works & Town Planning | 42,219 land-use polygons | ✅ on release |
| **DOL** — Department of Lands | title-deed → parcel coordinates | ⛔ blocked behind hCaptcha |

Every collector archives the raw response *before* interpreting it, so a change in
parsing rules replays from disk instead of re-crawling a rate-limited source. See
**[COLLECTORS.md](COLLECTORS.md)** before touching any of them.

## Coordinate provenance

Not every pin is equally trustworthy, and the app says so rather than pretending
otherwise.

| Source | Count | Rendered as |
|---|---:|---|
| `gov` | 39,035 | exact — though government coordinates are **not** automatically correct |
| `centroid` | 19,960 | faded pin, "ตำแหน่งโดยประมาณ" badge (±2–5 km) |
| `geocoded` | 3,045 | approximate badge |
| `sibling` | 568 | exact, labelled by origin — inherited from a licence at the same address |
| `admin` | 36 | exact — placed by a moderator |
| `repaired` | 12 | exact — a whole-degree digit error in the feed, corrected |
| *(none)* | 728 | not on the map |

**Never present an approximate position as exact.** A wrong pin on a named business is a
claim about that business.

---

## Project structure

```
client/                          React 18 + TypeScript + Vite — the deployed app
  src/
    context/                     auth + watchlist providers (one shared store each)
    components/                  map, sidebar, report form, dossier, admin modals
    hooks/                       useFactoriesApi, useReports, useWatchlist, useZoning
    pages/                       MapPage · DashboardPage · WasteMonitorPage
                                 UserDiaryPage · AdminPage
    utils/                       hazard classification, geo, the two Supabase clients
  public/data/                   generated — markers/ zoning/ dbd/ + aggregates

server/
  index.js                       Express moderation API (tailnet-only)
  collector/                     DBD collectors: resolve → load → detail → nations → audit
  sync/                          Python ETL and the export scripts
    pipeline.py                  fetch → transform → load (upsert, or atomic staging swap)
    export_markers.py            per-province marker files
    export_zoning.py             point-in-polygon against the DPT geodatabase
    geocode_missing.py           sibling / geocode / centroid recovery tiers
    repair_*.py                  fix swapped, mis-scaled and whole-degree coordinates
  deploy/systemd/                the four timers that run all of the above

supabase/
  migrations/                    government database
  migrations-citizen/            citizen database
```

## Getting started

**Prerequisites** — Node.js 18+, Python 3.12+ (pipeline only), and access to both
databases.

```bash
cd client
npm install
npm run dev          # http://localhost:5173
```

### Environment

`client/.env.local` — **two credential pairs, one per database**:

```env
# government data
VITE_SUPABASE_URL=https://<gov-host>
VITE_SUPABASE_ANON_KEY=<anon-key>

# citizen data — accounts, reports, watchlists
VITE_CITIZEN_SUPABASE_URL=https://<citizen-project>.supabase.co
VITE_CITIZEN_SUPABASE_ANON_KEY=<anon-key>

# moderation API (tailnet-only)
VITE_API_BASE=https://<host>:4443
```

Missing credentials degrade gracefully: the map still works, detail lookups return null,
sign-in and reporting are unavailable. `server/.env` mirrors the pair as `DATABASE_URL`
and `CITIZEN_DATABASE_URL`; `server/sync/.env` needs `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY` and `LONGDO_API_KEY`.

### Data pipeline

```bash
cd server/sync
python pipeline.py                          # full sync
python pipeline.py --test                   # test mode — no destructive writes
python pipeline.py --endpoint Factory_Data  # one endpoint

python export_markers.py && python export_dashboard.py
python export_zoning.py --check             # names any province whose zoning drifted
```

**Whenever a coordinate changes**, re-run `export_markers`, `export_dashboard`,
`export_zoning` and `audit_province_mismatch`. `geom` needs no manual step — a trigger
maintains it.

### Deploying

**A push to GitHub does not publish.** The flow is: push, then trigger a Vercel deploy by
hand (`vercel --prod` from `client/`, or the dashboard). A human gates production, on
purpose.

Two things follow. A successful nightly run leaves its exports *committed and waiting*,
not live. And `vercel --prod` uploads the **working directory, not a commit** — an
uncommitted file ships, so commit before you deploy.

---

## Documentation

| File | What it covers |
|---|---|
| **[CLAUDE.md](CLAUDE.md)** | how the app is built, and the rules that bind it |
| **[DATA_LAYER.md](DATA_LAYER.md)** | the two databases, the load path, every guard and why it exists |
| **[COLLECTORS.md](COLLECTORS.md)** | the four sources, the patterns that made them work, the dead ends |
| **[HANDOFF.md](HANDOFF.md)** | incident history — read §2 before touching `pipeline.py` |
| **[supabase/README.md](supabase/README.md)** | which migration belongs to which database |

The pipeline carries guards that exist because the failure already happened: a 5%
deactivation circuit breaker, volume floors on every full refresh, an atomic staging swap
so no reader ever sees an empty table, and protection for coordinates a human placed.
Read before changing the load path.

---

## Design system

**"Industrial-Eco"** — see `client/src/theme/index.ts`.

| Colour | Hex | Used for |
|---|---|---|
| Thai PBS Orange | `#F05223` | brand, calls to action, selection |
| Choropleth navy | `#0B3558` | province density ramp, from `#E8F1F4` |
| Eco Green | `#10B981` | general-industry hazard tier |
| Alert Crimson | `#EF4444` | hazardous industries only |
| Slate | `#f8fafc`–`#0f172a` | backgrounds, borders, text |

Typography: IBM Plex Sans Thai for Thai, Inter for Latin and numerals. The project follows
the Signal 39 cognitive design framework — three hazard colours, three primary filters,
progressive disclosure for everything else.

## Data source & license

Factory data from Thai government open data (Department of Industrial Works), company
data from the Department of Business Development, zoning from the Department of Public
Works and Town & Country Planning.

Citizen reports are **testimony, not verified fact**, and always render with that
disclaimer. Reporter contact details are visible only to moderators, over a tailnet.

ISC.
