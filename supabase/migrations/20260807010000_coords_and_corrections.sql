-- Coordinate provenance + citizen location corrections — geocoding phase 1
--
--  * factories.coord_source / coord_precision record WHERE each pin came from
--    so approximate positions are never presented as surveyed ones.
--  * location_corrections is the Tier-4 crowdsourcing queue: citizens drag a
--    pin to the factory's real position; an admin approves it into factories.
--    Same trust model as reports: anon INSERT only, moderated via admin API.

-- ── Provenance on factories ────────────────────────────────────────────────

alter table public.factories
  add column if not exists coord_source text
    check (coord_source in ('gov', 'repaired', 'geocoded', 'centroid', 'community')),
  add column if not exists coord_precision text
    check (coord_precision in ('exact', 'street', 'tambon'));

-- Existing pins all came straight from the DIW feed
update public.factories
  set coord_source = 'gov', coord_precision = 'exact'
  where lat is not null and coord_source is null;

-- ── Citizen location corrections ───────────────────────────────────────────

create table public.location_corrections (
  id            uuid primary key default gen_random_uuid(),
  factory_id    text not null check (char_length(factory_id) between 1 and 40),
  factory_name  text check (char_length(factory_name) <= 200),
  -- Proposed position, constrained to Thailand's bounding box
  lat           double precision not null check (lat between 5.3 and 20.6),
  lng           double precision not null check (lng between 97.2 and 105.7),
  note          text check (char_length(note) <= 500),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  source        text not null default 'web' check (source in ('web', 'line')),
  created_at    timestamptz not null default now(),
  moderated_at  timestamptz,
  reject_reason text
);

create index location_corrections_status_idx
  on public.location_corrections (status, created_at desc);

-- Same per-IP throttle as reports (shares report_throttle, different salt)
create or replace function public.corrections_before_insert()
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
  new.status := 'pending';
  new.moderated_at := null;
  new.reject_reason := null;
  new.created_at := now();

  begin
    headers := current_setting('request.headers', true)::json;
    ip := split_part(coalesce(headers ->> 'x-forwarded-for', 'unknown'), ',', 1);
  exception when others then
    ip := 'unknown';
  end;
  key := md5('correction-throttle:' || ip);

  insert into report_throttle as t (ip_hash, bucket, n)
  values (key, date_trunc('hour', now()), 1)
  on conflict (ip_hash, bucket) do update set n = t.n + 1
  returning t.n into hits;

  if hits > 5 then
    raise exception 'rate_limited' using errcode = 'P0001',
      hint = 'ส่งการแก้ไขได้สูงสุด 5 ครั้งต่อชั่วโมง';
  end if;

  return new;
end;
$$;

create trigger corrections_before_insert
  before insert on public.location_corrections
  for each row execute function public.corrections_before_insert();

alter table public.location_corrections enable row level security;

create policy "anon can submit corrections"
  on public.location_corrections for insert
  to anon
  with check (true);

revoke all on public.location_corrections from anon, authenticated;
grant insert (factory_id, factory_name, lat, lng, note, source)
  on public.location_corrections to anon;
