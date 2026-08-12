// Describing a factory's town-planning zone — and only describing it.
//
// What this file used to do
// -------------------------
// It decided, in the browser, whether a named business was operating lawfully:
// seven hand-drawn latitude/longitude rectangles stood in for the industrial
// zones, a registration year before 2550 became "สิทธิการประกอบกิจการเดิมได้รับ
// การคุ้มครอง", and a regular expression over the factory's name produced
// "เสี่ยงขัดผังเมือง" — a public allegation about an identifiable company,
// rendered in red under a heading that read "หลักเกณฑ์ทางกฎหมาย". None of it
// consulted the 42,219 DPT polygons the project had already downloaded, and
// four of the seven rectangles sat in provinces DPT publishes no plan for.
//
// What it does now
// ----------------
// Nothing but label the zone that a point-in-polygon test actually found
// (server/sync/export_zoning.py). Whether a particular factory may lawfully
// operate in that zone depends on its จำพวก, its machinery, the annex schedules
// of the specific ministerial regulation, and whether it predates the plan —
// several of which we do not hold, and none of which a map should be
// adjudicating. So the UI shows the zone, says who published it, and leaves
// the conclusion to the reader.

export interface ZoneDisplay {
  /** DPT's label for the land-use family. */
  title: string;
  /** Colour DPT uses for this family on its own maps. */
  color: string;
  /** Chakra colour scheme for the surrounding card. */
  scheme: string;
  /** One neutral sentence about what the zone designation means. */
  meaning: string;
}

const FAMILY: Record<string, ZoneDisplay> = {
  industrial: {
    title: "ผังเมืองสีม่วง — อุตสาหกรรมและคลังสินค้า",
    color: "#7C3AED",
    scheme: "purple",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้ใช้ประโยชน์เพื่ออุตสาหกรรมและคลังสินค้า",
  },
  warehouse: {
    title: "ผังเมืองสีเม็ดมะปราง — คลังสินค้า",
    color: "#A78BFA",
    scheme: "purple",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้ใช้ประโยชน์เพื่อคลังสินค้าและอุตสาหกรรมเฉพาะประเภท",
  },
  residential: {
    title: "ผังเมืองสีเหลือง/ส้ม — ที่อยู่อาศัย",
    color: "#FACC15",
    scheme: "yellow",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้ใช้ประโยชน์เพื่อการอยู่อาศัยเป็นหลัก",
  },
  commercial: {
    title: "ผังเมืองสีแดง — พาณิชยกรรม",
    color: "#EF4444",
    scheme: "red",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้ใช้ประโยชน์เพื่อพาณิชยกรรมและที่อยู่อาศัยหนาแน่นมาก",
  },
  rural_agricultural: {
    title: "ผังเมืองสีเขียว — ชนบทและเกษตรกรรม",
    color: "#22C55E",
    scheme: "green",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้ใช้ประโยชน์เพื่อเกษตรกรรมและชนบท",
  },
  open_space: {
    title: "ผังเมืองสีเขียวอ่อน — ที่โล่ง",
    color: "#86EFAC",
    scheme: "green",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้เป็นที่โล่งเพื่อนันทนาการและรักษาคุณภาพสิ่งแวดล้อม",
  },
  government: {
    title: "ผังเมืองสีน้ำเงิน — สถาบันราชการ",
    color: "#3B82F6",
    scheme: "blue",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้เป็นสถาบันราชการ สาธารณูปโภคและสาธารณูปการ",
  },
  education: {
    title: "ผังเมืองสีเทาอ่อน — สถาบันการศึกษา",
    color: "#94A3B8",
    scheme: "gray",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้เป็นสถาบันการศึกษา",
  },
  religious: {
    title: "ผังเมืองสีเทา — สถาบันศาสนา",
    color: "#A8A29E",
    scheme: "gray",
    meaning: "พื้นที่ที่ผังเมืองกำหนดให้เป็นสถาบันศาสนา",
  },
  other: {
    title: "ผังเมือง — ประเภทอื่น",
    color: "#CBD5E1",
    scheme: "gray",
    meaning: "พื้นที่ในผังเมืองรวมที่จัดอยู่ในประเภทอื่น",
  },
};

export function zoneDisplay(kind: string, label?: string, color?: string): ZoneDisplay {
  const known = FAMILY[kind];
  if (known) return known;
  // A code family we have no wording for: use DPT's own label rather than
  // inventing one, and stay visually neutral.
  return {
    title: label ? `ผังเมือง — ${label}` : "ผังเมืองรวม",
    color: color || "#CBD5E1",
    scheme: "gray",
    meaning: "พื้นที่ในผังเมืองรวมตามที่กรมโยธาธิการและผังเมืองประกาศ",
  };
}

/**
 * Why a factory has no zone.
 *
 * These provinces have no factory falling inside any DPT polygon we hold —
 * measured, not assumed (see zoning_summary.json). For them the honest reading
 * is that the area is planned under another instrument, not that the factory
 * sits outside every plan. Elsewhere a missing zone means only that this
 * particular point is not covered.
 */
export const PROVINCES_WITHOUT_DPT_PLAN = new Set([
  "ชลบุรี",
  "นครนายก",
  "นครพนม",
  "บึงกาฬ",
  "บุรีรัมย์",
  "พัทลุง",
  "ยโสธร",
  "ระยอง",
  "สุรินทร์",
]);

/**
 * Why a factory has no zone — stated as a limit of our data, not of the law.
 *
 * The dataset is 203 ผังเมืองรวมเมือง/ชุมชน (town and community plans) and no
 * province-wide plan at all. Those cover built-up areas, so a factory outside
 * one may genuinely sit outside any town plan — or may sit inside a
 * ผังเมืองรวมจังหวัด that this dataset does not contain. We cannot tell which
 * from here, so the wording must not imply the factory is unplanned.
 */
export function noZoneReason(provinceTh: string | undefined): string {
  const base =
    "ชุดข้อมูลนี้มีเฉพาะผังเมืองรวมเมือง/ชุมชน 203 ผัง ซึ่งครอบคลุมเฉพาะบางพื้นที่ " +
    "จึงไม่ทราบว่าจุดนี้อยู่นอกผังเมือง หรืออยู่ในผังที่ยังไม่มีในชุดข้อมูล";
  if (provinceTh && PROVINCES_WITHOUT_DPT_PLAN.has(provinceTh)) {
    return `ยังไม่มีแปลงผังเมืองของ DPT ในพื้นที่${provinceTh}ในชุดข้อมูลนี้ — ${base}`;
  }
  return `ไม่พบแปลงผังเมืองของ DPT ครอบคลุมจุดนี้ — ${base}`;
}
