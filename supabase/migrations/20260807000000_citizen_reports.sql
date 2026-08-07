-- Citizen impact reports (รายงานผลกระทบจากโรงงาน) — Phase 1
--
-- Design notes:
--  * anon can ONLY insert; reports are never publicly readable as raw rows.
--  * Public reads go through two views that expose approved rows only:
--      - approved_reports  (excerpt fields, no contact info, ever)
--      - report_counts     (aggregate per factory per impact type)
--  * Moderation (status pending → approved/rejected) is done with the
--    service key / Supabase Studio, not from the client app.
--  * Rate limiting: a BEFORE INSERT trigger hashes the caller IP from
--    PostgREST's request.headers and allows max 5 reports/hour per IP.
--  * distance_band is deliberately coarse — we never store reporter
--    coordinates or addresses (reporter safety).

create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  factory_id       text not null check (char_length(factory_id) between 1 and 40),
  impact_types     text[] not null check (
                     impact_types <@ array['smell','noise','water','dust','vibration','other']::text[]
                     and array_length(impact_types, 1) between 1 and 6
                   ),
  frequency        text check (frequency in ('once', 'sometimes', 'daily')),
  distance_band    text check (distance_band in ('near', 'mid', 'far')),
  description      text check (char_length(description) <= 2000),
  incident_date    date check (incident_date <= current_date),
  photo_paths      text[],
  reporter_contact text check (char_length(reporter_contact) <= 200),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source           text not null default 'web' check (source in ('web', 'line')),
  created_at       timestamptz not null default now(),
  moderated_at     timestamptz,
  reject_reason    text
);

create index reports_factory_id_idx on public.reports (factory_id);
create index reports_status_created_idx on public.reports (status, created_at desc);

-- ── Rate limiting ──────────────────────────────────────────────────────────

create table public.report_throttle (
  ip_hash text not null,
  bucket  timestamptz not null,
  n       int not null default 1,
  primary key (ip_hash, bucket)
);

create or replace function public.reports_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  headers json;
  ip text;
  key text;
  hits int;
begin
  -- Client input can never set moderation fields or a non-pending status
  new.status := 'pending';
  new.moderated_at := null;
  new.reject_reason := null;
  new.photo_paths := null;  -- photo upload is a later phase
  new.created_at := now();

  -- Per-IP throttle: max 5 reports per rolling hour bucket
  begin
    headers := current_setting('request.headers', true)::json;
    ip := split_part(coalesce(headers ->> 'x-forwarded-for', 'unknown'), ',', 1);
  exception when others then
    ip := 'unknown';
  end;
  key := md5('report-throttle:' || ip);

  insert into report_throttle as t (ip_hash, bucket, n)
  values (key, date_trunc('hour', now()), 1)
  on conflict (ip_hash, bucket) do update set n = t.n + 1
  returning t.n into hits;

  if hits > 5 then
    raise exception 'rate_limited' using errcode = 'P0001',
      hint = 'ส่งรายงานได้สูงสุด 5 ครั้งต่อชั่วโมง';
  end if;

  -- Opportunistic cleanup of stale throttle rows
  delete from report_throttle where bucket < now() - interval '1 day';

  return new;
end;
$$;

create trigger reports_before_insert
  before insert on public.reports
  for each row execute function public.reports_before_insert();

-- ── Row-level security ─────────────────────────────────────────────────────

alter table public.reports enable row level security;
alter table public.report_throttle enable row level security;

-- Anonymous visitors may only insert (no select/update/delete policies exist,
-- so those are denied by RLS). Moderation uses the service role, which
-- bypasses RLS.
create policy "anon can submit reports"
  on public.reports for insert
  to anon
  with check (true);

-- Lock down column-level access so anon cannot even attempt to write
-- moderation fields (the trigger also overwrites them, belt and braces).
revoke all on public.reports from anon, authenticated;
grant insert (factory_id, impact_types, frequency, distance_band,
              description, incident_date, reporter_contact, source)
  on public.reports to anon;

revoke all on public.report_throttle from anon, authenticated;

-- ── Public read views (approved rows only, no PII) ─────────────────────────

-- Note: these are intentionally security-definer-style views (owner = postgres)
-- so they can read past RLS, exposing only approved, non-sensitive fields.
create view public.approved_reports as
  select id, factory_id, impact_types, frequency, distance_band,
         description, incident_date, created_at
  from public.reports
  where status = 'approved';

create view public.report_counts as
  select factory_id, unnest(impact_types) as impact_type, count(*)::int as count
  from public.reports
  where status = 'approved'
  group by factory_id, unnest(impact_types);

grant select on public.approved_reports to anon, authenticated;
grant select on public.report_counts to anon, authenticated;
