import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, Flex, Select, Button, Icon } from "@chakra-ui/react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Circle,
  GeoJSON,
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
import { getHazardLevel, HAZARD_COLORS } from "../utils/hazard";
import type { HazardLevel } from "../utils/hazard";
import type { ProvinceCount } from "../hooks/useFactoriesApi";

const TILE_URLS = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
  satellite:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  openstreet: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
};

const TILE_ATTRIBUTIONS = {
  light: '© <a href="https://carto.com/">CARTO</a>',
  dark: '© <a href="https://carto.com/">CARTO</a>',
  satellite: '© <a href="https://www.esri.com/">Esri</a>',
  openstreet:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

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

const MARKER_STYLE: Record<HazardLevel, { color: string; detail: string; pulse: string }> = {
  hazard: { color: HAZARD_COLORS.hazard, detail: "#B91C1C", pulse: "239, 68, 68" },
  type3: { color: HAZARD_COLORS.type3, detail: "#B45309", pulse: "245, 158, 11" },
  general: { color: HAZARD_COLORS.general, detail: "#087F5B", pulse: "16, 185, 129" },
};

const buildFactoryIcon = (level: HazardLevel, isSelected: boolean) => {
  const width = isSelected ? 38 : 30;
  const height = isSelected ? 46 : 38;
  const { color, detail: detailColor, pulse: pulseColor } = MARKER_STYLE[level];

  return L.divIcon({
    html: `
      <div style="width: ${width}px; height: ${height}px; position: relative;">
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
        <svg width="${width}" height="${height}" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="position: relative; z-index: 2; filter: drop-shadow(0 3px 5px rgba(11,53,88,0.28));">
          <path d="M16 1C7.7 1 1 7.5 1 15.6C1 25.7 16 39 16 39S31 25.7 31 15.6C31 7.5 24.3 1 16 1Z" fill="${color}" stroke="white" stroke-width="2"/>
          <path d="M7.5 24.5V14L12.5 16.8V12.5L17.7 15.5V10.5L24 14.1V24.5H7.5Z" fill="white"/>
          <path d="M11 22V19.5M15.2 22V19.5M19.5 22V19.5" stroke="${detailColor}" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>
    `,
    className: `custom-factory-marker ${isSelected ? 'selected' : ''} ${level}`,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    popupAnchor: [0, -height],
  });
};

// Pre-created icon instances — only 6 combinations exist, so never rebuild per marker
const FACTORY_ICONS = {
  "hazard-selected": buildFactoryIcon("hazard", true),
  "hazard-normal": buildFactoryIcon("hazard", false),
  "type3-selected": buildFactoryIcon("type3", true),
  "type3-normal": buildFactoryIcon("type3", false),
  "general-selected": buildFactoryIcon("general", true),
  "general-normal": buildFactoryIcon("general", false),
};

const getFactoryIcon = (level: HazardLevel, isSelected: boolean) =>
  FACTORY_ICONS[`${level}-${isSelected ? "selected" : "normal"}`];

const FactoryLegendMarker: React.FC<{ level: HazardLevel }> = ({ level }) => {
  const { color, detail: detailColor } = MARKER_STYLE[level];

  return (
    <svg
      width="24"
      height="30"
      viewBox="0 0 32 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flex: "0 0 auto", filter: "drop-shadow(0 2px 3px rgba(11,53,88,0.18))" }}
    >
      <path
        d="M16 1C7.7 1 1 7.5 1 15.6C1 25.7 16 39 16 39S31 25.7 31 15.6C31 7.5 24.3 1 16 1Z"
        fill={color}
        stroke="white"
        strokeWidth="2"
      />
      <path d="M7.5 24.5V14L12.5 16.8V12.5L17.7 15.5V10.5L24 14.1V24.5H7.5Z" fill="white" />
      <path
        d="M11 22V19.5M15.2 22V19.5M19.5 22V19.5"
        stroke={detailColor}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
};

const userLocationIcon = L.divIcon({
  html: `
    <div style="width: 40px; height: 48px; filter: drop-shadow(0 3px 6px rgba(11,53,88,0.3));">
      <svg width="40" height="48" viewBox="0 0 40 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="19" r="19" fill="#F05223" opacity="0.2"/>
        <path d="M20 2C10.6 2 3 9.5 3 18.7C3 30.1 20 46 20 46S37 30.1 37 18.7C37 9.5 29.4 2 20 2Z" fill="#0B3558" stroke="white" stroke-width="2.5"/>
        <path d="M11.5 19L20 12L28.5 19V28.2H22.5V22.2H17.5V28.2H11.5V19Z" fill="#F8FAFC"/>
        <path d="M9.5 19L20 10.3L30.5 19" stroke="#F05223" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  `,
  className: "custom-user-location-marker",
  iconSize: [40, 48],
  iconAnchor: [20, 46],
  popupAnchor: [0, -46],
});

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
  }) => {
    const isProvinceMode = !!filters.selectedProvince;

    // Auto-detect dark mode
    const getPreferredTile = (): keyof typeof TILE_URLS => {
      if (typeof window !== 'undefined' && window.matchMedia) {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      return 'light';
    };

    const [selectedTile, setSelectedTile] =
      React.useState<keyof typeof TILE_URLS>(getPreferredTile);

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
    }, []);

    // Build counts lookup: English name → ProvinceCount
    const countsMap = useMemo(() => {
      const m = new Map<string, ProvinceCount>();
      provinceCounts.forEach((pc) => m.set(pc.name_en, pc));
      return m;
    }, [provinceCounts]);

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
        {/* Map Controls Card */}
        <Box
          position="absolute"
          top={isMobile ? "16" : "4"}
          right="4"
          zIndex="1000"
          bg="white"
          borderRadius="xl"
          boxShadow="lg"
          p={2}
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
          </Select>
        </Box>

        {/* Back to overview button */}
        {isProvinceMode && (
          <Box
            position="absolute"
            top={isMobile ? "16" : "4"}
            left={isMobile ? "14" : "4"}
            zIndex="1000"
          >
            <Button
              size="sm"
              bg="white"
              color="slate.700"
              boxShadow="lg"
              borderRadius="xl"
              border="1px solid"
              borderColor="slate.100"
              _hover={{ bg: "slate.50" }}
              onClick={handleBackToOverview}
              leftIcon={
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </Icon>
              }
            >
              ภาพรวมทั้งประเทศ
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
        {isProvinceMode && (
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
        {!isProvinceMode && (
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
          </Box>
        )}

        <MapContainer
          center={[13.2, 101.0]}
          zoom={6}
          style={{ height: "100%", width: "100%" }}
          zoomControl={false}
        >
          <TileLayer
            url={TILE_URLS[selectedTile]}
            attribution={TILE_ATTRIBUTIONS[selectedTile]}
          />

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
                    icon={getFactoryIcon(level, isSelected)}
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
                  radius={10000}
                  pathOptions={{
                    color: "#3b82f6",
                    fillColor: "#3b82f6",
                    fillOpacity: 0.1,
                    weight: 1,
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
