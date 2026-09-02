-- ผังเมืองรวมจังหวัด, with its land use — the third and best DPT tier.
--
-- TARGET: the government database (lighthouse-sev01). See supabase/README.md.
--
-- What changed since 20260902000000
-- ---------------------------------
-- That migration created two tiers: `municipal` (has a land-use code) and
-- `province` (plan footprints, no land use at all). The footprint tier was
-- built on the belief that DPT publishes provincial *extents* only and gates
-- the land use behind a token.
--
-- That was wrong. The probe had hit `onedpt.dpt.go.th/DPT_LANDUSE_NON/
-- PLLU_VIEW` — an empty decoy one hostname and one `_NON` away from the real
-- layer, which answers 200 with `layers: []`. The real one is
-- `onedptgis.dpt.go.th/DPT_LANDUSE/PLLU_VIEW` layer 5 `PLLU_PROV`, reachable
-- through DPT's own credential-free viewer proxy, and it carries 32,193
-- polygons with `PL_USE` and the numbered `PL_BLOCK` from DPT's printed plans.
--
-- So this adds a `province_landuse` tier. It does not remove `province`: the
-- footprints still answer "is there a plan here" for anywhere `PLLU_PROV` has
-- no polygon, which is a weaker answer but a true one.
--
-- Precedence, once all three exist
-- --------------------------------
--   municipal        most specific plan, has land use          → wins
--   province_landuse provincial plan, has land use             → next
--   province         provincial plan footprint, no land use    → last resort
--   (nothing)        DPT publishes no plan we hold             → absence
--
-- The tiers overlap by construction — a provincial plan covers the whole
-- province including its town-plan areas — so they are consulted in order and
-- never summed. `export_zoning.py` enforces this.

alter table dpt.plan_polygon
  drop constraint if exists plan_polygon_tier_check;

alter table dpt.plan_polygon
  add constraint plan_polygon_tier_check
  check (tier in ('municipal', 'province', 'province_landuse'));

alter table dpt.plan_polygon_staging
  drop constraint if exists plan_polygon_staging_tier_check;

comment on column dpt.plan_polygon.tier is
  'municipal = ผังเมืองรวมเมือง/ชุมชน (has pl_use); province_landuse = ผังเมืองรวมจังหวัด (has pl_use); province = ผังเมืองรวมจังหวัด footprint (no land use, fallback only). Consulted in that order; never sum them — the tiers overlap.';

-- DPT's own land-use classes, so nothing downstream invents a label or colour.
--
-- `color` is NOT taken from the service's `drawingInfo.renderer`. The renderer
-- describes 7180 อนุรักษ์ป่าไม้ and 8700 อนุรักษ์ชนบทและเกษตรกรรม as solid
-- white, while DPT's own map draws them as a #BFFF00 hatch and #00A524 — a
-- palette built from the renderer blanks out two of the commonest rural
-- classes and gets about a dozen wrong. These values are decoded from the
-- legend swatch the service actually rasterises. See
-- server/sync/derive_dpt_palette.py.
create table if not exists dpt.landuse_class (
    pl_use     text primary key,
    label      text not null,
    color      text,
    patterned  boolean not null default false,
    loaded_at  timestamptz not null default now()
);

comment on table dpt.landuse_class is
  'DPT land-use code -> Thai label and the colour DPT actually renders it in, decoded from the published legend swatch rather than from drawingInfo.renderer, which disagrees with the map.';
comment on column dpt.landuse_class.patterned is
  'True where DPT draws the class as a hatch rather than a solid fill; `color` is then the hatch line, which is what a reader perceives the class as.';

revoke all on dpt.landuse_class from anon, authenticated;

-- Extend the promote whitelist to the new tier. Floor reasoning unchanged: a
-- service answering 200-with-no-features must not be able to promote an empty
-- tier and silently un-zone the country. Observed count is 32,193.
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
  if p_tier not in ('municipal', 'province', 'province_landuse') then
    raise exception 'promote_plan_polygons: % is not a known tier', p_tier;
  end if;

  select count(*) into n from dpt.plan_polygon_staging where tier = p_tier;

  if n < p_min_rows then
    raise exception
      'promote_plan_polygons: refusing to promote % — staging has % rows, expected at least %',
      p_tier, n, p_min_rows;
  end if;

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

revoke all on function dpt.promote_plan_polygons(text, int) from public, anon, authenticated;
