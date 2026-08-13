import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Icon,
  Input,
  Link,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
} from "@chakra-ui/react";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";

const THAILAND_CENTER: [number, number] = [13.2, 101.0];

const MapResizer: React.FC = () => {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [map]);
  return null;
};

// Recenters the map when the pin moves via the lat/lng text inputs
const RecenterOnChange: React.FC<{ position: [number, number] }> = ({ position }) => {
  const map = useMap();
  useEffect(() => {
    map.setView(position, map.getZoom() < 10 ? 14 : map.getZoom());
  }, [position, map]);
  return null;
};

const pinIcon = L.divIcon({
  html: `
    <svg width="36" height="44" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 3px 5px rgba(11,53,88,0.35));">
      <path d="M16 1C7.7 1 1 7.5 1 15.6C1 25.7 16 39 16 39S31 25.7 31 15.6C31 7.5 24.3 1 16 1Z" fill="#0B3558" stroke="white" stroke-width="2"/>
      <circle cx="16" cy="15" r="5" fill="white"/>
    </svg>
  `,
  className: "admin-position-pin",
  iconSize: [36, 44],
  iconAnchor: [18, 44],
});

interface Factory {
  id: string;
  name: string | null;
  address_full: string | null;
  province: string | null;
  district: string | null;
  sub_district: string | null;
  /** Present when the factory already has an approximate position to correct. */
  lat?: number | null;
  lng?: number | null;
  coord_precision?: string | null;
}

interface AdminSetPositionModalProps {
  isOpen: boolean;
  onClose: () => void;
  factory: Factory | null;
  onSaved: (id: string, lat: number, lng: number) => void;
  authFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  /** Admin collection to POST to. Defaults to the no-coordinates queue. */
  endpoint?: string;
}

const PRECISION_LABEL: Record<string, string> = {
  tambon: "ตำแหน่งโดยประมาณระดับตำบล (คลาดเคลื่อน 2–5 กม.)",
  street: "ตำแหน่งโดยประมาณจากที่อยู่",
};

