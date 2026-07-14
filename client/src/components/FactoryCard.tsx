import React from "react";
import { Box, Flex, Icon, Text } from "@chakra-ui/react";
import type { FactoryFeature, UserLocation } from "../types/factory";
import { HIGH_RISK_FACTORY_TYPES } from "../types/factory";
import { haversineKm, formatDistanceTh } from "../utils/geo";

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
  const riskColor = isHighRisk ? "#EF4444" : "#10B981";
  const riskDetailColor = isHighRisk ? "#B91C1C" : "#087F5B";

  const distance = userLocation
    ? haversineKm(
        userLocation.lat,
        userLocation.lng,
        factory.geometry.coordinates[1],
        factory.geometry.coordinates[0]
      )
    : null;

  const contextLine =
    props.ประกอบกิจก?.trim() ||
    [props.อำเภอ, props.จังหวัด].filter(Boolean).join(" · ") ||
    `โรงงานจำพวก ${props.ประเภท}`;

  return (
    <Box
      as="button"
      type="button"
      w="full"
      p={4}
      mb={2.5}
      bg="white"
      borderRadius="2xl"
      border="1px solid"
      borderColor={isSelected ? "primary.200" : "slate.100"}
      boxShadow={isSelected ? "0 8px 24px rgba(11, 53, 88, 0.12)" : "sm"}
      cursor="pointer"
      textAlign="left"
      position="relative"
      overflow="hidden"
      transition="transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease"
      _hover={{
        transform: "translateY(-1px)",
        borderColor: isHighRisk ? "red.200" : "#B9D2DA",
        boxShadow: "0 8px 24px rgba(11, 53, 88, 0.1)",
      }}
      _focusVisible={{
        outline: "none",
        boxShadow: "0 0 0 3px rgba(240, 82, 35, 0.2)",
      }}
      onClick={onClick}
      aria-label={`ดูรายละเอียด ${props.ชื่อโรงงาน}`}
    >
      <Box
        position="absolute"
        left={0}
        top={3}
        bottom={3}
        w="4px"
        bg={riskColor}
        borderRightRadius="full"
      />

      <Flex align="flex-start" gap={3}>
        <Flex
          w="42px"
          h="42px"
          borderRadius="xl"
          bg={isHighRisk ? "red.50" : "green.50"}
          align="center"
          justify="center"
          flexShrink={0}
        >
          <Icon viewBox="0 0 32 32" boxSize="25px" aria-hidden="true">
            <path d="M4 26V12l7 4V10l7 4V7l10 5.5V26H4Z" fill={riskColor} />
            <path d="M9 23v-4m5 4v-4m5 4v-4" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </Icon>
        </Flex>

        <Box flex="1" minW={0}>
          <Flex align="flex-start" justify="space-between" gap={3}>
            <Text
              flex="1"
              fontWeight="700"
              color="slate.800"
              fontSize="sm"
              lineHeight="1.45"
              noOfLines={2}
            >
              {props.ชื่อโรงงาน || "ไม่ระบุชื่อโรงงาน"}
            </Text>
            {distance !== null && (
              <Text
                fontSize="xs"
                fontWeight="700"
                color={distance < 1 ? "primary.600" : "slate.600"}
                fontFamily="'Inter', sans-serif"
                flexShrink={0}
              >
                {formatDistanceTh(distance)}
              </Text>
            )}
          </Flex>

          <Text fontSize="xs" color="slate.500" mt={1} noOfLines={1}>
            {contextLine}
          </Text>
        </Box>
      </Flex>

      <Flex
        mt={3}
        pt={3}
        borderTop="1px solid"
        borderColor="slate.100"
        align="center"
        justify="space-between"
        gap={3}
      >
        <Flex align="center" gap={1.5} minW={0}>
          <Box w="5px" h="5px" borderRadius="full" bg={riskDetailColor} flexShrink={0} />
          <Text
            fontSize="10px"
            color="slate.400"
            fontFamily="'Inter', 'IBM Plex Sans Thai', sans-serif"
            noOfLines={1}
          >
            ทะเบียน {props.เลขทะเบียน || "ไม่ระบุ"}
          </Text>
        </Flex>

        <Flex align="center" gap={1} color="primary.600" flexShrink={0}>
          <Text fontSize="xs" fontWeight="600">ดูข้อมูล</Text>
          <Icon viewBox="0 0 20 20" boxSize={3.5} fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m7 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </Icon>
        </Flex>
      </Flex>
    </Box>
  );
};

export default FactoryCard;
