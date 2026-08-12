-- Shareholder nationality belongs in the registry, not beside it.
--
-- DBD's /nations endpoint answers a question /partners cannot: the aggregate
-- nationality split of a company's shareholders, including for บริษัทจำกัด,
-- where the partner list is empty for all 44,879 of them. It is DBD data of
-- exactly the same kind as the directors and financial statements already
-- stored here, arrived at the same way, and it belongs in the same schema —
-- a JSON file carried alongside the database is one more thing that can drift
-- out of step with it.
--
-- This is an aggregate and is stored as one. DBD names no shareholder here, so
-- there is one row per nationality per company and no person to identify: the
-- table cannot leak what it never holds.
create table if not exists dbd.company_nations (
  jp_no         text not null references dbd.juristic(jp_no) on delete cascade,
  nt_code       text not null,               -- ISO alpha-2 as DBD reports it
  holders       int,                         -- shareholders carrying it
  share_percent numeric,                     -- their combined stake
  share_amount  numeric,
  raw           jsonb,
  fetched_at    timestamptz not null default now(),
  primary key (jp_no, nt_code)
);

comment on table dbd.company_nations is
  'Aggregate shareholder nationality per juristic person, from DBD /nations. A summary, never individual shareholders — DBD does not name them at this endpoint.';

create index if not exists company_nations_jp_no_idx on dbd.company_nations (jp_no);

-- `raw` is a debugging aid, as with committee and shareholder: never granted.
revoke all on dbd.company_nations from anon, authenticated;

-- Republish the profile with nationality attached. The column is appended, so
-- every existing consumer keeps the shape it already reads.
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
  finance.net_profit,
  coalesce(nations.nationalities, '[]'::jsonb) as nationalities
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
) finance on true
left join lateral (
  -- Largest stake first, so the reader meets the controlling nationality
  -- before the rounding remainder.
  select jsonb_agg(
    jsonb_build_object(
      'code', n.nt_code,
      'holders', n.holders,
      'percent', n.share_percent
    )
    order by n.share_percent desc nulls last, n.nt_code
  ) as nationalities
  from dbd.company_nations n
  where n.jp_no = fo.jp_no
) nations on true;

comment on view public.factory_dbd_profile is
  'Safe per-factory DBD profile for the public detail panel. Exact or human-verified ownership links only; no raw payloads or personal identifiers.';

grant select on public.factory_dbd_profile to anon, authenticated;
