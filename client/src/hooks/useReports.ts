import { useEffect, useState } from "react";
import type { ImpactType, ReportCountSummary, ReportInput } from "../types/report";

// ── Supabase REST helpers (same raw-fetch pattern as useFactoriesApi) ──

function supabaseConfig(): { url: string; key: string } | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url, key };
}

/**
 * Submit a citizen impact report. Inserts a pending row; it becomes publicly
 * visible only after moderation. Throws with a Thai message on failure.
 */
export async function submitReport(input: ReportInput): Promise<void> {
  const cfg = supabaseConfig();
  if (!cfg) throw new Error("ระบบรับรายงานยังไม่พร้อมใช้งาน");

  const res = await fetch(`${cfg.url}/rest/v1/reports`, {
    method: "POST",
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...input, source: "web" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (body.includes("rate_limited")) {
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
  const cfg = supabaseConfig();
  if (!cfg) throw new Error("ระบบรับข้อมูลยังไม่พร้อมใช้งาน");

  const res = await fetch(`${cfg.url}/rest/v1/location_corrections`, {
    method: "POST",
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ ...input, source: "web" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (body.includes("rate_limited")) {
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
  const cfg = supabaseConfig();
  if (!cfg) return counts;

  const res = await fetch(
    `${cfg.url}/rest/v1/report_counts?select=factory_id,impact_type,count`,
    { headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rows: { factory_id: string; impact_type: ImpactType; count: number }[] =
    await res.json();
  for (const row of rows) {
    const entry = counts.get(row.factory_id) ?? { total: 0, byType: {} };
    entry.total += row.count;
    entry.byType[row.impact_type] = (entry.byType[row.impact_type] ?? 0) + row.count;
    counts.set(row.factory_id, entry);
  }
  return counts;
}

/** Approved-report counts per factory id. Empty map while loading or if unavailable. */
export function useReportCounts(): Map<string, ReportCountSummary> {
  const [counts, setCounts] = useState<Map<string, ReportCountSummary>>(new Map());

  useEffect(() => {
    let cancelled = false;
    if (!countsPromise) {
      countsPromise = loadReportCounts().catch((err) => {
        console.error("❌ Failed to load report counts:", err);
        countsPromise = null; // allow retry next mount
        return new Map<string, ReportCountSummary>();
      });
    }
    countsPromise.then((m) => {
      if (!cancelled && m.size > 0) setCounts(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return counts;
}
