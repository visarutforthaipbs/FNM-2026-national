# Handoff — 2026-08-08

Written for a fresh agent/session picking this up cold. Read this before touching
`server/sync/pipeline.py`, the admin API, or anything coordinate-related — there's
live incident context here that isn't obvious from the code alone.

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

After any geocoding tier run: refresh `geom`
(`UPDATE factories SET geom = ST_SetSRID(ST_MakePoint(lng, lat), 4326)
WHERE lat IS NOT NULL AND geom IS NULL;`), then
`python export_markers.py && python export_dashboard.py`, then commit the
regenerated `client/public/data/` files.

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
