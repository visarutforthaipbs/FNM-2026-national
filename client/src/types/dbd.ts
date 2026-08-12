export interface DbdDirector {
  name: string;
  role: string;
}

export interface DbdOwner {
  name: string;
  nationality: string | null;
  shareAmount: number | null;
  sharePercent: number | null;
}

export interface DbdFinancialSnapshot {
  year: string;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalRevenue: number | null;
  netProfit: number | null;
}

/**
 * Aggregate shareholder nationality, as DBD's /nations endpoint reports it:
 * how many holders carry a nationality and what share they hold between them.
 * DBD does not name those holders here, so this stays an aggregate — it must
 * never be expanded into individual shareholders.
 */
export interface DbdNationality {
  code: string;
  /** Combined share of the company held by holders of this nationality. */
  percent: number | null;
  /** How many shareholders carry it. */
  holders: number | null;
}

export interface DbdFactoryProfile {
  factoryId: string;
  juristicId: string;
  juristicName: string;
  juristicType: string | null;
  legalStatus: string | null;
  registeredCapital: number | null;
  registeredProvince: string | null;
  matchOutcome: "exact" | "probable" | "ambiguous" | string;
  humanVerified: boolean;
  /** Empty when DBD publishes no nationality breakdown for this company. */
  nationalities: DbdNationality[];
  /**
   * Whether a detail record exists for this factory. Directors, named
   * shareholders and financial statements are half the payload and only render
   * behind a disclosure, so they live in a second per-province file and are
   * fetched when the reader asks for them.
   */
  hasDetail: boolean;
}

/** Loaded on disclosure, from /data/dbd/{province}.detail.json. */
export interface DbdFactoryDetail {
  directors: DbdDirector[];
  owners: DbdOwner[];
  financial: DbdFinancialSnapshot | null;
}
