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

`download_dpt_geodatabase.py` (one-shot, ~40 s, public ArcGIS REST, no auth) →
`server/data/dpt_geodatabase.db` (400 MB, gitignored) → `export_zoning.py` →
per-province static JSON.

Know before using it:

- The layer is **203 town/community plans and no province-wide plan**. It covers
  built-up areas only, so **77% of mapped factories fall outside every polygon**.
  That absence is ambiguous — outside any plan, or inside one not in this layer —
  and the UI must say so rather than implying the factory is unplanned.
- Nine provinces have no matching polygon at all, including **Chonburi and
  Rayong** (EEC, planned under a separate statute) — 0 of 4,377 Chonburi
  factories.
- `TOWNPLAN/CPLLU_NON` is **not** "77 provinces"; it publishes เพชรบุรี and
  สระบุรี only.
- **Zoning is a function of position.** Run `export_zoning.py` whenever markers
  move — including after an admin repositions a factory in `/admin`.
  `export_zoning.py --check` exits non-zero and names stale provinces.

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

**The only remaining route is institutional**: Thai PBS asking DOL directly
(`pipr@dol.go.th`, 084-339-9216) for a one-off resolution of 8,705
(province, district, deed) triples to parcel centroids. Narrow, one CSV, no
standing access. Everything else is ready for the day that lands.

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
