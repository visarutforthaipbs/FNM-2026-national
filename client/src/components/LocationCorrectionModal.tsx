import React, { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  Icon,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
} from "@chakra-ui/react";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import type { FactoryFeature } from "../types/factory";
import { submitLocationCorrection } from "../hooks/useReports";
import {
  TILE_URLS,
  TILE_ATTRIBUTIONS,
  SATELLITE_LABELS_URL,
  SATELLITE_MAX_NATIVE_ZOOM,
} from "../utils/tiles";

// Leaflet maps inside a Chakra modal mount before the modal reaches its final
// size — invalidate once the animation settles or tiles render blank
const MapResizer: React.FC = () => {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [map]);
  return null;
};

const pinIcon = L.divIcon({
  html: `
    <svg width="36" height="44" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 3px 5px rgba(11,53,88,0.35));">
      <path d="M16 1C7.7 1 1 7.5 1 15.6C1 25.7 16 39 16 39S31 25.7 31 15.6C31 7.5 24.3 1 16 1Z" fill="#F05223" stroke="white" stroke-width="2"/>
      <circle cx="16" cy="15" r="5" fill="white"/>
    </svg>
  `,
  className: "correction-pin",
  iconSize: [36, 44],
  iconAnchor: [18, 44],
});

interface LocationCorrectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  factory: FactoryFeature;
}

/**
 * Tier-4 crowdsourced geocoding: the citizen drags a pin to the factory's
 * real position; the proposal lands in a moderated queue (admin approves it
 * into the factories table).
 */
