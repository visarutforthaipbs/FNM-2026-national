-- Keep DIW's coordinate even when a human has overridden it, and make the
-- override check atomic with the write.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- Two problems this closes.
--
-- 1. TOCTOU. pipeline.apply_gov_coordinates() read back the protected ids in
--    Python and then upserted. Over a chunked 274k-row sync those two steps are
--    minutes apart, so a moderator approving a correction in that window had it
--    silently overwritten by the same run. No error, no log — the pin just
--    reverted overnight.
--
-- 2. The override destroyed the evidence. A moderator's pin replaced the gov
--    coordinate in the same cell, and `location_corrections` stores only the
--    PROPOSED position — and lives on the citizen database besides, so the
--    government database kept no memory of what DIW had said. That means a bad
--    moderation cannot be reverted, and there is no way to notice that DIW has
--    since fixed the record upstream.
--
-- The fix is a shadow pair written on every sync for every row and read by
-- nothing in the application: a record, not a source. Anything that draws a map
-- still reads lat/lng.

alter table public.factories
  add column if not exists gov_lat           double precision,
  add column if not exists gov_lng           double precision,
  add column if not exists gov_coord_seen_at timestamptz;

comment on column public.factories.gov_lat is
  'Latitude as most recently published by DIW, recorded even when an override wins. Never rendered — lat/lng is what the app reads. Exists so an override can be reverted and so upstream fixes can be detected (see coord_override_drift).';
comment on column public.factories.gov_lng is
  'Longitude as most recently published by DIW. See gov_lat.';
comment on column public.factories.gov_coord_seen_at is
  'When the gov_lat/gov_lng pair was last confirmed present in the DIW feed.';

-- ── the atomic apply ───────────────────────────────────────────────────────
-- Replaces the read-then-write in pipeline.py. Both statements run in one
-- transaction, so an override committed mid-sync is either fully visible to the
-- filter or not yet applied — never half-seen.
--
-- Called in chunks (~5,000 rows) rather than with one 274k payload; each chunk
-- is its own transaction, which is fine because the two statements that must
-- agree are within a chunk, not across them.
create or replace function public.apply_gov_coordinates(p jsonb)
returns table(applied int, shadowed int)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Record what DIW said for every row in the batch, override or not.
  update factories f
     set gov_lat = i.lat,
         gov_lng = i.lng,
         gov_coord_seen_at = now()
    from jsonb_to_recordset(p)
      as i(id text, lat double precision, lng double precision)
   where f.id = i.id
     and i.lat is not null
     and i.lng is not null;
  get diagnostics shadowed = row_count;

  -- Apply only where no human has spoken.
  --
  -- 'community' and 'admin' are human-verified positions. 'repaired' is
  -- protected too: those rows exist precisely because the government
  -- coordinate was wrong — a whole-degree digit error that plotted the factory
  -- outside its own province — and the feed still carries the wrong value, so
  -- an unprotected sync restores the corruption the repair undid
  -- (HANDOFF.md §10.5). A repair was accepted only if it landed inside the
  -- stated province AND within 15 km of the stated tambon centroid AND was the
  -- only shift to do both, so it is better evidence than the value it replaces.
  --
  -- 'sibling' is deliberately NOT protected: an inherited position is a
  -- stand-in for missing government data, so a real DIW coordinate should win.
  --
  -- coalesce() is load-bearing. coord_source IS NULL for every unmapped
  -- factory, and `NULL not in (...)` evaluates to NULL, not true — without it
  -- the 728 rows that most need a coordinate are the ones silently skipped.
  -- This exact trap already cost us one dry run during the coordinate replay.
  update factories f
     set lat = i.lat,
         lng = i.lng,
         coord_source = 'gov',
         coord_precision = 'exact'
    from jsonb_to_recordset(p)
      as i(id text, lat double precision, lng double precision)
   where f.id = i.id
     and i.lat is not null
     and i.lng is not null
     and coalesce(f.coord_source, '') not in ('community', 'admin', 'repaired')
     and (f.lat is distinct from i.lat or f.lng is distinct from i.lng
          or coalesce(f.coord_source, '') <> 'gov');
  get diagnostics applied = row_count;

  return next;
end;
$$;

comment on function public.apply_gov_coordinates(jsonb) is
  'Apply DIW coordinates for one batch: shadow every row into gov_lat/gov_lng, then overwrite lat/lng only where coord_source is not community/admin/repaired. Atomic — replaces the read-then-write that could lose an override committed mid-sync.';

revoke all on function public.apply_gov_coordinates(jsonb) from public, anon, authenticated;
grant execute on function public.apply_gov_coordinates(jsonb) to service_role;

-- ── the drift queue ────────────────────────────────────────────────────────
-- An override, once set, is permanent: nothing ever revisits it. If DIW
-- corrects their own record next month we neither adopt it nor notice.
--
-- With the shadow pair that becomes a query. Small drift means DIW has caught
-- up and the override is now redundant — retire it and let the row go back to
-- 'gov'. Large drift means the override is still doing work.
--
-- geom is maintained by tr_factories_set_geometry and always agrees with
-- lat/lng, so it is safe to measure against.
create or replace view public.coord_override_drift as
select
  f.id,
  f.name,
  f.province,
  f.coord_source,
  f.lat,
  f.lng,
  f.gov_lat,
  f.gov_lng,
  f.gov_coord_seen_at,
  round(
    st_distance(
      f.geom::geography,
      st_setsrid(st_makepoint(f.gov_lng, f.gov_lat), 4326)::geography
    )::numeric
  ) as drift_m
from public.factories f
where f.coord_source in ('admin', 'community', 'repaired')
  and f.gov_lat is not null
  and f.gov_lng is not null
  and f.geom is not null
order by drift_m;

comment on view public.coord_override_drift is
  'Human-overridden coordinates alongside what DIW currently publishes. Low drift_m means the feed has caught up and the override can be retired; high drift_m means it is still needed. Moderator-facing — served by the tailnet-only admin API, never by PostgREST to anon.';

revoke all on public.coord_override_drift from anon, authenticated;
