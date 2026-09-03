/**
 * Thailand Standard Industrial Classification (TSIC) 2009 utilities.
 * Maps 2-digit TSIC divisions and common 5-digit industrial/trade codes to Thai descriptions.
 * Compares DIW factory operating licence activities against DBD registered corporate objectives.
 */

export const TSIC_DIVISIONS: Record<string, string> = {
  "01": "การเพาะปลูกและการเลี้ยงสัตว์",
  "02": "การป่าไม้และการทำไม้",
  "03": "การประมงและการเพาะเลี้ยงสัตว์น้ำ",
  "08": "การทำเหมืองแร่และเหมืองหิน",
  "10": "การผลิตผลิตภัณฑ์อาหาร",
  "11": "การผลิตเครื่องดื่ม",
  "13": "การผลิตสิ่งทอ",
  "14": "การผลิตเสื้อผ้าเครื่องแต่งกาย",
  "15": "การผลิตเครื่องหนังและผลิตภัณฑ์ที่เกี่ยวข้อง",
  "16": "การแปรรูปไม้และผลิตภัณฑ์จากไม้",
  "17": "การผลิตกระดาษและผลิตภัณฑ์กระดาษ",
  "18": "การพิมพ์และการทำสำเนาสื่อบันทึก",
  "19": "การผลิตผลิตภัณฑ์จากการกลั่นปิโตรเลียม",
  "20": "การผลิตสารเคมีและผลิตภัณฑ์เคมี",
  "21": "การผลิตเภสัชภัณฑ์และเคมีภัณฑ์ทางยา",
  "22": "การผลิตผลิตภัณฑ์ยางและพลาสติก",
  "23": "การผลิตผลิตภัณฑ์จากแร่อโลหะ (ซีเมนต์/แก้ว/คอนกรีต)",
  "24": "การผลิตโลหะขั้นมูลฐาน (หลอม/รีดโลหะ)",
  "25": "การผลิตผลิตภัณฑ์โลหะประดิษฐ์",
  "26": "การผลิตคอมพิวเตอร์และผลิตภัณฑ์อิเล็กทรอนิกส์",
  "27": "การผลิตอุปกรณ์ไฟฟ้า",
  "28": "การผลิตเครื่องจักรและเครื่องมือ",
  "29": "การผลิตยานยนต์ รถพ่วง และรถกึ่งพ่วง",
  "30": "การผลิตอุปกรณ์การขนส่งอื่นๆ",
  "31": "การผลิตเฟอร์นิเจอร์",
  "32": "การผลิตผลิตภัณฑ์อื่นๆ",
  "33": "การซ่อมและการติดตั้งเครื่องจักรและอุปกรณ์",
  "35": "การผลิตและการจ่ายไฟฟ้า ก๊าซ ไอน้ำ",
  "36": "การผลิตและการจ่ายน้ำ ประปา",
  "37": "การจัดการน้ำเสีย",
  "38": "การเก็บรวบรวม บำบัด กำจัดของเสีย และการรีไซเคิล",
  "39": "การบำบัดฟื้นฟูสิ่งแวดล้อม",
  "41": "การก่อสร้างอาคาร",
  "42": "วิศวกรรมโยธา",
  "43": "การก่อสร้างเฉพาะด้าน",
  "45": "การขายส่ง/ปลีก และซ่อมยานยนต์",
  "46": "การขายส่ง (ยกเว้นยานยนต์)",
  "47": "การขายปลีก (ยกเว้นยานยนต์)",
  "49": "การขนส่งทางบกและท่อลำเลียง",
  "52": "คลังสินค้าและกิจกรรมสนับสนุนการขนส่ง",
  "68": "กิจกรรมอสังหาริมทรัพย์",
  "70": "สำนักงานใหญ่และการให้คำปรึกษาด้านการจัดการ",
  "71": "สถาปัตยกรรมและวิศวกรรม",
  "77": "การให้เช่า",
  "82": "กิจกรรมสนับสนุนการดำเนินงานสำนักงาน"
};

