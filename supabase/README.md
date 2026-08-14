# Two databases, and which migrations belong to which

This project runs **two** Postgres databases. Putting a migration in the wrong
one is the failure mode this file exists to prevent — it already happened once,
for six days, and cost a reconciliation (see `HANDOFF.md` §11).

| | Government database | Citizen database |
|---|---|---|
| Host | `lighthouse-sev01`, self-hosted Supabase | cloud Supabase project |
| Migrations | `supabase/migrations/` | `supabase/migrations-citizen/` |
| Holds | `factories`, `businesses`, `permits`, `factory_statistics`, `sync_logs`, `dbd.*` | `auth.users`, `user_profiles`, watchlists, `reports`, `location_corrections` |
| Written by | the DIW/DBD/DPT collectors, on a timer | citizens, through the app |
| Rebuildable? | **Yes** — re-run the collectors | **No.** Nothing can re-derive it |
| Backups | convenience; the raw archives are the truth | the point. PITR, tested restores |
| Ever in an export? | yes, that's what it is for | **never** |

The split is by **recoverability**, not by subject. Government data can be
deleted and rebuilt from the collectors; citizen data cannot be rebuilt from
anything. Those two facts imply different backup policies, different blast
radii and different access control, which is why they are not roommates.

## Rules

1. **A migration touching `factories`, `businesses`, `permits`,
   `factory_statistics` or `dbd.*` goes in `migrations/`.** Anything touching
   accounts, watchlists, reports or corrections goes in `migrations-citizen/`.
2. **No foreign keys across the boundary.** `reports.factory_id` and
   `user_factory_watchlist.factory_id` are plain text. A registration id that
   no longer resolves is a display concern, not an integrity failure. The FK
   that used to exist carried `on delete cascade`, so a government data refresh
   could have silently deleted a citizen's watchlist.
3. **No joins across the boundary either.** Fetch ids from one, hydrate names
   from the other. `server/index.js` does this in the admin queues.
4. **Never dump the citizen database into anything public.** Open-data
   releases, snapshots for journalists and researcher extracts all come from
   the government database only.

## Migrations dated before 2026-08-14 are mixed

`20260807000000_citizen_reports.sql` and `20260807010000_coords_and_corrections.sql`
predate the split and touch both kinds of table — the latter adds
`factories.coord_source` *and* creates `location_corrections`. They are already
applied to both databases and are **not** rewritten here, because rewriting an
applied migration is worse than documenting it. Read them as history; do not
use them as a model.

## Applying

There is no `supabase db push` wiring for either database. Migrations are
applied by hand, in filename order:

```bash
# government (from a machine on the tailnet)
cat supabase/migrations/<file>.sql \
  | ssh visarut298@lighthouse-sev01 'docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1'

# citizen (cloud project)
psql "$CITIZEN_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations-citizen/<file>.sql
```

`ON_ERROR_STOP=1` is not optional: without it psql reports success after a
failed statement mid-file.
