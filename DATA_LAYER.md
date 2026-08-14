# The data layer — what exists, how it is loaded, how it is kept alive

Counted from the live databases on **2026-08-14**. Figures move; recount from the
artifact rather than citing this file (see the warning in [`CLAUDE.md`](CLAUDE.md)).

Companion documents, none of which this replaces:

- [`CLAUDE.md`](CLAUDE.md) — how the application is built and the rules that bind it
- [`COLLECTORS.md`](COLLECTORS.md) — the four government sources and the patterns that made them work
- [`HANDOFF.md`](HANDOFF.md) — incident history; read §2 and §11 before touching the load path
- [`supabase/README.md`](supabase/README.md) — which migration belongs to which database

---

## 1. Two databases, split by recoverability

The split is **not** by subject. It is by one question: *can a collector rebuild
this from scratch?*

Government data can — delete all of it and the collectors replay it from archived
snapshots. Citizen data cannot: a neighbour's report of the factory beside their
house exists nowhere else. Those two facts want different backup policies,
different blast radii and different access control, which is why they no longer
share an instance.

|  | Government | Citizen |
|---|---|---|
| Host | `lighthouse-sev01`, self-hosted Supabase, Postgres 17.6 | cloud Supabase project, managed |
| Size | **1,066 MB** | **20 MB** |
| Written by | the collectors, on a timer | people, through the app |
| Rebuildable | yes, from the archives | **no** |
| Backups | a convenience — the archive is the truth | the point |
| In an export | that is what it is for | **never** |
| Migrations | `supabase/migrations/` | `supabase/migrations-citizen/` |
| Client | `supabaseGov` | `supabaseCitizen` |
| Server pool | `pool` | `citizenPool` |

### Government database

```
public                                        dbd
  factories              274,422  282 MB        juristic          36,848  249 MB
  factory_statistics     371,834  226 MB        committee        101,471   68 MB
  businesses             223,542   86 MB        operator_match    52,441   52 MB
  permits                241,145   37 MB        financial         33,506   31 MB
  sync_logs                   71   80 kB        company_nations   43,164   12 MB
  permits_staging              0                shareholder        6,883  4.9 MB
  factory_statistics_staging   0
```

Views are the only surface the browser touches: `public.factory_dbd_profile`,
`dbd.factory_owner`, `dbd.company_people`, `dbd.company_shareholders`. National
ID numbers and contact details are redacted at the view, never selected.

### Citizen database

```
auth.users                    1
public
  user_profiles               1
  user_factory_watchlist      1
  user_industry_watchlist     0
  reports                     2
  location_corrections        1
  report_throttle             —   (ephemeral, per-IP-hash buckets)
views
  approved_reports, report_counts   approved rows only, never reporter contact
```

Auth lives here because it has to. The Tailscale Funnel on sev01 exposes
`/rest/v1` and nothing else, so `/auth/v1` answers **404** and GoTrue on that host
is unreachable from a browser. Verified, not assumed.

### Two rules that keep the split honest

1. **No foreign keys across the boundary.** `reports.factory_id` and
   `user_factory_watchlist.factory_id` are plain text. The FK that used to exist
   carried `on delete cascade`, so a government data refresh could have silently
   deleted a citizen's saved watchlist.
2. **No joins across it either.** Fetch ids from one, hydrate names from the
   other — `server/index.js` does this in both admin queues, and
   `useUserReports.ts` does it in the diary. An id the registry no longer knows
   leaves the name blank rather than dropping the row, because a moderator still
   needs to see the report.

---

## 2. How data gets in

| Source | Collector | State |
|---|---|---|
| **DIW** — factory registry | `server/collector/collect.py`, `server/sync/pipeline.py` | working, nightly |
| **DBD** — company ownership | `server/collector/dbd_*.py` | working, weekly |
| **DPT** — town-planning zones | `server/sync/download_dpt_geodatabase.py`, `export_zoning.py` | working, on release |
| **DOL** — land deeds | `server/sync/harvest_landsmaps_geodatabase.py` | **blocked** behind hCaptcha |

The read path matters more than the databases: **roughly 95% of what a visitor
sees is static JSON on a CDN**, not a live query.

```
DIW ──► collect.py ──► diw-archive ──► NAS          (never touches a database)
        pipeline.py ──► gov database
DBD ──► dbd_*.py ─────► dbd-archive ──► gov database (dbd schema)
DPT ──► download_dpt ─► dpt_geodatabase.db (SQLite, 398 MB, gitignored)

gov database ──► export_markers / export_dashboard / export_zoning
                        └──► client/public/data/*.json ──► CDN ──► browser
gov database ──► PostgREST ──► browser   (factory detail on selection only)
citizen db   ──► PostgREST ──► browser   (sign-in, watchlist, diary, reporting)
both         ──► admin API :4443         (moderation, tailnet-only)
```

`collect.py` is deliberately isolated: it writes to the archive and the NAS and
**touches no database**, so a bad night in collection cannot reach the live site.
Do not chain it to the sync — that isolation is the point.

---

## 3. The maintenance schedule

Four systemd timers on sev01, all recorded in
[`server/deploy/systemd/`](server/deploy/systemd/) rather than living only on the
host. Times are Bangkok; each carries randomised jitter.

