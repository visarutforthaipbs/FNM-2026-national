import { useCallback, useEffect, useState } from "react";
import type {
  DbdDirector,
  DbdFactoryProfile,
  DbdNationality,
  DbdOwner,
} from "../types/dbd";
import { provinceSlug } from "./useFactoriesApi";

// Ownership ships with the app, like markers: /data/dbd/{province}.json, keyed
// by factory registration id.
//
// Nothing is fetched from a database or a live API while someone is reading the
// page. That matters beyond tidiness: an earlier version called DBD's own
// service per factory viewed, which turns every visitor into crawl traffic
// against a WAF that had already blocked us once for far less. Whatever DBD
// says is collected once, offline, at a rate we control, and shipped as a file.
//
// Keys are abbreviated to match export_dbd_profiles.py; this module is the only
// place that has to know about them.
type RawOwner = { n: string; c?: string; p?: number; a?: number };
type RawNationality = { c: string; p?: number; h?: number };
type RawProfile = {
  j: string;                     // juristic id
  n: string;                     // juristic name
  t?: string;                    // type
  s?: string;                    // legal status
  c?: number;                    // registered capital
  p?: string;                    // registered province
  v?: number;                    // human-verified
  d?: string[];                  // directors
  o?: RawOwner[];                // named shareholders (partnerships only)
  nat?: RawNationality[];        // aggregate nationality split
  f?: { y: string; r: number | null; p: number | null; a: number | null };
};

interface UseDbdProfileResult {
  profile: DbdFactoryProfile | null;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  retry: () => void;
}

// One in-flight request per province, shared by every consumer, and the parsed
// result kept for the session — the same pattern the marker files use.
const provinceCache = new Map<string, Record<string, RawProfile>>();
const inFlight = new Map<string, Promise<Record<string, RawProfile>>>();

async function loadProvince(slug: string): Promise<Record<string, RawProfile>> {
  const cached = provinceCache.get(slug);
  if (cached) return cached;

  const pending = inFlight.get(slug);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch(`/data/dbd/${slug}.json`);
    // A province with no published ownership links has no file. That is an
    // absence of data, not a failure, and must not surface as an error.
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`http_${res.status}`);
    return (await res.json()) as Record<string, RawProfile>;
  })();

  inFlight.set(slug, request);
  try {
    const data = await request;
    provinceCache.set(slug, data);
    return data;
  } finally {
    inFlight.delete(slug);
  }
}

function normalize(factoryId: string, raw: RawProfile): DbdFactoryProfile {
  const directors: DbdDirector[] = (raw.d ?? []).map((name) => ({
    name,
    role: "กรรมการ",
  }));

  const owners: DbdOwner[] = (raw.o ?? []).map((o) => ({
    name: o.n,
    nationality: o.c ?? null,
    shareAmount: o.a ?? null,
    sharePercent: o.p ?? null,
  }));

  const nationalities: DbdNationality[] = (raw.nat ?? []).map((n) => ({
    code: n.c,
    percent: n.p ?? null,
    holders: n.h ?? null,
  }));

  return {
    factoryId,
    juristicId: raw.j,
    juristicName: raw.n,
    juristicType: raw.t ?? null,
    legalStatus: raw.s ?? null,
    registeredCapital: raw.c ?? null,
    registeredProvince: raw.p ?? null,
    // Only exact or human-verified links are exported at all, so anything
    // present here is publishable; `v` distinguishes which of the two.
    matchOutcome: "exact",
    humanVerified: raw.v === 1,
    directors,
    owners,
    nationalities,
    financial: raw.f
      ? {
          year: raw.f.y,
          totalAssets: raw.f.a,
          totalLiabilities: null,
          totalEquity: null,
          totalRevenue: raw.f.r,
          netProfit: raw.f.p,
        }
      : null,
  };
}

/**
 * @param factoryId registration number (เลขทะเบียน)
 * @param provinceEn English province name, used to pick the file
 */
export function useDbdProfile(
  factoryId: string,
  provinceEn: string | null
): UseDbdProfileResult {
  const [attempt, setAttempt] = useState(0);
  const [profile, setProfile] = useState<DbdFactoryProfile | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(factoryId && provinceEn));
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!factoryId || !provinceEn) {
      setProfile(null);
      setIsLoading(false);
      setHasLoaded(false);
      setError(null);
      return;
    }

    const slug = provinceSlug(provinceEn);
    let cancelled = false;

    // Already parsed: settle synchronously so switching between factories in a
    // loaded province never flashes a skeleton.
    const cached = provinceCache.get(slug);
    if (cached) {
      const raw = cached[factoryId];
      setProfile(raw ? normalize(factoryId, raw) : null);
      setIsLoading(false);
      setHasLoaded(true);
      setError(null);
      return;
    }

    setProfile(null);
    setIsLoading(true);
    setHasLoaded(false);
    setError(null);

    loadProvince(slug)
      .then((data) => {
        if (cancelled) return;
        const raw = data[factoryId];
        setProfile(raw ? normalize(factoryId, raw) : null);
        setHasLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to load DBD ownership data", err);
        setError("โหลดข้อมูลนิติบุคคลไม่สำเร็จ");
        setHasLoaded(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [factoryId, provinceEn, attempt]);

  const retry = useCallback(() => {
    if (provinceEn) provinceCache.delete(provinceSlug(provinceEn));
    setAttempt((value) => value + 1);
  }, [provinceEn]);

  return { profile, isLoading, hasLoaded, error, retry };
}
