-- Capture the columns Sum_Factory_Local actually publishes.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- The two Sum_* endpoints have different schemas, and config.py applied one
-- mapping to both. It fits Sum_Status_Factory_Local exactly and
-- Sum_Factory_Local not at all:
--
--   Sum_Factory_Local publishes : PROVINCE, TSIC, DESCR, TOTAL, TOTALMAN,
--                                 TOTALCAP, FACSIZE_S, FACSIZE_M, FACSIZE_L,
--                                 LAST_UPDATE
--   the mapping looked for      : YEAR, MONTH, FPROVNAME, TSIC, DESCR, STATUS,
--                                 TOTAL, LAST_UPDATE
--
-- So all 185,917 of its rows landed with year, month, province and status NULL.
-- Province was lost purely to a name mismatch (PROVINCE vs FPROVNAME), and the
-- worker, capital and factory-size columns were never mapped at all.
--
-- That data is worth having: it is the per-province, per-industry aggregate DIW
-- publishes on its executive dashboard, and it is the instrument for measuring
-- the ~10,400 จำพวก 3 factories our registry is short against the official
-- 71,012 (HANDOFF.md §4) — per province, from our own data, instead of scraping
-- an ASP page.

alter table public.factory_statistics
  add column if not exists total_workers integer,
  add column if not exists total_capital numeric,
  add column if not exists size_small    integer,
  add column if not exists size_medium   integer,
  add column if not exists size_large    integer;

comment on column public.factory_statistics.total_workers is
  'Sum_Factory_Local TOTALMAN — workers aggregated by province and TSIC. Null for Sum_Status_Factory_Local rows, which do not publish it.';
comment on column public.factory_statistics.total_capital is
  'Sum_Factory_Local TOTALCAP — registered capital, baht.';
comment on column public.factory_statistics.size_small is
  'Sum_Factory_Local FACSIZE_S — count of small factories in this province/TSIC cell.';
comment on column public.factory_statistics.size_medium is
  'Sum_Factory_Local FACSIZE_M.';
comment on column public.factory_statistics.size_large is
  'Sum_Factory_Local FACSIZE_L.';

-- The staging table is created with `like ... including defaults`, so it does
-- not inherit columns added afterwards. Keep the two shapes identical or
-- promote_staging()'s `insert into ... select *` will fail on a column mismatch.
alter table public.factory_statistics_staging
  add column if not exists total_workers integer,
  add column if not exists total_capital numeric,
  add column if not exists size_small    integer,
  add column if not exists size_medium   integer,
  add column if not exists size_large    integer;

-- ── permits.factory_id ─────────────────────────────────────────────────────
-- Never populated: PERMIT_TO_PERMITS had no rule for it, so all 241,145 rows
-- carried NULL and the table could not be joined to factories at all. The only
-- link the feed offers is FID, which resolves ~39% of rows — the remainder are
-- permits for factories the current registry no longer carries.
--
-- Called by pipeline.py after the permits swap, rather than done row-by-row in
-- Python, because it is one set-based UPDATE over the whole table.
create or replace function public.link_permits_to_factories()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update permits p
     set factory_id = f.id
    from factories f
   where f.fid = p.factory_fid
     and p.factory_id is distinct from f.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.link_permits_to_factories() is
  'Resolve permits.factory_id from factory_fid -> factories.fid. See COLLECTORS.md on the DIW permit feed.';

revoke all on function public.link_permits_to_factories() from public, anon, authenticated;
