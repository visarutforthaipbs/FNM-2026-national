// Factory data types for Thai factory information

export type RawFactoryData = {
  FACREG: string;
  FNAME: string;
  OBJECT: string;
  FTUMNAME: string;
  FAMPNAME: string;
  FPROVNAME: string;
  LAT: string;
  LNG: string;
  STATUS: string;
  FACTYPE: string;
  ISIC_CODE: string;
};

export type FactoryProperties = {
  เลขทะเบียน: string;
  ชื่อโรงงาน: string;
  ผู้ประกอบก: string;
  ประกอบกิจก: string;
  ละติจูด: number;
  ลองติจูด: number;
  โทรศัพท์?: string;
  อำเภอ: string;
  จังหวัด?: string;
  ที่อยู่?: string;
  เงินลงทุน?: number;
  แรงม้า?: number;
  คนงานชาย?: number;
  คนงานหญิง?: number;
  ประเภท: string;
  /**
   * Position provenance. Absent = straight from the government feed.
   *  - "geocoded"  from the address, street-level
   *  - "centroid"  tambon centroid, ±2–5 km
   *  - "sibling"   inherited from another licence at the SAME address. Exact,
   *                not approximate: one plant often holds several ทะเบียนโรงงาน
   *                and only one of them carries a coordinate.
   * The first two are approximate and must be visually distinguished (faded
   * marker, "ตำแหน่งโดยประมาณ" label) — never presented as surveyed. "sibling"
   * is a real position, so it is labelled by origin rather than by uncertainty.
   */
  coordQuality?: "geocoded" | "centroid" | "sibling";
};

export type FactoryFeature = {
  type: "Feature";
  properties: FactoryProperties;
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
};

export type FactoryGeoJSON = {
  type: "FeatureCollection";
  features: FactoryFeature[];
};

export type UserLocation = {
  lat: number;
  lng: number;
};

export type FilterState = {
  searchTerm: string;
  factoryTypes: string[];
  districts: string[];
  showOnlyInRadius: boolean;
  showHighRisk: boolean;
  selectedProvince: string; // "" means all provinces
};

// Risk classification now lives in src/utils/hazard.ts — a 3-tier level
// derived from the DIW industry code (ลำดับที่ 1–107) in the registration
// number, since ~90% of factories are จำพวก 3 and that split said little.

// High-risk factory classification criteria (Thai)
export const HIGH_RISK_CRITERIA =
  "เกณฑ์การจัดให้เป็นโรงงานระดับความเสี่ยงสูง คือ อาจก่อผลกระทบอย่างรุนแรงในวงกว้าง และเมื่อมีผลกระทบแล้วยากต่อการฟื้นฟูให้กลับสู่สภาพปกติ";
