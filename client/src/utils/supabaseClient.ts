import { createClient } from "@supabase/supabase-js";

/**
 * Two databases, two clients — see supabase/README.md.
 *
 *   gov     lighthouse-sev01, self-hosted. Factories, businesses, permits,
 *           DBD ownership. Rebuildable from the collectors; safe to publish.
 *   citizen cloud Supabase project. Accounts, watchlists, reports, location
 *           corrections. Rebuildable from nothing; never in an export.
 *
 * They are genuinely separate Postgres instances, so nothing joins across
 * them: fetch ids from one, hydrate names from the other. An earlier single
 * client assumed the two were "the exact same Postgres DB" and routed only
 * auth to the cloud — they never were, and the mismatch published one
 * database's coordinates under the other's factory detail for six days.
 *
 * Auth lives on `citizen` because GoTrue is not reachable on sev01: the
 * Tailscale Funnel exposes /rest/v1 and nothing else, so /auth/v1 answers 404.
 */

const govUrl = import.meta.env.VITE_SUPABASE_URL;
const govKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const citizenUrl = import.meta.env.VITE_CITIZEN_SUPABASE_URL;
const citizenKey = import.meta.env.VITE_CITIZEN_SUPABASE_ANON_KEY;

export const isGovConfigured = Boolean(govUrl && govKey);
export const isCitizenConfigured = Boolean(citizenUrl && citizenKey);

if (!isGovConfigured) {
  console.warn(
    "Government Supabase credentials missing — factory detail lookups will return null. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}
if (!isCitizenConfigured) {
  console.warn(
    "Citizen Supabase credentials missing — sign-in, watchlists and report submission are unavailable. Set VITE_CITIZEN_SUPABASE_URL and VITE_CITIZEN_SUPABASE_ANON_KEY."
  );
}

// Placeholders keep createClient from throwing at import time, so the map still
// works without credentials rather than white-screening.
const PLACEHOLDER_URL = "http://localhost";
const PLACEHOLDER_KEY = "public-anon-key-missing";

/** Government data: factories, businesses, DBD ownership. Read-only, no session. */
export const supabaseGov = createClient(
  govUrl || PLACEHOLDER_URL,
  govKey || PLACEHOLDER_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

/** Citizen data: accounts, watchlists, reports, corrections. Holds the session. */
export const supabaseCitizen = createClient(
  citizenUrl || PLACEHOLDER_URL,
  citizenKey || PLACEHOLDER_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);
