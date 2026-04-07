# 🏭 Factory Near Me

**เปิดข้อมูลโรงงาน เพื่อชุมชนที่น่าอยู่**
_Opening factory data for a livable community_

A civic tech application that visualizes factory data across Thailand on an interactive map, promoting industrial transparency for citizens, communities, and researchers. Built with data from Thai government OpenAPI endpoints covering **63,790+ operating factories** nationwide.

![React](https://img.shields.io/badge/React-18-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue) ![Vite](https://img.shields.io/badge/Vite-6-purple) ![Node.js](https://img.shields.io/badge/Node.js-Express-green) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-PostGIS-blue)

---

## Features

### 🗺️ Interactive Map
- Leaflet-based map with multiple tile layers (Light, Dark, Satellite, OpenStreetMap)
- Marker clustering for performance at scale
- User geolocation with fallback to Prachinburi (14.0504°N, 101.3678°E)
- Manual location setting via dialog
- Selected factory pulse animation

### 🔍 Search & Filtering
- Search by factory name, operator, or business type
- Province filter (77 provinces)
- High-risk factory filter (Category 3 — requires special permits)
- Radius filter (within 10 km of user location)

### 📊 Dashboard
- Total factories, high-risk count, capital investment, and worker statistics
- Breakdown by factory type and province (top 15)

### 📱 Responsive Design
- Mobile-first with overlay sidebar and floating menu button
- Tablet (360px sidebar) and desktop (420px sidebar) layouts
- Touch-friendly marker sizing

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Frontend** | React 18, TypeScript, Vite, Chakra UI, Leaflet, React-Leaflet, Turf.js, Framer Motion, React Router |
| **Backend** | Node.js, Express, PostgreSQL + PostGIS |
| **Data Sync** | Python 3, Pandas, Supabase SDK |
| **Analytics** | Vercel Analytics |

---

## Architecture

```
Thai Government OpenAPIs (CSV)
        ↓
  Python Sync Pipeline
        ↓
  Supabase (PostgreSQL + PostGIS)
        ↓
  Express REST API          →  Static JSON exports
        ↓                            ↓
  React Frontend (Map + Dashboard)
```

**Data sources** — 6 government endpoints including `Business_Location`, `Factory_Data`, `Factory_Operation_Permit`, `Sum_Factory_Local`, and `Sum_Status_Factory_Local`.

The sync pipeline fetches CSV data, transforms it, and upserts to Supabase. It also exports lightweight static JSON files (`markers.json`, `dashboard_stats.json`) for fast frontend loading.

---

## Project Structure

```
├── client/                        # React frontend
│   ├── src/
│   │   ├── App.tsx                # Main app — state management, routing
│   │   ├── components/
│   │   │   ├── FactoryCard.tsx    # Individual factory display
│   │   │   ├── MapWrapper.tsx     # Leaflet map with markers & clustering
│   │   │   ├── Navbar.tsx         # Top navigation (Map / Dashboard)
│   │   │   └── Sidebar.tsx        # Search, filters, factory list
│   │   ├── hooks/
│   │   │   └── useFactoriesApi.ts # Data fetching & caching
│   │   ├── pages/
│   │   │   ├── DashboardPage.tsx  # Statistics & charts
│   │   │   └── MapPage.tsx        # Map view with sidebar
│   │   ├── theme/
│   │   │   └── index.ts          # Chakra UI theme (colors, fonts)
│   │   └── types/
│   │       └── factory.ts        # TypeScript interfaces
│   └── public/data/               # Static JSON data files
│       ├── markers.json
│       ├── dashboard_stats.json
│       ├── factories.geojson
│       └── factories_loc.json
├── server/                        # Express backend
│   ├── index.js                   # REST API (factories, provinces)
│   ├── reload_schema.js           # PostgREST schema refresh
│   └── scripts/
│       ├── seed.js                # Import GeoJSON to Postgres
│       └── seed-nationwide.js     # Import nationwide data
└── server/sync/                   # Python data pipeline
    ├── pipeline.py                # ETL: fetch → transform → upsert
    ├── export_markers.py          # Export compact markers.json
    ├── export_dashboard.py        # Export dashboard_stats.json
    ├── config.py                  # API endpoint configuration
    └── requirements.txt
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL with PostGIS extension (or Supabase)
- Python 3.9+ (for sync pipeline only)

### Environment Variables

**Client** (`client/.env`)
```env
VITE_SUPABASE_URL=<supabase-url>
VITE_SUPABASE_ANON_KEY=<supabase-anon-key>
```

**Server** (`server/.env`)
```env
DATABASE_URL=postgresql://user:pass@host/dbname
PORT=3001
```

**Sync Pipeline** (`server/sync/.env`)
```env
SUPABASE_URL=<supabase-url>
SUPABASE_SERVICE_KEY=<supabase-service-key>
SYNC_TEST_MODE=false
SYNC_TEST_LIMIT=100
```

### Development

```bash
# Frontend
cd client
npm install
npm run dev             # http://localhost:5173

# Backend (separate terminal)
cd server
npm install
npm run dev             # http://localhost:3001
```

### Data Sync (optional)

```bash
cd server/sync
pip install -r requirements.txt

python pipeline.py                          # Full sync
python pipeline.py --test                   # Test mode (100 records)
python pipeline.py --endpoint Factory_Data  # Single endpoint
```

### Database Seeding

```bash
cd server
npm run seed              # Import local GeoJSON
npm run seed:nationwide   # Import nationwide data
```

### Production Build

```bash
cd client
npm run build      # TypeScript compilation + Vite build
npm run preview    # Preview production build
```

### Linting

```bash
cd client
npm run lint
```

---

## API Endpoints

| Method | Endpoint | Description | Query Parameters |
|--------|----------|-------------|-----------------|
| `GET` | `/api/factories` | List factories | `bbox`, `province`, `search`, `highRisk` |
| `GET` | `/api/provinces` | List provinces | — |

**Bounding box format:** `bbox=west,south,east,north`

---

## Database Schema

```sql
CREATE TABLE factories (
  id SERIAL PRIMARY KEY,
  fac_reg TEXT,
  name TEXT,
  operator_name TEXT,
  business_type TEXT,
  district TEXT,
  province TEXT,
  factory_type TEXT,           -- 1=low, 2=medium, 3=high-risk
  address TEXT,
  capital_investment NUMERIC,
  horsepower NUMERIC,
  workers_male INTEGER,
  workers_female INTEGER,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  geom GEOMETRY(Point, 4326)   -- PostGIS spatial column
);

-- Indexes
CREATE INDEX factories_geom_idx ON factories USING GIST (geom);
CREATE INDEX factories_province_idx ON factories (province);
CREATE INDEX factories_type_idx ON factories (factory_type);
```

---

## Performance Optimizations

- **Compact markers format** — `markers.json` uses abbreviated keys (`i`, `n`, `a`, `t`, `p`) to minimize payload
- **Viewport filtering** — only factories within the visible map bounds are rendered
- **Render cap** — max 2,000 markers on the map at once
- **Sidebar pagination** — max 200 factories in the list view
- **Marker caching** — `useFactoriesApi` caches fetched data to prevent redundant requests
- **Icon pre-creation** — Leaflet icons instantiated once and reused
- **React.memo** — `MapWrapper` wrapped to prevent unnecessary re-renders
- **PostGIS ST_MakeEnvelope** — server-side spatial filtering via GIST index

---

## Design System

**"Industrial-Eco" theme** — professional, trustworthy, and accessible.

| Color | HEX | Usage |
|-------|-----|-------|
| Industrial Blue | `#1A365D` | Headers, factory markers |
| Safety Orange | `#F59E0B` | Actions, user location, warnings |
| Eco Green | `#10B981` | Normal/clean status indicators |
| Alert Crimson | `#EF4444` | High-risk indicators only |
| Slate | `#f8fafc`–`#1e293b` | Backgrounds, text, borders |

**Typography:** IBM Plex Sans Thai + Noto Sans Thai (Thai), Inter (Latin/numbers)

---

## Data Source

Factory data sourced from Thai government open data APIs (Department of Industrial Works). Includes registration numbers, business types, locations, capital investment, and workforce data across 77 provinces.

## License

ISC
