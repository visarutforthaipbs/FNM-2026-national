import { Badge, Box, Flex, Icon, Link, Skeleton, Text } from "@chakra-ui/react";
import { useZoning } from "../hooks/useZoning";
import { noZoneReason, zoneDisplay } from "../utils/zoning";

interface ZoningSectionProps {
  factoryId: string;
  provinceTh?: string;
  provinceEn: string | null;
}

const MapIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
    <path d="M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15" />
  </Icon>
);

/**
 * The factory's town-planning zone, as the Department of Public Works and Town
 * & Country Planning publishes it.
 *
 * Deliberately descriptive. Whether a factory may lawfully operate where it
 * stands depends on its จำพวก, its horsepower, the annex schedules of the
 * particular ministerial regulation, and whether it was licensed before the
 * plan took effect — we hold none of the last three, so the card reports the
 * zone and links to DPT's own map rather than reaching a verdict about a named
 * business.
 */
const ZoningSection: React.FC<ZoningSectionProps> = ({ factoryId, provinceTh, provinceEn }) => {
  const { zone, isLoading, hasLoaded } = useZoning(factoryId, provinceEn);

  if (isLoading) {
    return (
      <Box p={4} borderRadius="xl" border="1px solid" borderColor="slate.200" bg="slate.50">
        <Skeleton height="14px" width="55%" mb={2} />
        <Skeleton height="12px" width="80%" />
      </Box>
    );
  }

  // A failed fetch is not the same as "no plan here", so say nothing at all.
  if (!hasLoaded) return null;

  const display = zone ? zoneDisplay(zone.kind, zone.label, zone.color) : null;

  return (
    <Box
      as="section"
      aria-label="ผังเมืองและการใช้ประโยชน์ที่ดิน"
      p={4}
      borderRadius="xl"
      border="1px solid"
      borderColor={display ? `${display.scheme}.200` : "slate.200"}
      bg={display ? `${display.scheme}.50` : "slate.50"}
    >
      <Flex align="center" justify="space-between" mb={2} gap={2}>
        <Flex align="center" gap={2} color="slate.600">
          <MapIcon />
          <Text fontSize="xs" fontWeight="700">
            ผังเมืองรวม · กรมโยธาธิการและผังเมือง (DPT)
          </Text>
        </Flex>
        {zone?.code && (
          <Badge bg="whiteAlpha.800" color="slate.600" fontSize="9px" borderRadius="full" px={2}>
            รหัส {zone.code}
          </Badge>
        )}
      </Flex>

      {zone && display ? (
        <>
          <Flex align="center" gap={2}>
            <Box w="10px" h="10px" borderRadius="full" bg={display.color} flexShrink={0} />
            <Text fontSize="sm" fontWeight="700" color="slate.800">
              {display.title}
            </Text>
          </Flex>
          <Text fontSize="xs" color="slate.600" mt={1.5} lineHeight="1.6">
            {display.meaning}
          </Text>
          <Text fontSize="10px" color="slate.500" mt={2} lineHeight="1.7">
            {[
              zone.planName,
              zone.block ? `บริเวณ ${zone.block}` : null,
              zone.planYear ? `ผังปี ${zone.planYear}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {/* The one thing a reader most needs and we cannot supply: whether
              this particular factory is permitted here. Point at the source
              instead of guessing. */}
          <Text fontSize="10px" color="slate.500" mt={2} lineHeight="1.7">
            ตำแหน่งโรงงานอยู่ในเขตผังเมืองนี้ตามการตรวจสอบพิกัดกับแปลงผังเมืองของ DPT —
            ส่วนโรงงานจะตั้งอยู่ได้หรือไม่ ขึ้นกับจำพวกโรงงาน ขนาดเครื่องจักร
            บัญชีแนบท้ายกฎกระทรวงของผังนั้น และวันที่ได้รับใบอนุญาตเทียบกับวันประกาศใช้ผัง
          </Text>
        </>
      ) : (
        <>
          <Text fontSize="sm" color="slate.700" fontWeight="600">
            ไม่มีข้อมูลผังเมืองสำหรับตำแหน่งนี้
          </Text>
          <Text fontSize="xs" color="slate.600" mt={1.5} lineHeight="1.6">
            {noZoneReason(provinceTh)}
          </Text>
        </>
      )}

      <Link
        href="https://landuseplan.dpt.go.th/map/search"
        isExternal
        fontSize="10px"
        color="primary.600"
        fontWeight="600"
        mt={2}
        display="inline-block"
      >
        ตรวจสอบผังเมืองที่เว็บไซต์ DPT ↗
      </Link>
    </Box>
  );
};

export default ZoningSection;
