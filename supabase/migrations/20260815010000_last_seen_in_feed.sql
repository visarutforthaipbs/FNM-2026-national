-- Record when each factory was last present in a DIW feed, so deactivation can
-- be based on sustained absence rather than one day's response.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- soft_delete_missing() deactivated anything absent from today's fetch. That
-- premise is false: the DIW endpoint oscillates between two populations about
-- 33,000 rows apart, and has done so for months. From sync_logs, Factory_Data:
--
--   2026-04-02  274,340
--   2026-07-17  274,414      2026-07-18  243,977
--   2026-08-08  274,418      2026-08-08  241,588   ← same day, both values
--   2026-08-14  241,145
--
-- A dry run on 2026-08-14 found 37,819 rows absent from that day's feed, of
-- which 32,762 are ดำเนินการ and 32,662 are on the map. Acting on a single
-- day's absence would have deactivated more than half of the operating
-- factories the site publishes. Cross-checked against the other endpoints:
-- Business_Location covered only 4,542 of them, so ~33,277 were absent
-- everywhere that day — and present again on other days.
--
-- The table's 274,422 rows are the high-water mark of a feed that keeps
-- dropping and restoring the same population. Accumulating via upsert is the
-- correct behaviour; deleting on absence is not.
--
-- So: stamp every row the feed *does* carry, and treat a row as closed only
-- once it has been missing for a sustained period. NULL means never yet
-- stamped, which is never a deactivation candidate — nothing can be
-- deactivated until it has been seen at least once and then gone.

alter table public.factories
  add column if not exists last_seen_in_feed timestamptz;

comment on column public.factories.last_seen_in_feed is
  'When this factory was last present in a DIW feed. Written on every upsert. Deactivation is based on sustained absence from this timestamp, never on one day''s response — the endpoint oscillates between two populations ~33k apart. NULL = not yet stamped, and never a deactivation candidate.';

create index if not exists idx_factories_last_seen_in_feed
  on public.factories (last_seen_in_feed)
  where is_active;
