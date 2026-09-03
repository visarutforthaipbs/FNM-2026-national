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
  Image,
} from "@chakra-ui/react";
import type { IconProps } from "@chakra-ui/react";
import type {
  FactoryGeoJSON,
  FactoryFeature,
  FilterState,
  UserLocation,
} from "../types/factory";
import { getHazardLevel, getHazardGroup, HAZARD_COLORS, HAZARD_LABELS } from "../utils/hazard";
import ZoningSection from "./ZoningSection";
import { factoryTypeName } from "../utils/factoryTypes";
import type { ProvinceCount } from "../hooks/useFactoriesApi";
import { haversineKm } from "../utils/geo";
import FactoryCard from "./FactoryCard";
import ReportSection from "./ReportSection";
import LocationCorrectionModal from "./LocationCorrectionModal";
import DbdOwnershipSection from "./DbdOwnershipSection";
import { useReportCounts } from "../hooks/useReports";

import { useWatchlist } from "../hooks/useWatchlist";
import { PROVINCE_TO_REGION, REGIONS_ORDER, TOP_INDUSTRIAL_PROVINCES } from "../utils/regions";
import { IndustryTypeModal } from "./IndustryTypeModal";
import { DossierPrintModal } from "./DossierPrintModal";

// Inline Icons
const SearchIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </Icon>
);

const StarIcon = ({ filled }: { filled: boolean }) => (
  <Icon
    viewBox="0 0 24 24"
    boxSize={3.5}
    fill={filled ? "#F59E0B" : "none"}
    stroke={filled ? "#F59E0B" : "#94A3B8"}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </Icon>
);



/**
 * How a position that did not come from the government feed is described.
 *
 * The two approximate tiers say plainly that they are approximate. "sibling" is
 * deliberately worded differently: it is an exact surveyed position, just one
 * recorded against another licence at the same address — one plant commonly
 * holds several ทะเบียนโรงงาน and only one of them carries a coordinate.
 * Calling that "โดยประมาณ" would understate it as badly as calling a tambon
 * centroid exact.
 */
const COORD_PROVENANCE: Record<
  NonNullable<FactoryFeature["properties"]["coordQuality"]>,
  { label: string; detail: string; approximate: boolean }
> = {
  centroid: {
    label: "ตำแหน่งโดยประมาณ (ระดับตำบล)",
    detail: "ใช้จุดกึ่งกลางตำบลแทนที่อยู่จริง คลาดเคลื่อนได้ 2–5 กม.",
    approximate: true,
  },
  geocoded: {
    label: "ตำแหน่งโดยประมาณ (จากที่อยู่)",
    detail: "ได้จากการแปลงที่อยู่เป็นพิกัดระดับถนน ไม่ใช่พิกัดที่กรมโรงงานฯ ให้มา",
    approximate: true,
  },
  sibling: {
    label: "อ้างอิงจากใบอนุญาตที่อยู่เดียวกัน",
    detail: "ใบอนุญาตนี้ไม่มีพิกัดของตนเอง จึงใช้พิกัดของอีกใบอนุญาตที่จดทะเบียนที่อยู่เดียวกัน",
    approximate: false,
  },
};

/**
 * The พิกัด block. When the position did not come from the government feed the
 * whole block is tinted and carries its own correction chip — the person best
 * placed to fix a wrong pin is the one looking at it, and asking them there
 * costs less attention than sending them to the button at the foot of the panel.
 */
