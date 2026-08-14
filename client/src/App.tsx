import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { Analytics } from "@vercel/analytics/react";
import type {
  FactoryGeoJSON,
  UserLocation,
  FactoryFeature,
  FilterState,
} from "./types/factory";
import { useFactoriesApi, fetchFactoryDetail } from "./hooks/useFactoriesApi";
import { theme } from "./theme";
import MapPage from "./pages/MapPage";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { WatchlistProvider } from "./context/WatchlistContext";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const WasteMonitorPage = lazy(() => import("./pages/WasteMonitorPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const UserDiaryPage = lazy(() => import("./pages/UserDiaryPage"));

// Shareable URLs: read ?province=, ?factory= and ?type= once at startup
const initialParams = new URLSearchParams(window.location.search);
const initialProvince = initialParams.get("province") ?? "";
const initialFactoryId = initialParams.get("factory") ?? "";
// ?type= is a comma-separated list of DIW industry codes (ลำดับที่ 1-107)
const initialFactoryTypes = (initialParams.get("type") ?? "")
  .split(",")
  .filter((t) => /^\d{1,3}$/.test(t));

function App() {
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isLocationLoading, setIsLocationLoading] = useState(true);
  const [selectedFactory, setSelectedFactory] = useState<FactoryFeature | null>(
    null
  );
  // Factory id from a shared link, selected once its province's markers load
  const [pendingFactoryId, setPendingFactoryId] = useState(initialFactoryId);

  const [filters, setFilters] = useState<FilterState>({
    searchTerm: "",
    factoryTypes: initialFactoryTypes,
    districts: [],
    showOnlyInRadius: false,
    showHighRisk: false,
    selectedProvince: initialProvince,
  });

  // Fetch factories — lazy loads markers only when province selected
  const { factories: apiFactories, isLoading: isApiLoading, provinceCounts } = useFactoriesApi({
    filters,
    userLocation,
  });

  // Construct GeoJSON from API results (memoized so MapWrapper's React.memo works)
  const factoriesGeoJSON: FactoryGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection",
      features: apiFactories,
    }),
    [apiFactories]
  );

  // Province select handler (from map choropleth click)
  const handleProvinceSelect = useCallback((provinceTh: string) => {
    setFilters((prev) => ({ ...prev, selectedProvince: provinceTh }));
    setSelectedFactory(null);
  }, []);

  // Factory select handler — fetches full details from Supabase
  const handleFactorySelect = useCallback((factory: FactoryFeature | null) => {
    if (!factory) {
      setSelectedFactory(null);
      return;
    }

    // Show immediately with marker data
    setSelectedFactory(factory);

    // Fetch full details in background
    const factoryId = factory.properties.เลขทะเบียน;
    if (factoryId) {
      fetchFactoryDetail(factoryId).then((detail) => {
        if (!detail) return;
        // Only apply if this factory is still the selected one (avoids a
        // slow response overwriting a newer selection)
        setSelectedFactory((current) =>
          current?.properties.เลขทะเบียน === factoryId
            ? { ...current, properties: { ...current.properties, ...detail } }
            : current
        );
      });
    }
  }, []);

  // Select the factory from a shared link once its markers are available
  useEffect(() => {
    if (!pendingFactoryId || apiFactories.length === 0) return;
    const match = apiFactories.find(
      (f) => f.properties.เลขทะเบียน === pendingFactoryId
    );
    setPendingFactoryId("");
    if (match) handleFactorySelect(match);
  }, [pendingFactoryId, apiFactories, handleFactorySelect]);

  // Keep the URL shareable: reflect province + factory as query params
  useEffect(() => {
    if (window.location.pathname !== "/") return;
    const params = new URLSearchParams();
    if (filters.selectedProvince) params.set("province", filters.selectedProvince);
    if (filters.factoryTypes.length > 0) params.set("type", filters.factoryTypes.join(","));
    const factoryId = selectedFactory?.properties.เลขทะเบียน;
    if (factoryId) params.set("factory", factoryId);
    const query = params.toString();
    const url = query ? `/?${query}` : "/";
    if (url !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", url);
    }
  }, [filters.selectedProvince, filters.factoryTypes, selectedFactory]);

  // Mobile responsive state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Get user location with improved error handling
  useEffect(() => {
    const getLocation = () => {
      if (!navigator.geolocation) {
        console.log("Geolocation not supported, using fallback location");
        setLocationError("เบราว์เซอร์ไม่รองรับการระบุตำแหน่ง");
        setUserLocation({
          lat: 14.0504,
          lng: 101.3678,
        });
        setIsLocationLoading(false);
        return;
      }

      const options = {
        enableHighAccuracy: true,
        timeout: 10000, // 10 seconds timeout
        maximumAge: 300000, // 5 minutes cache
      };

      console.log("🌍 Requesting user location...");

      navigator.geolocation.getCurrentPosition(
        (position) => {
          console.log("✅ Location obtained:", {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
          setUserLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
          setLocationError(null);
          setIsLocationLoading(false);
        },
        (error) => {
          console.warn("⚠️ Geolocation error:", error.code, error.message);
          let errorMessage = "ไม่สามารถระบุตำแหน่งของคุณได้";

          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMessage = "คุณไม่อนุญาตให้เข้าถึงตำแหน่ง";
              break;
            case error.POSITION_UNAVAILABLE:
              errorMessage = "ข้อมูลตำแหน่งไม่พร้อมใช้งาน";
              break;
            case error.TIMEOUT:
              errorMessage = "หมดเวลาในการขอตำแหน่ง";
              break;
          }

          setLocationError(errorMessage);
          console.log("Using fallback location (Prachinburi)");
          setUserLocation({
            lat: 14.0504,
            lng: 101.3678,
          });
          setIsLocationLoading(false);
        },
        options
      );
    };

    getLocation();
  }, []);

  // Function to manually set location
  const setManualLocation = (lat: number, lng: number) => {
    setUserLocation({ lat, lng });
    setLocationError(null);
    console.log("📍 Manual location set:", { lat, lng });
  };

  return (
    <ChakraProvider theme={theme}>
      <AuthProvider>
        <WatchlistProvider>
          <Router>
            <Routes>
              <Route
                path="/"
                element={
                  <MapPage
                    factories={factoriesGeoJSON}
                    userLocation={userLocation}
                    selectedFactory={selectedFactory}
                    setSelectedFactory={handleFactorySelect}
                    filters={filters}
                    setFilters={setFilters}
                    locationError={locationError}
                    isLocationLoading={isLocationLoading}
                    setManualLocation={setManualLocation}
                    isMobileSidebarOpen={isMobileSidebarOpen}
                    setIsMobileSidebarOpen={setIsMobileSidebarOpen}
                    provinceCounts={provinceCounts}
                    onProvinceSelect={handleProvinceSelect}
                    isApiLoading={isApiLoading}
                  />
                }
              />
              <Route
                path="/dashboard"
                element={
                  <Suspense fallback={null}>
                    <DashboardPage />
                  </Suspense>
                }
              />
              <Route
                path="/waste-monitor"
                element={
                  <Suspense fallback={null}>
                    <WasteMonitorPage />
                  </Suspense>
                }
              />
              <Route
                path="/diary"
                element={
                  <Suspense fallback={null}>
                    <UserDiaryPage />
                  </Suspense>
                }
              />
              <Route
                path="/admin"
                element={
                  <Suspense fallback={null}>
                    <AdminPage />
                  </Suspense>
                }
              />
            </Routes>
          </Router>
          <Analytics />
        </WatchlistProvider>
      </AuthProvider>
    </ChakraProvider>
  );
}

export default App;
