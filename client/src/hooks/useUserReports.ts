import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/useAuth";
import { supabaseCitizen, supabaseGov } from "../utils/supabaseClient";
import type { UserIncidentReport } from "../types/auth";
import type { ImpactType, ReportFrequency, DistanceBand } from "../types/report";

export function useUserReports() {
  const { user } = useAuth();
  const [reports, setReports] = useState<UserIncidentReport[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUserReports = useCallback(async () => {
    if (!user) {
      setReports([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // No embed here, and none is possible: factories lives in the government
      // database and reports lives in the citizen one, so there is no foreign
      // key for PostgREST to resolve `factories(...)` through. Names are
      // hydrated from the other client below, and their absence is not fatal
      // to showing the user their own reports.
      const { data, error: fetchErr } = await supabaseCitizen
        .from("reports")
        .select(
          "id, factory_id, impact_types, frequency, distance_band, description, incident_date, created_at, status, private_note"
        )
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (fetchErr) {
        throw fetchErr;
      }

      interface ReportDbRow {
        id: string;
        factory_id: string;
        impact_types: string[];
        frequency: string | null;
        distance_band: string | null;
        description: string | null;
        incident_date: string | null;
        created_at: string;
        status: "pending" | "approved" | "rejected";
        private_note: string | null;
      }

      const rows = (data as unknown as ReportDbRow[]) || [];

      // Best-effort factory names, in one query against the *government*
      // database. Cross-database, so it cannot be a join. If it fails the
      // reports still render, just without a resolved name.
      const factoryNames = new Map<string, { name?: string; province?: string; district?: string }>();
      const factoryIds = Array.from(new Set(rows.map((r) => r.factory_id)));
      if (factoryIds.length > 0) {
        const { data: factoryRows, error: factoryErr } = await supabaseGov
          .from("factories")
          .select("id, name, province, district")
          .in("id", factoryIds);

        if (factoryErr) {
          console.warn("Could not resolve factory names:", factoryErr.message);
        } else {
          for (const f of factoryRows ?? []) {
            factoryNames.set(f.id as string, f);
          }
        }
      }

      const formattedReports: UserIncidentReport[] = rows.map((row) => {
        const factoryObj = factoryNames.get(row.factory_id);
        return {
          id: row.id,
          factory_id: row.factory_id,
          factory_name: factoryObj?.name || "ไม่ระบุชื่อโรงงาน",
          province: factoryObj?.province || "",
          district: factoryObj?.district || "",
          impact_types: (row.impact_types || []) as ImpactType[],
          frequency: row.frequency as ReportFrequency | null,
          distance_band: row.distance_band as DistanceBand | null,
          description: row.description || null,
          incident_date: row.incident_date || null,
          created_at: row.created_at,
          status: row.status,
          private_note: row.private_note || null,
        };
      });

      setReports(formattedReports);
    } catch (err: unknown) {
      console.error("Error fetching user reports:", err);
      const msg = err instanceof Error ? err.message : "ไม่สามารถโหลดประวัติการรายงานได้";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchUserReports();
  }, [fetchUserReports]);

  const updatePrivateNote = useCallback(
    async (reportId: string, privateNote: string) => {
      if (!user) return false;
      try {
        const { error: updateErr } = await supabaseCitizen
          .from("reports")
          .update({ private_note: privateNote })
          .eq("id", reportId)
          .eq("user_id", user.id);

        if (updateErr) throw updateErr;

        setReports((prev) =>
          prev.map((r) => (r.id === reportId ? { ...r, private_note: privateNote } : r))
        );
        return true;
      } catch (err) {
        console.error("Error updating note:", err);
        return false;
      }
    },
    [user]
  );

  const deleteReport = useCallback(
    async (reportId: string) => {
      if (!user) return false;
      try {
        // `.select()` so we can tell "deleted" from "RLS matched no row" —
        // approved reports are public evidence and may no longer be removed,
        // and that comes back as a silent zero-row delete, not an error.
        const { data, error: deleteErr } = await supabaseCitizen
          .from("reports")
          .delete()
          .eq("id", reportId)
          .eq("user_id", user.id)
          .select("id");

        if (deleteErr) throw deleteErr;
        if (!data || data.length === 0) return false;

        setReports((prev) => prev.filter((r) => r.id !== reportId));
        return true;
      } catch (err) {
        console.error("Error deleting report:", err);
        return false;
      }
    },
    [user]
  );

  return {
    reports,
    isLoading,
    error,
    refresh: fetchUserReports,
    updatePrivateNote,
    deleteReport,
  };
}