export const COMMON_TSIC_CODES: Record<string, string> = {
  // Waste & Recycling
  "38110": "การเก็บรวบรวมของเสียที่ไม่เป็นอันตราย",
  "38120": "การเก็บรวบรวมของเสียอันตราย",
  "38211": "การบำบัดและกำจัดของเสียที่ไม่เป็นอันตรายโดยการฝังกลบ",
  "38212": "การกำจัดของเสียที่ไม่เป็นอันตรายโดยการเผา",
  "38213": "การบำบัดและกำจัดของเสีย",
  "38221": "การกำจัดกากของเสียอุตสาหกรรมแบบครบวงจร",
  "38222": "การบำบัดและกำจัดของเสียอันตราย",
  "38300": "การนำวัสดุที่ใช้แล้วกลับมาใช้ใหม่ (รีไซเคิล)",
  "46692": "การขายส่งเศษวัสดุและของเก่า",

  // Chemicals & Plastics
  "20111": "การผลิตสารเคมีขั้นมูลฐาน",
  "20121": "การผลิตปุ๋ยเคมี",
  "20122": "การผลิตสารประกอบไนโตรเจน",
  "20221": "การผลิตสี ทานิช และสารเคลือบ",
  "20231": "การผลิตสบู่และสารซักฟอก",
  "22210": "การผลิตผลิตภัณฑ์พลาสติกกึ่งสำเร็จรูปและสำเร็จรูป",
  "22199": "การผลิตผลิตภัณฑ์ยางอื่นๆ",

  // Metal & Machinery
  "24101": "การผลิตเหล็กและเหล็กกล้าขั้นมูลฐาน",
  "24310": "การหล่อเหล็กและเหล็กกล้า",
  "24320": "การหล่อโลหะที่ไม่ใช่เหล็ก",
  "25922": "การกลึง เจาะ เชื่อม ไส โลหะทั่วไป",
  "28199": "การผลิตเครื่องจักรสำหรับใช้งานทั่วไป",
  "33121": "การซ่อมและบำรุงรักษาเครื่องจักร",

  // Automotive & Transport
  "29101": "การผลิตยานยนต์เพื่อการพาณิชย์",
  "29309": "การผลิตชิ้นส่วนและอุปกรณ์เสริมสำหรับยานยนต์",
  "45201": "การบำรุงรักษาและการซ่อมระบบเครื่องยนต์",
  "45301": "การขายส่งชิ้นส่วนและอุปกรณ์เสริมยานยนต์",

  // Common non-manufacturing flags (trading / real estate / shell)
  "46109": "ตัวแทนและนายหน้าค้าสินค้าทั่วไป",
  "46900": "การขายส่งสินค้าทั่วไป",
  "47190": "การขายปลีกสินค้าทั่วไป",
  "68101": "การซื้อและการขายอสังหาริมทรัพย์เพื่อการพักอาศัย",
  "68102": "การซื้อและการขายอสังหาริมทรัพย์ที่ไม่ใช่เพื่อการพักอาศัย",
  "68201": "การให้เช่าอสังหาริมทรัพย์",
  "70209": "การให้คำปรึกษาด้านการบริหารจัดการ"
};

/**
 * Returns a human-friendly Thai description for a TSIC code.
 */
export function getTsicDescription(code?: string | null): string | null {
  if (!code) return null;
  const clean = code.trim();
  if (COMMON_TSIC_CODES[clean]) return COMMON_TSIC_CODES[clean];
  const div = clean.substring(0, 2);
  if (TSIC_DIVISIONS[div]) return `หมวด ${clean}: ${TSIC_DIVISIONS[div]}`;
  return `รหัส TSIC ${clean}`;
}

export type ObjectiveMatchResult = {
  status: "match" | "discrepancy" | "neutral" | "unverified";
  label: string;
  colorScheme: string;
  reason?: string;
};

/**
 * Compares DIW factory operating licence activities against DBD registered business objectives.
 */
