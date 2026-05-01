import { useState, useCallback } from "react";
import { Box, Flex, IconButton, Icon, Text, Button, VStack, useBreakpointValue } from "@chakra-ui/react";
import { booleanPointInPolygon, point } from "@turf/turf";
import type { FactoryGeoJSON, UserLocation, FactoryFeature, FilterState } from "../types/factory";
import type { ProvinceCount } from "../hooks/useFactoriesApi";
import Sidebar from "../components/Sidebar";
import MapWrapper from "../components/MapWrapper";
import Navbar from "../components/Navbar";

interface MapPageProps {
  factories: FactoryGeoJSON | null;
  userLocation: UserLocation | null;
  selectedFactory: FactoryFeature | null;
  setSelectedFactory: (factory: FactoryFeature | null) => void;
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  locationError: string | null;
  isLocationLoading: boolean;
  setManualLocation: (lat: number, lng: number) => void;
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (isOpen: boolean) => void;
  provinceCounts: ProvinceCount[];
  onProvinceSelect: (provinceTh: string) => void;
  isApiLoading: boolean;
}

const MapPage: React.FC<MapPageProps> = ({
  factories,
  userLocation,
  selectedFactory,
  setSelectedFactory,
  filters,
  setFilters,
  locationError,
  isLocationLoading,
  setManualLocation,
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  provinceCounts,
  onProvinceSelect,
  isApiLoading
}) => {
  // Responsive hooks inside ChakraProvider
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false;
  const isTablet =
    useBreakpointValue({ base: false, md: true, lg: false }) ?? false;

  // Welcome popup state
  const [showWelcome, setShowWelcome] = useState(() => {
    return !localStorage.getItem("factory-nearme-visited");
  });
  const [isLocating, setIsLocating] = useState(false);

  // Auto-detect province from user coordinates
  const detectAndSelectProvince = useCallback(async (lat: number, lng: number) => {
    try {
      const res = await fetch("/data/thailand-provinces.json");
      const geo = await res.json() as GeoJSON.FeatureCollection;
      const pt = point([lng, lat]);
      for (const feature of geo.features) {
        if (booleanPointInPolygon(pt, feature as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)) {
          const nameEn = feature.properties?.NAME_1 as string;
          const matched = provinceCounts.find((pc) => pc.name_en === nameEn);
          if (matched) {
            onProvinceSelect(matched.name_th);
          }
          break;
        }
      }
    } catch (err) {
      console.error("Province detection failed:", err);
    }
  }, [provinceCounts, onProvinceSelect]);

  // Handle "find near me" CTA
  const handleFindNearMe = useCallback(async () => {
    setIsLocating(true);

    // If we already have a real user location (not fallback), use it
    if (userLocation && !locationError) {
      setFilters({ ...filters, showOnlyInRadius: true });
      await detectAndSelectProvince(userLocation.lat, userLocation.lng);
      localStorage.setItem("factory-nearme-visited", "1");
      setShowWelcome(false);
      setIsLocating(false);
      return;
    }

    // Otherwise request fresh geolocation
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          setManualLocation(latitude, longitude);
          setFilters({ ...filters, showOnlyInRadius: true });
          await detectAndSelectProvince(latitude, longitude);
          localStorage.setItem("factory-nearme-visited", "1");
          setShowWelcome(false);
          setIsLocating(false);
        },
        () => {
          // Location denied — just close popup, user can browse manually
          localStorage.setItem("factory-nearme-visited", "1");
          setShowWelcome(false);
          setIsLocating(false);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    } else {
      localStorage.setItem("factory-nearme-visited", "1");
      setShowWelcome(false);
      setIsLocating(false);
    }
  }, [userLocation, locationError, filters, setFilters, setManualLocation, detectAndSelectProvince]);

  const handleSkipWelcome = () => {
    localStorage.setItem("factory-nearme-visited", "1");
    setShowWelcome(false);
  };

  return (
    <Box h="100vh" w="100vw" overflow="hidden" bg="slate.50" display="flex" flexDirection="column">
      <Navbar />
      <Flex flex="1" position="relative" overflow="hidden">
        {/* Mobile Menu Button — minimal, no decoration */}
        {isMobile && (
          <Box
            position="absolute"
            top={3}
            left={3}
            zIndex={1100}
          >
            <IconButton
              aria-label="Menu"
              icon={<Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18" /></Icon>}
              size="sm"
              bg="white"
              color="slate.600"
              boxShadow="sm"
              borderRadius="lg"
              border="1px solid"
              borderColor="slate.100"
              _hover={{ bg: "slate.50" }}
              onClick={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
            />
          </Box>
        )}

        {/* Sidebar — clean edge, no heavy shadow */}
        <Box
          position={isMobile ? "fixed" : "relative"}
          left={isMobile && !isMobileSidebarOpen ? "-100%" : "0"}
          top={0}
          zIndex={1000}
          h="full"
          w={isMobile ? "85vw" : isTablet ? "340px" : "380px"}
          maxW={isMobile ? "380px" : "none"}
          transition="left 0.25s ease"
          boxShadow={isMobile ? "lg" : "none"}
        >
          <Sidebar
            factories={factories}
            selectedFactory={selectedFactory}
            filters={filters}
            onFiltersChange={setFilters}
            onFactorySelect={(factory) => {
              setSelectedFactory(factory);
              // Close mobile sidebar when factory is selected
              if (isMobile) {
                setIsMobileSidebarOpen(false);
              }
            }}
            userLocation={userLocation}
            locationError={locationError}
            isLocationLoading={isLocationLoading}
            onManualLocationSet={setManualLocation}
            isMobile={isMobile}
            isTablet={isTablet}
            onMobileClose={() => setIsMobileSidebarOpen(false)}
            provinceCounts={provinceCounts}
            onProvinceSelect={onProvinceSelect}
          />
        </Box>

        {/* Mobile Overlay — subtle, no heavy blur */}
        {isMobile && isMobileSidebarOpen && (
          <Box
            position="fixed"
            top={0}
            left={0}
            w="100vw"
            h="100vh"
            bg="blackAlpha.300"
            zIndex={999}
            onClick={() => setIsMobileSidebarOpen(false)}
          />
        )}

        {/* Map Area */}
        <Box flex="1" position="relative" w="100%">
          <MapWrapper
            factories={factories}
            userLocation={userLocation}
            selectedFactory={selectedFactory}
            onFactorySelect={setSelectedFactory}
            filters={filters}
            onProvinceSelect={onProvinceSelect}
            provinceCounts={provinceCounts}
            isMobile={isMobile}
            isTablet={isTablet}
            isLoading={isApiLoading}
          />
        </Box>
      </Flex>

      {/* SIGNAL 39: Welcome Modal — High-Surprisal First, Minimal Cognitive Tax */}
      {showWelcome && (
        <Box
          position="fixed"
          top={0}
          left={0}
          w="100vw"
          h="100vh"
          bg="blackAlpha.600"
          backdropFilter="blur(8px)"
          zIndex={2000}
          display="flex"
          alignItems="center"
          justifyContent="center"
          p={4}
        >
          <VStack
            bg="white"
            borderRadius="2xl"
            p={isMobile ? 8 : 12}
            maxW="420px"
            w="full"
            spacing={6}
            boxShadow="2xl"
            textAlign="center"
          >
            {/* LAYER 1: Visual hook — icon communicates purpose (map/location) */}
            <Box
              w="64px"
              h="64px"
              borderRadius="full"
              bg="primary.50"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Icon viewBox="0 0 24 24" w={8} h={8} color="primary.600">
                <path
                  fill="currentColor"
                  d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"
                />
              </Icon>
            </Box>

            {/* LAYER 2: One-sentence value prop — 8 words max */}
            <VStack spacing={2}>
              <Text fontSize="2xl" fontWeight="bold" color="slate.800" lineHeight="short">
                ค้นหาโรงงานใกล้บ้านคุณ
              </Text>
              <Text fontSize="sm" color="slate.500" fontWeight="medium">
                63,790+ โรงงานทั่วประเทศไทย
              </Text>
            </VStack>

            {/* LAYER 2: Single primary CTA — clear action, no competition */}
            <Button
              w="full"
              size="lg"
              bg="primary.600"
              color="white"
              fontWeight="600"
              borderRadius="xl"
              py={6}
              _hover={{ bg: "primary.700" }}
              _active={{ bg: "primary.800" }}
              onClick={handleFindNearMe}
              isLoading={isLocating}
              loadingText="ระบุตำแหน่ง..."
              leftIcon={
                <Icon viewBox="0 0 24 24" w={5} h={5} fill="currentColor">
                  <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
                </Icon>
              }
            >
              ค้นหาโรงงานใกล้ฉัน
            </Button>

            {/* LAYER 3: Secondary action — minimal visual weight, low cognitive tax */}
            <Button
              size="sm"
              variant="ghost"
              color="slate.400"
              fontWeight="normal"
              _hover={{ color: "slate.600" }}
              onClick={handleSkipWelcome}
            >
              ดูภาพรวมทั้งประเทศ
            </Button>
          </VStack>
        </Box>
      )}
    </Box>
  );
};

export default MapPage;
