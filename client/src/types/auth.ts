import type { User } from "@supabase/supabase-js";
import type { ImpactType, ReportFrequency, DistanceBand } from "./report";

export interface UserProfile {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  phone?: string | null;
  created_at: string;
}

export interface WatchedFactory {
  id: string;
  user_id: string;
  factory_id: string;
  notes?: string | null;
  created_at: string;
}

export interface WatchedIndustry {
  id: string;
  user_id: string;
  industry_code: number;
  province?: string | null;
  created_at: string;
}

export interface UserIncidentReport {
  id: string;
  factory_id: string;
  factory_name?: string;
  province?: string;
  district?: string;
  impact_types: ImpactType[];
  frequency?: ReportFrequency | null;
  distance_band?: DistanceBand | null;
  description?: string | null;
  incident_date?: string | null; // YYYY-MM-DD
  created_at: string;
  status: "pending" | "approved" | "rejected";
  private_note?: string | null;
}

export interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  isLoading: boolean;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  isAuthModalOpen: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
}
