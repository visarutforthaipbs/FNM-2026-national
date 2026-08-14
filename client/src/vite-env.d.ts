/// <reference types="vite/client" />

declare module "*.css";

interface ImportMetaEnv {
  // Government database (lighthouse-sev01): factories, businesses, DBD.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  // Citizen database (cloud project): accounts, watchlists, reports.
  readonly VITE_CITIZEN_SUPABASE_URL?: string;
  readonly VITE_CITIZEN_SUPABASE_ANON_KEY?: string;
  // Admin API on sev01:4443, tailnet-only.
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
