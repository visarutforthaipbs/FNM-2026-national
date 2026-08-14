-- Migration: User Authentication, Watchlists, Incident Diary, and Authority Dossier Support
-- Created: 2026-08-14
--
-- TARGET: the citizen database (cloud Supabase project), not the government
-- database on lighthouse-sev01. See supabase/README.md for the split.
--
-- factory_id columns here are plain text, deliberately unconstrained: the
-- factories table lives in the other database, so a foreign key is not
-- available. A registration id that no longer resolves is a display concern,
-- not an integrity failure — and the previous FK carried `on delete cascade`,
-- which would have let a government data refresh silently delete a citizen's
-- saved watchlist. Losing the constraint removes that coupling.

-- 1. Create user profiles table (synced from auth.users)
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Factory Watchlist table (citizens bookmarking specific factories)
create table if not exists public.user_factory_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  factory_id text not null check (char_length(factory_id) between 1 and 40),
  notes text,
  created_at timestamptz not null default now(),
  unique (user_id, factory_id)
);

create index if not exists idx_user_factory_watchlist_user on public.user_factory_watchlist (user_id);
create index if not exists idx_user_factory_watchlist_factory on public.user_factory_watchlist (factory_id);

-- 3. Industry Type Watchlist table (citizens following entire industry codes like 101/105/106/52)
create table if not exists public.user_industry_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  industry_code int not null check (industry_code between 1 and 107),
  province text, -- optional province scope
  created_at timestamptz not null default now(),
  unique (user_id, industry_code, province)
);

create index if not exists idx_user_industry_watchlist_user on public.user_industry_watchlist (user_id);

-- 4. Extend public.reports to support authenticated user links and private incident notes
alter table public.reports
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists private_note text;

create index if not exists idx_reports_user_id on public.reports (user_id);

-- 5. Row-Level Security (RLS) Policies
alter table public.user_profiles enable row level security;
alter table public.user_factory_watchlist enable row level security;
alter table public.user_industry_watchlist enable row level security;

-- user_profiles policies
drop policy if exists "users can view own profile" on public.user_profiles;
create policy "users can view own profile"
  on public.user_profiles for select
  to authenticated using (auth.uid() = id);

drop policy if exists "users can update own profile" on public.user_profiles;
create policy "users can update own profile"
  on public.user_profiles for update
  to authenticated using (auth.uid() = id);

drop policy if exists "users can insert own profile" on public.user_profiles;
create policy "users can insert own profile"
  on public.user_profiles for insert
  to authenticated with check (auth.uid() = id);

-- user_factory_watchlist policies
drop policy if exists "users can manage own factory watchlist" on public.user_factory_watchlist;
create policy "users can manage own factory watchlist"
  on public.user_factory_watchlist for all
  to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_industry_watchlist policies
drop policy if exists "users can manage own industry watchlist" on public.user_industry_watchlist;
create policy "users can manage own industry watchlist"
  on public.user_industry_watchlist for all
  to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- reports policies for authenticated users
drop policy if exists "users can view own submitted reports" on public.reports;
create policy "users can view own submitted reports"
  on public.reports for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can update own private notes" on public.reports;
create policy "users can update own private notes"
  on public.reports for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users can delete own reports" on public.reports;
create policy "users can delete own reports"
  on public.reports for delete
  to authenticated
  using (auth.uid() = user_id);

-- Grant appropriate permissions to authenticated role
grant select, insert, update on public.user_profiles to authenticated;
grant select, insert, delete, update on public.user_factory_watchlist to authenticated;
grant select, insert, delete, update on public.user_industry_watchlist to authenticated;
grant select, insert (factory_id, impact_types, frequency, distance_band, description, incident_date, reporter_contact, source, user_id, private_note), update (private_note), delete on public.reports to authenticated;

-- 6. Trigger to automatically populate user_profiles when a user signs in via Google OAuth
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(nullif(excluded.full_name, ''), public.user_profiles.full_name),
    avatar_url = coalesce(nullif(excluded.avatar_url, ''), public.user_profiles.avatar_url),
    updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
