import React from "react";
import { Box, Text, Flex } from "@chakra-ui/react";
import type { FactoryFeature, UserLocation } from "../types/factory";
import { HIGH_RISK_FACTORY_TYPES } from "../types/factory";

interface FactoryCardProps {
  factory: FactoryFeature;
  isSelected: boolean;
  onClick: () => void;
  userLocation: UserLocation | null;
}

const FactoryCard: React.FC<FactoryCardProps> = ({
  factory,
  isSelected,
  onClick,
  userLocation,
}) => {
  const props = factory.properties;
  const isHighRisk = HIGH_RISK_FACTORY_TYPES.includes(props.ประเภท);

  // Check if we have detail info beyond just name
  const hasOperator = props.ผู้ประกอบก && props.ผู้ประกอบก !== "—";
  const hasBusinessType = props.ประกอบกิจก && props.ประกอบกิจก !== "—";
  const hasDetails = hasOperator || hasBusinessType;

  // Calculate distance
  let distance: number | null = null;
  if (userLocation) {
    const R = 6371;
    const factoryLat = factory.geometry.coordinates[1];
    const factoryLng = factory.geometry.coordinates[0];
    const dLat = ((factoryLat - userLocation.lat) * Math.PI) / 180;
    const dLng = ((factoryLng - userLocation.lng) * Math.PI) / 180;
    const lat1 = (userLocation.lat * Math.PI) / 180;
    const lat2 = (factoryLat * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    distance = R * c;
  }

  // Compact mode: only name + distance when no extra info
  if (!hasDetails) {
    return (
      <Flex
        py={2}
        px={4}
        mx={1}
        align="center"
        gap={2}
        bg={isSelected ? "white" : "transparent"}
        borderRadius="lg"
        border="1px solid"
        borderColor={isSelected ? "slate.200" : "transparent"}
        cursor="pointer"
        transition="all 0.15s ease"
        _hover={{ bg: "white", borderColor: "slate.100" }}
        onClick={onClick}
      >
        <Box
          w="6px"
          h="6px"
          borderRadius="full"
          bg={isHighRisk ? "#EF4444" : "#10B981"}
          flexShrink={0}
        />
        <Text
          flex="1"
          fontWeight="500"
          color="slate.700"
          fontSize="sm"
          noOfLines={1}
        >
          {props.ชื่อโรงงาน}
        </Text>
        {distance !== null && (
          <Text 
            fontSize="xs" 
            fontWeight={distance < 1 ? "600" : "500"}
            color={distance < 1 ? "primary.600" : "slate.400"}
            fontFamily="'Inter', sans-serif" 
            flexShrink={0}
            bg={distance < 1 ? "primary.50" : "transparent"}
            px={distance < 1 ? 2 : 0}
            py={distance < 1 ? 0.5 : 0}
            borderRadius={distance < 1 ? "md" : "none"}
          >
            {distance < 1
              ? `${(distance * 1000).toFixed(0)} ม.`
              : `${distance.toFixed(1)} กม.`}
          </Text>
        )}
      </Flex>
    );
  }

  return (
    <Box
      py={4}
      px={4}
      mx={1}
      bg={isSelected ? "white" : "transparent"}
      borderRadius="xl"
      border="1px solid"
      borderColor={isSelected ? "slate.200" : "transparent"}
      cursor="pointer"
      transition="all 0.15s ease"
      _hover={{
        bg: "white",
        borderColor: "slate.100",
      }}
      onClick={onClick}
      position="relative"
    >
      {/* LAYER 1: Subconscious Hook — risk color bar (no reading needed) */}
      {isSelected && (
        <Box
          position="absolute"
          left={0}
          top="12px"
          bottom="12px"
          w="3px"
          bg={isHighRisk ? "accent.crimson" : "primary.400"}
          borderRadius="full"
        />
      )}

      {/* Header: Name + Status dot */}
      <Flex justify="space-between" align="start" gap={3}>
        <Box flex="1">
          <Text
            fontWeight="600"
            color="slate.800"
            fontSize="sm"
            lineHeight="1.4"
            noOfLines={2}
          >
            {props.ชื่อโรงงาน}
          </Text>
        </Box>
        {/* Layer 1: Pre-attentive risk dot */}
        <Box
          w="8px"
          h="8px"
          borderRadius="full"
          bg={isHighRisk ? "#EF4444" : "#10B981"}
          flexShrink={0}
          mt={1}
        />
      </Flex>

      {/* LAYER 2: Chunked details — max 2 lines of context */}
      <Text
        fontSize="xs"
        color="slate.500"
        mt={1.5}
        noOfLines={1}
      >
        {props.ผู้ประกอบก || "—"}
      </Text>
      <Text
        fontSize="xs"
        color="slate.400"
        mt={0.5}
        noOfLines={1}
      >
        {props.ประกอบกิจก || "—"}
      </Text>

      {/* Footer: Type + District + Distance — 3 chunks max */}
      <Flex justify="space-between" align="center" mt={3}>
        <Flex gap={2} align="center">
          <Text
            fontSize="xs"
            fontWeight="500"
            color={isHighRisk ? "red.600" : "slate.500"}
            bg={isHighRisk ? "red.50" : "slate.50"}
            px={2}
            py={0.5}
            borderRadius="md"
          >
            {props.ประเภท}
          </Text>
          <Text fontSize="xs" color="slate.400">
            {props.อำเภอ}
          </Text>
        </Flex>

        {distance !== null && (
          <Text 
            fontSize="xs" 
            fontWeight={distance < 1 ? "600" : "500"}
            color={distance < 1 ? "primary.600" : "slate.400"}
            fontFamily="'Inter', sans-serif"
            bg={distance < 1 ? "primary.50" : "transparent"}
            px={distance < 1 ? 2 : 0}
            py={distance < 1 ? 0.5 : 0}
            borderRadius={distance < 1 ? "md" : "none"}
          >
            {distance < 1
              ? `${(distance * 1000).toFixed(0)} ม.`
              : `${distance.toFixed(1)} กม.`}
          </Text>
        )}
      </Flex>
    </Box>
  );
};

export default FactoryCard;
