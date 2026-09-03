import { useState, useEffect, useMemo } from "react";
import type { FactoryFeature, FactoryProperties, FilterState, UserLocation } from "../types/factory";
import { haversineKm } from "../utils/geo";
import { getHazardLevel, parseFactoryTypeCode } from "../utils/hazard";

// ── Province counts type ──
export interface ProvinceCount {
    name_en: string;
    name_th: string;
    count: number;
}

interface UseFactoriesApiProps {
    filters: FilterState;
    userLocation?: UserLocation | null;
}

// Radius used by the "10 กม." filter
export const RADIUS_KM = 10;

interface UseFactoriesApiResult {
    factories: FactoryFeature[];
    isLoading: boolean;
    error: string | null;
    total: number;
    provinceCounts: ProvinceCount[];
    provinceCountsLoading: boolean;
}

// Max markers to render at once
const MAX_RENDER = 2000;

// ── Fetch full factory details from Supabase ──
export async function fetchFactoryDetail(factoryId: string): Promise<Partial<FactoryProperties> | null> {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey || !/^[\x20-\x7E]+$/.test(supabaseKey)) {
        console.warn("Missing or invalid Supabase credentials, cannot fetch detail");
        return null;
    }

    try {
        // Query factories table with embedded business join
        const url = `${supabaseUrl}/rest/v1/factories?id=eq.${encodeURIComponent(factoryId)}&select=*,businesses(legal_name,objective)`;
        const res = await fetch(url, {
            headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
            },
        });

        if (!res.ok) return null;
        const rows = await res.json();
        const row = rows?.[0];
        if (!row) return null;

        const biz = row.businesses;

        // Only include fields that actually have data, so spreading this over
        // the marker properties never erases known values with ""/0
        const detail: Partial<FactoryProperties> = {
            เลขทะเบียน: row.id || factoryId,
            ชื่อโรงงาน: row.name || undefined,
            ผู้ประกอบก: biz?.legal_name || undefined,
            ประกอบกิจก: biz?.objective || undefined,
            ละติจูด: row.lat ?? undefined,
            ลองติจูด: row.lng ?? undefined,
            โทรศัพท์: row.phone || undefined,
            อำเภอ: row.district || undefined,
            จังหวัด: row.province || undefined,
            ที่อยู่: row.address_full || undefined,
            เงินลงทุน: row.capital_investment ?? undefined,
            แรงม้า: row.horsepower ?? undefined,
            คนงานชาย: row.workers_male ?? row.total_workers ?? undefined,
            คนงานหญิง: row.workers_female ?? undefined,
            ประเภท: row.factory_type || undefined,
        };
        for (const key of Object.keys(detail) as (keyof FactoryProperties)[]) {
            if (detail[key] === undefined) delete detail[key];
        }
        return detail;
    } catch (err) {
        console.error("❌ fetchFactoryDetail error:", err);
        return null;
    }
}

// ── Per-province marker loading ──
// Markers are split into /data/markers/{slug}.json (one file per province,
// ~50–500 KB each) so selecting a province downloads only what it needs
// instead of the full 7 MB nationwide file.

/** URL slug for a province's marker file, from its English name. */
export function provinceSlug(nameEn: string): string {
    return nameEn.toLowerCase().replace(/\s+/g, "-");
}

const markerCache = new Map<string, FactoryFeature[]>();

async function loadProvinceMarkers(slug: string): Promise<FactoryFeature[]> {
    const cached = markerCache.get(slug);
    if (cached) return cached;

    const res = await fetch(`/data/markers/${slug}.json`);
    if (!res.ok) throw new Error(`Failed to load markers for ${slug} (HTTP ${res.status})`);
    const raw = await res.json();

    type RawMarker = { i?: string; n?: string; p?: string; t?: string; q?: string; a: [number, number] };
    const features: FactoryFeature[] = (raw as RawMarker[]).map((m) => ({
        type: "Feature",
        properties: {
            เลขทะเบียน: m.i || "",
            ชื่อโรงงาน: m.n || "",
            // 'g'/'c' = approximate (geocoded / tambon centroid);
            // 's' = exact, inherited from a licence at the same address
            coordQuality:
                m.q === "g" ? "geocoded"
                : m.q === "c" ? "centroid"
                : m.q === "s" ? "sibling"
                : undefined,
            ผู้ประกอบก: "",
            ประกอบกิจก: "",
            ละติจูด: m.a[1],
            ลองติจูด: m.a[0],
            อำเภอ: "",
            จังหวัด: m.p || "",
            ที่อยู่: "",
            เงินลงทุน: 0,
            แรงม้า: 0,
            คนงานชาย: 0,
            ประเภท: m.t || ""
        },
        geometry: {
            type: "Point",
            coordinates: m.a
        }
    }));

    markerCache.set(slug, features);
    return features;
}

