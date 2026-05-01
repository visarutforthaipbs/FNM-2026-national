import React, { useMemo, useState } from "react";
import {
  Box,
  Text,
  Input,
  Button,
  Flex,
  Badge,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  FormControl,
  FormLabel,
  VStack,
  HStack,
  Icon,
  IconButton,
  InputGroup,
  InputLeftElement,
  Select,
} from "@chakra-ui/react";
import type {
  FactoryGeoJSON,
  FactoryFeature,
  FilterState,
  UserLocation,
} from "../types/factory";
import { HIGH_RISK_FACTORY_TYPES } from "../types/factory";
import type { ProvinceCount } from "../hooks/useFactoriesApi";
import FactoryCard from "./FactoryCard";

// Inline Icons
const SearchIcon = (props: any) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Icon>
);



interface SidebarProps {
  factories: FactoryGeoJSON | null;
  selectedFactory: FactoryFeature | null;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  onFactorySelect: (factory: FactoryFeature | null) => void;
  userLocation: UserLocation | null;
  locationError: string | null;
  isLocationLoading: boolean;
  onManualLocationSet: (lat: number, lng: number) => void;
  isMobile?: boolean;
  isTablet?: boolean;
  onMobileClose?: () => void;
  provinceCounts?: ProvinceCount[];
  onProvinceSelect?: (provinceTh: string) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  factories,
  selectedFactory,
  filters,
  onFiltersChange,
  onFactorySelect,
  userLocation,
  isLocationLoading,
  onManualLocationSet,
  isMobile = false,
  onMobileClose,
  provinceCounts = [],
  onProvinceSelect,
}) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [manualLat, setManualLat] = useState<string>("13.7563");
  const [manualLng, setManualLng] = useState<string>("100.5018");

  // Removed client-side province computation in favor of API data passed via props


  // Filter factories logic
  const filteredFactories = useMemo(() => {
    if (!factories) return [];

    return factories.features.filter((factory) => {
      const props = factory.properties;

      // Province filter
      if (filters.selectedProvince && props.จังหวัด !== filters.selectedProvince) {
        return false;
      }

      // Search term filter
      if (filters.searchTerm) {
        const searchLower = filters.searchTerm.toLowerCase();
        const matchesSearch =
          props.ชื่อโรงงาน.toLowerCase().includes(searchLower) ||
          props.ผู้ประกอบก.toLowerCase().includes(searchLower) ||
          props.ประกอบกิจก.toLowerCase().includes(searchLower);

        if (!matchesSearch) return false;
      }

      // High-risk filter
      if (filters.showHighRisk) {
        if (!HIGH_RISK_FACTORY_TYPES.includes(props.ประเภท)) return false;
      }

      // Radius filter
      if (filters.showOnlyInRadius && userLocation) {
        const factoryLat = factory.geometry.coordinates[1];
        const factoryLng = factory.geometry.coordinates[0];
        const distance =
          Math.sqrt(
            Math.pow(factoryLat - userLocation.lat, 2) +
            Math.pow(factoryLng - userLocation.lng, 2)
          ) * 111;

        if (distance > 10) return false;
      }

      return true;
    });
  }, [factories, filters, userLocation]);

  // Sort by distance (nearest first) then limit for performance
  const displayedFactories = useMemo(() => {
    if (!userLocation) return filteredFactories.slice(0, 200);

    const { lat, lng } = userLocation;
    return [...filteredFactories]
      .sort((a, b) => {
        const dA = Math.pow(a.geometry.coordinates[1] - lat, 2) + Math.pow(a.geometry.coordinates[0] - lng, 2);
        const dB = Math.pow(b.geometry.coordinates[1] - lat, 2) + Math.pow(b.geometry.coordinates[0] - lng, 2);
        return dA - dB;
      })
      .slice(0, 200);
  }, [filteredFactories, userLocation]);

  const totalCount = filteredFactories.length;
  const displayedCount = displayedFactories.length;

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({
      ...filters,
      searchTerm: e.target.value,
    });
  };

  const handleRadiusToggle = () => {
    onFiltersChange({
      ...filters,
      showOnlyInRadius: !filters.showOnlyInRadius,
    });
  };

  const handleHighRiskToggle = () => {
    onFiltersChange({
      ...filters,
      showHighRisk: !filters.showHighRisk,
    });
  };

  const clearFilters = () => {
    onFiltersChange({
      searchTerm: "",
      factoryTypes: [],
      districts: [],
      showOnlyInRadius: false,
      showHighRisk: false,
      selectedProvince: "",
    });
  };

  const handleManualLocationSubmit = () => {
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);

    if (!isNaN(lat) && !isNaN(lng)) {
      onManualLocationSet(lat, lng);
      onClose();
    }
  };

  const hasActiveFilters =
    filters.searchTerm ||
    filters.showOnlyInRadius ||
    filters.showHighRisk ||
    filters.selectedProvince;

  return (
    <Box
      w="full"
      h="full"
      bg="slate.50"
      borderRight={isMobile ? "none" : "1px solid"}
      borderColor="slate.100"
      overflow="hidden"
      display="flex"
      flexDirection="column"
    >
      {/* LAYER 2: Chunked Gateway — Search & Filters */}
      {/* Generous padding (p-6) for cognitive breathing room */}
      <Box
        p={6}
        bg="white"
        zIndex={10}
      >
        {/* Mobile close — minimal, no decorative weight */}
        {isMobile && onMobileClose && (
          <Flex justify="flex-end" mb={2}>
            <Button
              size="xs"
              variant="ghost"
              onClick={onMobileClose}
              color="slate.400"
              _hover={{ color: "slate.600" }}
            >
              ✕
            </Button>
          </Flex>
        )}

        {/* Search — Primary action, prominent placement */}
        <InputGroup size="lg">
          <InputLeftElement pointerEvents="none" color="slate.300">
            <SearchIcon boxSize={5} />
          </InputLeftElement>
          <Input
            placeholder="ค้นหาชื่อโรงงาน..."
            value={filters.searchTerm}
            onChange={handleSearchChange}
            bg="slate.50"
            border="none"
            _focus={{
              bg: "white",
              boxShadow: "0 0 0 2px rgba(26, 54, 93, 0.15)",
            }}
            fontSize="md"
            borderRadius="xl"
          />
        </InputGroup>

        {/* Province — Single select, semantic grouping with search */}
        <Select
          mt={3}
          value={filters.selectedProvince}
          onChange={(e) => {
            const val = e.target.value;
            onFiltersChange({ ...filters, selectedProvince: val });
            if (onProvinceSelect) onProvinceSelect(val);
          }}
          size="md"
          bg="slate.50"
          border="none"
          _focus={{
            bg: "white",
            boxShadow: "0 0 0 2px rgba(26, 54, 93, 0.15)",
          }}
          borderRadius="xl"
          fontWeight="medium"
          color={filters.selectedProvince ? "slate.800" : "slate.400"}
        >
          <option value="">ทุกจังหวัด ({provinceCounts.reduce((s, p) => s + p.count, 0).toLocaleString()})</option>
          {provinceCounts
            .sort((a, b) => b.count - a.count)
            .map((pc) => (
              <option key={pc.name_th} value={pc.name_th}>
                {pc.name_th} ({pc.count.toLocaleString()})
              </option>
            ))}
        </Select>

        {/* Filter Chips — Rule of Three: max 3 action chunks */}
        <HStack spacing={2} mt={4} flexWrap="wrap">
          <Button
            size="sm"
            borderRadius="full"
            variant="ghost"
            bg={filters.showHighRisk ? "red.50" : "slate.50"}
            color={filters.showHighRisk ? "red.600" : "slate.500"}
            fontWeight={filters.showHighRisk ? "600" : "400"}
            onClick={handleHighRiskToggle}
            flexShrink={0}
            _hover={{ bg: filters.showHighRisk ? "red.100" : "slate.100" }}
          >
            {filters.showHighRisk && "●  "}เสี่ยงสูง
          </Button>

          {userLocation && (
            <Button
              size="sm"
              borderRadius="full"
              variant="ghost"
              bg={filters.showOnlyInRadius ? "primary.50" : "slate.50"}
              color={filters.showOnlyInRadius ? "primary.600" : "slate.500"}
              fontWeight={filters.showOnlyInRadius ? "600" : "400"}
              onClick={handleRadiusToggle}
              flexShrink={0}
              _hover={{ bg: filters.showOnlyInRadius ? "primary.100" : "slate.100" }}
            >
              {filters.showOnlyInRadius && "●  "}10 กม.
            </Button>
          )}

          {hasActiveFilters && (
            <Button
              size="sm"
              variant="ghost"
              color="slate.400"
              onClick={clearFilters}
              fontSize="xs"
              flexShrink={0}
              _hover={{ color: "slate.600" }}
            >
              ล้าง
            </Button>
          )}
        </HStack>
      </Box>

      {/* LAYER 1: Subconscious Hook — Location + Count signal */}
      {/* Minimal info bar: location dot + result count. No reading required for hierarchy */}
      <Flex
        px={6}
        py={3}
        bg="slate.50"
        align="center"
        justify="space-between"
        borderTop="1px solid"
        borderBottom="1px solid"
        borderColor="slate.100"
      >
        {/* Location indicator — pre-attentive color dot */}
        <Flex align="center" gap={2}>
          <Box w="6px" h="6px" borderRadius="full" bg={userLocation ? "accent.green" : "slate.300"} />
          {isLocationLoading ? (
            <Text fontSize="xs" color="slate.400">ระบุตำแหน่ง...</Text>
          ) : userLocation ? (
            <Text fontSize="xs" color="slate.400" fontFamily="'Inter', monospace">
              {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
            </Text>
          ) : (
            <Text fontSize="xs" color="slate.400">ไม่พบตำแหน่ง</Text>
          )}
          <Button
            size="xs"
            variant="ghost"
            color="slate.400"
            onClick={onOpen}
            px={1}
            minW="auto"
            fontSize="xs"
            _hover={{ color: "primary.500" }}
          >
            แก้ไข
          </Button>
        </Flex>

        {/* Result count — key metric, bold for signal */}
        <Text fontSize="xs" fontWeight="600" color="slate.500">
          {displayedCount < totalCount
            ? `${displayedCount.toLocaleString()} / ${totalCount.toLocaleString()}`
            : totalCount.toLocaleString()
          }
        </Text>
      </Flex>

      {/* LAYER 3: Conscious Deep-Dive — Factory detail or list */}
      <Box flex="1" overflowY="auto" py={2} pb={20}>
        {/* SIGNAL 39: Selected Factory Detail — Progressive Disclosure */}
        {selectedFactory ? (
          <Box px={5} py={4}>
            {/* LAYER 1: Back navigation — minimal visual weight */}
            <Flex align="center" mb={4}>
              <IconButton
                aria-label="Back to list"
                icon={
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </Icon>
                }
                size="sm"
                variant="ghost"
                color="slate.500"
                mr={2}
                borderRadius="full"
                onClick={() => onFactorySelect(null)}
              />
              <Text fontSize="xs" color="slate.400">กลับไปรายการ</Text>
            </Flex>

            {/* LAYER 2: Primary info — factory name + risk signal */}
            <Flex align="flex-start" gap={3} mb={3}>
              {/* Risk indicator dot */}
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                bg={HIGH_RISK_FACTORY_TYPES.includes(selectedFactory.properties.ประเภท) ? "red.500" : "green.500"}
                mt={1.5}
                flexShrink={0}
              />
              <Text fontWeight="700" color="slate.900" fontSize="lg" lineHeight="1.3" flex="1">
                {selectedFactory.properties.ชื่อโรงงาน}
              </Text>
            </Flex>

            {/* LAYER 2: Location badges — geographic context */}
            <Flex wrap="wrap" gap={2} mb={5}>
              <Badge 
                bg={HIGH_RISK_FACTORY_TYPES.includes(selectedFactory.properties.ประเภท) ? "red.50" : "green.50"}
                color={HIGH_RISK_FACTORY_TYPES.includes(selectedFactory.properties.ประเภท) ? "red.700" : "green.700"}
                borderRadius="full" 
                px={3} 
                fontSize="xs"
                fontWeight="600"
              >
                จำพวก {selectedFactory.properties.ประเภท}
              </Badge>
              {selectedFactory.properties.อำเภอ && (
                <Badge colorScheme="gray" variant="subtle" borderRadius="full" px={3} fontSize="xs">
                  {selectedFactory.properties.อำเภอ}
                </Badge>
              )}
              {selectedFactory.properties.จังหวัด && (
                <Badge bg="primary.50" color="primary.700" borderRadius="full" px={3} fontSize="xs">
                  {selectedFactory.properties.จังหวัด}
                </Badge>
              )}
            </Flex>

            <VStack spacing={4} align="stretch">
              {/* Operator */}
              <Box>
                <Text fontSize="xs" color="slate.400" fontWeight="500" mb={1}>ผู้ประกอบการ</Text>
                <Text fontSize="sm" color="slate.700" fontWeight="medium">
                  {selectedFactory.properties.ผู้ประกอบก || (
                    <Text as="span" color="slate.300">กำลังโหลด...</Text>
                  )}
                </Text>
              </Box>

              {/* Business type */}
              <Box>
                <Text fontSize="xs" color="slate.400" fontWeight="500" mb={1}>ประเภทกิจการ</Text>
                <Text fontSize="sm" color="slate.700" fontWeight="medium">
                  {selectedFactory.properties.ประกอบกิจก || (
                    <Text as="span" color="slate.300">กำลังโหลด...</Text>
                  )}
                </Text>
              </Box>

              {/* Registration */}
              <Box>
                <Text fontSize="xs" color="slate.400" fontWeight="500" mb={1}>เลขทะเบียน</Text>
                <Text fontSize="sm" color="slate.700" fontFamily="'Inter', monospace">
                  {selectedFactory.properties.เลขทะเบียน}
                </Text>
              </Box>

              {/* Address */}
              {selectedFactory.properties.ที่อยู่ && (
                <Box>
                  <Text fontSize="xs" color="slate.400" fontWeight="500" mb={1}>ที่อยู่</Text>
                  <Text fontSize="sm" color="slate.700">
                    {selectedFactory.properties.ที่อยู่}
                  </Text>
                </Box>
              )}

              {/* Stats */}
              {(selectedFactory.properties.เงินลงทุน || selectedFactory.properties.แรงม้า || selectedFactory.properties.คนงานชาย || selectedFactory.properties.คนงานหญิง) && (
                <Flex wrap="wrap" gap={4} pt={3} borderTop="1px solid" borderColor="slate.100">
                  {selectedFactory.properties.เงินลงทุน ? (
                    <Box>
                      <Text fontSize="xs" color="slate.400">เงินลงทุน</Text>
                      <Text fontSize="sm" fontWeight="bold" color="green.600">
                        {selectedFactory.properties.เงินลงทุน.toLocaleString()} บาท
                      </Text>
                    </Box>
                  ) : null}
                  {selectedFactory.properties.แรงม้า ? (
                    <Box>
                      <Text fontSize="xs" color="slate.400">เครื่องจักร</Text>
                      <Text fontSize="sm" fontWeight="bold" color="orange.600">
                        {selectedFactory.properties.แรงม้า.toLocaleString()} HP
                      </Text>
                    </Box>
                  ) : null}
                  {(selectedFactory.properties.คนงานชาย || selectedFactory.properties.คนงานหญิง) ? (
                    <Box>
                      <Text fontSize="xs" color="slate.400">คนงาน</Text>
                      <Text fontSize="sm" fontWeight="bold" color="blue.600">
                        {((selectedFactory.properties.คนงานชาย || 0) + (selectedFactory.properties.คนงานหญิง || 0)).toLocaleString()} คน
                      </Text>
                    </Box>
                  ) : null}
                </Flex>
              )}

              {/* Phone */}
              {selectedFactory.properties.โทรศัพท์ && (
                <Button
                  size="sm"
                  width="full"
                  colorScheme="green"
                  variant="solid"
                  mt={2}
                  onClick={() => window.open(`tel:${selectedFactory.properties.โทรศัพท์}`)}
                  leftIcon={
                    <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                    </Icon>
                  }
                >
                  โทร {selectedFactory.properties.โทรศัพท์}
                </Button>
              )}

              {/* Coordinates */}
              <Box pt={2} borderTop="1px solid" borderColor="slate.100">
                <Text fontSize="xs" color="slate.400" fontWeight="500" mb={1}>พิกัด</Text>
                <Text fontSize="xs" color="slate.500" fontFamily="'Inter', monospace">
                  {selectedFactory.geometry.coordinates[1].toFixed(6)}, {selectedFactory.geometry.coordinates[0].toFixed(6)}
                </Text>
              </Box>
            </VStack>
          </Box>
        ) : displayedFactories.length > 0 ? (
          <VStack spacing={0} align="stretch" px={3}>
            {displayedFactories.map((factory, index) => (
              <FactoryCard
                key={`${factory.properties.เลขทะเบียน}-${index}`}
                factory={factory}
                isSelected={false}
                onClick={() => onFactorySelect(factory)}
                userLocation={userLocation}
              />
            ))}
          </VStack>
        ) : (
          <Flex direction="column" align="center" justify="center" h="200px" p={8} textAlign="center">
            {/* LAYER 1: Visual hook — empty state icon */}
            <Box
              w="56px"
              h="56px"
              borderRadius="full"
              bg="slate.100"
              display="flex"
              alignItems="center"
              justifyContent="center"
              mb={3}
            >
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" boxSize={7} color="slate.400">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </Icon>
            </Box>
            {/* LAYER 2: Actionable message — clear next step */}
            <Text color="slate.600" fontSize="sm" fontWeight="500">
              ไม่พบข้อมูล
            </Text>
            <Text color="slate.400" fontSize="xs" mt={1}>
              ลองปรับตัวกรองหรือเปลี่ยนจังหวัด
            </Text>
          </Flex>
        )}
      </Box>

      {/* SIGNAL 39: Manual Location Modal — Minimal Cognitive Tax */}
      <Modal isOpen={isOpen} onClose={onClose} isCentered motionPreset="slideInBottom">
        <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.300" />
        <ModalContent borderRadius="2xl" boxShadow="xl" p={2}>
          <ModalHeader color="slate.800" pb={2}>
            <Flex align="center" gap={2.5}>
              {/* LAYER 1: Icon hook — location marker */}
              <Box
                w="36px"
                h="36px"
                borderRadius="lg"
                bg="primary.50"
                display="flex"
                alignItems="center"
                justifyContent="center"
              >
                <Icon viewBox="0 0 24 24" fill="currentColor" color="primary.600" boxSize={5}>
                  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
                </Icon>
              </Box>
              <Text fontSize="lg" fontWeight="bold">กำหนดตำแหน่ง</Text>
            </Flex>
          </ModalHeader>
          <ModalBody pt={0} pb={4}>
            {/* LAYER 2: Chunked form — 2 inputs max, clear labels */}
            <VStack spacing={3}>
              <FormControl>
                <FormLabel fontSize="sm" fontWeight="600" color="slate.700" mb={1}>Latitude</FormLabel>
                <Input
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                  placeholder="14.0504"
                  size="lg"
                  bg="slate.50"
                  border="none"
                  _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(26, 54, 93, 0.15)" }}
                  fontFamily="'Inter', monospace"
                />
              </FormControl>
              <FormControl>
                <FormLabel fontSize="sm" fontWeight="600" color="slate.700" mb={1}>Longitude</FormLabel>
                <Input
                  value={manualLng}
                  onChange={(e) => setManualLng(e.target.value)}
                  placeholder="101.3678"
                  size="lg"
                  bg="slate.50"
                  border="none"
                  _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(26, 54, 93, 0.15)" }}
                  fontFamily="'Inter', monospace"
                />
              </FormControl>
            </VStack>
          </ModalBody>
          <ModalFooter pt={0}>
            {/* LAYER 3: Secondary vs primary action — clear hierarchy */}
            <Button variant="ghost" mr={2} onClick={onClose} color="slate.400" size="md">
              ยกเลิก
            </Button>
            <Button bg="primary.600" color="white" onClick={handleManualLocationSubmit} size="md" _hover={{ bg: "primary.700" }}>
              บันทึก
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default Sidebar;
