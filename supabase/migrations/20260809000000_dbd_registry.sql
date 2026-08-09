-- DBD company registry, and its mapping to DIW factory operators.
--
-- Kept in a separate `dbd` schema rather than mixed into the factory tables.
-- The two datasets come from different agencies, disagree with each other, and
-- are updated on different schedules — the moment DBD values are written into
-- `factories` columns, "what DIW says" and "what DBD says" become
-- indistinguishable, which is precisely the confusion that froze
-- factories.status. Keeping them apart means a disagreement stays visible.
--
-- The mapping is likewise its own table, never a column on `businesses`.
-- Matching rules will improve; a separate table can be recomputed wholesale
-- without touching source data, and it can record *why* a match was made.

create schema if not exists dbd;

-- ---------------------------------------------------------------------------
-- Juristic person identity, as returned by DBD search
-- ---------------------------------------------------------------------------
create table if not exists dbd.juristic (
  jp_no             text primary key,          -- 13-digit juristic person number
  jp_name           text not null,             -- as DBD stores it (suffix included for companies)
  jp_type_code      text,
  jp_type_desc      text,                      -- บริษัทจำกัด / ห้างหุ้นส่วนจำกัด / บริษัทมหาชนจำกัด
  jp_status_code    text,
  jp_status_desc    text,                      -- ยังดำเนินกิจการอยู่ / แปรสภาพ / เลิก...
  jp_name_old       text,                      -- previous name, when the entity was renamed
  register_capital  numeric,
  province          text,
  province_code     text,
  ampur_code        text,
  tumbon_code       text,                      -- same 6-digit scheme as DIW TA_ID
  setup_obj_code    text,                      -- TSIC at registration
  submit_obj_code   text,                      -- TSIC as last filed
  business_size     text,
  jp_age            int,
  address           text,
  fiscal_year       text,
  raw               jsonb,                     -- full response; nothing is lost to schema drift
  fetched_at        timestamptz not null default now()
);

comment on table dbd.juristic is
  'Company identity from DBD DataWarehouse. `raw` keeps the untouched response so new fields never require a re-crawl.';

-- ---------------------------------------------------------------------------
-- Who runs and owns the company
-- ---------------------------------------------------------------------------
create table if not exists dbd.committee (
  jp_no       text not null references dbd.juristic(jp_no) on delete cascade,
  seq         int  not null,
  full_name   text,
  title       text,
  raw         jsonb,
  fetched_at  timestamptz not null default now(),
  primary key (jp_no, seq)
);

create table if not exists dbd.shareholder (
  jp_no        text not null references dbd.juristic(jp_no) on delete cascade,
  seq          int  not null,
  holder_name  text,
  nationality  text,
  share_amount numeric,
  share_percent numeric,
  raw          jsonb,
  fetched_at   timestamptz not null default now(),
  primary key (jp_no, seq)
);

create table if not exists dbd.financial (
  jp_no          text not null references dbd.juristic(jp_no) on delete cascade,
  year           text not null,                -- Thai fiscal year as DBD reports it (e.g. 2568)
  total_assets      numeric,
  total_liabilities numeric,
  total_equity      numeric,
  total_revenue     numeric,
  net_profit        numeric,
  raw            jsonb,
  fetched_at     timestamptz not null default now(),
  primary key (jp_no, year)
);

-- ---------------------------------------------------------------------------
-- Mapping: DIW operator -> DBD juristic person
-- ---------------------------------------------------------------------------
create table if not exists dbd.operator_match (
  business_id     varchar primary key references public.businesses(id) on delete cascade,
  legal_name      text not null,               -- DIW ONAME as matched, kept for audit
  core_name       text,                        -- name after stripping the legal-form prefix
  matched_query   text,                        -- the spelling that actually found it
  expected_form   text,                        -- legal form implied by the DIW prefix
  jp_no           text references dbd.juristic(jp_no) on delete set null,

  -- exact | probable | ambiguous | form_mismatch | no_match | not_juristic | error
  outcome         text not null,
  candidates      int,

  -- Independent corroboration, computed from signals the matcher did NOT use.
  -- These exist to measure precision rather than assert it.
  isic_agrees     boolean,                     -- DIW ISIC_CODE vs DBD setup/submit obj code
  province_agrees boolean,                     -- only meaningful for single-site operators

  -- Human decisions must survive automated re-runs, the same way community and
  -- admin coordinates are protected from the nightly gov sync.
  verified_by     text,
  verified_at     timestamptz,
  verified_note   text,

  resolved_at     timestamptz not null default now()
);

comment on column dbd.operator_match.verified_by is
  'Set when a human confirms or corrects a match. Loaders must never overwrite a verified row.';

create index if not exists idx_operator_match_jp_no on dbd.operator_match(jp_no);
create index if not exists idx_operator_match_outcome on dbd.operator_match(outcome);
create index if not exists idx_juristic_status on dbd.juristic(jp_status_desc);

-- ---------------------------------------------------------------------------
-- Read path for the application
-- ---------------------------------------------------------------------------
-- Only matches good enough to show publicly. Naming a company as the owner of
-- a specific factory is a claim about a real business, so ambiguous and
-- form-mismatched rows are deliberately excluded rather than shown with a
-- caveat.
create or replace view dbd.factory_owner as
select
  f.id            as factory_id,
  f.name          as factory_name,
  f.province      as factory_province,
  m.jp_no,
  j.jp_name,
  j.jp_type_desc,
  j.jp_status_desc,
  j.register_capital,
  j.province      as registered_province,
  m.outcome       as match_outcome,
  m.verified_by is not null as human_verified
from public.factories f
join public.businesses b on b.id = f.business_id
join dbd.operator_match m on m.business_id = b.id
join dbd.juristic j on j.jp_no = m.jp_no
where m.outcome in ('exact', 'probable') or m.verified_by is not null;

grant usage on schema dbd to anon, authenticated;
grant select on dbd.juristic, dbd.committee, dbd.shareholder, dbd.financial, dbd.factory_owner
  to anon, authenticated;
