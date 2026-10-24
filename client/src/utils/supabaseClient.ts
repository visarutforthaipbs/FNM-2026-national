import { createClient } from "@supabase/supabase-js";

/**
 * Government database client (lighthouse-sev01, self-hosted PostgREST).
 *
 * Holds: factories, businesses, permits, factory_statistics, dbd.*
 * Read-only access for citizen frontend. Safe to export and cache.
 *
 * Note: Citizen data (accounts, watchlists, reports) has migrated to Firebase
 * (see client/src/utils/firebaseClient.ts) to eliminate free-tier project limits
 * and 7-day auto-pause issues.
 */

const govUrl = import.meta.env.VITE_SUPABASE_URL;
const govKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isGovConfigured = Boolean(govUrl && govKey);

if (!isGovConfigured) {
  console.warn(
    "Government Supabase credentials missing — factory detail lookups will return null. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  );
}

const PLACEHOLDER_URL = "http://localhost";
const PLACEHOLDER_KEY = "public-anon-key-missing";

/** Government data: factories, businesses, DBD ownership. Read-only, no session. */
export const supabaseGov = createClient(
  govUrl || PLACEHOLDER_URL,
  govKey || PLACEHOLDER_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

/**
 * Deprecated: Citizen layer now uses Firebase (see client/src/utils/firebaseClient.ts).
 * This stub is kept inert with no auto-refresh to prevent any ERR_NAME_NOT_RESOLVED.
 */
export const supabaseCitizen = createClient(
  PLACEHOLDER_URL,
  PLACEHOLDER_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);
export const isCitizenConfigured = false;
