-- DPT town-planning polygons, moved into the government database.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- Why this exists
-- ---------------
-- Until now the 42,219 DPT polygons lived in exactly one place: a 398 MB
-- SQLite file (`server/data/dpt_geodatabase.db`) that is gitignored and exists
-- on two laptops-worth of disk. DATA_LAYER.md §6.1 already records the same
-- shape of problem for the DBD archive. Zoning was worse: it is the only
-- government dataset with no archive at all, so losing the file meant
-- re-harvesting from DPT and hoping the service still answered.
--
-- It also meant the point-in-polygon ran in Python, ray-casting every factory
-- against a hand-rolled integer-degree grid, because SQLite cannot do better.
-- PostGIS is already installed here (3.3.7) and `factories.geom` is already
-- maintained by a trigger, so the same question is one indexed spatial join.
--
-- Two tiers, and the difference matters
-- -------------------------------------
-- `municipal` — ผังเมืองรวมเมือง/ชุมชน, the 204 town and community plans in
--   DPT's PLLU_ALL layer. These carry a real land-use code (`pl_use`) and zone
--   block (`pl_block`): they say what a point is zoned.
--
-- `province` — ผังเมืองรวมจังหวัด, from TOWNPLAN/TP_MAIN layer 2. These are
--   plan *footprints* and carry NO land-use attribute. One polygon per plan,
--   covering the whole province — verified against ระยอง (one MultiPolygon,
--   23,180 vertices, the province outline). They answer "is this point inside
--   a provincial plan", never "what is it zoned".
--
-- That distinction is the whole point of the tier column and must survive into
-- the UI. Nine provinces — ชลบุรี and ระยอง among them, 8,366 factories, 13.4%
-- of everything mapped — have no municipal polygon at all and were being told
-- "ไม่มีข้อมูลผังเมืองสำหรับตำแหน่งนี้" when a provincial plan demonstrably
-- covers them. That is our harvest scope reading as an absence in the world,
-- which is the exact failure COLLECTORS.md §5 warns about.
--
-- The tiers overlap, so municipal wins
-- ------------------------------------
-- The provincial footprint is the whole province, not the province minus its
-- town plans. Measured on เชียงใหม่: 1,004 of 1,007 factories fall inside the
-- provincial footprint, including 335 of the 336 that already carry a
-- municipal zone. So a point inside both is governed by the more specific
-- plan, and the provincial tier may only ever be consulted where the municipal
-- tier has no answer. Never union the two counts.

create schema if not exists dpt;

comment on schema dpt is
  'Government data harvested from third parties: DBD ownership (see dbd schema) and DPT town planning. Not exposed through PostgREST.';

create table if not exists dpt.plan_polygon (
    id            bigserial primary key,

    -- 'municipal' carries a land-use code; 'province' is a plan footprint with
    -- no land-use attribute at all. See the header.
    tier          text not null check (tier in ('municipal', 'province')),

    -- Identity as DPT publishes it. `source_id` is PLLU_ALL's FID for
    -- municipal rows and TP_MAIN's OBJECTID for provincial ones; it is stable
    -- enough to diff two harvests but is not a key we rely on.
    source_id     text,
    plan_name     text,
    plan_code     text,
    prov_code     text,
    province_th   text,
    amphoe_th     text,
    plan_year     integer,
    status_major  text,
    doc_type      text,

    -- Municipal only. `pl_use` is the 4-digit land-use code that
    -- export_zoning.py's CODE_FAMILIES classifies on; `pl_block` is DPT's own
    -- zone letter (ย./พ./อ./ก./ล./ส.) and is what proved the digit-prefix
    -- guess wrong for 8600. Both are null on provincial rows, by definition.
    pl_use        text,
    pl_block      text,

    geom          geometry(MultiPolygon, 4326) not null,
    loaded_at     timestamptz not null default now()
);

-- The spatial join is the only hot query: given a factory point, which polygon
-- contains it. GiST on the geometry plus a tier filter is the whole access
-- pattern.
create index if not exists idx_plan_polygon_geom     on dpt.plan_polygon using gist (geom);
create index if not exists idx_plan_polygon_tier     on dpt.plan_polygon (tier);
create index if not exists idx_plan_polygon_province on dpt.plan_polygon (province_th);

comment on table dpt.plan_polygon is
  'DPT town-planning polygons. tier=municipal carries a land-use code and says what a point is zoned; tier=province is a plan footprint and says only that a provincial plan covers the point. Municipal wins where both contain a point.';
comment on column dpt.plan_polygon.tier is
  'municipal = ผังเมืองรวมเมือง/ชุมชน (has pl_use); province = ผังเมืองรวมจังหวัด footprint (no land use). Never union their counts — the two tiers overlap.';

-- Load target, promoted by dpt.promote_plan_polygons(). Same reasoning as
-- public.promote_staging: a harvest that dies halfway must not be able to
-- leave the live table empty or partial.
create table if not exists dpt.plan_polygon_staging
  (like dpt.plan_polygon including defaults);

comment on table dpt.plan_polygon_staging is
  'Load target for a DPT harvest. Promoted by dpt.promote_plan_polygons(); never read by anything else.';

-- Promote one tier's staged polygons over the live rows, atomically.
--
-- Scoped by tier for the same reason promote_staging takes p_source: the two
-- tiers are harvested from different DPT services on different schedules, and
-- re-running the provincial harvest must not delete the municipal rows.
--
-- The row floor is a circuit breaker, not a formality. A DPT service that
-- answers 200 with an empty feature set — which is exactly how the WAF-vs-
-- service ambiguity in COLLECTORS.md §2.4 presents — would otherwise promote
-- an empty tier and silently un-zone the whole country.
create or replace function dpt.promote_plan_polygons(
  p_tier text,
  p_min_rows int
)
returns int
language plpgsql
security definer
set search_path = dpt, public
as $$
declare
  n int;
begin
  if p_tier not in ('municipal', 'province') then
    raise exception 'promote_plan_polygons: % is not a known tier', p_tier;
  end if;

  select count(*) into n from dpt.plan_polygon_staging where tier = p_tier;

  if n < p_min_rows then
    raise exception
      'promote_plan_polygons: refusing to promote % — staging has % rows, expected at least %',
      p_tier, n, p_min_rows;
  end if;

  -- One transaction: the live tier goes from its old contents to its new
  -- contents with nothing observable in between.
  delete from dpt.plan_polygon where tier = p_tier;
  insert into dpt.plan_polygon (
      tier, source_id, plan_name, plan_code, prov_code, province_th,
      amphoe_th, plan_year, status_major, doc_type, pl_use, pl_block, geom, loaded_at
  )
  select tier, source_id, plan_name, plan_code, prov_code, province_th,
         amphoe_th, plan_year, status_major, doc_type, pl_use, pl_block, geom, loaded_at
  from dpt.plan_polygon_staging where tier = p_tier;

  delete from dpt.plan_polygon_staging where tier = p_tier;

  return n;
end;
$$;

comment on function dpt.promote_plan_polygons(text, int) is
  'Atomically replace one tier of dpt.plan_polygon from staging. Refuses below p_min_rows, so a DPT service answering 200-with-no-features cannot un-zone the country.';

revoke all on function dpt.promote_plan_polygons(text, int) from public, anon, authenticated;
revoke all on all tables in schema dpt from anon, authenticated;
