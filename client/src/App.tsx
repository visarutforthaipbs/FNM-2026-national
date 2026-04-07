import { useState, useEffect, useCallback } from "react";
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
import DashboardPage from "./pages/DashboardPage";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";

function App() {
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [isLocationLoading, setIsLocationLoading] = useState(true);
  const [selectedFactory, setSelectedFactory] = useState<FactoryFeature | null>(
    null
  );

  const [filters, setFilters] = useState<FilterState>({
    searchTerm: "",
    factoryTypes: [],
    districts: [],
    showOnlyInRadius: false,
    showHighRisk: false,
    selectedProvince: "",
  });

  // Fetch factories — lazy loads markers only when province selected
  const { factories: apiFactories, isLoading: isApiLoading, provinceCounts } = useFactoriesApi({
    filters,
  });

  // Construct GeoJSON from API results
  const factoriesGeoJSON: FactoryGeoJSON = {
    type: "FeatureCollection",
    features: apiFactories,
  };

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
        if (detail) {
          setSelectedFactory({
            ...factory,
            properties: { ...factory.properties, ...detail },
          });
        }
      });
    }
  }, []);

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
          let errorMessage = "ไม่สามารถระบุตำแหน่งได้";

          switch (error.code) {
            case error.PERMISSION_DENIED:
              errorMessage =
                "การเข้าถึงตำแหน่งถูกปฏิเสธ กรุณาอนุญาตในการตั้งค่าเบราว์เซอร์";
              console.log("📍 Location access denied by user");
              break;
            case error.POSITION_UNAVAILABLE:
              errorMessage = "ไม่สามารถระบุตำแหน่งได้ในขณะนี้";
              console.log(
                "📍 Location unavailable (GPS disabled or no signal)"
              );
              break;
            case error.TIMEOUT:
              errorMessage = "หมดเวลาในการระบุตำแหน่ง";
              console.log("📍 Location request timed out");
              break;
            default:
              errorMessage = "เกิดข้อผิดพลาดในการระบุตำแหน่ง";
              console.warn("📍 Unexpected geolocation error:", error.message);
              break;
          }

          setLocationError(errorMessage);

          // Use fallback location (Prachinburi city center)
          console.log(
            "🏠 Using fallback location (Prachinburi city center: 14.0504, 101.3678)"
          );
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
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </Router>
      <Analytics />
    </ChakraProvider>
  );
}

export default App;