export function evaluateObjectiveMatch(
  factoryObjective?: string | null,
  dbdObjective?: string | null,
  tsicCode?: string | null
): ObjectiveMatchResult {
  if (!dbdObjective && !tsicCode) {
    return {
      status: "unverified",
      label: "รอข้อมูลวัตถุประสงค์ DBD",
      colorScheme: "gray",
      reason: "ยังไม่มีข้อมูลวัตถุประสงค์ที่จดทะเบียนไว้ในระบบ DBD",
    };
  }

  const fo = (factoryObjective || "").toLowerCase();
  const dbd = `${dbdObjective || ""} ${getTsicDescription(tsicCode) || ""}`.toLowerCase();

  // Topic keywords groups
  const TOPIC_GROUPS = [
    { name: "บำบัดของเสีย/รีไซเคิล", keywords: ["ขยะ", "ของเสีย", "กาก", "บำบัด", "คัดแยก", "รีไซเคิล", "กำจัด", "สิ่งปฏิกูล"] },
    { name: "เคมี/สี/ปุ๋ย", keywords: ["เคมี", "สารเคมี", "สี", "ปุ๋ย", "ทินเนอร์", "กาว", "ตัวทำละลาย"] },
    { name: "พลาสติก/ยาง", keywords: ["พลาสติก", "ยาง", "โพลิเมอร์", "เรซิน", "หล่อแบบ"] },
    { name: "โลหะ/เครื่องจักร", keywords: ["โลหะ", "เหล็ก", "หลอม", "กลึง", "เชื่อม", "อลูมิเนียม", "ทองแดง", "เครื่องจักร", "แม่พิมพ์"] },
    { name: "ยานยนต์/อะไหล่", keywords: ["รถ", "ยานยนต์", "อะไหล่", "เบรค", "คลัช", "ล้อ", "ท่อไอเสีย"] },
    { name: "อาหาร/เกษตร", keywords: ["อาหาร", "เครื่องดื่ม", "แปรรูป", "เกษตร", "ข้าว", "แป้ง", "ผลไม้", "สัตว์", "ปลา"] },
    { name: "ไม้/เฟอร์นิเจอร์", keywords: ["ไม้", "แปรรูปไม้", "เฟอร์นิเจอร์", "วงกบ", "เตียง", "ตู้"] },
    { name: "สิ่งทอ/เครื่องแต่งกาย", keywords: ["ผ้า", "สิ่งทอ", "เย็บ", "เสื้อผ้า", "เส้นด้าย", "ถัก"] },
    { name: "กระดาษ/พิมพ์", keywords: ["กระดาษ", "สิ่งพิมพ์", "กล่อง", "พิมพ์"] },
    { name: "พลังงาน/ไฟฟ้า", keywords: ["ไฟฟ้า", "พลังงาน", "โซลาร์", "ชีวมวล", "ก๊าซ", "ไอน้ำ"] },
  ];

  // Discrepancy flags (Non-industrial shell/trading entities holding heavy permits)
  const SHELL_OR_SERVICE_KEYWORDS = [
    "อสังหาริมทรัพย์", "ให้เช่า", "ที่ปรึกษา", "นายหน้า", "โรงแรม", "ท่องเที่ยว", "ร้านอาหาร", "บันเทิง", "โฆษณา"
  ];

  // Check if DIW factory is heavy / manufacturing / waste
  const isDiwHeavyOrIndustrial = TOPIC_GROUPS.some(g => g.keywords.some(kw => fo.includes(kw)));
  const isDbdShellOrService = SHELL_OR_SERVICE_KEYWORDS.some(kw => dbd.includes(kw));

  // If DIW is heavy industrial but DBD is solely real estate / services / consulting
  if (isDiwHeavyOrIndustrial && isDbdShellOrService && !TOPIC_GROUPS.some(g => g.keywords.some(kw => dbd.includes(kw)))) {
    return {
      status: "discrepancy",
      label: "ประเภทธุรกิจต่างจากใบอนุญาต",
      colorScheme: "amber",
      reason: "DBD ระบุเป็นธุรกิจบริการ/อสังหาริมทรัพย์ แต่ใบอนุญาตโรงงานเป็นอุตสาหกรรมการผลิตหรือของเสีย",
    };
  }

  // Check keyword topic matches
  for (const group of TOPIC_GROUPS) {
    const diwMatches = group.keywords.some(kw => fo.includes(kw));
    const dbdMatches = group.keywords.some(kw => dbd.includes(kw));
    if (diwMatches && dbdMatches) {
      return {
        status: "match",
        label: "สอดคล้องกับใบอนุญาต",
        colorScheme: "green",
        reason: `ทั้งสองหน่วยงานระบุตรงกันในหมวดหมู่ ${group.name}`,
      };
    }
  }

  // If TSIC code division matches 2-digit ISIC in factory
  if (tsicCode && fo) {
    return {
      status: "neutral",
      label: "หมวดธุรกิจใกล้เคียง",
      colorScheme: "blue",
      reason: "มีข้อมูลประเภทธุรกิจจาก DBD และใบอนุญาตโรงงาน",
    };
  }

  return {
    status: "neutral",
    label: "ตรวจสอบคู่ขนาน",
    colorScheme: "slate",
    reason: "มีข้อมูลวัตถุประสงค์จากทั้งสองฝ่าย แต่อาจใช้คำอธิบายที่แตกต่างกัน",
  };
}