const LocationCorrectionModal: React.FC<LocationCorrectionModalProps> = ({
  isOpen,
  onClose,
  factory,
}) => {
  const initialLat = factory.geometry.coordinates[1];
  const initialLng = factory.geometry.coordinates[0];
  const [position, setPosition] = useState<[number, number]>([initialLat, initialLng]);
  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Satellite by default: the whole task is "find this building", and imagery is
  // what makes a roof, a yard or an access road recognisable to someone who
  // lives next to it. The street map is a deliberate second choice, not a base.
  const [basemap, setBasemap] = useState<"satellite" | "street">("satellite");
  const markerRef = useRef<L.Marker | null>(null);

  // Open wide enough that the real factory is plausibly already on screen.
  // A tambon centroid can sit 5–15 km from the actual site, so starting at
  // building zoom would put the target off-screen in exactly the cases that most
  // need correcting. An exact pin, by contrast, only needs nudging.
  const initialZoom =
    factory.properties.coordQuality === "centroid" ? 13
    : factory.properties.coordQuality === "geocoded" ? 15
    : 17;

  useEffect(() => {
    if (isOpen) {
      setPosition([initialLat, initialLng]);
      setNote("");
      setIsSubmitted(false);
      setError(null);
    }
  }, [isOpen, initialLat, initialLng]);

  const moved =
    Math.abs(position[0] - initialLat) > 1e-6 || Math.abs(position[1] - initialLng) > 1e-6;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await submitLocationCorrection({
        factory_id: factory.properties.เลขทะเบียน,
        factory_name: factory.properties.ชื่อโรงงาน || undefined,
        lat: position[0],
        lng: position[1],
        note: note.trim() || undefined,
      });
      setIsSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ส่งข้อมูลไม่สำเร็จ");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} isCentered size={{ base: "full", md: "lg" }} motionPreset="slideInBottom" scrollBehavior="inside">
      <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.400" />
      <ModalContent borderRadius="2xl" boxShadow="xl" mx={{ base: 3, md: 4 }}>
        {isSubmitted ? (
          <ModalBody py={10} textAlign="center">
            <Flex w="56px" h="56px" mx="auto" mb={4} borderRadius="full" bg="green.50" align="center" justify="center">
              <Icon viewBox="0 0 24 24" boxSize={7} fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </Icon>
            </Flex>
            <Text fontWeight="700" color="slate.800" fontSize="lg">
              ขอบคุณที่ช่วยปรับปรุงข้อมูล
            </Text>
            <Text mt={2} fontSize="sm" color="slate.500">
              ตำแหน่งที่เสนอจะถูกตรวจสอบก่อนนำไปแสดงบนแผนที่
            </Text>
            <Button mt={6} w="full" variant="outline" borderRadius="xl" onClick={onClose}>
              ปิด
            </Button>
          </ModalBody>
        ) : (
          <>
            <ModalHeader pb={2}>
              <Text fontSize="lg" fontWeight="700" color="slate.800">
                ปักหมุดตำแหน่งจริงของโรงงาน
              </Text>
              <Text fontSize="xs" color="slate.400" fontWeight="400" noOfLines={1}>
                {factory.properties.ชื่อโรงงาน} — ลากหมุดไปยังตำแหน่งจริง
              </Text>
            </ModalHeader>
            <ModalBody pb={5}>
              <Box position="relative" borderRadius="xl" overflow="hidden" h={{ base: "240px", md: "300px" }} border="1px solid" borderColor="slate.100">
                <MapContainer
                  center={[initialLat, initialLng]}
                  zoom={initialZoom}
                  maxZoom={21}
                  style={{ height: "100%", width: "100%" }}
                >
                  <MapResizer />
                  {basemap === "satellite" ? (
                    // Imagery first: a citizen recognises their neighbour's
                    // factory by its roof, yard and access road, not by a street
                    // name. The labels layer goes on top because Esri's imagery
                    // carries no place names at all.
                    <>
                      <TileLayer
                        key="satellite"
                        url={TILE_URLS.satellite}
                        attribution={TILE_ATTRIBUTIONS.satellite}
                        maxNativeZoom={SATELLITE_MAX_NATIVE_ZOOM}
                        maxZoom={21}
                      />
                      <TileLayer
                        key="satellite-labels"
                        url={SATELLITE_LABELS_URL}
                        maxNativeZoom={SATELLITE_MAX_NATIVE_ZOOM}
                        maxZoom={21}
                      />
                    </>
                  ) : (
                    <TileLayer
                      key="street"
                      url={TILE_URLS.light}
                      attribution={TILE_ATTRIBUTIONS.light}
                      maxNativeZoom={19}
                      maxZoom={21}
                    />
                  )}
                  <Marker
                    position={position}
                    icon={pinIcon}
                    draggable
                    ref={markerRef}
                    eventHandlers={{
                      dragend: () => {
                        const pos = markerRef.current?.getLatLng();
                        if (pos) setPosition([pos.lat, pos.lng]);
                      },
                    }}
                  />
                </MapContainer>

                {/* Basemap toggle. Two options only, satellite first because
                    that is the one that makes a factory findable; the street map
                    stays one tap away for orientation. Sits above Leaflet's
                    panes (z-index 400) but below the modal itself. */}
                <Flex
                  position="absolute"
                  top={2}
                  right={2}
                  zIndex={500}
                  bg="white"
                  borderRadius="lg"
                  boxShadow="md"
                  overflow="hidden"
                  role="group"
                  aria-label="เลือกรูปแบบแผนที่"
                >
                  {(
                    [
                      { key: "satellite", label: "ภาพดาวเทียม" },
                      { key: "street", label: "แผนที่ถนน" },
                    ] as const
                  ).map((option) => (
                    <Button
                      key={option.key}
                      size="xs"
                      borderRadius="none"
                      fontSize="11px"
                      fontWeight="700"
                      px={3}
                      h="28px"
                      bg={basemap === option.key ? "primary.500" : "white"}
                      color={basemap === option.key ? "white" : "slate.600"}
                      _hover={{ bg: basemap === option.key ? "primary.600" : "slate.100" }}
                      aria-pressed={basemap === option.key}
                      onClick={() => setBasemap(option.key)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </Flex>
              </Box>

              <Flex mt={3} align="center" justify="space-between" gap={3}>
                <Text fontSize="xs" color="slate.500" fontFamily="'Inter', monospace">
                  {position[0].toFixed(5)}, {position[1].toFixed(5)}
                </Text>
                {moved && (
                  <Text fontSize="xs" color="primary.600" fontWeight="600">
                    ย้ายหมุดแล้ว
                  </Text>
                )}
              </Flex>

              <Input
                mt={3}
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                placeholder="หมายเหตุ เช่น ประตูทางเข้าอยู่ฝั่งถนนใหญ่ (ไม่บังคับ)"
                aria-label="หมายเหตุตำแหน่งที่ถูกต้อง"
                size="md"
                fontSize={{ base: "md", md: "sm" }}
                bg="slate.50"
                border="none"
                borderRadius="xl"
              />

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
                  isDisabled={!moved}
                  isLoading={isSubmitting}
                  loadingText="กำลังส่ง..."
                  onClick={handleSubmit}
                  _hover={{ bg: "primary.700" }}
                >
                  ส่งตำแหน่งที่ถูกต้อง
                </Button>
              </Flex>
              <Text mt={2} fontSize="10px" color="slate.400" textAlign="center">
                ตำแหน่งที่เสนอจะผ่านการตรวจสอบก่อนแสดงจริง
              </Text>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
};

export default LocationCorrectionModal;
