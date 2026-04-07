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

// Factory markers
const factoryIcon = L.divIcon({
  html: `
    <div style="width: 24px; height: 24px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" fill="#1A365D" stroke="white" stroke-width="2"/>
        <path d="M9 16V10H15V16" stroke="white" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 7H16" stroke="white" stroke-linecap="round"/>
        <path d="M12 7V10" stroke="white" stroke-linecap="round"/>
      </svg>
    </div>
  `,
  className: "custom-factory-marker",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12],
});

const selectedFactoryIcon = L.divIcon({
  html: `
    <div style="width: 32px; height: 32px; position: relative;">
      <div style="position: absolute; width: 100%; height: 100%; border-radius: 50%; background: rgba(26,54,93,0.4); animation: pulse 1.5s infinite;"></div>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="position: relative; z-index: 2;">
        <circle cx="12" cy="12" r="11" fill="#1A365D" stroke="white" stroke-width="2"/>
        <path d="M9 16V10H15V16" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 7H16" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        <path d="M12 7V10" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <style>@keyframes pulse { 0% { transform: scale(1); opacity: 0.6; } 70% { transform: scale(1.5); opacity: 0; } 100% { transform: scale(1.5); opacity: 0; } }</style>
    </div>
  `,
  className: "custom-factory-marker selected",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
});

const userLocationIcon = L.divIcon({
  html: `
    <div style="width: 28px; height: 28px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
         <circle cx="12" cy="12" r="10" fill="#f59e0b" stroke="white" stroke-width="2"/>
         <circle cx="12" cy="12" r="4" fill="white"/>
      </svg>
    </div>
  `,
  className: "custom-user-location-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

// ── Choropleth color scale ──
function getDensityColor(count: number): string {
  if (count >= 3000) return "#1A365D";
  if (count >= 1000) return "#2B6CB0";
  if (count >= 500)  return "#3182CE";
  if (count >= 200)  return "#63B3ED";
  if (count >= 50)   return "#90CDF4";
  if (count >= 10)   return "#BEE3F8";
  return "#EBF8FF";
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

    const geoLayer = L.geoJSON(feature as any);
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
          fillOpacity: count > 0 ? 0.7 : 0.15,
          color: "#1A365D",
          weight: 1,
          opacity: 0.4,
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
          `<div style="font-family: 'IBM Plex Sans Thai', 'Inter', sans-serif; text-align: center; padding: 4px 8px;">
            <strong style="color: #1A365D; font-size: 14px;">${thaiName}</strong>
            <div style="color: #64748b; font-size: 12px; margin-top: 2px;">
              ${count > 0 ? `${count.toLocaleString()} โรงงาน` : "ไม่มีข้อมูล"}
            </div>
          </div>`,
          { direction: "top", className: "province-tooltip", sticky: true }
        );

        const pathLayer = layer as L.Path;
        layer.on({
          mouseover: () => {
            pathLayer.setStyle({
              fillOpacity: 0.85,
              weight: 2,
              opacity: 0.8,
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
            <Flex direction="column" gap={1}>
              {[
                { color: "#1A365D", label: "3,000+" },
                { color: "#2B6CB0", label: "1,000–3,000" },
                { color: "#3182CE", label: "500–1,000" },
                { color: "#63B3ED", label: "200–500" },
                { color: "#90CDF4", label: "50–200" },
                { color: "#BEE3F8", label: "10–50" },
                { color: "#EBF8FF", label: "< 10" },
              ].map((item) => (
                <Flex key={item.label} align="center" gap={2}>
                  <Box w="14px" h="10px" borderRadius="2px" bg={item.color} />
                  <Text color="slate.500">{item.label}</Text>
                </Flex>
              ))}
            </Flex>
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
                color: "#1A365D",
                weight: 2,
                opacity: 0.6,
                fillOpacity: 0,
                dashArray: "6 4",
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
              iconCreateFunction={(cluster: any) => {
                const count = cluster.getChildCount();
                let sizeClass = 40;
                let fontSize = "13px";
                if (count > 500) { sizeClass = 56; fontSize = "15px"; }
                else if (count > 100) { sizeClass = 48; fontSize = "14px"; }

                return L.divIcon({
                  html: `<div style="
                    width: ${sizeClass}px; height: ${sizeClass}px;
                    display: flex; align-items: center; justify-content: center;
                    background: rgba(26, 54, 93, 0.85);
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

                const lng = factory.geometry.coordinates[0];
                const lat = factory.geometry.coordinates[1];
                if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;

                return (
                  <Marker
                    key={`factory-${factory.properties.เลขทะเบียน}-${index}`}
                    position={[lat, lng]}
                    icon={isSelected ? selectedFactoryIcon : factoryIcon}
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
                    <strong style={{ color: "#f59e0b" }}>ตำแหน่งของคุณ</strong>
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
