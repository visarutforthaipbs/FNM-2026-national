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
    color: "#4D004D",
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
 * Why a factory has no zone — stated as a limit of our data, not of the law.
 *
 * This used to carry a hardcoded list of nine provinces "DPT publishes no plan
 * for" — ชลบุรี, ระยอง, นครนายก, นครพนม, บึงกาฬ, บุรีรัมย์, พัทลุง, ยโสธร,
 * สุรินทร์ — and told their 8,366 factories that no plan covered them. That was
 * never a fact about DPT. It was a fact about the one layer we had harvested:
 * every one of those nine has a ผังเมืองรวมจังหวัด, and once the provincial
 * tier was loaded `provinces_without_dpt_coverage` in zoning_summary.json came
 * back empty for all 77. The list is gone rather than corrected, because the
 * question it answered is now answered by the data.
 *
 * What remains is genuinely narrower. We now test two tiers — municipal
 * ผังเมืองรวมเมือง/ชุมชน, which carry a land use, and provincial
 * ผังเมืองรวมจังหวัด footprints, which carry only an extent — so reaching this
 * message means neither contained the point. That dropped from 48,170
 * factories (76.9%) to 8,515 (13.6%). It still must not be read as "unplanned":
 * a plan may exist that DPT does not publish as a polygon, or does not publish
 * to us at all.
 */
export function noZoneReason(provinceTh: string | undefined): string {
  const where = provinceTh ? `ในพื้นที่${provinceTh}` : "ที่จุดนี้";
  return (
    `ไม่พบทั้งแปลงผังเมืองรวมเมือง/ชุมชน และขอบเขตผังเมืองรวมจังหวัดของ DPT ครอบคลุมจุดนี้ — ` +
    `อาจอยู่นอกเขตผังเมืองที่ประกาศไว้ หรืออยู่ในผังที่ DPT ยังไม่ได้เผยแพร่เป็นข้อมูลเชิงพื้นที่${where}`
  );
}
