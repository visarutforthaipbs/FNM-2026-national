/// <reference types="vite/client" />

declare module "*.css";

interface ImportMetaEnv {
  // Government database (lighthouse-sev01): factories, businesses, DBD.
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  // Citizen database & Auth (Firebase): accounts, watchlists, reports, storage.
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  // Legacy citizen database (cloud Supabase project)
  readonly VITE_CITIZEN_SUPABASE_URL?: string;
  readonly VITE_CITIZEN_SUPABASE_ANON_KEY?: string;
  // Admin API on sev01:4443, tailnet-only.
  readonly VITE_API_BASE?: string;
  readonly VITE_CARTO_API_KEY?: string;
  readonly VITE_SPHERE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
