// Hazard classification based on the DIW factory-type code (ลำดับที่ 1–107,
// บัญชีท้ายกฎกระทรวง พ.ร.บ.โรงงาน) embedded in every registration number.
//
// Registration formats: "จ3-52(3)-54/58ยล", "3-10(1)-9/22", "ส3-101-1/45รย"
// → segment after the first dash is the factory-type code (ลำดับที่).
//
// The old red/green split by จำพวก (1/2/3) said little — ~90% of factories
// are จำพวก 3. This classifies by what the factory actually does.

export type HazardLevel = "hazard" | "type3" | "general";

// DIW type codes with elevated community/environmental impact
// (chemicals, petroleum, metal smelting, power/gas, waste handling)
export const HAZARD_GROUPS: Record<number, string> = {
  42: "เคมีภัณฑ์ สารเคมี",
  43: "ปุ๋ย/สารป้องกันศัตรูพืช",
  45: "สี แล็กเกอร์ ทินเนอร์",
  48: "ผลิตภัณฑ์เคมี",
  49: "กลั่นน้ำมันปิโตรเลียม",
  50: "ผลิตภัณฑ์ปิโตรเลียม/ถ่านหิน",
  59: "ถลุง/หลอมเหล็ก",
  60: "ถลุง/หลอมโลหะ",
  88: "โรงไฟฟ้า",
  89: "ผลิต/จำหน่ายก๊าซ",
  99: "ผลิต/ซ่อมแซมอาวุธ",
  101: "บำบัดของเสียรวม",
  105: "คัดแยก/ฝังกลบของเสีย",
  106: "รีไซเคิลของเสีย",
};

/** Extract the DIW factory-type code (ลำดับที่) from a registration number. */
export function parseFactoryTypeCode(regId: string): number | null {
  if (!regId) return null;
  const segments = regId.split("-");
  if (segments.length < 2) return null;
  // Standard DIW format: code is the second segment, e.g. "จ3-52(3)-54/58ยล"
  let match = segments[1].match(/^(\d{1,3})(?:\(\d+\))?$/);
  // Industrial-estate (กนอ.) format: code is in the first segment, e.g. "น.10(1)-1/2548-ญนช."
  if (!match) match = segments[0].match(/^[^\d]*(\d{1,3})(?:\(\d+\))?$/);
  if (!match) return null;
  const code = parseInt(match[1], 10);
  return code >= 1 && code <= 107 ? code : null;
}

/** Thai label for the hazardous-industry group, or null if not hazardous. */
export function getHazardGroup(regId: string): string | null {
  const code = parseFactoryTypeCode(regId);
  return code !== null ? HAZARD_GROUPS[code] ?? null : null;
}

/**
 * Three-tier hazard level:
 *  - "hazard"  — hazardous industry (chemicals/petroleum/metals/power/waste)
 *  - "type3"   — จำพวก 3 (licensed) but not a hazardous industry
 *  - "general" — จำพวก 1–2 or unknown
 */
export function getHazardLevel(regId: string, factoryType: string): HazardLevel {
  if (getHazardGroup(regId) !== null) return "hazard";
  if (factoryType === "3") return "type3";
  return "general";
}

export const HAZARD_COLORS: Record<HazardLevel, string> = {
  hazard: "#EF4444", // red — hazardous industry
  type3: "#F59E0B", // amber — licensed (จำพวก 3), non-hazardous industry
  general: "#10B981", // green — จำพวก 1–2 / small operations
};

export const HAZARD_LABELS: Record<HazardLevel, string> = {
  hazard: "อุตสาหกรรมเสี่ยงสูง",
  type3: "จำพวก 3 ทั่วไป",
  general: "จำพวก 1–2",
};
