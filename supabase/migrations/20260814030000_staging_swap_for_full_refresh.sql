-- Staging tables + an atomic promote, for the two tables that are fully
-- replaced on every sync rather than upserted.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- Why this exists
-- ---------------
-- `permits` and `factory_statistics` are refreshed with "delete everything,
-- then insert what we fetched". On 2026-08-08 a test run executed the delete
-- with 100 rows in hand and cleared 814,588 permits (HANDOFF.md §2). Guards
-- were added afterwards — test mode no-ops, and a fetch below
-- MIN_EXPECTED_PERMITS refuses to clear — and they are good guards, but they
-- protect against a *small fetch*. They do nothing about the window itself:
-- between the delete and the last insert the table is empty or partial, and a
-- crash, a dropped connection or an OOM in that window leaves it that way.
--
-- The duplicate copies found on the retired cloud project are the same failure
-- seen from the other side: six partial syncs, each leaving its rows behind
-- (201,500 / 171,000 / 24,000 / 58,500 / 118,000 / 241,588 by date).
--
-- The fix is to load into a staging table first and promote in one
-- transaction. TRUNCATE takes an ACCESS EXCLUSIVE lock, so a concurrent reader
-- does not see an empty table — it waits for the commit and then sees the new
-- rows. If the load fails halfway, the live table was never touched.

create table if not exists public.permits_staging
  (like public.permits including defaults);

create table if not exists public.factory_statistics_staging
  (like public.factory_statistics including defaults);

comment on table public.permits_staging is
  'Load target for the permits full refresh. Promoted by public.promote_staging(); never read by the application.';
comment on table public.factory_statistics_staging is
  'Load target for the factory_statistics full refresh. Promoted by public.promote_staging(); never read by the application.';

-- Promote a staging table over its live counterpart, atomically.
--
-- Returns the number of rows promoted. Raises rather than promoting if staging
-- holds fewer than p_min_rows — the same circuit-breaker idea as the existing
-- MIN_EXPECTED_PERMITS check, enforced in the database so it also covers a
-- caller that forgets to check.
-- p_source scopes the replacement to one slice of the table. factory_statistics
-- is owned jointly by two endpoints (Sum_Factory_Local and
-- Sum_Status_Factory_Local), each refreshing only its own rows, so truncating
-- the whole table on either one's behalf would silently delete the other's.
-- With p_source set the swap is DELETE-then-INSERT rather than TRUNCATE, which
-- is also gentler: readers keep their MVCC snapshot instead of blocking.
create or replace function public.promote_staging(
  p_table text,
  p_min_rows int,
  p_source text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  staging text;
begin
  -- Whitelist rather than trusting the caller: this function runs as definer
  -- and truncates whatever it is pointed at.
  if p_table not in ('permits', 'factory_statistics') then
    raise exception 'promote_staging: % is not a promotable table', p_table;
  end if;
  staging := p_table || '_staging';

  if p_source is null then
    execute format('select count(*) from public.%I', staging) into n;
  else
    execute format('select count(*) from public.%I where source_endpoint = $1', staging)
      into n using p_source;
  end if;

  if n < p_min_rows then
    raise exception
      'promote_staging: refusing to promote % — staging has % rows, expected at least %',
      coalesce(p_table || ' / ' || p_source, p_table), n, p_min_rows;
  end if;

  -- All of this is one transaction, so the live table goes from its old
  -- contents to its new contents with nothing observable in between.
  if p_source is null then
    execute format('truncate table public.%I', p_table);
    execute format('insert into public.%I select * from public.%I', p_table, staging);
    execute format('truncate table public.%I', staging);
  else
    execute format('delete from public.%I where source_endpoint = $1', p_table)
      using p_source;
    execute format(
      'insert into public.%I select * from public.%I where source_endpoint = $1',
      p_table, staging
    ) using p_source;
    execute format('delete from public.%I where source_endpoint = $1', staging)
      using p_source;
  end if;

  return n;
end;
$$;

comment on function public.promote_staging(text, int, text) is
  'Atomically replace a full-refresh table from its _staging counterpart. Refuses below p_min_rows. See HANDOFF.md §2 for the incident that motivated it.';

drop function if exists public.promote_staging(text, int);
revoke all on function public.promote_staging(text, int, text) from public, anon, authenticated;
