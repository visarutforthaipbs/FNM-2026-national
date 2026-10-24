import { useEffect, useState } from "react";
import { provinceSlug } from "./useFactoriesApi";

// Town-planning situation per factory, from /data/zoning/{province}.json — the
// result of a real point-in-polygon test against the DPT polygons we hold,
// computed offline by server/sync/export_zoning.py against PostGIS.
//
// There are three possible answers, and collapsing any two of them misleads:
//
//   tier "municipal"  a ผังเมืองรวมเมือง/ชุมชน polygon contains the point, and
//                     it carries a land-use code. This says what the point is
//                     ZONED.
//   tier "province"   only a ผังเมืองรวมจังหวัด footprint contains the point.
//                     Those footprints carry no land-use attribute at all, so
//                     this says a plan COVERS the point and nothing more. It
//                     must never be rendered as a land-use category.
//   null              neither tier contains it — DPT publishes no plan we hold
//                     for this point. Never "unzoned", never a verdict.
//
// The two tiers overlap (a provincial footprint is the whole province), so the
// export applies municipal precedence and a factory never carries both.
//
// This is a discriminated union on purpose: a provincial entry has no code,
// label or colour to read, and the type should make reaching for one a
// compile error rather than a blank badge.
export type FactoryZone =
  | {
      tier: "municipal";
      /** DPT land-use code, e.g. "3200". */
      code: string;
      /** Family key: industrial, residential, commercial, … */
      kind: string;
      /** DPT's own label for the family, in Thai. */
      label: string;
      /** DPT's colour for the family. */
      color: string;
      /** Zoning block, e.g. อ.1-3. */
      block: string | null;
      /** Name of the town plan this polygon belongs to. */
      planName: string | null;
      /** Year the plan was issued (พ.ศ.). */
      planYear: number | null;
    }
  | {
      /**
       * A real zone, but from ผังเมืองรวมจังหวัด rather than a town plan.
       * Kept distinct from "municipal" because the two are different legal
       * instruments and the card says which one it is reading.
       */
      tier: "province_landuse";
      code: string;
      kind: string;
      /** DPT's own published label for this class. */
      label: string;
      /** The colour DPT actually renders this class in. */
      color: string;
      /** DPT's numbered block, e.g. "1.14". */
      block: string | null;
      /** DPT draws this class as a hatch rather than a solid fill. */
      patterned: boolean;
    }
  | {
      tier: "province";
      /** Name of the ผังเมืองรวมจังหวัด covering this point. */
      planName: string | null;
    };

type RawZone =
  | { t?: undefined; u: string; k: string; l: string; c: string; b?: string; n?: string; y?: number }
  | { t: "pl"; u: string; k: string; l: string; c: string; b?: string; h?: 1 }
  | { t: "p"; n?: string };

const cache = new Map<string, Record<string, RawZone>>();
const inFlight = new Map<string, Promise<Record<string, RawZone>>>();

async function loadProvince(slug: string): Promise<Record<string, RawZone>> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const pending = inFlight.get(slug);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch(`/data/zoning/${slug}.json`);
    // A province with no DPT coverage has no file. That is an absence of
    // published planning data, not an error.
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`http_${res.status}`);
    return (await res.json()) as Record<string, RawZone>;
  })();

  inFlight.set(slug, request);
  try {
    const data = await request;
    cache.set(slug, data);
    return data;
  } finally {
    inFlight.delete(slug);
  }
}

interface UseZoningResult {
  zone: FactoryZone | null;
  isLoading: boolean;
  /** True once we know the answer — including when the answer is "no data". */
  hasLoaded: boolean;
}

export function useZoning(factoryId: string, provinceEn: string | null): UseZoningResult {
  const [zone, setZone] = useState<FactoryZone | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(factoryId && provinceEn));
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    if (!factoryId || !provinceEn) {
      setZone(null);
      setIsLoading(false);
      setHasLoaded(false);
      return;
    }
    const slug = provinceSlug(provinceEn);
    let cancelled = false;

    const settle = (data: Record<string, RawZone>) => {
      const raw = data[factoryId];
      let next: FactoryZone | null = null;
      if (raw?.t === "p") {
        // A provincial footprint: it names the plan and knows no land use.
        next = { tier: "province", planName: raw.n ?? null };
      } else if (raw?.t === "pl") {
        next = {
          tier: "province_landuse",
          code: raw.u,
          kind: raw.k,
          label: raw.l,
          color: raw.c,
          block: raw.b ?? null,
          patterned: raw.h === 1,
        };
      } else if (raw) {
        next = {
          tier: "municipal",
          code: raw.u,
          kind: raw.k,
          label: raw.l,
          color: raw.c,
          block: raw.b ?? null,
          planName: raw.n ?? null,
          planYear: raw.y ?? null,
        };
      }
      setZone(next);
      setHasLoaded(true);
      setIsLoading(false);
    };

    const cached = cache.get(slug);
    if (cached) {
      settle(cached);
      return;
    }

    setIsLoading(true);
    setHasLoaded(false);
    loadProvince(slug)
      .then((data) => {
        if (!cancelled) settle(data);
      })
      .catch(() => {
        // Treat a failed fetch as unknown rather than as "no zone": the two
        // read identically to a user and only one of them is true.
        if (!cancelled) {
          setZone(null);
          setHasLoaded(false);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [factoryId, provinceEn]);

  return { zone, isLoading, hasLoaded };
}
