import { useEffect, useState } from "react";
import type { ImpactType, ReportCountSummary, ReportInput } from "../types/report";
import {
  collection,
  addDoc,
  setDoc,
  doc,
  getDocs,
  query,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db, isFirebaseConfigured } from "../utils/firebaseClient";

const LAST_REPORT_KEY = "fnm_last_report_ts";
const COOLDOWN_MS = 20000; // 20-second client cooldown against rapid spam

/**
 * Submit a citizen impact report to Cloud Firestore.
 *
 * PRIVACY GUARANTEE (HANDOFF §8):
 * Sensitive fields (reporter_contact, private_note) are stored in an isolated
 * private subcollection (`reports/{id}/sensitive/details`) rather than the
 * public document. The public document contains ONLY anonymized impact data.
 * Even after moderation approval, the public can never read reporter contacts.
 */
export async function submitReport(input: ReportInput): Promise<void> {
  if (!isFirebaseConfigured) {
    throw new Error("ระบบฐานข้อมูลยังไม่พร้อมใช้งาน กรุณาระบุ Firebase Config ใน client/.env.local");
  }

  // Rate limiting check
  const now = Date.now();
  const lastTs = Number(localStorage.getItem(LAST_REPORT_KEY) || 0);
  if (now - lastTs < COOLDOWN_MS) {
    throw new Error("กรุณารอประมาณ 20 วินาทีก่อนส่งรายงานถัดไป เพื่อป้องกันข้อมูลซ้ำซ้อน");
  }

  const userId = auth.currentUser?.uid || input.user_id || null;

  // 1. Public document — deliberately omits reporter_contact and private_note
  const publicPayload: Record<string, unknown> = {
    factory_id: input.factory_id,
    impact_types: input.impact_types,
    frequency: input.frequency || null,
    distance_band: input.distance_band || null,
    description: input.description || null,
    incident_date: input.incident_date || null,
    user_id: userId,
    status: "pending",
    source: "web",
    created_at: serverTimestamp(),
  };

  try {
    const reportRef = await addDoc(collection(db, "reports"), publicPayload);

    // 2. Sensitive data — written to isolated subcollection
    if (input.reporter_contact || input.private_note) {
      await setDoc(doc(db, "reports", reportRef.id, "sensitive", "details"), {
        reporter_contact: input.reporter_contact || null,
        private_note: input.private_note || null,
        user_id: userId,
        created_at: serverTimestamp(),
      });
    }

    localStorage.setItem(LAST_REPORT_KEY, String(Date.now()));
  } catch (err) {
    console.error("Failed to submit report to Firestore:", err);
    throw new Error("ส่งรายงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

/**
 * Submit a citizen location correction to Cloud Firestore (Tier 4 crowdsourced geocoding).
 * Goes into a pending queue; an admin approves it into factories.
 */
export async function submitLocationCorrection(input: {
  factory_id: string;
  factory_name?: string;
  lat: number;
  lng: number;
  note?: string;
}): Promise<void> {
  if (!isFirebaseConfigured) {
    throw new Error("ระบบฐานข้อมูลยังไม่พร้อมใช้งาน กรุณาระบุ Firebase Config ใน client/.env.local");
  }

  const now = Date.now();
  const lastTs = Number(localStorage.getItem(LAST_REPORT_KEY) || 0);
  if (now - lastTs < COOLDOWN_MS) {
    throw new Error("กรุณารอประมาณ 20 วินาทีก่อนส่งข้อมูลถัดไป");
  }

  try {
    await addDoc(collection(db, "location_corrections"), {
      factory_id: input.factory_id,
      factory_name: input.factory_name || null,
      lat: input.lat,
      lng: input.lng,
      note: input.note || null,
      user_id: auth.currentUser?.uid || null,
      status: "pending",
      source: "web",
      created_at: serverTimestamp(),
    });

    localStorage.setItem(LAST_REPORT_KEY, String(Date.now()));
  } catch (err) {
    console.error("Failed to submit location correction to Firestore:", err);
    throw new Error("ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
  }
}

// ── Approved-report counts (public aggregate view) ──
// Fetched once per session and shared by every card/badge via a module cache.
// Only approved reports are counted.

let countsPromise: Promise<Map<string, ReportCountSummary>> | null = null;

async function loadReportCounts(): Promise<Map<string, ReportCountSummary>> {
  const counts = new Map<string, ReportCountSummary>();

  if (!isFirebaseConfigured) {
    return counts;
  }

  try {
    const q = query(
      collection(db, "reports"),
      where("status", "==", "approved")
    );
    const snap = await getDocs(q);

    snap.forEach((doc) => {
      const data = doc.data();
      const factoryId = data.factory_id;
      if (!factoryId) return;

      const entry = counts.get(factoryId) ?? { total: 0, byType: {} };
      entry.total += 1;

      const types: ImpactType[] = Array.isArray(data.impact_types)
        ? data.impact_types
        : [];
      types.forEach((t) => {
        entry.byType[t] = (entry.byType[t] ?? 0) + 1;
      });

      counts.set(factoryId, entry);
    });
  } catch (err) {
    console.warn("Could not load report counts from Firestore:", err);
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
