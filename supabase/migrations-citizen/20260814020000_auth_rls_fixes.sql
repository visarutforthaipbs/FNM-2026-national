-- Migration: fixes for the user-auth rollout (20260814010000)
-- Created: 2026-08-14
--
-- The auth migration added SELECT/UPDATE/DELETE policies for `authenticated`
-- but no INSERT policy, while the client moved every write onto supabase-js.
-- supabase-js attaches the user's JWT once signed in, so the request arrives as
-- role `authenticated` — and the only INSERT policies on `reports` and
-- `location_corrections` are `to anon`. Result: submitting a report or a pin
-- correction fails with 42501 for exactly the users we just asked to sign in.

-- ── 1. Authenticated citizens may submit reports ───────────────────────────
-- `user_id` is optional: a signed-in user may still report anonymously by
-- leaving it null. What they may not do is file a report under someone else's
-- id, hence the equality check.
drop policy if exists "authenticated can submit reports" on public.reports;
create policy "authenticated can submit reports"
  on public.reports for insert
  to authenticated
  with check (user_id is null or auth.uid() = user_id);

-- ── 2. Authenticated citizens may submit location corrections ──────────────
-- The coords migration revoked all and re-granted insert to `anon` only.
drop policy if exists "authenticated can submit corrections" on public.location_corrections;
create policy "authenticated can submit corrections"
  on public.location_corrections for insert
  to authenticated
  with check (true);

grant insert (factory_id, factory_name, lat, lng, note, source)
  on public.location_corrections to authenticated;

-- ── 3. Approved reports may no longer be hard-deleted by their author ──────
-- Once approved, a report is public evidence feeding `report_counts`; letting
-- the author delete it silently rewrites a public statistic. Pending and
-- rejected rows are still theirs to remove.
drop policy if exists "users can delete own reports" on public.reports;
create policy "users can delete own reports"
  on public.reports for delete
  to authenticated
  using (auth.uid() = user_id and status <> 'approved');

-- ── 4. Industry watchlist: make the uniqueness constraint actually fire ────
-- `unique (user_id, industry_code, province)` never dedupes the rows the client
-- writes, because it always leaves `province` null and NULL <> NULL in a unique
-- index. Toggling a follow on/off/on accumulates duplicates.
delete from public.user_industry_watchlist a
  using public.user_industry_watchlist b
 where a.ctid > b.ctid
   and a.user_id = b.user_id
   and a.industry_code = b.industry_code
   and a.province is not distinct from b.province;

alter table public.user_industry_watchlist
  drop constraint if exists user_industry_watchlist_user_id_industry_code_province_key;

create unique index if not exists uq_user_industry_watchlist_scoped
  on public.user_industry_watchlist (user_id, industry_code, province)
  where province is not null;

create unique index if not exists uq_user_industry_watchlist_nationwide
  on public.user_industry_watchlist (user_id, industry_code)
  where province is null;

-- ── 5. Keep profiles in sync, not just at signup ───────────────────────────
-- The trigger fired `after insert` only, so the `on conflict do update` branch
-- was dead code: a changed Google display name or avatar never reached us.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed in before the auth migration landed — they have no
-- user_profiles row at all, so the app shows them a permanently empty profile.
insert into public.user_profiles (id, email, full_name, avatar_url)
select u.id,
       u.email,
       coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
       coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture', '')
  from auth.users u
on conflict (id) do nothing;
