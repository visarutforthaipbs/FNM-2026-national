// Shareholder nationality, as DBD actually publishes it.
//
// Two different endpoints answer this, and they answer differently:
//
//   /partners  names individual shareholders, but only for partnerships — over
//              the whole collection it covered 0 of 44,879 บริษัทจำกัด. It
//              gives no usable stake size: share_percent is empty for every row
//              in the dataset.
//   /nations   gives the aggregate split — how many holders carry each
//              nationality and what share they hold between them — and it
//              answers for limited companies too, with real percentages.
//
// So a real percentage is available whenever /nations has been collected, and
// only a headcount otherwise. Those are different claims and the UI has to say
// which one it is showing: a company whose shareholders are 3 Thai and 1
// Chinese may well be 20% foreign-owned, not 25%, and foreign ownership is
// exactly the number where an approximation invented by the renderer does
// damage. `basis` carries that distinction out of this module.
//
// Absence is not evidence of Thai ownership: a limited company with no
// /nations row simply has not been collected yet, and callers must render that
// as "not disclosed" rather than omitting the section.

import type { DbdNationality, DbdOwner } from "../types/dbd";

const THAI_CODE = "TH";

const NATIONALITY_LABELS: Record<string, string> = {
  TH: "ไทย",
  CN: "จีน",
  JP: "ญี่ปุ่น",
  TW: "ไต้หวัน",
  HK: "ฮ่องกง",
  KR: "เกาหลีใต้",
  SG: "สิงคโปร์",
  MY: "มาเลเซีย",
  ID: "อินโดนีเซีย",
  PH: "ฟิลิปปินส์",
  VN: "เวียดนาม",
  LA: "ลาว",
  KH: "กัมพูชา",
  MM: "เมียนมา",
  IN: "อินเดีย",
  US: "สหรัฐอเมริกา",
  GB: "สหราชอาณาจักร",
  DE: "เยอรมนี",
  FR: "ฝรั่งเศส",
  NL: "เนเธอร์แลนด์",
  CH: "สวิตเซอร์แลนด์",
  IT: "อิตาลี",
  ES: "สเปน",
  SE: "สวีเดน",
  DK: "เดนมาร์ก",
  NO: "นอร์เวย์",
  BE: "เบลเยียม",
  AT: "ออสเตรีย",
  RU: "รัสเซีย",
  AU: "ออสเตรเลีย",
  NZ: "นิวซีแลนด์",
  CA: "แคนาดา",
  AE: "สหรัฐอาหรับเอมิเรตส์",
  IL: "อิสราเอล",
  TR: "ตุรกี",
  BR: "บราซิล",
  ZA: "แอฟริกาใต้",
  OT: "อื่น ๆ",
};

export interface NationalityShare {
  /** ISO alpha-2 code, or null for holders DBD left blank. */
  code: string | null;
  label: string;
  /** Share of the company, when DBD stated one. */
  percent: number | null;
  /** How many shareholders carry this nationality, when known. */
  holders: number | null;
  /** Width to render, 0–100. Derived from percent, or from headcount. */
  weight: number;
  isThai: boolean;
  isUnknown: boolean;
}

export interface NationalitySummary {
  shares: NationalityShare[];
  /**
   * What the numbers mean — the UI must label them accordingly.
   *   "share"   real shareholding percentages from /nations
   *   "holders" a count of named shareholders; no shareholding is known
   *   "none"    nothing published
   */
  basis: "share" | "holders" | "none";
  totalHolders: number;
  /** Combined non-Thai shareholding, only when basis is "share". */
  foreignPercent: number | null;
  hasForeign: boolean;
  isUndisclosed: boolean;
}

/** Thai label for a nationality code; unknown codes fall back to the code. */
export function nationalityLabel(code: string | null | undefined): string {
  const key = (code ?? "").trim().toUpperCase();
  if (!key) return "ไม่ระบุสัญชาติ";
  return NATIONALITY_LABELS[key] ?? key;
}

export function isThaiNationality(code: string | null | undefined): boolean {
  return (code ?? "").trim().toUpperCase() === THAI_CODE;
}

function sortShares(shares: NationalityShare[]): NationalityShare[] {
  return [...shares].sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1;
    if (a.isThai !== b.isThai) return a.isThai ? -1 : 1;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.label.localeCompare(b.label, "th");
  });
}

const EMPTY: NationalitySummary = {
  shares: [],
  basis: "none",
  totalHolders: 0,
  foreignPercent: null,
  hasForeign: false,
  isUndisclosed: true,
};

/**
 * Summarise nationality, preferring DBD's own aggregate over a headcount.
 *
 * @param nationalities aggregate split from /nations (authoritative when present)
 * @param owners named shareholders from /partners, used only as a fallback
 */
export function summarizeNationalities(
  nationalities: DbdNationality[],
  owners: DbdOwner[] = []
): NationalitySummary {
  if (nationalities.length) {
    const total = nationalities.reduce((sum, n) => sum + (n.percent ?? 0), 0);
    const shares: NationalityShare[] = nationalities.map((n) => {
      const code = n.code.trim().toUpperCase();
      return {
        code,
        label: nationalityLabel(code),
        percent: n.percent,
        holders: n.holders,
        // Normalising keeps the bar full when DBD's percentages do not quite
        // total 100, which happens with rounding on small stakes.
        weight: total > 0 ? ((n.percent ?? 0) / total) * 100 : 0,
        isThai: code === THAI_CODE,
        isUnknown: false,
      };
    });
    const foreign = shares.filter((s) => !s.isThai);
    const foreignPercent = foreign.reduce((sum, s) => sum + (s.percent ?? 0), 0);
    return {
      shares: sortShares(shares),
      basis: "share",
      totalHolders: nationalities.reduce((sum, n) => sum + (n.holders ?? 0), 0),
      foreignPercent: foreign.length ? foreignPercent : 0,
      hasForeign: foreign.length > 0,
      isUndisclosed: false,
    };
  }

  if (!owners.length) return EMPTY;

  // Fallback: count named shareholders. No shareholding is known here, so no
  // percentage is reported — only how many holders there are.
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const owner of owners) {
    const code = (owner.nationality ?? "").trim().toUpperCase();
    if (!code) unknown += 1;
    else counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  const totalHolders = owners.length;
  const shares: NationalityShare[] = [...counts.entries()].map(([code, holders]) => ({
    code,
    label: nationalityLabel(code),
    percent: null,
    holders,
    weight: (holders / totalHolders) * 100,
    isThai: code === THAI_CODE,
    isUnknown: false,
  }));
  if (unknown) {
    shares.push({
      code: null,
      label: nationalityLabel(null),
      percent: null,
      holders: unknown,
      weight: (unknown / totalHolders) * 100,
      isThai: false,
      isUnknown: true,
    });
  }

  return {
    shares: sortShares(shares),
    basis: "holders",
    totalHolders,
    foreignPercent: null,
    hasForeign: shares.some((s) => !s.isThai && !s.isUnknown),
    isUndisclosed: false,
  };
}
