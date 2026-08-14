import { useEffect, useState } from "react";
import type { ImpactType, ReportCountSummary, ReportInput } from "../types/report";
import { supabaseCitizen } from "../utils/supabaseClient";

/**
 * Submit a citizen impact report. Inserts a pending row; it becomes publicly
 * visible only after moderation. Throws with a Thai message on failure.
 */
export async function submitReport(input: ReportInput): Promise<void> {
  const { data: sessionData } = await supabaseCitizen.auth.getSession();
  const userId = sessionData?.session?.user?.id || input.user_id;

  const payload: Record<string, unknown> = {
    factory_id: input.factory_id,
    impact_types: input.impact_types,
    frequency: input.frequency,
    distance_band: input.distance_band,
    description: input.description,
    incident_date: input.incident_date,
    reporter_contact: input.reporter_contact,
    source: "web",
  };

  if (userId) {
    payload.user_id = userId;
  }
  if (input.private_note) {
    payload.private_note = input.private_note;
  }

  const { error } = await supabaseCitizen.from("reports").insert(payload);

  if (error) {
    if (error.message?.includes("rate_limited")) {
      throw new Error("ส่งรายงานได้สูงสุด 5 ครั้งต่อชั่วโมง กรุณาลองใหม่ภายหลัง");
    }
    throw new Error("ส่งรายงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

/**
 * Submit a citizen location correction (Tier 4 crowdsourced geocoding).
 * Goes into a pending queue; an admin approves it into factories.
 */
export async function submitLocationCorrection(input: {
  factory_id: string;
  factory_name?: string;
  lat: number;
  lng: number;
  note?: string;
}): Promise<void> {
  const { error } = await supabaseCitizen.from("location_corrections").insert({
    ...input,
    source: "web",
  });

  if (error) {
    if (error.message?.includes("rate_limited")) {
      throw new Error("ส่งการแก้ไขได้สูงสุด 5 ครั้งต่อชั่วโมง กรุณาลองใหม่ภายหลัง");
    }
    throw new Error("ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

// ── Approved-report counts (public aggregate view) ──
// Fetched once per session and shared by every card/badge via a module cache.
// Only approved reports are counted, so a fresh submission doesn't change it.

let countsPromise: Promise<Map<string, ReportCountSummary>> | null = null;

async function loadReportCounts(): Promise<Map<string, ReportCountSummary>> {
  const counts = new Map<string, ReportCountSummary>();

  const { data, error } = await supabaseCitizen
    .from("report_counts")
    .select("factory_id, impact_type, count");

  if (error) {
    console.error("Failed to load report counts:", error.message);
    return counts;
  }

  for (const row of (data || []) as { factory_id: string; impact_type: ImpactType; count: number }[]) {
    const entry = counts.get(row.factory_id) ?? { total: 0, byType: {} };
    entry.total += row.count;
    entry.byType[row.impact_type] = (entry.byType[row.impact_type] ?? 0) + row.count;
    counts.set(row.factory_id, entry);
  }
  return counts;
}

export function useReportCounts(): {
  counts: Map<string, ReportCountSummary>;
  isLoading: boolean;
} {
  const [counts, setCounts] = useState<Map<string, ReportCountSummary>>(
    new Map()
  );
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!countsPromise) {
      countsPromise = loadReportCounts();
    }
    let cancelled = false;
    countsPromise
      .then((c) => {
        if (!cancelled) {
          setCounts(c);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load report counts:", err);
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { counts, isLoading };
}
