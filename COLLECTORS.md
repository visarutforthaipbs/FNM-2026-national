# Collectors — what we built, and what we learned building them

Four government data sources feed this map. Each needed a collector, each behaved
differently, and each taught us something that cost real time to discover. This
file is the memory: what exists, what state it is in, and the patterns worth
carrying to the next source or the next project.

Written 2026-08-13.

---

## 1. The four sources at a glance

| # | Source | What we get | Collector | State |
|---|--------|-------------|-----------|-------|
| 1 | **DIW** — Department of Industrial Works | The factory registry itself: 274,422 records, 63,384 operating (~89% of DIW's published 71,012 — see below) | `server/collector/collect.py`, `server/sync/pipeline.py` | ✅ working, nightly |
| 2 | **DBD** — Dept. of Business Development | Who owns each factory: company, directors, financials, shareholder nationality | `server/collector/dbd_*.py` | ✅ working — 36,965 exact links, 36,487 companies with nationality |
| 3 | **DPT** — Dept. of Public Works & Town Planning | Land-use zoning: 42,219 polygons, 203 town/community plans | `server/sync/download_dpt_geodatabase.py`, `export_zoning.py` | ✅ working, one-shot + re-runnable |
| 4 | **DOL** — Department of Lands | Land-title-deed → parcel coordinates, for 8,705 factories with no position | `server/sync/harvest_landsmaps_geodatabase.py`, `dol_session.py` | ⛔ **blocked** — see §6 |

Plus geocoding tiers that are not "collectors" but sit in the same pipeline:
`repair_coordinates.py`, `geocode_missing.py` (Longdo, paid quota, cache is
committed — do not delete it).

---


### DIW: the open-data feed is not the official count

Two DIW sources disagree, and the API is the one that is wrong for our purpose.

- The **open-data feed** we poll reports 33,696 factories as `ดำเนินการ`.
- DIW's **executive dashboard** (`http://reg.diw.go.th/executive/thailand3.asp`)
  reports **71,012** operating factories นอกนิคมฯ, with 8,623,184 ล้านบาท capital
  and 3,751,795 workers.

Our database validates against the dashboard at 89–90% on three independent
measures — factory count, capital and workers — with จำพวก 1 matching exactly at
47. The feed is 47%. Whatever `FFLAG=1` encodes administratively, it is not the
operating population DIW publishes, so **never write `STATUS`/`FFLAG` into
`factories.status`** (HANDOFF §4 carries the full evidence).

The feed also shrinks by roughly **48 rows/day** and is now ~32,700 rows smaller
than our table — about 1.9 years of drift. Treat it as a narrowing view of the
registry, not as ground truth, and do not let `soft_delete_missing()` reconcile
against it.

## 2. The patterns that worked

These came out of failures. Each one is here because we got it wrong first.

### 2.1 One rate limiter, not a sleep per worker

`dbd_resolve.RateLimiter` — a single gate every worker passes through, expressed
as **requests per second**, with additive-increase/multiplicative-decrease
recovery.

The antipattern, which we shipped twice: `time.sleep(0.5)` inside each worker.
That bounds nothing — three workers sleeping 0.5 s is 6 req/s, four times the
tested ceiling, and it silently gets worse as workers are added. It is what drew
the WAF block on 2026-08-12.

Measured on DBD: 4 req/s → 44 × HTTP 429 in 200 operators. 1.2 req/s → clean for
125 minutes. 1.0 req/s → 36,684 requests over 10 hours, **2 errors, zero blocks**.

Import it rather than reimplementing:

```python
sys.path.insert(0, str(REPO / "server" / "collector"))
from dbd_resolve import RateLimiter
```

### 2.2 Archive first, interpret later

Every raw response is written to disk **before** anything reads it
(`dbd_archive.write_gzip_json_atomic`, content-addressed by query or id).

The payoff is concrete: when we fixed the name-matching rules, re-scoring 52,484
operators took **4 seconds and zero requests**, because every answer was already
on disk. Without the archive that is a 10-hour re-crawl, and one you cannot ask
a government service for twice.

Corollary: the archive is the source of truth, not the derived JSON. When we
retired `dbd_nations.json`, the loader still rebuilt the table from the archive
alone — one company out of 36,708 depended on the old file.

### 2.3 An outcome per record, and errors are not settled

Every record carries an explicit state: `exact` / `probable` / `ambiguous` /
`no_match` / `not_juristic` / `error`, or for parcels `found` / `not_found` /
`error`.

Two rules follow:

- **Resume only on settled outcomes.** An `error` means *we do not know*, not
  *there is nothing*. Treating a transient 429 as a permanent gap bakes it into
  the dataset forever.
- **Never let "no data" render as a value.** A parcel row with `lat = NULL` and
  no outcome column cannot distinguish "DOL has no such deed" from "the request
  failed" — and those need opposite follow-ups.

### 2.4 A gateway's answer is not the service's answer

Both DBD and DOL sit behind Imperva. Both return **HTTP 200 with an HTML
challenge page** when unhappy. Any code checking `res.ok` or `status == 200`
believes it succeeded.

This exact bug made the DOL harvester report success while writing zero rows for
weeks. `dbd_client.classify_response()` now distinguishes them:

| response | meaning | correct reaction |
|---|---|---|
| 401/403 + JSON | the service rejected our token | refresh the token |
| 401/403 + HTML | the gateway blocked us | **stop and wait** — a token cannot help |
| 200 + HTML on a JSON endpoint | challenge page | not through the gate yet |

And the reflex to avoid: answering a block by re-requesting `/api/refresh`. That
endpoint is the most closely guarded one, so retrying there *prolongs* the block.
Back off, wait, and re-establish a browser session instead.

### 2.5 Wait for the answer, not for the clock

The DOL harvester slept exactly 10 seconds for a challenge that clears in 10–15.
A fixed sleep against a variable gate, with a failure mode that looks like
success. Poll for the condition — a real page title, a JSON content-type — and
give up loudly.

### 2.6 Sessions are worth saving

Where a WAF requires a real browser, `dbd_bootstrap.py` / `dol_bootstrap.py`
clear the challenge in Playwright and export the cookies; the crawl then runs on
ordinary HTTP requests carrying them. `dol_session.py` additionally caches the
session to disk (`chmod 600`) because *establishing* one costs a request the
gateway may refuse.

Cookies are credentials. They are gitignored (`*cookies*.json`, `*session*.json`).

### 2.7 Verify against an independent oracle

Do not verify a collector against its own report. For the DPT zoning we queried
**DPT's own ArcGIS service** for the same points and compared: 14/14 zoned
agreed, 8/8 unzoned agreed, polygon counts matched exactly.

That check also caught an error nothing else would have: our land-use categories
were derived from the leading digit of the code, and `8600` — the most common
code in the country — is *agricultural*, not the "religious/special" a digit rule
implies. The fix came from `pl_block`, which carries DPT's own zone letter.

**Anything numeric gets checked against the artifact, never against a summary.**
Four separate fabricated figures reached production in this project because a
chat summary was believed over the data.

### 2.8 Politeness is a design constraint, not a setting

- Order work so an interrupted run has collected the most valuable part first
  (public companies first, then most-factories-first).
- A block is a pause, not a failure: wait 10 → 60 min and resume from the
  archive rather than dying at 3am.
- Probe sparsely when checking whether a block has lifted — one request per
  interval, widening. `dbd_block_probe.py`.
- **Never build around a CAPTCHA.** When DOL escalated to hCaptcha it was asking
  for a human; that is a stop, not an obstacle.

---

## 3. DIW — the factory registry

`server/sync/pipeline.py`, nightly via `.github/workflows/daily-sync.yml`.

Read `HANDOFF.md` §2 before touching it. Summary of the scars:

- `status` is **frozen** — no pipeline path writes it. `FFLAG`/`STATUS` semantics
  are still unresolved and a wrong mapping halved the operating-factory count once.
- `soft_delete_missing()` has a circuit breaker: it refuses to deactivate more
  than 5% of active factories in one run.
- `is_active` is `true` for all 274,421 rows and is **not** a usable filter.
  Operating factories are `status = 'ดำเนินการ'` (63,384).

---

## 4. DBD — ownership

Pipeline: `dbd_resolve.py` → `dbd_load.py` → `dbd_detail.py` → `dbd_nations.py`
→ `dbd_nations_load.py` → `dbd_audit.py --strict`. Orchestrated by
`dbd_run_all.sh`.

What made matching work (all measured, see `test_dbd_match.py`):

- **Legal form is a hard gate.** DBD really holds both `ไทยวา จำกัด (มหาชน)` and
  `ไทยวา จำกัด` as separate companies.
- **Compare names ignoring spacing.** Thai has no semantic inter-word spaces, so
  `เอส.เจ.ซี. คอนกรีต` and `เอส.เจ.ซี.คอนกรีต` are the same name typed twice.
  This alone recovered **3,722** matches.
- **A spelling variant is admissible only if the original spelling matched
  nothing** — that proves no company exists under the name as written.
- **Liveness is a gate, not a tie-breaker.** 233 of 239 names that fit two
  companies fit exactly one still trading; the other is `ควบ` (merged). Picking
  by points let province agreement elect the *dissolved* one.
- **Two live companies of the same name and form is genuinely ambiguous** — say
  so rather than choosing.

Net: 33,082 → **36,965** exact links, and 10 published links corrected from
dissolved companies to their surviving entities.

Nationality: `/nations` is the only endpoint that answers for `บริษัทจำกัด`
(`/partners` returns nothing for all 44,879 of them) and it returns real
percentages. **It is an aggregate — do not expand it into individual
shareholders.** An earlier pass invented 12,748 shareholders named
`ผู้ถือหุ้นสัญชาติไทย`; they would have rendered as real owners.

---

## 5. DPT — land-use zoning

DPT publishes **two tiers** of plan, and for a long time we harvested only one.

```
municipal  PLLU_ALL/PLLU_ALL/MapServer/0   42,219 polygons, 204 plans, HAS land use
province   TOWNPLAN/TP_MAIN/MapServer/2    71 footprints, 71 provinces, NO land use
                 ↓ load_dpt_polygons.py
           dpt.plan_polygon  (PostGIS, gov database, 165 MB)
                 ↓ export_zoning.py  (indexed spatial join)
           client/public/data/zoning/{province}.json
```

`download_dpt_geodatabase.py` (one-shot, ~40 s, public ArcGIS REST, no auth)
still builds `server/data/dpt_geodatabase.db` (400 MB, gitignored); it is now
only the staging area that `load_dpt_polygons.py` reads the municipal tier from.

### The correction of 2026-09-02 — we were publishing our harvest as the world

This section used to say "203 town/community plans and **no province-wide
plan**", and that "nine provinces have no matching polygon at all, including
Chonburi and Rayong (EEC, planned under a separate statute)". The first half was
true of `PLLU_ALL`. Both halves were false of DPT.

`TOWNPLAN/TP_MAIN` layer 2 is `ผังเมืองรวมจังหวัด` and publishes a footprint for
**71 provinces including ชลบุรี and ระยอง**. All nine "uncovered" provinces have
one, covering 8,366 factories between them — and the site was telling every one
of them *ไม่มีข้อมูลผังเมืองสำหรับตำแหน่งนี้*. After loading the provincial tier,
`no_dpt_plan_data` fell from **48,170 (76.9%) to 8,515 (13.6%)** and
`provinces_without_dpt_coverage` came back **empty for all 77**.

Know before using it:

- **The provincial tier has no land-use attribute.** Its fields are plan
  identity only (`TOWN_PLAN_NAME`, `TOWN_PLAN_CODE`, `PROV_CODE`). A hit means a
  plan *covers* the point, never what it is *zoned* — verified on ระยอง: one
  MultiPolygon, 23,180 vertices, the province outline. Anything that renders it
  as a zone, colour or category is inventing the thing DPT withheld.
- **The tiers overlap, so municipal wins.** The provincial footprint is the whole
  province, not the province minus its town plans: on เชียงใหม่, 1,004 of 1,007
  factories fall inside it, including 335 of the 336 already municipally zoned.
  `export_zoning.py` applies municipal precedence. **Never sum the two counts.**
- **`DOC_TYPE` is not a status.** It is the plan-making action — จัดทำ (79),
  ปรับปรุง (7), แก้ไข (7). There is no field on this layer saying whether a plan
  is ประกาศบังคับใช้, so nothing may claim one is in force.
- **A provincial footprint *is* the province boundary.** Measured against
  `thailand-provinces.json`: areas agree to a ratio of 1.01 and overlap 98.8%,
  the rest being digitisation differences between two sources. So do not ship
  the footprints to the browser — 60 MB raw, 460 kB simplified, to redraw
  boundaries the client already loads. `export_zoning.py` writes a ~7 kB lookup
  (`client/public/data/dpt_province_plans.json`, keyed by English province name
  to match the map's `NAME_1`) and the map styles the polygons it already has.
- **Six provinces have no ผังเมืองรวมจังหวัด**: กรุงเทพมหานคร, สมุทรปราการ,
  พระนครศรีอยุธยา, นนทบุรี, ชัยภูมิ, สิงห์บุรี — 14,371 factories. Since 71 of
  77 are covered, the absence is the informative half, and the map overlay is
  styled so the gaps are what the eye catches.
- **`TP_MAIN`'s own rendering is unusable as an overlay.** Its `export`
  endpoint answers anonymously, but paints whole provinces in opaque red/green
  by `DOC_TYPE` — a plan-making status rendered as a traffic light over the
  entire country. `CPLLU_NON`'s export *does* return real provincial land use in
  DPT's own colours, but only for เพชรบุรี and สระบุรี and organised by drafting
  stage (กำหนดเขตผัง → ยกร่างผัง → เตรียมปิดประกาศ → ประกาศราชกิจจานุเบกษา), so
  picking a stage to display would assert that a draft is in force. Neither is
  shipped.
- **PROV_CODE 10 is DPT's test fixture and is dropped at load.** 71 provinces
  hold one plan each with 71 distinct geometries; PROV_CODE 10 holds 22 records
  sharing *one* geometry — every combination of จัดทำ/ปรับปรุง/แก้ไข ×
  กรมฯ/อปท. × revisions 1–6, four of them named `ทดสอบสถานะ ไม่ใช้` outright.
  TP_MAIN's layer 1 is the same story for the same code. Bangkok is planned under
  ผังเมืองรวมกรุงเทพมหานคร by the BMA anyway, and keeps its municipal zones.
- `TOWNPLAN/CPLLU_NON` is **not** "77 provinces"; it publishes เพชรบุรี and
  สระบุรี only — but for those two it carries *real* provincial land use (55
  polygons each, schema `Type`/`BLOCK_T` letters like `อก.1`, not PLLU_ALL's
  4-digit `pl_use`). Unharvested; it needs a letter→family mapping first.
### The provincial land use IS reachable — collected 2026-09-02

An earlier version of this section said the nationwide provincial land use was
token-gated and a dead end. **That was wrong, and the mistake is worth keeping.**
The probe hit `onedpt.dpt.go.th/.../DPT_LANDUSE_**NON**/PLLU_VIEW`, which really
does answer 200 with `layers: []` — an empty decoy one character and one
hostname away from the real thing. Seeing the expected answer, the search
stopped. The real layer is on a **different host** and **without the `_NON`
suffix**:

```
https://onedptgis.dpt.go.th/arcgis/rest/services/DPT_LANDUSE/PLLU_VIEW/MapServer
   layer 4 PLLU_AREA   ผังเมืองรวมเมือง/ชุมชน
   layer 5 PLLU_PROV   ผังเมืองรวมจังหวัด   ← 32,193 polygons, capabilities Map,Query,Data
```

It answers `499 Token Required` directly. DPT's own public viewer reaches it
through a **bare pass-through proxy** that supplies the token server-side and
needs no credential from the caller — `GET {proxy}?{full upstream URL, query
string raw and unencoded}`. Encode the upstream's `?`/`&` and its parameters
become the proxy's, which returns HTML rather than JSON.

`server/sync/collect_dpt_provincial.py` collects it. **Do not** use the
`clientId`/`clientSecret` also sitting in that bundle: this route needs no
credential, so scraping one would be gratuitous.

What the collection established, all counted from the artifact:

- **32,193 polygons stored = 32,193 the service reports.** The arithmetic
  closes exactly. 31,954 sit in 75 plan areas keyed by `CB_ID`; the remaining
  **239 have a blank `CB_ID`** and belong to no plan area. They are collected
  under an `__unassigned__` sentinel rather than dropped — a factory can stand
  on one.
- **`PL_BLOCK` is the numbered block from DPT's printed plans** — 1.x ชุมชน,
  2.x ชนบทและเกษตรกรรม, 3.x อนุรักษ์ชนบทและเกษตรกรรม, 4.x อนุรักษ์ป่าไม้,
  5.x ที่โล่ง. `PL_USE` is the 4-digit code, arriving as a float (`4400.0`) and
  normalised on the way in.
- **`drawingInfo.renderer` is not what the map paints.** It calls 7180
  อนุรักษ์ป่าไม้ and 8700 อนุรักษ์ชนบทและเกษตรกรรม solid **white**; DPT's own
  `export` draws them as a `#BFFF00` hatch and `#00A524`. A palette built from
  the renderer would blank out two of the commonest rural classes and get about
  a dozen wrong. The **legend swatch is ground truth** — the service rasterises
  it from the symbology actually in use. `derive_dpt_palette.py` decodes the
  stored base64 PNGs (pure Python; Pillow is not installed) and writes the real
  colour per class. Their byte sizes give it away before you decode: solid
  classes ~200 B, the two "white" ones 264 B and 288 B.
- **Six of DPT's own rows have no geometry at all** (`Polygon` with
  `coordinates: []`) — verified empty at full precision, so it is upstream data
  quality, not our generalisation.
- **`maxAllowableOffset=0.00005` (~5.5 m) is load-bearing.** Raw geometry is
  ~309 KB/feature, ~10 GB for the layer; generalised it is ~15 KB. Our factory
  coordinates are frequently tambon centroids at ±2–5 km, so 5.5 m is far below
  the noise floor of the question we ask these polygons.
- Cost: **76 plan areas, ~250 requests at 1 req/s, 6.5 minutes**, 24 MB gzipped
  archive, 96 MB SQLite. Every response archived; `--from-archive` rebuilds the
  database with zero requests.

The web map is also built offline from that SQLite file:

```bash
python server/sync/export_dpt_provincial_map.py
```

This spatially assigns plan areas to the province boundaries already shipped
by the client and writes one lazy-loaded file per covered province under
`client/public/data/dpt-province-landuse/`. The browser requests only the
selected province and never calls DPT. Exact duplicate shapes are reduced for
drawing with the highest OBJECTID as the deterministic winner; unknown legend
codes stay visible in grey and are labelled as unknown rather than guessed.

**Fetch ids first, then geometry by id.** The collector does this rather than
`resultOffset` paging so each plan area has an exact expected count and a short
read is arithmetic rather than a guess — HANDOFF §12.2 is the cautionary tale.

### What it changed, and the one gap left

Loaded as `dpt.plan_polygon` tier `province_landuse` (32,187 rows — the 6
geometry-less ones dropped) and re-exported:

| | before | after |
|---|---:|---:|
| Zoned by a town plan | 14,486 | **14,486** (identical, byte for byte) |
| Zoned by a provincial plan | — | **31,698** |
| Plan extent only, no land use | 39,655 | **10,044** |
| No DPT plan at all | 8,515 | **6,428** |

**The remaining gap is the EEC, and it is not ours to close.** `PLLU_PROV`
publishes **no polygons at all** for ชลบุรี, ระยอง or ฉะเชิงเทรา — there is no
`CB_ID` beginning 20, 21 or 24 — and those three provinces are **8,360 of the
10,044 extent-only factories (83%)**. The legend defines EEC classes (3101,
3102, 4403–4405, 6900, 7111, 7352, 8001) but not one EEC polygon came back,
which fits: the EEC is planned under a separate statute, as a
ผังการใช้ประโยชน์ที่ดิน EEC rather than a ผังเมืองรวมจังหวัด. So the two most
industrial provinces in the country still have only a plan extent, and finding
the EEC layer is the next thread — not more of this one.
- **`urllib` from lighthouse-sev01 must force IPv4.** The host has a public IPv6
  address and no route to DPT over it, so a connection sits in `SYN-SENT` until
  it times out. `curl` hides this (Happy Eyeballs, 0.12 s over v4); `urllib`
  tries only the first address getaddrinfo returns. See `force_ipv4()` in
  `load_dpt_polygons.py`. It cost a stalled harvest to find.
- **Zoning is a function of position.** Run `export_zoning.py` whenever markers
  move — including after an admin repositions a factory in `/admin`.
  `export_zoning.py --check` exits non-zero and names stale provinces.
- **Reload cadence:** town plans change on a scale of years, so
  `load_dpt_polygons.py` is run by hand, not nightly. Every response is archived
  to `server/data/dpt-archive/`, and `--from-archive` replays the whole
  provincial tier in **6.5 seconds with zero requests** — which is how the
  PROV_CODE 10 exclusion was applied without re-asking DPT for anything.

Do not compute legal compliance from this. Whether a factory may operate in a
zone depends on its จำพวก, machinery, the annex schedules of that specific
ministerial regulation, and whether it predates the plan — we hold none of the
last three.

---

## 6. DOL — land title deeds (blocked)

The goal: resolve deed numbers to parcel coordinates for **8,705 factories with
no position at all**. The collector is complete and proven — five factories
resolved to real coordinates — but the route is closed.

What we established, so nobody re-derives it:

- The working call is **`GET /apiService/LandsMaps/GetParcelByParcelNo/{pvcode}/{amcode}/{deed_no}`**
  — path parameters, not a POST body — with a Bearer token.
- **The token cannot be requested directly.** `GetJWTAccessToken` returns
  `access_token: null` on a freshly loaded page; the app mints a real one only
  while *performing a search*. `dol_session.py` scripts that search and captures
  the token as it goes past.
- **GeoServer (`/geoserver/LANDSMAPS/wfs`) works anonymously** with the Incapsula
  cookies and needs no JWT — but publishes **no deed number**. Only `parcel_seq`,
  `land_no` and `utmmap*`, and land numbers are not unique (110,491 parcels share
  `land_no='18'`). It renders parcels; it cannot look them up by deed.
- **PIPR (`pipr.dol.go.th`) is government-to-government.** Registration is open
  only to DOL staff and องค์กรปกครองส่วนท้องถิ่น, via AD/LDAP. Not an API we can
  apply for.
- After ~10 automated sessions the gateway escalated to **hCaptcha**. That is a
  stop.
- **Re-probed 2026-08-18** (6 days later): the block is **still active** — a
  visible-browser acquisition attempt cleared Incapsula but hit the hCaptcha
  hard-block, and no token was minted. Also note: `playwright-stealth` is NOT
  installed in any interpreter on this machine, but that is secondary — the
  definitive blocker is the hCaptcha, not the missing stealth module.

### Exhaustive 2026-08-18 re-survey — no anonymous deed→coordinate route exists

Drove every candidate source to a live-tested verdict. **Conclusion: the
deed→parcel mapping is singular and gated.** Every anonymous route publishes
parcel *geometry* but not the deed number; the deed number lives only behind a
login. Full matrix (each live-verified):

| Source | Verdict |
|---|---|
| DOL LandsMaps app (`GET …/GetParcelByParcelNo/{pv}/{am}/{deed}`) | hCaptcha — hard stop |
| DOL GeoServer (`/geoserver/LANDSMAPS/wfs`) | Incapsula WAF + no deed field |
| **DOL parcel shapefiles (data.go.th, org กรมที่ดิน)** | **anon download, but no deed no.** — `LAND_NO` is a sheet-local 1–4 digit sequence, not the โฉนด number. Verified on นนทบุรี (160k parcels, 0/12 factory deeds joined). |
| LTAX GIS (`ltax.dla.go.th/geoserver`) | 57.8M parcels keyed by `land_id`/`parcel_code` — deed→`land_id` needs LTAX login (`ltaxsv`, ThaiD-gated) |
| NGIS `Land_Parcel_Industrial` | settlement land, 0 overlap |
| LDD / GISTDA | land-use / admin boundaries, no cadastre |
| data.go.th "ข้อมูลรูปแปลงที่ดิน ตามเลขที่โฉนด" | requires DOL Consumer-Key/Secret |

The only sanctioned exact-coordinate path is the **institutional request to DOL
(Consumer-Key/Secret)** or **DLA (`land_id` registry)**. No CAPTCHA bypass — and
none is needed: for the "factory near me" product, the tambon-centroid tier
(±2–5 km) is the honest, appropriate granularity and already covers ~97% of the
deed-bearing set. Exact parcel boundaries are a legal/advocacy nicety, not a
blocker for near-me.

**The only remaining route is institutional**: Thai PBS asking DOL directly
(`pipr@dol.go.th`, 084-339-9216) for a one-off resolution of 8,705
(province, district, deed) triples to parcel centroids. Narrow, one CSV, no
standing access. Everything else is ready for the day that lands.

### NGIS alternate route — investigated 2026-08-18, verdict: no overlap

Searched for a CAPTCHA-free alternate to the hCaptcha'd LandsMaps app. NGIS
(`ngis.go.th`) hosts a **public, token-free** ArcGIS FeatureServer,
`Land_Parcel_Industrial`, that returns real WGS84 polygons with a `lot_no`
(deed) field — verified live. **But it does not resolve this project's
factories**, and that is a data-universe problem, not a bug:

- The layer is **government settlement/นิคม land** (tambon values like นิคม,
  ภูดิน, ขมิ้น), published by กรมพัฒนาสังคมฯ — not the private cadastre.
- Its data quality is poor: multiple spellings of the same district
  (`เมืองกาฬสินธุ`/`เมืองกาฬสินธู์`/`เมืองกาฬสินธุ์`), a district mislabelled
  as a province (`บ้านผือ`), and most rows carry a **blank `lot_no`**.
- DIW's private factory deed numbers (e.g. `lot_no=9574` in กาฬสินธุ์) return
  **0 features**. Two different deed universes; essentially zero overlap.

A pilot collector over 10 in-scope rows returned **0/10 found** — all
`not_found`. Do not re-build against this layer. The institutional route above
remains the only legitimate path to private-factory parcel coordinates.

---

## 7. Checklist for the next source

1. Can we get it **legitimately and in bulk**? Check open-data catalogues and
   eligibility *before* reverse-engineering. PIPR looked like an API programme
   and turned out to be closed to us.
2. Put the raw response on disk before parsing it.
3. One rate limiter. Start slower than you think — 1 req/s finished 36,684
   requests without a single block.
4. Classify gateway errors separately from application errors.
5. Give every record an explicit outcome; never resume over errors.
6. Verify against an independent oracle, and check every number against the
   artifact.
7. Ship absence as absence. "No data" is a finding; a guess dressed as a finding
   is a liability — especially about named businesses.

---

## 8. Files worth knowing

| Path | Purpose |
|---|---|
| `server/collector/dbd_archive.py` | Atomic gzip writes, PII redaction, append-only journal read at logical grain |
| `server/collector/dbd_resolve.py` | `RateLimiter`, name normalisation, candidate scoring, `--rescore` replay |
| `server/collector/dbd_audit.py` | `--strict` gate: PII, orphans, unsafe public matches, nationality sanity |
| `server/collector/dbd_bootstrap.py` | Playwright cookie bootstrap for DBD |
| `server/sync/dol_session.py` | DOL session acquisition (challenge + token capture) with disk cache |
| `server/sync/export_zoning.py` | Point-in-polygon export + `--check` staleness guard |
| `server/collector/test_dbd_match.py` | 14 regression cases from live registry data, including must-not-match |
| `server/collector/test_dbd_client.py` | WAF-vs-auth classification and cookie loading |

Tests — **30 cases**:

```bash
cd server/collector && python -m unittest discover -p "test_*.py"
```

Use an interpreter that has `requests` and `cryptography` (e.g.
`server/sync/venv/bin/python` on the server). With a bare system Python the
client and matching suites fail to import and you silently run only 6 of the 30 —
which looks like a pass if you only read the last line.
