import { useState, useEffect, useMemo } from "react";
import type { FactoryFeature, FactoryProperties, FilterState } from "../types/factory";

// ── Province counts type ──
export interface ProvinceCount {
    name_en: string;
    name_th: string;
    count: number;
}

interface UseFactoriesApiProps {
    filters: FilterState;
}

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
export async function fetchFactoryDetail(factoryId: string): Promise<FactoryProperties | null> {
    const supabaseUrl = (import.meta as any).env.VITE_SUPABASE_URL;
    const supabaseKey = (import.meta as any).env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
        console.warn("Missing Supabase credentials, cannot fetch detail");
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

        return {
            เลขทะเบียน: row.id || factoryId,
            ชื่อโรงงาน: row.name || "",
            ผู้ประกอบก: biz?.legal_name || "",
            ประกอบกิจก: biz?.objective || "",
            ละติจูด: row.lat || 0,
            ลองติจูด: row.lng || 0,
            โทรศัพท์: row.phone || undefined,
            อำเภอ: row.district || "",
            จังหวัด: row.province || "",
            ที่อยู่: row.address_full || undefined,
            เงินลงทุน: row.capital_investment || undefined,
            แรงม้า: row.horsepower || undefined,
            คนงานชาย: row.workers_male || row.total_workers || undefined,
            คนงานหญิง: row.workers_female || undefined,
            ประเภท: row.factory_type || "",
        };
    } catch (err) {
        console.error("❌ fetchFactoryDetail error:", err);
        return null;
    }
}

// ── Cache ──
let cachedMarkers: FactoryFeature[] | null = null;

async function loadMarkers(): Promise<FactoryFeature[]> {
    if (cachedMarkers) return cachedMarkers;

    console.time("⏱️ Load all markers");
    const res = await fetch("/data/markers.json");
    const raw = await res.json();
    console.timeEnd("⏱️ Load all markers");

    const features: FactoryFeature[] = raw.map((m: any) => ({
        type: "Feature",
        properties: {
            เลขทะเบียน: m.i || "",
            ชื่อโรงงาน: m.n || "",
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

    console.log(`📍 ${features.length} factory markers ready`);
    cachedMarkers = features;
    return features;
}

// ── Hook ──
export const useFactoriesApi = ({
    filters,
}: UseFactoriesApiProps): UseFactoriesApiResult => {
    const [allFactories, setAllFactories] = useState<FactoryFeature[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [provinceCounts, setProvinceCounts] = useState<ProvinceCount[]>([]);
    const [provinceCountsLoading, setProvinceCountsLoading] = useState(true);

    // Load lightweight province counts on mount (tiny file, instant)
    useEffect(() => {
        fetch("/data/province-counts.json")
            .then((res) => res.json())
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

        setIsLoading(true);
        loadMarkers()
            .then((all) => {
                // Filter to selected province immediately
                const provinceFactories = all.filter(
                    (f) => f.properties.จังหวัด === filters.selectedProvince
                );
                setAllFactories(provinceFactories);
            })
            .catch((err) => {
                console.error("❌", err);
                setError(err.message);
            })
            .finally(() => setIsLoading(false));
    }, [filters.selectedProvince]);

    // Apply remaining filters (search, high-risk, etc.)
    const factories = useMemo(() => {
        let result = allFactories;

        if (filters.showHighRisk) {
            result = result.filter((f) => f.properties.ประเภท === "3");
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

        return result.length > MAX_RENDER ? result.slice(0, MAX_RENDER) : result;
    }, [allFactories, filters.showHighRisk, filters.searchTerm]);

    const total = provinceCounts.reduce((sum, p) => sum + p.count, 0);

    return { factories, isLoading, error, total, provinceCounts, provinceCountsLoading };
};