| When | Unit | What it does |
|---|---|---|
| every 10 min | `dbd-stall-check` | Watches for a hung DBD crawl. One ran 5h24m silently before this existed. |
| daily 02:30 | `diw-collector` | Archives a raw DIW snapshot, mirrors it to the NAS. No database writes. |
| daily 03:00 | `factory-sync` | Loads DIW, regenerates every static export, commits and pushes to GitHub. **Does not publish** — see below. |
| Sunday 04:30 | `dbd-collect` | Full DBD pass: refresh operator list → resolve → load → detail → audit. |

`factory-sync` is **independent** of `diw-collector` by design, not by oversight.

### Nothing here reaches the public site on its own

**Vercel is not connected to the repository.** The deploy flow is: push to GitHub,
then trigger a deploy by hand (`vercel --prod` from `client/`, or the dashboard).
That is deliberate — a human gates what reaches production, which is a reasonable
guard for a project with this incident history.

Two consequences worth holding on to:

- A nightly run that succeeds leaves its exports **committed and waiting**, not
  live. The site updates when someone deploys.
- `vercel --prod` uploads the **working directory, not a commit**. An uncommitted
  file ships; a committed file that is not in the working tree does not. The
  entire citizen-account UI was live in production for a day while absent from
  git for exactly this reason.

Approving a location correction in `/admin` therefore takes three steps to become
visible: the approval writes to the database, an export regenerates the static
JSON, and a deploy publishes it. Only the first is automatic.

`dbd-collect` regenerates `operators.tsv` from the factory registry as stage 0.
Without that it would re-resolve a frozen list forever, which is why it had no
timer until 2026-08-14. The query is documented in `dbd_resolve.py`'s docstring.

---

## 4. What stops it going wrong

Every guard below exists because the failure it prevents already happened.

| Guard | Prevents |
|---|---|
| `promote_staging()` — staging load, then swap in one transaction | A reader seeing an empty `permits`/`factory_statistics`. Replaces a delete-then-insert that once cleared **814,588** permits. |
| 5% deactivation circuit breaker | A truncated CSV mass-deactivating the registry |
| `MIN_EXPECTED_PERMITS` / `MIN_EXPECTED_STATISTICS` = 100,000 | Loading a degraded fetch over good data |
| `DBD_MIN_OPERATORS` = 40,000 | A failed query blanking `operators.tsv` and no-opping every later run |
| Test mode no-ops on destructive paths | A `--test` run wiping a table, as on 2026-08-08 |
| `PROTECTED = (community, admin, repaired)` | The nightly sync overwriting human coordinate decisions |
| `reports` trigger: forces `pending`, throttles 5/hour per IP hash | Clients self-approving; report flooding |
| Anon has INSERT only; reads go through views | Reporter contact details ever reaching the public |
| Admin API tailnet-only, 30/min, constant-time compare, per-request log | The one process that can read unmoderated reporter contact being on the open internet |
| Archive-first collection | Re-crawling a WAF-protected source to apply a rules change |

`sibling` is deliberately **not** protected: an inherited position is a stand-in
for missing government data, so a real DIW coordinate should overwrite it.

---

## 5. Coordinate provenance

Every mapped factory carries a source flag, and the map renders approximate
positions differently from exact ones.

| `coord_source` | Count | Origin |
|---|---:|---|
| `gov` | 39,035 | Straight from the DIW feed — **not** automatically trustworthy |
| `centroid` | 19,960 | Tambon centroid, ±2–5 km. Faded pin, "approximate" badge |
| `geocoded` | 3,045 | Longdo street geocode, province-validated |
| `sibling` | 568 | Inherited from a licence at the same address — exact, labelled by origin |
| `admin` | 36 | Placed by hand by a moderator |
| `repaired` | 12 | Whole-degree digit error in the government value, corrected |
| *(none)* | 728 | Unmapped — 1.1% of operating factories |

Operating factories **63,384**; mapped **62,656 (98.8%)**.

---

## 6. Known gaps

None is currently breaking the site. Each would cost something real if left.

1. **The DBD archive exists on one disk.** 865 MB, only on sev01 — a laptop on
   home power. The DIW archive is mirrored to the NAS; this one is not. It is what
   makes a rate-limited crawl behind a WAF replayable instead of repeatable.
2. **Citizen database backups are unverified.** It holds the only data nothing can
   rebuild, and its schedule depends on the Supabase plan. Confirm PITR is on and
   test a restore once.
3. **Moderator decisions still overwrite derived data.** `/admin` writes
   coordinates directly into `factories`, so a human judgement and a collector's
   value share one cell — rebuilding the table loses the human half. An
   append-only overrides log with a composing view would fix it.
4. **209 factories are plotted in the wrong province**, all government
   coordinates, all still published as exact with no badge. Worst case is 1,052 km
   from the province it claims.
5. **`factories.status` is frozen.** Nothing writes it since the 2026-08-08
   corruption, because DIW's `FFLAG` and `STATUS` fields were never decoded. It
   drifts stale until someone resolves it with DIW.
6. **Photo/video reporting needs EXIF stripping first.** A phone photo carries GPS
   to metre precision; someone photographing the factory beside their house would
   upload their home coordinates, defeating the coarse `distance_band` the whole
   reporting design rests on. Strip server-side, before storage — never
   client-side, where it can be skipped.
