import { useEffect, useState } from "react";
import { provinceSlug } from "./useFactoriesApi";

// Town-planning zone per factory, from /data/zoning/{province}.json — the
// result of a real point-in-polygon test against DPT's 42,219 published
// polygons, computed offline by server/sync/export_zoning.py.
//
// A factory is absent from the file when no DPT polygon contains it, which is
// the majority case: DPT's national layer has no coverage at all for 16
// provinces (Bangkok, Samut Prakan, Chonburi and Rayong among them, which are
// planned under the BMA's own plan and the EEC land-use plan), and nationally
// only 23% of mapped factories fall inside a polygon. `null` therefore means
// "DPT publishes no plan for this point", never "no zone" and never "unzoned".

export interface FactoryZone {
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

type RawZone = { u: string; k: string; l: string; c: string; b?: string; n?: string; y?: number };

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
      setZone(
        raw
          ? {
              code: raw.u,
              kind: raw.k,
              label: raw.l,
              color: raw.c,
              block: raw.b ?? null,
              planName: raw.n ?? null,
              planYear: raw.y ?? null,
            }
          : null
      );
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
