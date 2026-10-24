import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../context/useAuth";
import { supabaseGov } from "../utils/supabaseClient";
import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db, isFirebaseConfigured } from "../utils/firebaseClient";
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

    if (!isFirebaseConfigured) {
      setReports([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Query reports authored by this user from Cloud Firestore
      const q = query(
        collection(db, "reports"),
        where("user_id", "==", user.id)
      );
      const snap = await getDocs(q);

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

      // Fetch private notes in parallel from the secure subcollection
      const rows: ReportDbRow[] = await Promise.all(
        snap.docs.map(async (d) => {
          const data = d.data();
          let privateNote: string | null = null;
          try {
            const sensitiveSnap = await getDoc(
              doc(db, "reports", d.id, "sensitive", "details")
            );
            if (sensitiveSnap.exists()) {
              privateNote = sensitiveSnap.data().private_note || null;
            }
          } catch {
            /* If no sensitive subcollection, defaults to null */
          }

          return {
            id: d.id,
            factory_id: data.factory_id || "",
            impact_types: data.impact_types || [],
            frequency: data.frequency || null,
            distance_band: data.distance_band || null,
            description: data.description || null,
            incident_date: data.incident_date || null,
            created_at: data.created_at?.toDate
              ? data.created_at.toDate().toISOString()
              : new Date().toISOString(),
            status: data.status || "pending",
            private_note: privateNote,
          };
        })
      );

      // Sort descending by created_at in memory
      rows.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Best-effort factory names from the *government* database (sev01)
      const factoryNames = new Map<
        string,
        { name?: string; province?: string; district?: string }
      >();
      const factoryIds = Array.from(new Set(rows.map((r) => r.factory_id).filter(Boolean)));

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
      console.error("Error fetching user reports from Firestore:", err);
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
      if (!user || !isFirebaseConfigured) return false;
      try {
        await setDoc(
          doc(db, "reports", reportId, "sensitive", "details"),
          {
            private_note: privateNote,
            user_id: user.id,
            updated_at: serverTimestamp(),
          },
          { merge: true }
        );

        setReports((prev) =>
          prev.map((r) => (r.id === reportId ? { ...r, private_note: privateNote } : r))
        );
        return true;
      } catch (err) {
        console.error("Error updating note in Firestore:", err);
        return false;
      }
    },
    [user]
  );

  const deleteReport = useCallback(
    async (reportId: string) => {
      if (!user || !isFirebaseConfigured) return false;
      try {
        await deleteDoc(doc(db, "reports", reportId));
        // Subcollection is orphaned or can be deleted
        setReports((prev) => prev.filter((r) => r.id !== reportId));
        return true;
      } catch (err) {
        console.error("Error deleting report in Firestore:", err);
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