const AdminSetPositionModal: React.FC<AdminSetPositionModalProps> = ({
  isOpen,
  onClose,
  factory,
  onSaved,
  authFetch,
  endpoint = "/api/admin/unmapped-factories",
}) => {
  const [position, setPosition] = useState<[number, number]>(THAILAND_CENTER);
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  // Where the pin started. Saving is only allowed once it has actually moved,
  // which is what stops a reviewer from certifying a tambon centroid as an
  // exact position simply by opening the dialog and pressing save.
  const startRef = useRef<[number, number]>(THAILAND_CENTER);

  const [resolvedDeeds, setResolvedDeeds] = useState<Record<string, { deed_no?: string; land_no?: string; lat?: number; lng?: number }>>({});

  useEffect(() => {
    fetch("/data/landsmaps_resolved.json")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const map: Record<string, { deed_no?: string; land_no?: string; lat?: number; lng?: number }> = {};
          data.forEach((item) => {
            if (item.id) map[item.id] = item;
          });
          setResolvedDeeds(map);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const start: [number, number] =
      typeof factory?.lat === "number" && typeof factory?.lng === "number"
        ? [factory.lat, factory.lng]
        : THAILAND_CENTER;
    startRef.current = start;
    setPosition(start);
    setLatInput(start === THAILAND_CENTER ? "" : start[0].toFixed(6));
    setLngInput(start === THAILAND_CENTER ? "" : start[1].toFixed(6));
    setError(null);
  }, [isOpen, factory?.id, factory?.lat, factory?.lng]);

  const applyTypedCoords = () => {
    const lat = parseFloat(latInput);
    const lng = parseFloat(lngInput);
    if (!isNaN(lat) && !isNaN(lng)) setPosition([lat, lng]);
  };

  const address = [factory?.address_full, factory?.sub_district, factory?.district, factory?.province]
    .filter(Boolean)
    .join(" ");
  const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

  const hasMoved =
    position[0] !== startRef.current[0] || position[1] !== startRef.current[1];

  const handleSave = async () => {
    if (!factory) return;
    setIsSaving(true);
    setError(null);
    try {
      await authFetch(`${endpoint}/${encodeURIComponent(factory.id)}`, {
        method: "POST",
        body: JSON.stringify({ lat: position[0], lng: position[1] }),
      });
      onSaved(factory.id, position[0], position[1]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setIsSaving(false);
    }
  };

  if (!factory) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered size="lg" motionPreset="slideInBottom">
      <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.400" />
      <ModalContent borderRadius="2xl" boxShadow="xl" mx={4} overflow="hidden">
        <ModalHeader pb={2}>
          <Text fontSize="lg" fontWeight="700" color="slate.800" noOfLines={1}>
            {factory.name || factory.id}
          </Text>
          <Text fontSize="xs" color="slate.400" fontWeight="400">
            {[factory.district, factory.province].filter(Boolean).join(" · ")}
          </Text>
        </ModalHeader>
        <ModalBody pb={5}>
          {address && (
            <Text fontSize="sm" color="slate.600" mb={2}>
              {address}
            </Text>
          )}
          <Link
            href={googleMapsUrl}
            isExternal
            fontSize="sm"
            color="primary.600"
            fontWeight="600"
            display="inline-flex"
            alignItems="center"
            gap={1}
          >
            ค้นหาที่อยู่นี้ใน Google Maps ↗
          </Link>
          {/* DOL LandsMaps Land Title Deed Lookup & Coordinate Quick-Apply */}
          {(() => {
            const matchedDeed = factory?.id ? resolvedDeeds[factory.id] : null;
            const text = address;
            const deedMatch = text.match(/(โฉนด|เลขที่โฉนด|โฉนดที่ดิน)\s*เลขที่?\s*(\d+[\d/|-]*)/);
            const landMatch = text.match(/(เลขที่ดิน|ดินเลขที่)\s*(\d+[\d/|-]*)/);
            const deedNo = matchedDeed?.deed_no || (deedMatch ? deedMatch[2] : null);
            const landNo = matchedDeed?.land_no || (landMatch ? landMatch[2] : null);

            if (!deedNo && !landNo) return null;

            const suggestedLat = matchedDeed?.lat;
            const suggestedLng = matchedDeed?.lng;

            return (
              <Box bg="purple.50" p={3.5} borderRadius="xl" border="1px solid" borderColor="purple.200" my={2}>
                <Flex align="center" justify="space-between" wrap="wrap" gap={2} mb={suggestedLat ? 2 : 0}>
                  <Box>
                    <Text fontSize="xs" fontWeight="700" color="purple.900">
                      📍 เอกสารสิทธิ์ที่ดิน & ค่าพิกัดแปลง (กรมที่ดิน DOL)
                    </Text>
                    <Text fontSize="xs" color="purple.700">
                      {deedNo ? `โฉนดที่ดินเลขที่ ${deedNo}` : ""} {landNo ? `เลขที่ดิน ${landNo}` : ""}
                    </Text>
                  </Box>
                  <Link
                    href="https://landsmaps.dol.go.th/"
                    isExternal
                    fontSize="xs"
                    color="white"
                    bg="purple.600"
                    px={3}
                    py={1.5}
                    borderRadius="lg"
                    fontWeight="600"
                    _hover={{ bg: "purple.700", textDecoration: "none" }}
                  >
                    เปิดค้นหาใน LandsMaps ↗
                  </Link>
                </Flex>

                {suggestedLat && suggestedLng && (
                  <Flex align="center" justify="space-between" bg="white" p={2.5} borderRadius="lg" border="1px solid" borderColor="purple.100" wrap="wrap" gap={2}>
                    <Box>
                      <Text fontSize="xs" fontWeight="600" color="slate.700">
                        ค่าพิกัดแปลง: {suggestedLat.toFixed(6)}, {suggestedLng.toFixed(6)}
                      </Text>
                      <Text fontSize="10px" color="slate.500">
                        กดปุ่มเพื่อวางพิกัดนี้บนแผนที่และตรวจสอบก่อนบันทึก
                      </Text>
                    </Box>
                    <Button
                      size="xs"
                      colorScheme="purple"
                      onClick={() => {
                        setPosition([suggestedLat, suggestedLng]);
                        setLatInput(suggestedLat.toFixed(6));
                        setLngInput(suggestedLng.toFixed(6));
                      }}
                    >
                      นำพิกัดแปลงปักบนแผนที่ 📍
                    </Button>
                  </Flex>
                )}
              </Box>
            );
          })()}

          <Text mt={1} mb={3} fontSize="10px" color="slate.400">
            เปิดดูตำแหน่งจริง แล้วคัดลอกพิกัด (คลิกขวา → "What's here?") มาใส่ด้านล่าง
          </Text>

          {factory.coord_precision && PRECISION_LABEL[factory.coord_precision] && (
            <Text
              mb={3}
              px={3}
              py={2}
              bg="orange.50"
              color="orange.800"
              borderRadius="lg"
              fontSize="11px"
              lineHeight="1.6"
            >
              หมุดตั้งต้นคือ{PRECISION_LABEL[factory.coord_precision]} —
              ต้องย้ายหมุดไปยังตำแหน่งจริงก่อนจึงจะบันทึกได้
            </Text>
          )}

          <Flex gap={2} mb={3}>
            <Input
              placeholder="Latitude"
              size="sm"
              value={latInput}
              onChange={(e) => setLatInput(e.target.value)}
              onBlur={applyTypedCoords}
              bg="slate.50"
              border="none"
              borderRadius="lg"
              fontFamily="'Inter', monospace"
            />
            <Input
              placeholder="Longitude"
              size="sm"
              value={lngInput}
              onChange={(e) => setLngInput(e.target.value)}
              onBlur={applyTypedCoords}
              bg="slate.50"
              border="none"
              borderRadius="lg"
              fontFamily="'Inter', monospace"
            />
          </Flex>

          <Box borderRadius="xl" overflow="hidden" h="280px" border="1px solid" borderColor="slate.100">
            <MapContainer center={position} zoom={6} style={{ height: "100%", width: "100%" }}>
              <MapResizer />
              <RecenterOnChange position={position} />
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
                attribution='© <a href="https://carto.com/">CARTO</a>'
              />
              <Marker
                position={position}
                icon={pinIcon}
                draggable
                ref={markerRef}
                eventHandlers={{
                  dragend: () => {
                    const pos = markerRef.current?.getLatLng();
                    if (pos) {
                      setPosition([pos.lat, pos.lng]);
                      setLatInput(pos.lat.toFixed(6));
                      setLngInput(pos.lng.toFixed(6));
                    }
                  },
                }}
              />
            </MapContainer>
          </Box>

          {error && (
            <Text mt={2} fontSize="xs" color="red.500" fontWeight="600">
              {error}
            </Text>
          )}

          <Flex mt={4} gap={2}>
            <Button variant="ghost" color="slate.400" borderRadius="xl" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button
              flex="1"
              bg="primary.600"
              color="white"
              borderRadius="xl"
              isDisabled={!hasMoved}
              isLoading={isSaving}
              loadingText="กำลังบันทึก..."
              onClick={handleSave}
              _hover={{ bg: "primary.700" }}
              leftIcon={
                <Icon viewBox="0 0 24 24" boxSize={4} fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                </Icon>
              }
            >
              บันทึกตำแหน่ง
            </Button>
          </Flex>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};

export default AdminSetPositionModal;
