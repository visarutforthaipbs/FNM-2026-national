// Citizen impact report types (รายงานผลกระทบจากโรงงาน)

export type ImpactType = "smell" | "noise" | "water" | "dust" | "vibration" | "other";
export type ReportFrequency = "once" | "sometimes" | "daily";
export type DistanceBand = "near" | "mid" | "far";

export interface ReportInput {
  factory_id: string;
  impact_types: ImpactType[];
  frequency?: ReportFrequency;
  distance_band?: DistanceBand;
  description?: string;
  incident_date?: string; // YYYY-MM-DD
  reporter_contact?: string; // stored privately, never displayed
}

export interface ReportCountSummary {
  total: number;
  byType: Partial<Record<ImpactType, number>>;
}

export const IMPACT_TYPE_META: Record<ImpactType, { label: string; emoji: string }> = {
  smell: { label: "กลิ่นเหม็น", emoji: "👃" },
  noise: { label: "เสียงดัง", emoji: "🔊" },
  water: { label: "น้ำเสีย", emoji: "💧" },
  dust: { label: "ฝุ่น / ควัน", emoji: "🌫️" },
  vibration: { label: "แรงสั่นสะเทือน", emoji: "📳" },
  other: { label: "อื่นๆ", emoji: "⚠️" },
};

export const FREQUENCY_META: Record<ReportFrequency, string> = {
  once: "ครั้งเดียว",
  sometimes: "เป็นบางครั้ง",
  daily: "แทบทุกวัน",
};

export const DISTANCE_META: Record<DistanceBand, string> = {
  near: "ไม่เกิน 500 ม.",
  mid: "500 ม. – 2 กม.",
  far: "ไกลกว่า 2 กม.",
};

// Shown wherever report data appears — citizen testimony, not verified fact
export const REPORT_DISCLAIMER =
  "ข้อมูลจากการรายงานของประชาชน ยังไม่ผ่านการตรวจสอบข้อเท็จจริงโดยหน่วยงานราชการ";
