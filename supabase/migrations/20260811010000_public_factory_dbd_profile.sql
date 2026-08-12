-- One safe, public-schema read model for the factory detail panel.
--
-- PostgREST exposes `public` by default. Keeping the client on a single view
-- avoids exposing the internal dbd schema or asking the browser to assemble
-- joins across ownership, people and financial tables. The source
-- dbd.factory_owner view already limits publication to exact or human-verified
-- mappings. National ID numbers, contact details and raw API payloads are
-- never selected.
create or replace view public.factory_dbd_profile
with (security_barrier = true) as
select
  fo.factory_id,
  fo.jp_no,
  fo.jp_name,
  fo.jp_type_desc,
  fo.jp_status_desc,
  fo.register_capital,
  fo.registered_province,
  fo.match_outcome,
  fo.human_verified,
  coalesce(people.directors, '[]'::jsonb) as directors,
  coalesce(owners.owners, '[]'::jsonb) as owners,
  finance.year as financial_year,
  finance.total_assets,
  finance.total_liabilities,
  finance.total_equity,
  finance.total_revenue,
  finance.net_profit
from dbd.factory_owner fo
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'name', p.full_name,
      'role', 'กรรมการ'
    )
    order by p.seq
  ) as directors
  from dbd.company_people p
  where p.jp_no = fo.jp_no
    and nullif(btrim(p.full_name), '') is not null
) people on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'name', s.holder_name,
      'nationality', nullif(btrim(s.nationality), ''),
      'shareAmount', s.share_amount,
      'sharePercent', s.share_percent
    )
    order by s.seq
  ) as owners
  from dbd.company_shareholders s
  where s.jp_no = fo.jp_no
    and nullif(btrim(s.holder_name), '') is not null
) owners on true
left join lateral (
  select
    f.year,
    f.total_assets,
    f.total_liabilities,
    f.total_equity,
    f.total_revenue,
    f.net_profit
  from dbd.financial f
  where f.jp_no = fo.jp_no
  order by
    case when f.year ~ '^[0-9]{4}$' then f.year::int else 0 end desc,
    f.year desc
  limit 1
) finance on true;

comment on view public.factory_dbd_profile is
  'Safe per-factory DBD profile for the public detail panel. Exact or human-verified ownership links only; no national IDs, contact details or raw payloads.';

grant select on public.factory_dbd_profile to anon, authenticated;