const CoordinateBlock: React.FC<{
  factory: FactoryFeature;
  onCorrect: () => void;
}> = ({ factory, onCorrect }) => {
  const quality = factory.properties.coordQuality;
  const provenance = quality ? COORD_PROVENANCE[quality] : null;
  // Approximate positions get the warmer, more insistent treatment; an
  // inherited-but-exact one is merely noted.
  const tint = !provenance ? null : provenance.approximate ? "orange" : "blue";

  return (
    <Box pt={3} borderTop="1px solid" borderColor="slate.100">
      <Text fontSize="xs" color="slate.500" fontWeight="600" mb={1}>
        พิกัด
      </Text>
      <Box
        {...(tint
          ? {
              bg: `${tint}.50`,
              border: "1px solid",
              borderColor: `${tint}.200`,
              borderRadius: "lg",
              p: 3,
            }
          : {})}
      >
        <Text fontSize="xs" color="slate.600" fontFamily="'Inter', monospace">
          {factory.geometry.coordinates[1].toFixed(6)}, {factory.geometry.coordinates[0].toFixed(6)}
        </Text>

        {provenance && (
          <>
            <Badge
              mt={1.5}
              bg={`${tint}.100`}
              color={`${tint}.800`}
              borderRadius="full"
              px={2.5}
              py={0.5}
              fontSize="10px"
              fontWeight="700"
              whiteSpace="normal"
              textAlign="left"
            >
              {provenance.label}
            </Badge>
            <Text fontSize="10px" color="slate.600" mt={1.5} lineHeight="1.6">
              {provenance.detail}
            </Text>
            <Button
              mt={2.5}
              size="xs"
              borderRadius="full"
              bg="white"
              color={`${tint}.800`}
              border="1px solid"
              borderColor={`${tint}.300`}
              fontWeight="600"
              fontSize="11px"
              px={3}
              _hover={{ bg: `${tint}.100` }}
              onClick={onCorrect}
              leftIcon={
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3}>
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
                  <circle cx="12" cy="10" r="3" />
                </Icon>
              }
            >
              รู้ตำแหน่งจริง? ปักหมุดให้ถูกต้อง
            </Button>
          </>
        )}
      </Box>
    </Box>
  );
};

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
  locationError,
  isLocationLoading,
  onManualLocationSet,
  isMobile = false,
  onMobileClose,
  provinceCounts = [],
  onProvinceSelect,
}) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const {
    isOpen: isCorrectionOpen,
    onOpen: onCorrectionOpen,
    onClose: onCorrectionClose,
  } = useDisclosure();
  const {
    isOpen: isIndustryModalOpen,
    onOpen: onIndustryModalOpen,
    onClose: onIndustryModalClose,
  } = useDisclosure();
  const {
    isOpen: isPrintOpen,
    onOpen: onPrintOpen,
    onClose: onPrintClose,
  } = useDisclosure();
  const { counts: reportCounts } = useReportCounts();
  const { isFactoryWatched, toggleWatchFactory, watchedFactories } = useWatchlist();
  const [showWatchedOnly, setShowWatchedOnly] = useState(false);
  const [manualLat, setManualLat] = useState<string>("13.7563");
  const [manualLng, setManualLng] = useState<string>("100.5018");
  const hasReliableLocation = Boolean(userLocation && !locationError);

  // Group provinces by region and top industrial hubs for chunked navigation
  const groupedProvinces = useMemo(() => {
    const map: Record<string, ProvinceCount[]> = {};
    for (const reg of REGIONS_ORDER) {
      map[reg] = [];
    }
    for (const pc of provinceCounts) {
      const reg = PROVINCE_TO_REGION[pc.name_th] || "ภาคกลาง";
      if (!map[reg]) map[reg] = [];
      map[reg].push(pc);
    }
    for (const reg of REGIONS_ORDER) {
      map[reg].sort((a, b) => b.count - a.count);
    }
    return map;
  }, [provinceCounts]);

  const topProvinces = useMemo(() => {
    return provinceCounts
      .filter((pc) => TOP_INDUSTRIAL_PROVINCES.includes(pc.name_th))
      .sort((a, b) => b.count - a.count);
  }, [provinceCounts]);

  const totalNationwideCount = useMemo(() => {
    return provinceCounts.reduce((s, p) => s + p.count, 0);
  }, [provinceCounts]);

  // Filtering (province/search/high-risk/radius) happens in useFactoriesApi —
  // the features received here are already filtered
  const rawFeatures = useMemo(() => factories?.features ?? [], [factories]);
  const filteredFactories = useMemo(() => {
    if (showWatchedOnly) {
      return rawFeatures.filter((f) => watchedFactories.includes(f.properties.เลขทะเบียน));
    }
    return rawFeatures;
  }, [rawFeatures, showWatchedOnly, watchedFactories]);

  // Sort by distance (nearest first) then limit for performance
  const displayedFactories = useMemo(() => {
    if (!hasReliableLocation || !userLocation) {
      return [...filteredFactories]
        .sort((a, b) => {
          const riskDelta =
            Number(getHazardLevel(b.properties.เลขทะเบียน, b.properties.ประเภท) === "hazard") -
            Number(getHazardLevel(a.properties.เลขทะเบียน, a.properties.ประเภท) === "hazard");
          if (riskDelta !== 0) return riskDelta;
          return a.properties.ชื่อโรงงาน.localeCompare(b.properties.ชื่อโรงงาน, "th");
        })
        .slice(0, 200);
    }

    const { lat, lng } = userLocation;
    return [...filteredFactories]
      .sort((a, b) => {
        const dA = haversineKm(lat, lng, a.geometry.coordinates[1], a.geometry.coordinates[0]);
        const dB = haversineKm(lat, lng, b.geometry.coordinates[1], b.geometry.coordinates[0]);
        return dA - dB;
      })
      .slice(0, 200);
  }, [filteredFactories, hasReliableLocation, userLocation]);

  const totalCount = filteredFactories.length;
  const displayedCount = displayedFactories.length;
  const highRiskCount = useMemo(
    () =>
      filteredFactories.filter(
        (factory) => getHazardLevel(factory.properties.เลขทะเบียน, factory.properties.ประเภท) === "hazard"
      ).length,
    [filteredFactories]
  );
  const generalCount = totalCount - highRiskCount;

  // Share the current factory as a URL (?province=…&factory=… is kept in
  // sync by App, so the current address bar URL IS the shareable link)
  const [shareCopied, setShareCopied] = useState(false);
  const handleShareFactory = async () => {
    const url = window.location.href;
    const title = selectedFactory?.properties.ชื่อโรงงาน || "Factory Near Me";
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShareCopied(true);
        setTimeout(() => setShareCopied(false), 2000);
      }
    } catch {
      // user cancelled the share sheet — nothing to do
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({
      ...filters,
      searchTerm: e.target.value,
    });
  };

  const handleRadiusSelect = (km: number) => {
    if (filters.showOnlyInRadius && (filters.radiusKm ?? 10) === km) {
      onFiltersChange({ ...filters, showOnlyInRadius: false });
    } else {
      onFiltersChange({ ...filters, showOnlyInRadius: true, radiusKm: km });
    }
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

    if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      onManualLocationSet(lat, lng);
      onClose();
    }
  };

  const hasActiveFilters =
    filters.searchTerm ||
    filters.showOnlyInRadius ||
    filters.showHighRisk ||
    filters.selectedProvince ||
    filters.factoryTypes.length > 0;

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
        p={isMobile ? 4 : 6}
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
              minW="44px"
              minH="44px"
              fontSize="md"
              aria-label="ปิดแผงข้อมูล"
              _hover={{ color: "slate.600" }}
            >
              ✕
            </Button>
          </Flex>
        )}

        {/* Search — Primary action, prominent placement */}
        <InputGroup size="lg">
          <InputLeftElement pointerEvents="none" color="slate.400">
            <SearchIcon boxSize={5} />
          </InputLeftElement>
          <Input
            placeholder="ค้นหาชื่อโรงงาน..."
            aria-label="ค้นหาชื่อโรงงาน"
            value={filters.searchTerm}
            onChange={handleSearchChange}
            bg="slate.50"
            border="none"
            _focus={{
              bg: "white",
              boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)",
            }}
            fontSize="md"
            borderRadius="xl"
          />
        </InputGroup>

        {/* Province — Single select, semantic grouping with search */}
        <Select
          mt={3}
          aria-label="เลือกจังหวัด"
          value={filters.selectedProvince}
          onChange={(e) => {
            const val = e.target.value;
            onFiltersChange({ ...filters, selectedProvince: val });
            if (onProvinceSelect) onProvinceSelect(val);
          }}
          size="md"
          minH={isMobile ? "44px" : undefined}
          bg="slate.50"
          border="none"
          _focus={{
            bg: "white",
            boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)",
          }}
          borderRadius="xl"
          fontWeight="medium"
          color={filters.selectedProvince ? "slate.800" : "slate.600"}
        >
          <option value="">ทุกจังหวัด ({totalNationwideCount.toLocaleString()})</option>
          <optgroup label="จังหวัดอุตสาหกรรมหลัก">
            {topProvinces.map((pc) => (
              <option key={`top-${pc.name_th}`} value={pc.name_th}>
                {pc.name_th} ({pc.count.toLocaleString()})
              </option>
            ))}
          </optgroup>
          {REGIONS_ORDER.map((region) => (
            <optgroup key={region} label={`${region} (${groupedProvinces[region]?.length || 0} จังหวัด)`}>
              {groupedProvinces[region]?.map((pc) => (
                <option key={pc.name_th} value={pc.name_th}>
                  {pc.name_th} ({pc.count.toLocaleString()})
                </option>
              ))}
            </optgroup>
          ))}
        </Select>

        {/* Filter Chips — Rule of Three: max 3 action chunks */}
        <HStack spacing={2} mt={4} flexWrap="wrap">
          <Button
            size="sm"
            minH={isMobile ? "44px" : undefined}
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

          {hasReliableLocation && (
            <HStack spacing={0.5} bg="slate.50" p={0.5} borderRadius="full" border="1px solid" borderColor="slate.200">
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3} color="slate.500" ml={2} mr={0.5}>
                <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
              </Icon>
              {[3, 5, 10].map((km) => {
                const isSelected = filters.showOnlyInRadius && (filters.radiusKm ?? 10) === km;
                return (
                  <Button
                    key={`radius-${km}`}
                    size="xs"
                    minH="28px"
                    px={2}
                    borderRadius="full"
                    variant={isSelected ? "solid" : "ghost"}
                    bg={isSelected ? "primary.600" : "transparent"}
                    color={isSelected ? "white" : "slate.600"}
                    fontWeight={isSelected ? "700" : "500"}
                    onClick={() => handleRadiusSelect(km)}
                    _hover={{ bg: isSelected ? "primary.700" : "slate.100" }}
                  >
                    {km} กม.
                  </Button>
                );
              })}
            </HStack>
          )}

          {/* Button to open Industry Type Picker Modal */}
          <Button
            size="sm"
            minH={isMobile ? "44px" : undefined}
            borderRadius="full"
            variant="outline"
            borderColor={filters.factoryTypes.length > 0 ? "primary.300" : "slate.200"}
            bg={filters.factoryTypes.length > 0 ? "primary.50" : "white"}
            color={filters.factoryTypes.length > 0 ? "primary.700" : "slate.600"}
            fontWeight={filters.factoryTypes.length > 0 ? "700" : "500"}
            onClick={onIndustryModalOpen}
            flexShrink={0}
            _hover={{ bg: "primary.50", borderColor: "primary.300" }}
            leftIcon={
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </Icon>
            }
          >
            ประเภทโรงงาน {filters.factoryTypes.length > 0 ? `(${filters.factoryTypes.length})` : ""}
          </Button>

          {/* Industry-type filter chip (set from the dashboard / ?type= URL) */}
          {filters.factoryTypes.map((code) => (
            <Button
              key={code}
              size="sm"
              minH={isMobile ? "44px" : undefined}
              borderRadius="full"
              variant="ghost"
              bg="primary.50"
              color="primary.700"
              fontWeight="600"
              flexShrink={0}
              onClick={() =>
                onFiltersChange({
                  ...filters,
                  factoryTypes: filters.factoryTypes.filter((c) => c !== code),
                })
              }
              rightIcon={
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={2.5}>
                  <path d="M18 6L6 18M6 6l12 12" />
                </Icon>
              }
              _hover={{ bg: "primary.100" }}
            >
              {factoryTypeName(parseInt(code, 10))}
            </Button>
          ))}

          {/* Watched factories filter chip */}
          {watchedFactories.length > 0 && (
            <Button
              size="sm"
              minH={isMobile ? "44px" : undefined}
              borderRadius="full"
              variant="ghost"
              bg={showWatchedOnly ? "amber.100" : "amber.50"}
              color={showWatchedOnly ? "amber.800" : "amber.700"}
              fontWeight={showWatchedOnly ? "700" : "500"}
              onClick={() => setShowWatchedOnly(!showWatchedOnly)}
              flexShrink={0}
              leftIcon={<StarIcon filled={showWatchedOnly} />}
              _hover={{ bg: "amber.100" }}
            >
              {showWatchedOnly && "●  "}ที่ฉันติดตาม ({watchedFactories.length})
            </Button>
          )}

          {hasActiveFilters && (
            <Button
              size="sm"
              minH={isMobile ? "44px" : undefined}
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
        px={isMobile ? 4 : 6}
        py={2.5}
        bg={locationError ? "orange.50" : "slate.50"}
        align="center"
        justify="space-between"
        borderTop="1px solid"
        borderBottom="1px solid"
        borderColor={locationError ? "orange.200" : "slate.100"}
      >
        {/* Location indicator — Home icon + clear citizen label */}
        <Flex align="center" gap={2} minW={0} flex="1">
          <Flex
            align="center"
            justify="center"
            w="24px"
            h="24px"
            borderRadius="md"
            bg={hasReliableLocation ? "green.50" : locationError ? "orange.100" : "slate.100"}
            color={hasReliableLocation ? "accent.green" : locationError ? "orange.600" : "slate.500"}
            flexShrink={0}
            title="บ้าน / ตำแหน่งของคุณ"
          >
            <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </Icon>
          </Flex>
          {isLocationLoading ? (
            <Text fontSize="xs" color="slate.600">ระบุตำแหน่ง...</Text>
          ) : hasReliableLocation && userLocation ? (
            <Box minW={0} isTruncated>
              <Text fontSize="xs" fontWeight="600" color="slate.700" isTruncated>
                ตำแหน่งของคุณ
                <Text as="span" ml={1.5} fontSize="11px" fontWeight="normal" color="slate.500" fontFamily="'Inter', monospace">
                  ({userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)})
                </Text>
              </Text>
            </Box>
          ) : locationError ? (
            <Box minW={0} isTruncated>
              <Text fontSize="xs" color="orange.800" fontWeight="600" isTruncated>
                พิกัดจำลอง (ปราจีนบุรี)
              </Text>
            </Box>
          ) : (
            <Text fontSize="xs" color="slate.500">ไม่พบตำแหน่ง</Text>
          )}
          <Button
            size="xs"
            variant="outline"
            borderColor={locationError ? "orange.300" : "slate.200"}
            color={locationError ? "orange.800" : "slate.600"}
            bg="white"
            onClick={onOpen}
            px={2}
            minH={isMobile ? "36px" : "28px"}
            minW="auto"
            fontSize="xs"
            fontWeight="600"
            borderRadius="md"
            flexShrink={0}
            _hover={{ color: "primary.600", borderColor: "primary.300" }}
          >
            แก้ไข
          </Button>
        </Flex>

        {/* Result count — key metric, bold for signal */}
        <Text fontSize="xs" fontWeight="700" color={locationError ? "orange.900" : "slate.600"} flexShrink={0} ml={2}>
          {displayedCount < totalCount
            ? `${displayedCount.toLocaleString()} / ${totalCount.toLocaleString()}`
            : totalCount.toLocaleString()
          } แห่ง
        </Text>
      </Flex>

      {/* LAYER 3: Conscious Deep-Dive — Factory detail or list */}
      <Box flex="1" overflowY="auto" py={2} pb={isMobile ? "calc(5rem + env(safe-area-inset-bottom, 0px))" : 20}>
        {/* SIGNAL 39: Selected Factory Detail — Progressive Disclosure */}
        {selectedFactory ? (
          <Box px={5} py={4}>
            {/* LAYER 1: Back navigation — minimal visual weight */}
            <Flex align="center" mb={4}>
              <IconButton
                aria-label="ย้อนกลับไปหน้ารายการโรงงาน"
                icon={
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </Icon>
                }
                size="sm"
                variant="ghost"
                color="slate.600"
                mr={2}
                borderRadius="full"
                minW="44px"
                minH="44px"
                onClick={() => onFactorySelect(null)}
              />
              <Text fontSize="xs" color="slate.500" fontWeight="500">กลับไปรายการ</Text>
              <HStack ml="auto" spacing={1}>
                <Button
                  size="xs"
                  variant="ghost"
                  color={isFactoryWatched(selectedFactory.properties.เลขทะเบียน) ? "amber.700" : "slate.500"}
                  bg={isFactoryWatched(selectedFactory.properties.เลขทะเบียน) ? "amber.50" : "transparent"}
                  fontWeight="600"
                  onClick={() => toggleWatchFactory(selectedFactory.properties.เลขทะเบียน)}
                  leftIcon={<StarIcon filled={isFactoryWatched(selectedFactory.properties.เลขทะเบียน)} />}
                  _hover={{ bg: "amber.50" }}
                >
                  {isFactoryWatched(selectedFactory.properties.เลขทะเบียน) ? "ติดตามแล้ว" : "ติดตาม"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  color={shareCopied ? "green.600" : "slate.500"}
                  fontWeight="600"
                  onClick={handleShareFactory}
                  leftIcon={
                    <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                      {shareCopied
                        ? <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                        : <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></>}
                    </Icon>
                  }
                >
                  {shareCopied ? "คัดลอกแล้ว" : "แชร์"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  color="slate.600"
                  fontWeight="600"
                  onClick={onPrintOpen}
                  title="พิมพ์สรุปข้อมูลโรงงาน (A4 / PDF)"
                  leftIcon={
                    <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                      <polyline points="6 9 6 2 18 2 18 9" />
                      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                      <rect x="6" y="14" width="12" height="8" />
                    </Icon>
                  }
                  _hover={{ bg: "slate.100" }}
                >
                  พิมพ์สรุป
                </Button>
              </HStack>
            </Flex>

            {/* LAYER 2: Primary info — factory name + risk signal */}
            <Flex align="flex-start" gap={3} mb={3}>
              {/* Risk indicator dot — 3-tier hazard color */}
              <Box
                w="10px"
                h="10px"
                borderRadius="full"
                bg={HAZARD_COLORS[getHazardLevel(selectedFactory.properties.เลขทะเบียน, selectedFactory.properties.ประเภท)]}
                mt={1.5}
                flexShrink={0}
              />
              <Text fontWeight="700" color="slate.900" fontSize="lg" lineHeight="1.3" flex="1">
                {selectedFactory.properties.ชื่อโรงงาน}
              </Text>
            </Flex>

            {/* LAYER 2: Location badges — geographic context */}
            <Flex wrap="wrap" gap={2} mb={5}>
              {(() => {
                const level = getHazardLevel(selectedFactory.properties.เลขทะเบียน, selectedFactory.properties.ประเภท);
                const group = getHazardGroup(selectedFactory.properties.เลขทะเบียน);
                const scheme = level === "hazard"
                  ? { bg: "red.50", color: "red.700" }
                  : level === "type3"
                    ? { bg: "orange.50", color: "orange.700" }
                    : { bg: "green.50", color: "green.700" };
                return (
                  <Badge
                    bg={scheme.bg}
                    color={scheme.color}
                    borderRadius="full"
                    px={3}
                    fontSize="xs"
                    fontWeight="600"
                  >
                    {group ?? HAZARD_LABELS[level]}
                  </Badge>
                );
              })()}
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

            {/* Quick Jump Section Pills */}
            <HStack
              spacing={1.5}
              mb={4}
              overflowX="auto"
              py={1}
              sx={{
                scrollbarWidth: "none",
                "&::-webkit-scrollbar": { display: "none" }
              }}
            >
              <Button
                size="xs"
                borderRadius="full"
                bg="slate.100"
                color="slate.700"
                fontWeight="600"
                fontSize="11px"
                px={2.5}
                py={1}
                flexShrink={0}
                _hover={{ bg: "primary.50", color: "primary.700" }}
                onClick={() => document.getElementById("section-diw")?.scrollIntoView({ behavior: "smooth" })}
              >
                DIW โรงงาน
              </Button>
              <Button
                size="xs"
                borderRadius="full"
                bg="slate.100"
                color="slate.700"
                fontWeight="600"
                fontSize="11px"
                px={2.5}
                py={1}
                flexShrink={0}
                _hover={{ bg: "primary.50", color: "primary.700" }}
                onClick={() => document.getElementById("section-dbd")?.scrollIntoView({ behavior: "smooth" })}
              >
                DBD ผู้ถือหุ้น
              </Button>
              <Button
                size="xs"
                borderRadius="full"
                bg="slate.100"
                color="slate.700"
                fontWeight="600"
                fontSize="11px"
                px={2.5}
                py={1}
                flexShrink={0}
                _hover={{ bg: "primary.50", color: "primary.700" }}
                onClick={() => document.getElementById("section-zoning")?.scrollIntoView({ behavior: "smooth" })}
              >
                DPT ผังเมือง
              </Button>
              <Button
                size="xs"
                borderRadius="full"
                bg="slate.100"
                color="slate.700"
                fontWeight="600"
                fontSize="11px"
                px={2.5}
                py={1}
                flexShrink={0}
                _hover={{ bg: "primary.50", color: "primary.700" }}
                onClick={() => document.getElementById("section-citizen")?.scrollIntoView({ behavior: "smooth" })}
              >
                ภาคประชาชน
              </Button>
            </HStack>

            <VStack spacing={5} align="stretch">
              {/* SOURCE GROUP 1 — the DIW factory licence record */}
              <Box as="section" id="section-diw" aria-label="ข้อมูลโรงงานจากกรมโรงงานอุตสาหกรรม">
                <Flex align="center" gap={2} mb={3} color="slate.600">
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={4}>
                    <path d="M2 20h20M4 20V10l5 3V10l5 3V7l5 3v10" />
                  </Icon>
                  <Text fontSize="10px" fontWeight="800" letterSpacing=".06em" lineHeight="1.4">
                    ข้อมูลโรงงาน · กรมโรงงานอุตสาหกรรม (DIW)
                  </Text>
                </Flex>

                <VStack spacing={4} align="stretch">
                  {/* Operator */}
                  <Box>
                    <Text fontSize="xs" color="slate.500" fontWeight="600" mb={1}>ผู้ประกอบการ</Text>
                    <Text fontSize="sm" color="slate.700" fontWeight="medium">
                      {selectedFactory.properties.ผู้ประกอบก || (
                        <Text as="span" color="slate.400">กำลังโหลด...</Text>
                      )}
                    </Text>
                  </Box>

                  {/* Business type */}
                  <Box>
                    <Text fontSize="xs" color="slate.500" fontWeight="600" mb={1}>ประเภทกิจการ</Text>
                    <Text fontSize="sm" color="slate.700" fontWeight="medium">
                      {selectedFactory.properties.ประกอบกิจก || (
                        <Text as="span" color="slate.400">กำลังโหลด...</Text>
                      )}
                    </Text>
                  </Box>

                  {/* Registration */}
                  <Box>
                    <Text fontSize="xs" color="slate.500" fontWeight="600" mb={1}>เลขทะเบียน</Text>
                    <Text fontSize="sm" color="slate.700" fontFamily="'Inter', monospace">
                      {selectedFactory.properties.เลขทะเบียน}
                    </Text>
                  </Box>

                  {/* Address */}
                  {selectedFactory.properties.ที่อยู่ && (
                    <Box>
                      <Text fontSize="xs" color="slate.500" fontWeight="600" mb={1}>ที่อยู่</Text>
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
                          <Text fontSize="xs" color="slate.500" fontWeight="600">เงินลงทุน</Text>
                          <Text fontSize="sm" fontWeight="bold" color="green.600">
                            {selectedFactory.properties.เงินลงทุน.toLocaleString()} บาท
                          </Text>
                        </Box>
                      ) : null}
                      {selectedFactory.properties.แรงม้า ? (
                        <Box>
                          <Text fontSize="xs" color="slate.500" fontWeight="600">เครื่องจักร</Text>
                          <Text fontSize="sm" fontWeight="bold" color="orange.600">
                            {selectedFactory.properties.แรงม้า.toLocaleString()} HP
                          </Text>
                        </Box>
                      ) : null}
                      {(selectedFactory.properties.คนงานชาย || selectedFactory.properties.คนงานหญิง) ? (
                        <Box>
                          <Text fontSize="xs" color="slate.500" fontWeight="600">คนงาน</Text>
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

                  {/* Coordinates — with provenance so a position that did not
                      come from the government feed is never mistaken for a
                      surveyed one, and can be corrected on the spot */}
                  <CoordinateBlock
                    factory={selectedFactory}
                    onCorrect={onCorrectionOpen}
                  />
                </VStack>
              </Box>

              {/* SOURCE GROUP 2 — the DBD company record */}
              <Box id="section-dbd">
                <DbdOwnershipSection
                  factoryId={selectedFactory.properties.เลขทะเบียน}
                  provinceEn={
                    provinceCounts.find((p) => p.name_th === selectedFactory.properties.จังหวัด)
                      ?.name_en ?? null
                  }
                  factoryObjective={selectedFactory.properties.ประกอบกิจก}
                  factoryType={selectedFactory.properties.ประเภท}
                />
              </Box>

              {/* SOURCE GROUP 2.5 — town planning */}
              <Box id="section-zoning">
                <ZoningSection
                  factoryId={selectedFactory.properties.เลขทะเบียน}
                  provinceTh={selectedFactory.properties.จังหวัด}
                  provinceEn={
                    provinceCounts.find((p) => p.name_th === selectedFactory.properties.จังหวัด)
                      ?.name_en ?? null
                  }
                />
              </Box>

              {/* SOURCE GROUP 3 — citizen participation */}
              <Box as="section" id="section-citizen" aria-label="ข้อมูลจากภาคประชาชน" pt={2} borderTop="1px solid" borderColor="slate.100">
                <Flex align="center" gap={2} mb={3} color="slate.500">
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={4}>
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                  </Icon>
                  <Text fontSize="10px" fontWeight="800" letterSpacing=".06em" lineHeight="1.4">
                    ภาคประชาชน · รายงานและแก้ไขข้อมูล
                  </Text>
                </Flex>

                <VStack spacing={4} align="stretch">
                  {/* Citizen impact reports — counts + submission CTA */}
                  <ReportSection
                    factory={selectedFactory}
                    counts={reportCounts.get(selectedFactory.properties.เลขทะเบียน)}
                  />

                  {/* Crowd-sourced location correction */}
                  <Button
                    size="xs"
                    variant="ghost"
                    color="slate.400"
                    fontWeight="500"
                    px={1}
                    alignSelf="flex-start"
                    _hover={{ color: "primary.600" }}
                    onClick={onCorrectionOpen}
                  >
                    ตำแหน่งไม่ถูกต้อง? ปักหมุดตำแหน่งจริง
                  </Button>
                </VStack>
              </Box>
            </VStack>

            <LocationCorrectionModal
              isOpen={isCorrectionOpen}
              onClose={onCorrectionClose}
              factory={selectedFactory}
            />
          </Box>
        ) : displayedFactories.length > 0 ? (
          <>
            <Box px={4} pt={3} pb={3}>
              <Box
                bg="#E8F1F4"
                border="1px solid"
                borderColor="#D5E5EA"
                borderRadius="2xl"
                p={4}
              >
                <Text fontSize="10px" color="slate.500" fontWeight="700" letterSpacing=".08em">
                  พื้นที่ที่เลือก
                </Text>
                <Flex justify="space-between" align="baseline" gap={3} mt={1}>
                  <Text fontSize="lg" fontWeight="800" color="#0B3558" noOfLines={1}>
                    {filters.selectedProvince || "ผลการค้นหา"}
                  </Text>
                  <Text fontSize="xs" fontWeight="700" color="slate.600" flexShrink={0}>
                    {totalCount.toLocaleString()} แห่ง
                  </Text>
                </Flex>

                <Flex mt={3} gap={2} wrap="wrap">
                  <Badge bg="red.50" color="red.700" borderRadius="full" px={2.5} py={1} fontSize="10px">
                    เสี่ยงสูง {highRiskCount.toLocaleString()}
                  </Badge>
                  <Badge bg="whiteAlpha.800" color="green.700" borderRadius="full" px={2.5} py={1} fontSize="10px">
                    ทั่วไป {generalCount.toLocaleString()}
                  </Badge>
                </Flex>

                <Flex align="center" gap={1.5} mt={3} color="slate.500">
                  <Icon viewBox="0 0 20 20" boxSize={3.5} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {hasReliableLocation ? (
                      <><circle cx="10" cy="10" r="3" /><circle cx="10" cy="10" r="7" /></>
                    ) : (
                      <><path d="M4 6h12M4 10h9M4 14h6" /><path d="m14 12 2 2 3-4" /></>
                    )}
                  </Icon>
                  <Text fontSize="10px">
                    {hasReliableLocation ? "เรียงจากโรงงานที่ใกล้คุณ" : "เรียงโรงงานเสี่ยงสูงก่อน"}
                  </Text>
                </Flex>
              </Box>
            </Box>

            <VStack spacing={0} align="stretch" px={3}>
              {displayedFactories.map((factory, index) => (
                <FactoryCard
                  key={`${factory.properties.เลขทะเบียน}-${index}`}
                  factory={factory}
                  isSelected={false}
                  onClick={() => onFactorySelect(factory)}
                  userLocation={hasReliableLocation ? userLocation : null}
                  reportCount={reportCounts.get(factory.properties.เลขทะเบียน)?.total}
                />
              ))}
            </VStack>
          </>
        ) : (
          <Flex direction="column" align="center" justify="center" h="200px" p={8} textAlign="center">
            {/* LAYER 1: Visual hook — branded search/map state */}
            <Image
              src="/assets/brand/empty-search.svg"
              alt=""
              aria-hidden="true"
              w="148px"
              h="84px"
              objectFit="contain"
              mb={2}
            />
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
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" color="primary.600" boxSize={5}>
                  <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </Icon>
              </Box>
              <Box>
                <Text fontSize="md" fontWeight="bold" color="slate.800">
                  กำหนดบ้าน / ตำแหน่งของคุณ
                </Text>
                <Text fontSize="xs" color="slate.500">
                  ใช้สำหรับคำนวณระยะห่างและค้นหาโรงงานรอบตัวคุณ
                </Text>
              </Box>
            </Flex>
          </ModalHeader>
          <ModalBody pt={0} pb={4}>
            <VStack spacing={3}>
              {navigator.geolocation && (
                <Button
                  w="full"
                  size="sm"
                  variant="outline"
                  borderColor="slate.200"
                  color="primary.600"
                  borderRadius="xl"
                  _hover={{ bg: "primary.50", borderColor: "primary.300" }}
                  leftIcon={
                    <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="3" />
                    </Icon>
                  }
                  onClick={() => {
                    navigator.geolocation.getCurrentPosition(
                      (pos) => {
                        setManualLat(pos.coords.latitude.toFixed(6));
                        setManualLng(pos.coords.longitude.toFixed(6));
                      },
                      (err) => console.warn(err)
                    );
                  }}
                >
                  ใช้พิกัดจาก GPS ปัจจุบัน
                </Button>
              )}
              <FormControl>
                <FormLabel fontSize="sm" fontWeight="600" color="slate.700" mb={1}>Latitude</FormLabel>
                <Input
                  value={manualLat}
                  onChange={(e) => setManualLat(e.target.value)}
                  placeholder="14.0504"
                  size="lg"
                  bg="slate.50"
                  border="none"
                  _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
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
                  _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
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

      {/* Industry Type Picker Modal */}
      <IndustryTypeModal
        isOpen={isIndustryModalOpen}
        onClose={onIndustryModalClose}
        selectedTypes={filters.factoryTypes}
        onChangeTypes={(types) => onFiltersChange({ ...filters, factoryTypes: types })}
      />

      {/* Factory Dossier Print / Summary Modal */}
      {selectedFactory && (
        <DossierPrintModal
          isOpen={isPrintOpen}
          onClose={onPrintClose}
          reports={[]}
          factoryMeta={{
            id: selectedFactory.properties.เลขทะเบียน,
            name: selectedFactory.properties.ชื่อโรงงาน,
            address: selectedFactory.properties.ที่อยู่,
            province: selectedFactory.properties.จังหวัด,
            district: selectedFactory.properties.อำเภอ,
            factory_type: selectedFactory.properties.ประเภท,
            horsepower: selectedFactory.properties.แรงม้า,
            capital_investment: selectedFactory.properties.เงินลงทุน,
            total_workers: (selectedFactory.properties.คนงานชาย || 0) + (selectedFactory.properties.คนงานหญิง || 0),
            juristic_name: selectedFactory.properties.ผู้ประกอบก,
            lat: selectedFactory.geometry.coordinates[1],
            lng: selectedFactory.geometry.coordinates[0],
          }}
        />
      )}
    </Box>
  );
};

export default Sidebar;
