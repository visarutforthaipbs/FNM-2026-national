import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, Flex, Select, Button, Icon, Popover, PopoverTrigger, PopoverContent, PopoverArrow, PopoverBody, VStack } from "@chakra-ui/react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Circle,
  GeoJSON,
  ZoomControl,
  useMap,
} from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type {
  FactoryGeoJSON,
  FactoryFeature,
  FilterState,
  UserLocation,
} from "../types/factory";
import { getHazardLevel } from "../utils/hazard";
import type { HazardLevel } from "../utils/hazard";
import type { ProvinceCount } from "../hooks/useFactoriesApi";

// Tile sources live in utils/tiles.ts — shared with LocationCorrectionModal so
// the two maps can't drift apart.
import {
  TILE_URLS,
  TILE_ATTRIBUTIONS,
  TILE_LABELS_URLS,
  TILE_MAX_NATIVE_ZOOM,
  HAS_SPHERE_KEY,
} from "../utils/tiles";

interface MapWrapperProps {
  factories: FactoryGeoJSON | null;
  userLocation: UserLocation | null;
  selectedFactory: FactoryFeature | null;
  onFactorySelect: (factory: FactoryFeature | null) => void;
  filters: FilterState;
  onProvinceSelect: (provinceTh: string) => void;
  provinceCounts: ProvinceCount[];
  isMobile?: boolean;
  isTablet?: boolean;
  isLoading?: boolean;
  /** Mobile only: the sidebar overlay is open — hide floating map chrome so the
      narrow visible strip stays clean (Signal 39: no chrome competing with content). */
  hideChrome?: boolean;
}

// Fix for default markers
delete (
  L.Icon.Default.prototype as L.Icon.Default & { _getIconUrl?: () => string }
)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

// SIGNAL 39 Layer 1: Semantic color coding for factory markers
// Red = hazardous industry (chemicals/petroleum/metals/power/waste),
// Amber = จำพวก 3 general, Green = จำพวก 1-2 / small operations.
// User can identify risk status without reading text (pre-attentive processing)