// ── Hook ──
export const useFactoriesApi = ({
    filters,
    userLocation = null,
}: UseFactoriesApiProps): UseFactoriesApiResult => {
    const [allFactories, setAllFactories] = useState<FactoryFeature[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [provinceCounts, setProvinceCounts] = useState<ProvinceCount[]>([]);
    const [provinceCountsLoading, setProvinceCountsLoading] = useState(true);

    // Load lightweight province counts on mount (tiny file, instant)
    useEffect(() => {
        fetch("/data/province-counts.json")
            .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then((data: ProvinceCount[]) => {
                setProvinceCounts(data);
                setProvinceCountsLoading(false);
            })
            .catch((err) => {
                console.error("❌ Failed to load province counts:", err);
                setProvinceCountsLoading(false);
            });
    }, []);

    // Lazy-load markers ONLY when a province is selected
    useEffect(() => {
        if (!filters.selectedProvince) {
            // No province selected — clear markers, show choropleth only
            setAllFactories([]);
            setIsLoading(false);
            return;
        }

        // Need province counts to map Thai name → file slug
        const pc = provinceCounts.find((p) => p.name_th === filters.selectedProvince);
        if (!pc) return; // counts not loaded yet — effect reruns when they arrive

        let cancelled = false;
        setIsLoading(true);
        setError(null);
        loadProvinceMarkers(provinceSlug(pc.name_en))
            .then((provinceFactories) => {
                if (!cancelled) setAllFactories(provinceFactories);
            })
            .catch((err) => {
                console.error("❌", err);
                if (!cancelled) setError(err.message);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [filters.selectedProvince, provinceCounts]);

    // Apply remaining filters (search, high-risk, radius)
    const factories = useMemo(() => {
        let result = allFactories;

        if (filters.showHighRisk) {
            // "เสี่ยงสูง" = hazardous industry (chemicals/petroleum/metals/
            // power/waste) by DIW type code, not just จำพวก 3 (~90% of factories)
            result = result.filter(
                (f) => getHazardLevel(f.properties.เลขทะเบียน, f.properties.ประเภท) === "hazard"
            );
        }
        if (filters.factoryTypes.length > 0) {
            // Filter by DIW industry code (ลำดับที่ 1-107, e.g. from the dashboard)
            result = result.filter((f) => {
                const code = parseFactoryTypeCode(f.properties.เลขทะเบียน);
                return code !== null && filters.factoryTypes.includes(String(code));
            });
        }
        if (filters.searchTerm) {
            const term = filters.searchTerm.toLowerCase();
            result = result.filter((f) => {
                const props = f.properties;
                return [props.ชื่อโรงงาน, props.เลขทะเบียน, props.จังหวัด]
                    .join(" ")
                    .toLowerCase()
                    .includes(term);
            });
        }
        if (filters.showOnlyInRadius && userLocation) {
            const limit = filters.radiusKm ?? RADIUS_KM;
            result = result.filter((f) => {
                const [lng, lat] = f.geometry.coordinates;
                return haversineKm(userLocation.lat, userLocation.lng, lat, lng) <= limit;
            });
        }

        return result.length > MAX_RENDER ? result.slice(0, MAX_RENDER) : result;
    }, [allFactories, filters.showHighRisk, filters.searchTerm, filters.showOnlyInRadius, filters.radiusKm, filters.factoryTypes, userLocation]);

    const total = provinceCounts.reduce((sum, p) => sum + p.count, 0);

    return { factories, isLoading, error, total, provinceCounts, provinceCountsLoading };
};