// Inject the pulse keyframes once (instead of a <style> tag per selected marker)
if (typeof document !== "undefined" && !document.getElementById("factory-marker-pulse")) {
  const style = document.createElement("style");
  style.id = "factory-marker-pulse";
  style.textContent = `
    @keyframes factory-marker-pulse {
      0% { transform: scale(1); opacity: 0.6; }
      70% { transform: scale(1.5); opacity: 0; }
      100% { transform: scale(1.5); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

const MARKER_STYLE: Record<HazardLevel, { asset: string; pulse: string }> = {
  hazard: { asset: "/assets/markers/red-factory.svg", pulse: "239, 68, 68" },
  type3: { asset: "/assets/markers/yellow-factory.svg", pulse: "245, 158, 11" },
  general: { asset: "/assets/markers/green-factory.svg", pulse: "16, 185, 129" },
};

const buildFactoryIcon = (level: HazardLevel, isSelected: boolean, isApprox = false) => {
  const width = isSelected ? 38 : 30;
  const height = isSelected ? 46 : 38;
  const { asset, pulse: pulseColor } = MARKER_STYLE[level];

  return L.divIcon({
    html: `
      <div style="width: ${width}px; height: ${height}px; position: relative;${isApprox ? " opacity: 0.55; filter: saturate(0.75);" : ""}">
        ${isSelected ? `
          <div style="
            position: absolute;
            width: ${width - 4}px;
            height: ${width - 4}px;
            left: 2px;
            top: 2px;
            border-radius: 50%;
            background: rgba(${pulseColor}, 0.4);
            animation: factory-marker-pulse 1.5s infinite;
          "></div>
        ` : ''}
        <img
          src="${asset}"
          width="${width}"
          height="${height}"
          alt=""
          draggable="false"
          style="position: relative; z-index: 2; display: block; filter: drop-shadow(0 3px 5px rgba(11,53,88,0.28));"
        />
      </div>
    `,
    className: `custom-factory-marker ${isSelected ? 'selected' : ''} ${level}`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height],
  });
};

// Pre-created icon instances — only 12 combinations exist, so never rebuild
// per marker. "approx" = tambon-centroid position, rendered faded so an
// approximate pin is never mistaken for a surveyed one.
const FACTORY_ICONS = {
  "hazard-selected": buildFactoryIcon("hazard", true),
  "hazard-normal": buildFactoryIcon("hazard", false),
  "type3-selected": buildFactoryIcon("type3", true),
  "type3-normal": buildFactoryIcon("type3", false),
  "general-selected": buildFactoryIcon("general", true),
  "general-normal": buildFactoryIcon("general", false),
  "hazard-selected-approx": buildFactoryIcon("hazard", true, true),
  "hazard-normal-approx": buildFactoryIcon("hazard", false, true),
  "type3-selected-approx": buildFactoryIcon("type3", true, true),
  "type3-normal-approx": buildFactoryIcon("type3", false, true),
  "general-selected-approx": buildFactoryIcon("general", true, true),
  "general-normal-approx": buildFactoryIcon("general", false, true),
};

const getFactoryIcon = (level: HazardLevel, isSelected: boolean, isApprox = false) =>
  FACTORY_ICONS[
    `${level}-${isSelected ? "selected" : "normal"}${isApprox ? "-approx" : ""}`
  ];

const FactoryLegendMarker: React.FC<{ level: HazardLevel }> = ({ level }) => {
  return (
    <Box
      as="img"
      src={MARKER_STYLE[level].asset}
      alt=""
      aria-hidden="true"
      w="24px"
      h="30px"
      objectFit="contain"
      style={{ flex: "0 0 auto", filter: "drop-shadow(0 2px 3px rgba(11,53,88,0.18))" }}
    />
  );
};

const userLocationIcon = L.icon({
  iconUrl: "/assets/markers/home.svg",
  className: "custom-user-location-marker",
  iconSize: [40, 48],
  iconAnchor: [20, 46],
  popupAnchor: [0, -46],
});

type DptProvincialGeoJSON = GeoJSON.FeatureCollection & {
  metadata?: {
    province_th?: string;
    feature_count?: number;
    unknown_class_count?: number;
  };
};

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// ── Choropleth color scale ──
function getDensityColor(count: number): string {
  if (count >= 3000) return "#0B3558";
  if (count >= 1000) return "#2F6987";
  if (count >= 500)  return "#5D91A8";
  if (count >= 200)  return "#8FB9C9";
  if (count >= 50)   return "#B9D2DA";
  if (count >= 10)   return "#D5E5EA";
  return "#E8F1F4";
}

// ── Zoom to province bounds ──
const FlyToProvince: React.FC<{
  provinceGeo: GeoJSON.FeatureCollection | null;
  selectedProvince: string;
  countsMap: Map<string, ProvinceCount>;
}> = ({ provinceGeo, selectedProvince, countsMap }) => {
  const map = useMap();

  useEffect(() => {
    if (!selectedProvince || !provinceGeo) return;

    // Find the province feature by matching English name from countsMap
    const provinceCount = Array.from(countsMap.values()).find(
      (pc) => pc.name_th === selectedProvince
    );
    if (!provinceCount) return;

    const feature = provinceGeo.features.find(
      (f) => f.properties?.NAME_1 === provinceCount.name_en
    );
    if (!feature) return;

    const geoLayer = L.geoJSON(feature);
    const bounds = geoLayer.getBounds();
    if (bounds.isValid()) {
      map.flyToBounds(bounds, { padding: [40, 40], duration: 0.8 });
    }
  }, [selectedProvince, provinceGeo, countsMap, map]);

  return null;
};

// ── Reset to Thailand overview ──
const FlyToOverview: React.FC<{ trigger: number }> = ({ trigger }) => {
  const map = useMap();
  useEffect(() => {
    if (trigger > 0) {
      map.flyTo([13.2, 101.0], 6, { duration: 0.8 });
    }
  }, [trigger, map]);
  return null;
};

// ── Fly to selected factory ──
const FlyToFactory: React.FC<{ factory: FactoryFeature | null }> = ({ factory }) => {
  const map = useMap();
  useEffect(() => {
    if (!factory) return;
    const lat = factory.geometry.coordinates[1];
    const lng = factory.geometry.coordinates[0];
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
    map.flyTo([lat, lng], 16, { duration: 0.8 });
  }, [factory, map]);
  return null;
};

const MapWrapper: React.FC<MapWrapperProps> = React.memo(
  ({
    factories,
    userLocation,
    selectedFactory,
    onFactorySelect,
    filters,
    onProvinceSelect,
    provinceCounts,
    isMobile = false,
    isLoading = false,
    hideChrome = false,
  }) => {
    const isProvinceMode = !!filters.selectedProvince;
    // When the mobile sidebar covers the map, all floating controls hide —
    // otherwise legend, zoom, layer toggles and back button crowd the strip.
    const showChrome = !hideChrome;

    // Auto-detect dark mode
    const getPreferredTile = (): keyof typeof TILE_URLS => {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      return 'light';
    };

    const [selectedTile, setSelectedTile] =
      React.useState<keyof typeof TILE_URLS>(getPreferredTile);

    // DPT Local Industrial Purple Zones layer state
    // Keep the first phone viewport focused on the factory signal. Zoning stays
    // one tap away in the layer sheet, while desktop keeps the established
    // always-on planning context.
    const [showPurpleZones, setShowPurpleZones] = useState<boolean>(() => !isMobile);
    // Separate municipal/town-community plan layer from DPT's existing tile
    // service. This is not the downloaded PLLU_PROV dataset below.
    const [showTownPlan, setShowTownPlan] = useState<boolean>(false);
    const [townPlanOpacity, setTownPlanOpacity] = useState<number>(0.55);
    const [dptPlanOpacity, setDptPlanOpacity] = useState<number>(0.55);
    const [purpleZonesGeo, setPurpleZonesGeo] = useState<GeoJSON.FeatureCollection | null>(null);

    // Built offline from the downloaded PLLU_PROV archive. Only the selected
    // province file is requested, and previously viewed provinces are cached.
    const [showProvincePlans, setShowProvincePlans] = useState<boolean>(false);
    const [provinceLanduseGeo, setProvinceLanduseGeo] = useState<DptProvincialGeoJSON | null>(null);
    const [provinceLanduseStatus, setProvinceLanduseStatus] =
      useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
    const provinceLanduseCache = React.useRef(new Map<string, DptProvincialGeoJSON>());

    useEffect(() => {
      if (typeof window === 'undefined' || !window.matchMedia) return;
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const h = (e: MediaQueryListEvent) => setSelectedTile(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', h);
      return () => mq.removeEventListener('change', h);
    }, []);

    // Province GeoJSON polygons
    const [provinceGeo, setProvinceGeo] = useState<GeoJSON.FeatureCollection | null>(null);

    useEffect(() => {
      fetch("/data/thailand-provinces.json")
        .then((r) => r.json())
        .then(setProvinceGeo)
        .catch((err) => console.error("Error loading provinces:", err));

      fetch("/data/dpt_industrial_purple_zones.json")
        .then((r) => r.json())
        .then(setPurpleZonesGeo)
        .catch((err) => console.error("Error loading DPT purple zones:", err));

    }, []);

    // Build counts lookup: English name → ProvinceCount
    const countsMap = useMemo(() => {
      const m = new Map<string, ProvinceCount>();
      provinceCounts.forEach((pc) => m.set(pc.name_en, pc));
      return m;
    }, [provinceCounts]);

    useEffect(() => {
      if (!showProvincePlans || !isProvinceMode) {
        setProvinceLanduseGeo(null);
        setProvinceLanduseStatus("idle");
        return;
      }
      const pc = provinceCounts.find((p) => p.name_th === filters.selectedProvince);
      if (!pc) return;
      const provinceSlug = pc.name_en.trim().toLowerCase().replace(/\s+/g, "-");
      const cached = provinceLanduseCache.current.get(provinceSlug);
      if (cached) {
        setProvinceLanduseGeo(cached);
        setProvinceLanduseStatus("ready");
        return;
      }

      const controller = new AbortController();
      setProvinceLanduseGeo(null);
      setProvinceLanduseStatus("loading");
      fetch(`/data/dpt-province-landuse/${provinceSlug}.json`, { signal: controller.signal })
        .then((response) => {
          if (response.status === 404) {
            setProvinceLanduseStatus("missing");
            return null;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<DptProvincialGeoJSON>;
        })
        .then((data) => {
          if (!data) return;
          provinceLanduseCache.current.set(provinceSlug, data);
          setProvinceLanduseGeo(data);
          setProvinceLanduseStatus("ready");
        })
        .catch((error: Error) => {
          if (error.name === "AbortError") return;
          console.error("Error loading local DPT provincial land use:", error);
          setProvinceLanduseStatus("error");
        });
      return () => controller.abort();
    }, [showProvincePlans, isProvinceMode, provinceCounts, filters.selectedProvince]);

    // Selected province boundary GeoJSON (outline only, no fill)
    const selectedProvinceBoundary = useMemo(() => {
      if (!isProvinceMode || !provinceGeo) return null;
      const pc = Array.from(countsMap.values()).find(
        (p) => p.name_th === filters.selectedProvince
      );
      if (!pc) return null;
      const feature = provinceGeo.features.find(
        (f) => f.properties?.NAME_1 === pc.name_en
      );
      if (!feature) return null;
      return { type: "FeatureCollection" as const, features: [feature] };
    }, [isProvinceMode, provinceGeo, filters.selectedProvince, countsMap]);

    // Trigger for flying back to overview
    const [overviewTrigger, setOverviewTrigger] = useState(0);

    const handleBackToOverview = useCallback(() => {
      onProvinceSelect("");
      onFactorySelect(null);
      setShowProvincePlans(false);
      setOverviewTrigger((t) => t + 1);
    }, [onProvinceSelect, onFactorySelect]);

    // Choropleth style per feature
    const getProvinceStyle = useCallback(
      (feature?: GeoJSON.Feature): L.PathOptions => {
        const name = feature?.properties?.NAME_1;
        const pc = name ? countsMap.get(name) : undefined;
        const count = pc?.count || 0;
        return {
          fillColor: getDensityColor(count),
          fillOpacity: count > 0 ? 0.66 : 0.24,
          color: "#F8FAFC",
          weight: 1.5,
          opacity: 0.92,
          lineCap: "round",
          lineJoin: "round",
          className: "province-shape",
        };
      },
      [countsMap]
    );

    // Choropleth interaction
    const onEachProvince = useCallback(
      (feature: GeoJSON.Feature, layer: L.Layer) => {
        const name = feature.properties?.NAME_1;
        const pc = name ? countsMap.get(name) : undefined;
        const thaiName = pc?.name_th || name || "";
        const count = pc?.count || 0;

        layer.bindTooltip(
          `<div style="font-family: 'IBM Plex Sans Thai', 'Inter', sans-serif; text-align: left; padding: 3px 5px; min-width: 104px;">
            <div style="display: flex; align-items: center; gap: 7px;">
              <span style="width: 7px; height: 7px; border-radius: 999px; background: #F05223; flex: none;"></span>
              <strong style="color: #0B3558; font-size: 14px;">${thaiName}</strong>
            </div>
            <div style="color: #64748b; font-size: 12px; margin-top: 4px; padding-left: 14px;">
              ${count > 0 ? `${count.toLocaleString()} โรงงาน` : "ไม่มีข้อมูล"}
            </div>
          </div>`,
          { direction: "top", className: "province-tooltip", sticky: true }
        );

        const pathLayer = layer as L.Path;
        layer.on({
          mouseover: () => {
            pathLayer.bringToFront();
            pathLayer.setStyle({
              fillOpacity: 0.8,
              color: "#0B3558",
              weight: 2.5,
              opacity: 0.68,
            });
          },
          mouseout: () => {
            pathLayer.setStyle(getProvinceStyle(feature));
          },
          click: () => {
            if (pc && count > 0) {
              onProvinceSelect(pc.name_th);
            }
          },
        });
      },
      [countsMap, onProvinceSelect, getProvinceStyle]
    );

    const viewportFactories = factories?.features || [];

    return (
      <Box h="full" position="relative" bg="white">
        {/* Map Controls — desktop: one compact row. Mobile: a single "เลเยอร์"
            menu (Signal 39: one Layer-2 affordance instead of four floating chunks). */}
        {showChrome && !isMobile && (
          <Flex
            position="absolute"
            top="4"
            right="4"
            zIndex="1000"
            bg="white"
            borderRadius="xl"
            boxShadow="lg"
            p={2}
            gap={2}
            align="center"
            border="1px solid"
            borderColor="slate.100"
          >
            <Select
              value={selectedTile}
              onChange={(e) =>
                setSelectedTile(e.target.value as keyof typeof TILE_URLS)
              }
              size="sm"
              width="auto"
              variant="filled"
              cursor="pointer"
              fontWeight="medium"
            >
              <option value="light">เรียบง่าย</option>
              <option value="openstreet">แผนที่ถนน</option>
              <option value="dark">กลางคืน</option>
              <option value="satellite">ดาวเทียม</option>
              {HAS_SPHERE_KEY && (
                <>
                  <option value="sphere_streets">GISTDA ถนนภาษาไทย</option>
                  <option value="sphere_hybrid">GISTDA ดาวเทียมไทย</option>
                </>
              )}
            </Select>

            <Button
              size="sm"
              variant={showPurpleZones ? "solid" : "outline"}
              colorScheme={showPurpleZones ? "purple" : "gray"}
              onClick={() => setShowPurpleZones((prev) => !prev)}
              fontSize="xs"
              fontWeight="600"
              px={3}
              borderRadius="lg"
              leftIcon={
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                  <path d="M3 6l9-4 9 4v12l-9 4-9-4V6z" />
                  <path d="M9 22V12" />
                  <path d="M15 22V12" />
                </Icon>
              }
            >
              ผังเมืองสีม่วง DPT
            </Button>

            <Button
              size="sm"
              variant={showTownPlan ? "solid" : "outline"}
              colorScheme={showTownPlan ? "orange" : "gray"}
              onClick={() => setShowTownPlan((prev) => !prev)}
              fontSize="xs"
              fontWeight="600"
              px={3}
              borderRadius="lg"
              leftIcon={
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                  <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
                  <path d="M9 3v15M15 6v15" />
                </Icon>
              }
            >
              ผังเมืองรวมเมือง/ชุมชน
            </Button>

            {isProvinceMode && (
              <Button
                size="sm"
                variant={showProvincePlans ? "solid" : "outline"}
                colorScheme={showProvincePlans ? "blue" : "gray"}
                onClick={() => setShowProvincePlans((prev) => !prev)}
                fontSize="xs"
                fontWeight="600"
                px={3}
                borderRadius="lg"
                leftIcon={
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                    <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z" />
                    <circle cx="12" cy="10" r="3" />
                  </Icon>
                }
              >
                ผังเมืองรวมจังหวัด
              </Button>
            )}

            {showProvincePlans && isProvinceMode && (
              <Flex align="center" gap={2} bg="white" px={3} py={1.5} borderRadius="lg" boxShadow="sm">
                <Text fontSize="10px" color="slate.500" whiteSpace="nowrap">ความเข้มผังสี</Text>
                <input
                  type="range"
                  min={20}
                  max={90}
                  value={Math.round(dptPlanOpacity * 100)}
                  onChange={(e) => setDptPlanOpacity(Number(e.target.value) / 100)}
                  style={{ width: 90 }}
                  aria-label="ความเข้มของชั้นผังเมือง"
                />
              </Flex>
            )}

            {showTownPlan && (
              <Flex align="center" gap={2} bg="white" px={3} py={1.5} borderRadius="lg" boxShadow="sm">
                <Text fontSize="10px" color="slate.500" whiteSpace="nowrap">ความเข้มผังเมือง/ชุมชน</Text>
                <input
                  type="range"
                  min={20}
                  max={90}
                  value={Math.round(townPlanOpacity * 100)}
                  onChange={(e) => setTownPlanOpacity(Number(e.target.value) / 100)}
                  style={{ width: 90 }}
                  aria-label="ความเข้มของผังเมืองรวมเมืองและชุมชน"
                />
              </Flex>
            )}
          </Flex>
        )}

        {showChrome && isMobile && (
          <Box position="absolute" top="3" right="3" zIndex="1000">
            <Popover placement="bottom-end" isLazy closeOnBlur>
              <PopoverTrigger>
                <Button
                  size="sm"
                  minH="44px"
                  bg="white"
                  color="slate.700"
                  border="1px solid"
                  borderColor="slate.100"
                  boxShadow="lg"
                  borderRadius="xl"
                  fontWeight="600"
                  leftIcon={
                    <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                      <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
                      <path d="M9 3v15M15 6v15" />
                    </Icon>
                  }
                >
                  เลเยอร์
                </Button>
              </PopoverTrigger>
              <PopoverContent
                w="min(280px, calc(100vw - 24px))"
                maxH="calc(100dvh - 96px)"
                borderRadius="xl"
                boxShadow="xl"
                border="1px solid"
                borderColor="slate.100"
                overflow="hidden"
                _focusVisible={{ outline: "none" }}
              >
                <PopoverArrow />
                <PopoverBody p={3} overflowY="auto" overscrollBehavior="contain">
                  <VStack spacing={2.5} align="stretch">
                    <Box>
                      <Text fontSize="xs" fontWeight="700" color="slate.500" mb={1}>
                        สไตล์แผนที่
                      </Text>
                      <Select
                        value={selectedTile}
                        onChange={(e) =>
                          setSelectedTile(e.target.value as keyof typeof TILE_URLS)
                        }
                        size="sm"
                        minH="44px"
                        variant="filled"
                        cursor="pointer"
                        fontWeight="medium"
                      >
                        <option value="light">เรียบง่าย</option>
                        <option value="openstreet">แผนที่ถนน</option>
                        <option value="dark">กลางคืน</option>
                        <option value="satellite">ดาวเทียม</option>
                        {HAS_SPHERE_KEY && (
                          <>
                            <option value="sphere_streets">GISTDA ถนนภาษาไทย</option>
                            <option value="sphere_hybrid">GISTDA ดาวเทียมไทย</option>
                          </>
                        )}
                      </Select>
                    </Box>

                    <Button
                      size="sm"
                      minH="44px"
                      w="full"
                      justifyContent="flex-start"
                      variant={showPurpleZones ? "solid" : "outline"}
                      colorScheme={showPurpleZones ? "purple" : "gray"}
                      onClick={() => setShowPurpleZones((prev) => !prev)}
                      fontSize="xs"
                      fontWeight="600"
                      borderRadius="lg"
                      aria-pressed={showPurpleZones}
                      leftIcon={
                        <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                          <path d="M3 6l9-4 9 4v12l-9 4-9-4V6z" />
                          <path d="M9 22V12" />
                          <path d="M15 22V12" />
                        </Icon>
                      }
                    >
                      ผังเมืองสีม่วง DPT
                    </Button>

                    <Button
                      size="sm"
                      minH="44px"
                      w="full"
                      justifyContent="flex-start"
                      variant={showTownPlan ? "solid" : "outline"}
                      colorScheme={showTownPlan ? "orange" : "gray"}
                      onClick={() => setShowTownPlan((prev) => !prev)}
                      fontSize="xs"
                      fontWeight="600"
                      borderRadius="lg"
                      aria-pressed={showTownPlan}
                      leftIcon={
                        <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                          <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3z" />
                          <path d="M9 3v15M15 6v15" />
                        </Icon>
                      }
                    >
                      ผังเมืองรวมเมือง/ชุมชน
                    </Button>

                    {isProvinceMode && (
                      <Button
                        size="sm"
                        minH="44px"
                        w="full"
                        justifyContent="flex-start"
                        variant={showProvincePlans ? "solid" : "outline"}
                        colorScheme={showProvincePlans ? "blue" : "gray"}
                        onClick={() => setShowProvincePlans((prev) => !prev)}
                        fontSize="xs"
                        fontWeight="600"
                        borderRadius="lg"
                        aria-pressed={showProvincePlans}
                        leftIcon={
                          <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                            <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z" />
                            <circle cx="12" cy="10" r="3" />
                          </Icon>
                        }
                      >
                        ผังเมืองรวมจังหวัด
                      </Button>
                    )}

                    {showProvincePlans && isProvinceMode && (
                      <Flex direction="column" align="stretch" gap={1} bg="slate.50" px={3} py={2} borderRadius="lg">
                        <Text fontSize="xs" color="slate.600">ความเข้มผังจังหวัด</Text>
                        <input
                          type="range"
                          min={20}
                          max={90}
                          value={Math.round(dptPlanOpacity * 100)}
                          onChange={(e) => setDptPlanOpacity(Number(e.target.value) / 100)}
                          style={{ width: "100%", minHeight: 28, accentColor: "#2563EB" }}
                          aria-label="ความเข้มของชั้นผังเมือง"
                        />
                      </Flex>
                    )}

                    {showTownPlan && (
                      <Flex direction="column" align="stretch" gap={1} bg="slate.50" px={3} py={2} borderRadius="lg">
                        <Text fontSize="xs" color="slate.600">ความเข้มผังเมือง/ชุมชน</Text>
                        <input
                          type="range"
                          min={20}
                          max={90}
                          value={Math.round(townPlanOpacity * 100)}
                          onChange={(e) => setTownPlanOpacity(Number(e.target.value) / 100)}
                          style={{ width: "100%", minHeight: 28, accentColor: "#DD6B20" }}
                          aria-label="ความเข้มของผังเมืองรวมเมืองและชุมชน"
                        />
                      </Flex>
                    )}

                    {/* Mobile legends live with the controls they explain. Keeping
                        them out of the map viewport preserves the geographic signal
                        until the user explicitly asks for this detail. */}
                    <Box borderTop="1px solid" borderColor="slate.100" pt={2.5}>
                      <Text fontSize="xs" fontWeight="700" color="slate.500" mb={2}>
                        คำอธิบายสัญลักษณ์
                      </Text>

                      {isProvinceMode ? (
                        <VStack spacing={1.5} align="stretch">
                          <Flex align="center" gap={2.5} minH="32px">
                            <FactoryLegendMarker level="hazard" />
                            <Text color="slate.600" fontSize="xs">อุตสาหกรรมเสี่ยงสูง</Text>
                          </Flex>
                          <Flex align="center" gap={2.5} minH="32px">
                            <FactoryLegendMarker level="type3" />
                            <Text color="slate.600" fontSize="xs">จำพวก 3 ทั่วไป</Text>
                          </Flex>
                          <Flex align="center" gap={2.5} minH="32px">
                            <FactoryLegendMarker level="general" />
                            <Text color="slate.600" fontSize="xs">จำพวก 1–2 / ขนาดเล็ก</Text>
                          </Flex>
                        </VStack>
                      ) : (
                        <Box bg="slate.50" borderRadius="lg" px={3} py={2.5}>
                          <Flex gap={0} aria-label="สีเข้มขึ้นหมายถึงจังหวัดที่มีโรงงานหนาแน่นขึ้น">
                            {["#E8F1F4", "#D5E5EA", "#B9D2DA", "#8FB9C9", "#5D91A8", "#2F6987", "#0B3558"].map((color, index) => (
                              <Box
                                key={color}
                                flex="1"
                                h="10px"
                                bg={color}
                                borderLeftRadius={index === 0 ? "2px" : 0}
                                borderRightRadius={index === 6 ? "2px" : 0}
                              />
                            ))}
                          </Flex>
                          <Flex justify="space-between" mt={1}>
                            <Text color="slate.500" fontSize="2xs">น้อยกว่า 10</Text>
                            <Text color="slate.500" fontSize="2xs">3,000+</Text>
                          </Flex>
                          <Text color="slate.500" fontSize="2xs" mt={1.5}>
                            แตะจังหวัดเพื่อดูโรงงาน
                          </Text>
                        </Box>
                      )}

                      {(showPurpleZones || showTownPlan || (showProvincePlans && isProvinceMode)) && (
                        <VStack spacing={1.5} align="stretch" mt={2.5}>
                          {showPurpleZones && (
                            <Flex align="center" gap={2}>
                              <Box w="12px" h="12px" borderRadius="2px" bg="#4D004D" flex="none" />
                              <Text color="slate.600" fontSize="2xs">เขตอุตสาหกรรมและคลังสินค้า DPT</Text>
                            </Flex>
                          )}
                          {showTownPlan && (
                            <Flex align="center" gap={2}>
                              <Box w="12px" h="12px" borderRadius="2px" bg="orange.300" flex="none" />
                              <Text color="slate.600" fontSize="2xs">ผังเมืองรวมเมือง/ชุมชน</Text>
                            </Flex>
                          )}
                          {showProvincePlans && isProvinceMode && (
                            <Flex align="center" gap={2}>
                              <Box w="12px" h="12px" borderRadius="2px" bg="green.400" flex="none" />
                              <Text color="slate.600" fontSize="2xs">
                                ผังเมืองรวมจังหวัด · {filters.selectedProvince}
                              </Text>
                            </Flex>
                          )}
                        </VStack>
                      )}
                    </Box>
                  </VStack>
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </Box>
        )}

        {/* Back to overview button */}
        {showChrome && isProvinceMode && (
          <Box
            position="absolute"
            top={isMobile ? "3" : "4"}
            left={isMobile ? "16" : "4"}
            zIndex="1000"
          >
            <Button
              size="sm"
              minW={isMobile ? "44px" : undefined}
              minH={isMobile ? "44px" : undefined}
              px={isMobile ? 0 : undefined}
              bg="white"
              color="slate.700"
              boxShadow="lg"
              borderRadius="xl"
              border="1px solid"
              borderColor="slate.100"
              _hover={{ bg: "slate.50" }}
              onClick={handleBackToOverview}
              leftIcon={isMobile ? undefined :
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </Icon>
              }
              aria-label={isMobile ? "กลับสู่ภาพรวมทั้งประเทศ" : undefined}
            >
              {isMobile ? (
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={5}>
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </Icon>
              ) : "ภาพรวมทั้งประเทศ"}
            </Button>
          </Box>
        )}

        {/* Loading overlay */}
        {isLoading && isProvinceMode && (
          <Flex
            position="absolute"
            top="50%"
            left="50%"
            transform="translate(-50%, -50%)"
            zIndex="1000"
            bg="white"
            borderRadius="xl"
            boxShadow="xl"
            px={6}
            py={4}
            align="center"
            gap={3}
          >
            <Box
              w="16px"
              h="16px"
              borderRadius="full"
              border="2px solid"
              borderColor="primary.200"
              borderTopColor="primary.600"
              animation="spin 0.6s linear infinite"
              sx={{ "@keyframes spin": { to: { transform: "rotate(360deg)" } } }}
            />
            <Text fontSize="sm" color="slate.600">โหลดข้อมูลโรงงาน...</Text>
          </Flex>
        )}

        {/* Legend (province detail mode) - SIGNAL 39 Layer 1 color key */}
        {showChrome && !isMobile && isProvinceMode && (
          <Box
            position="absolute"
            bottom={4}
            left={isMobile ? 3 : 4}
            zIndex="1000"
            bg="white"
            borderRadius="xl"
            boxShadow="lg"
            p={3}
            border="1px solid"
            borderColor="slate.100"
            fontSize="xs"
          >
            <Text fontWeight="600" color="slate.700" mb={2}>
              ระดับความเสี่ยง
            </Text>
            <Flex direction="column" gap={2}>
              <Flex align="center" gap={2.5} minH="30px">
                <FactoryLegendMarker level="hazard" />
                <Text color="slate.600">
                  {isMobile ? "อุตสาหกรรมเสี่ยงสูง" : "อุตสาหกรรมเสี่ยงสูง (เคมี/ของเสีย/โลหะ/พลังงาน)"}
                </Text>
              </Flex>
              <Flex align="center" gap={2.5} minH="30px">
                <FactoryLegendMarker level="type3" />
                <Text color="slate.600">จำพวก 3 ทั่วไป</Text>
              </Flex>
              <Flex align="center" gap={2.5} minH="30px">
                <FactoryLegendMarker level="general" />
                <Text color="slate.600">จำพวก 1–2 / ขนาดเล็ก</Text>
              </Flex>
            </Flex>
          </Box>
        )}

        {/* Legend (overview mode) */}
        {showChrome && !isMobile && !isProvinceMode && (
          <Box
            position="absolute"
            bottom={4}
            left={isMobile ? 3 : 4}
            zIndex="1000"
            bg="white"
            borderRadius="xl"
            boxShadow="lg"
            p={3}
            border="1px solid"
            borderColor="slate.100"
            fontSize="xs"
          >
            <Text fontWeight="600" color="slate.700" mb={2}>
              ความหนาแน่นโรงงาน
            </Text>
            {isMobile ? (
              <Box>
                <Flex gap={0}>
                  {["#E8F1F4", "#D5E5EA", "#B9D2DA", "#8FB9C9", "#5D91A8", "#2F6987", "#0B3558"].map((c, i) => (
                    <Box key={c} w="18px" h="10px" bg={c} borderLeftRadius={i === 0 ? "2px" : 0} borderRightRadius={i === 6 ? "2px" : 0} />
                  ))}
                </Flex>
                <Flex justify="space-between" mt={0.5}>
                  <Text color="slate.500" fontSize="2xs">&lt; 10</Text>
                  <Text color="slate.500" fontSize="2xs">3,000+</Text>
                </Flex>
              </Box>
            ) : (
              <Flex direction="column" gap={1}>
                {[
                  { color: "#0B3558", label: "3,000+" },
                  { color: "#2F6987", label: "1,000–3,000" },
                  { color: "#5D91A8", label: "500–1,000" },
                  { color: "#8FB9C9", label: "200–500" },
                  { color: "#B9D2DA", label: "50–200" },
                  { color: "#D5E5EA", label: "10–50" },
                  { color: "#E8F1F4", label: "< 10" },
                ].map((item) => (
                  <Flex key={item.label} align="center" gap={2}>
                    <Box w="14px" h="10px" borderRadius="2px" bg={item.color} />
                    <Text color="slate.500">{item.label}</Text>
                  </Flex>
                ))}
              </Flex>
            )}
            <Text mt={2} color="slate.400" fontSize="2xs">
              คลิกจังหวัดเพื่อดูโรงงาน
            </Text>
            {/* Honest-counting caption: ~98% of operating factories are mapped;
                ~1/3 of positions are approximate (tambon centroid / geocoded) */}
            <Text mt={1} color="slate.400" fontSize="2xs" maxW="170px">
              ครอบคลุม ~98% ของโรงงานที่เปิดดำเนินการ (บางส่วนเป็นตำแหน่งโดยประมาณ)
            </Text>
          </Box>
        )}

        {/* Overlay legends share one stack in the bottom-right corner. They
            used to each claim a corner absolutely, so turning on a second
            overlay dropped its legend on top of the first — and on the density
            legend, which owns the bottom-left. Stacking them keeps any
            combination of overlays legible without hand-tuned offsets. */}
        {showChrome && !isMobile && (showPurpleZones || (showProvincePlans && isProvinceMode)) && (
        <VStack
          position="absolute"
          bottom={isMobile ? "140px" : 4}
          right={4}
          zIndex="1000"
          spacing={2}
          align="stretch"
        >
        {showProvincePlans && isProvinceMode && (
          <Box
            bg="white"
            borderRadius="xl"
            boxShadow="lg"
            p={3}
            border="1px solid"
            borderColor="slate.200"
            fontSize="xs"
            maxW="270px"
          >
            <Flex align="center" gap={2} mb={2}>
              <Icon viewBox="0 0 24 24" fill="none" stroke="#0B3558" strokeWidth="2" boxSize={4}>
                <path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </Icon>
              <Text fontWeight="700" color="slate.800" fontSize="xs">
                ผังเมืองรวมจังหวัด · {filters.selectedProvince}
              </Text>
            </Flex>
            {provinceLanduseStatus === "loading" && (
              <Text color="slate.500" fontSize="2xs">กำลังเปิดข้อมูลในเครื่อง…</Text>
            )}
            {provinceLanduseStatus === "missing" && (
              <Text color="slate.600" fontSize="2xs" lineHeight="1.5">
                ชุดข้อมูลที่ดาวน์โหลดไม่มีผังรายแปลงสำหรับจังหวัดนี้
              </Text>
            )}
            {provinceLanduseStatus === "error" && (
              <Text color="red.600" fontSize="2xs">เปิดไฟล์ข้อมูลในเครื่องไม่สำเร็จ</Text>
            )}
            {provinceLanduseStatus === "ready" && provinceLanduseGeo && (
              <>
                <Flex direction="column" gap={1.5} mb={2}>
                  <Flex align="center" gap={2}>
                    <Box w="12px" h="12px" borderRadius="2px" bg="#4D004D" flex="none" />
                    <Text color="slate.700" fontSize="2xs">อุตสาหกรรมและคลังสินค้า</Text>
                  </Flex>
                  <Flex align="center" gap={2}>
                    <Box w="12px" h="12px" borderRadius="2px" bg="#22C55E" flex="none" />
                    <Text color="slate.700" fontSize="2xs">สีอื่นตามประเภทที่ DPT เผยแพร่</Text>
                  </Flex>
                  <Flex align="center" gap={2}>
                    <Box w="12px" h="12px" borderRadius="2px" bg="#CBD5E1" flex="none" />
                    <Text color="slate.700" fontSize="2xs">ไม่พบคำอธิบายสีในต้นทาง</Text>
                  </Flex>
                </Flex>
                <Text color="slate.500" fontSize="2xs" lineHeight="1.5">
                  {provinceLanduseGeo.metadata?.feature_count?.toLocaleString() ?? provinceLanduseGeo.features.length.toLocaleString()} พื้นที่
                  {provinceLanduseGeo.metadata?.unknown_class_count
                    ? ` · ไม่ทราบประเภท ${provinceLanduseGeo.metadata.unknown_class_count.toLocaleString()}`
                    : ""} · เปิดจากไฟล์ที่เก็บในระบบ
                </Text>
              </>
            )}
          </Box>
        )}

        {/* DPT Purple Industrial Zones Legend */}
        {showPurpleZones && (
          <Box
            bg="white"
            borderRadius="xl"
            boxShadow="lg"
            p={3}
            border="1px solid"
            borderColor="purple.200"
            fontSize="xs"
            maxW="240px"
          >
            <Flex align="center" gap={2} mb={1.5}>
              <Icon viewBox="0 0 24 24" fill="none" stroke="#4D004D" strokeWidth="2" boxSize={4}>
                <path d="M3 6l9-4 9 4v12l-9 4-9-4V6z" />
              </Icon>
              <Text fontWeight="700" color="purple.900" fontSize="xs">
                ผังเมืองสีม่วง DPT (570 โซน)
              </Text>
            </Flex>
            <Flex align="center" gap={2} mb={1}>
              <Box w="12px" h="12px" borderRadius="2px" bg="#4D004D" flex="none" />
              <Text color="slate.700" fontSize="2xs" fontWeight="500">
                เขตอุตสาหกรรมและคลังสินค้า
              </Text>
            </Flex>
            <Text color="slate.400" fontSize="2xs">
              ข้อมูลทางการจาก GeoDatabase landuseplan.dpt.go.th
            </Text>
          </Box>
        )}
        </VStack>
        )}

        <MapContainer
          center={[13.2, 101.0]}
          zoom={6}
          style={{ height: "100%", width: "100%" }}
          zoomControl={false}
        >
          {showChrome && <ZoomControl position="bottomright" />}
          <TileLayer
            key={`${selectedTile}-base`}
            url={TILE_URLS[selectedTile]}
            attribution={TILE_ATTRIBUTIONS[selectedTile]}
            maxNativeZoom={TILE_MAX_NATIVE_ZOOM[selectedTile]}
            maxZoom={21}
          />
          {TILE_LABELS_URLS[selectedTile] && (
            <TileLayer
              key={`${selectedTile}-labels`}
              url={TILE_LABELS_URLS[selectedTile]!}
              maxNativeZoom={TILE_MAX_NATIVE_ZOOM[selectedTile]}
              maxZoom={21}
              zIndex={205}
            />
          )}

          {/* DPT town/community plans remain an independent GIS layer. The
              local-only decision applies to PLLU_PROV, not this tile layer. */}
          {showTownPlan && (
            <TileLayer
              url="https://onedpt.dpt.go.th/arcgis/rest/services/PLLU_ALL/PLLU_ALL/MapServer/tile/{z}/{y}/{x}"
              maxNativeZoom={10}
              maxZoom={18}
              opacity={townPlanOpacity}
              zIndex={340}
              attribution='ผังเมืองรวมเมือง/ชุมชน &copy; กรมโยธาธิการและผังเมือง (DPT)'
            />
          )}

          {/* Provincial land use from the local archive. The effect above
              requests one selected-province file only; there is no DPT call. */}
          {showProvincePlans && provinceLanduseGeo && (
            <GeoJSON
              key={`dpt-province-landuse-${filters.selectedProvince}`}
              data={provinceLanduseGeo}
              style={(feature) => ({
                color: feature?.properties?.c || "#CBD5E1",
                weight: feature?.properties?.x ? 1.2 : 0.7,
                opacity: 0.78,
                fillColor: feature?.properties?.c || "#CBD5E1",
                fillOpacity: dptPlanOpacity,
                dashArray: feature?.properties?.h ? "4, 3" : undefined,
              })}
              onEachFeature={(feature, layer) => {
                const props = feature.properties || {};
                const block = props.b ? ` · แปลง ${escapeHtml(props.b)}` : "";
                layer.bindTooltip(
                  `<div style="font-family: 'IBM Plex Sans Thai', sans-serif; padding: 4px 6px; max-width: 270px;">
                    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                      <span style="width:10px;height:10px;border-radius:2px;background:${escapeHtml(props.c || '#CBD5E1')};flex:none;"></span>
                      <strong style="color:#0B3558;font-size:13px;">${escapeHtml(props.l || 'ไม่ระบุประเภท')}</strong>
                    </div>
                    <div style="font-size:11px;color:#475569;">รหัส ${escapeHtml(props.u || '—')}${block}</div>
                    <div style="font-size:10px;color:#64748B;margin-top:3px;">ผังเมืองรวมจังหวัด · ข้อมูล DPT ที่เก็บในระบบ</div>
                  </div>`,
                  { direction: "top", sticky: true }
                );
              }}
            />
          )}

          {/* Official DPT Purple Industrial Zones Layer (553 Polygons) */}
          {showPurpleZones && purpleZonesGeo && (
            <GeoJSON
              key="dpt-purple-industrial-zones"
              data={purpleZonesGeo}
              style={(feature) => ({
                color: feature?.properties?.color || "#4D004D",
                weight: 2,
                opacity: 0.85,
                fillColor: feature?.properties?.color || "#4D004D",
                fillOpacity: 0.38,
                dashArray: "5, 5",
              })}
              onEachFeature={(feature, layer) => {
                const props = feature.properties;
                layer.bindTooltip(
                  `<div style="font-family: 'IBM Plex Sans Thai', sans-serif; padding: 4px 6px; max-width: 250px;">
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                      <span style="width: 10px; height: 10px; border-radius: 2px; background: ${props.color || '#4D004D'}; flex: none;"></span>
                      <strong style="color: #4C1D95; font-size: 13px;">${props.name || 'เขตผังเมืองรวม'}</strong>
                    </div>
                    <div style="font-size: 11px; color: #6B21A8; font-weight: 600; margin-bottom: 2px;">
                      ${props.zone_desc || 'ผังเมืองสีม่วง'} (${props.pl_block || ''})
                    </div>
                    <div style="font-size: 11px; color: #475569;">
                      ${props.cw_name || ''} ${props.amphoe_nam || ''}
                    </div>
                    <div style="font-size: 10px; color: #64748B; margin-top: 3px; font-style: italic;">
                      สถานะ: ${props.status || 'ประกาศบังคับใช้'}
                    </div>
                  </div>`,
                  { direction: "top", sticky: true }
                );
              }}
            />
          )}

          {/* Province choropleth (overview mode) */}
          {!isProvinceMode && provinceGeo && (
            <GeoJSON
              key="choropleth"
              data={provinceGeo}
              style={getProvinceStyle}
              onEachFeature={onEachProvince}
            />
          )}

          {/* Selected province boundary outline (detail mode) */}
          {isProvinceMode && selectedProvinceBoundary && (
            <GeoJSON
              key={`boundary-${filters.selectedProvince}`}
              data={selectedProvinceBoundary}
              style={{
                color: "#F05223",
                weight: 3,
                opacity: 0.82,
                fillColor: "#0B3558",
                fillOpacity: 0.045,
                lineCap: "round",
                lineJoin: "round",
                className: "selected-province-boundary",
              }}
              interactive={false}
            />
          )}

          {/* Province zoom controller */}
          <FlyToProvince
            provinceGeo={provinceGeo}
            selectedProvince={filters.selectedProvince}
            countsMap={countsMap}
          />
          <FlyToOverview trigger={overviewTrigger} />
          <FlyToFactory factory={selectedFactory} />

          {/* Factory markers (province detail mode) */}
          {isProvinceMode && viewportFactories.length > 0 && (
            <MarkerClusterGroup
              key={`cluster-${filters.selectedProvince}`}
              chunkedLoading
              maxClusterRadius={60}
              spiderfyOnMaxZoom={true}
              showCoverageOnHover={false}
              disableClusteringAtZoom={14}
              iconCreateFunction={(cluster: { getChildCount: () => number }) => {
                const count = cluster.getChildCount();
                let sizeClass = 40;
                let fontSize = "13px";
                if (count > 500) { sizeClass = 56; fontSize = "15px"; }
                else if (count > 100) { sizeClass = 48; fontSize = "14px"; }

                return L.divIcon({
                  html: `<div style="
                    width: ${sizeClass}px; height: ${sizeClass}px;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(240, 82, 35, 0.85);
                    border-radius: 50%; color: white; font-weight: bold;
                    font-size: ${fontSize};
                    box-shadow: 0 4px 6px rgba(0,0,0,0.2);
                    border: 2px solid white;
                  ">${count.toLocaleString()}</div>`,
                  className: "marker-cluster",
                  iconSize: L.point(sizeClass, sizeClass),
                });
              }}
            >
              {viewportFactories.map((factory, index) => {
                const isSelected =
                  selectedFactory?.properties.เลขทะเบียน ===
                  factory.properties.เลขทะเบียน;
                
                // SIGNAL 39 Layer 1: 3-tier hazard color from DIW industry code
                const level = getHazardLevel(
                  factory.properties.เลขทะเบียน,
                  factory.properties.ประเภท
                );

                const lng = factory.geometry.coordinates[0];
                const lat = factory.geometry.coordinates[1];
                if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;

                return (
                  <Marker
                    key={`factory-${factory.properties.เลขทะเบียน}-${index}`}
                    position={[lat, lng]}
                    icon={getFactoryIcon(
                      level,
                      isSelected,
                      factory.properties.coordQuality === "centroid"
                    )}
                    eventHandlers={{ click: () => onFactorySelect(factory) }}
                  />
                );
              })}
            </MarkerClusterGroup>
          )}

          {userLocation && (
            <>
              <Marker position={[userLocation.lat, userLocation.lng]} icon={userLocationIcon}>
                <Popup>
                  <div style={{ fontFamily: "'Inter', sans-serif", textAlign: "center", padding: "4px" }}>
                    <strong style={{ color: "#0B3558" }}>บ้าน / ตำแหน่งของคุณ</strong>
                    <div style={{ fontSize: "12px", color: "#64748b" }}>
                      {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
                    </div>
                  </div>
                </Popup>
              </Marker>

              {filters.showOnlyInRadius && (
                <Circle
                  center={[userLocation.lat, userLocation.lng]}
                  radius={(filters.radiusKm ?? 10) * 1000}
                  pathOptions={{
                    color: "#F05223",
                    fillColor: "#F05223",
                    fillOpacity: 0.08,
                    weight: 1.5,
                    dashArray: "4 4",
                  }}
                />
              )}
            </>
          )}
        </MapContainer>
      </Box>
    );
  }
);

export default MapWrapper;
