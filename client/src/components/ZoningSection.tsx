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

  // Two tiers carry a land use and one does not. A provincial *footprint* has
  // no code, label or colour — rendering one would be inventing the very thing
  // DPT does not publish in that layer.
  const municipal = zone?.tier === "municipal" ? zone : null;
  const provLandUse = zone?.tier === "province_landuse" ? zone : null;
  const provincial = zone?.tier === "province" ? zone : null;

  // The provincial tier is DPT's own published label and colour for its own
  // plan, so it is passed through rather than remapped onto our municipal
  // wording. zoneDisplay falls back to exactly that for a family it has no
  // copy for, which is the honest rendering: DPT's words, DPT's colour.
  const zoned = municipal ?? provLandUse;
  const display = zoned ? zoneDisplay(zoned.kind, zoned.label, zoned.color) : null;

  // The heading names the instrument this card is actually reading, so it may
  // only claim one when there is one. An earlier version chose between the two
  // plan names on `municipal ? … : …`, which meant every card with no zone at
  // all — and every provincial *footprint* — was headed "ผังเมืองรวมจังหวัด"
  // above the words "ไม่มีข้อมูลผังเมืองสำหรับตำแหน่งนี้". A header asserting a
  // plan over a body denying one is worse than either alone.
  const planLabel =
    municipal ? "ผังเมืองรวม · กรมโยธาธิการและผังเมือง (DPT)"
    : provLandUse || provincial ? "ผังเมืองรวมจังหวัด · กรมโยธาธิการและผังเมือง (DPT)"
    : "ผังเมืองรวม · กรมโยธาธิการและผังเมือง (DPT)";

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
            {planLabel}
          </Text>
        </Flex>
        {zoned && (
          <Badge bg="whiteAlpha.800" color="slate.600" fontSize="9px" borderRadius="full" px={2}>
            รหัส {zoned.code}
          </Badge>
        )}
      </Flex>

      {zoned && display ? (
        <>
          <Flex align="center" gap={2}>
            <Box
              w="10px"
              h="10px"
              borderRadius="full"
              bg={display.color}
              flexShrink={0}
              /* DPT draws some classes as a hatch, not a solid fill. A ring
                 rather than a dot keeps the chip honest about that instead of
                 flattening a pattern into a block of colour. */
              border={provLandUse?.patterned ? "2px solid" : undefined}
              borderColor={provLandUse?.patterned ? display.color : undefined}
              bgColor={provLandUse?.patterned ? "transparent" : display.color}
            />
            <Text fontSize="sm" fontWeight="700" color="slate.800">
              {display.title}
            </Text>
          </Flex>
          <Text fontSize="xs" color="slate.600" mt={1.5} lineHeight="1.6">
            {display.meaning}
          </Text>
          <Text fontSize="10px" color="slate.500" mt={2} lineHeight="1.7">
            {(municipal
              ? [
                  municipal.planName,
                  municipal.block ? `บริเวณ ${municipal.block}` : null,
                  municipal.planYear ? `ผังปี ${municipal.planYear}` : null,
                ]
              : [
                  "ผังเมืองรวมจังหวัด",
                  provLandUse?.block ? `บริเวณ ${provLandUse.block}` : null,
                ]
            )
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
      ) : provincial ? (
        <>
          {/* DPT's provincial layer publishes plan footprints and no land-use
              attribute at all, so this branch may say that a plan covers the
              point and must stop there. No colour dot, no category, no code —
              there is nothing here to derive one from, and a grey pill that
              looked like the zoned card would read as a finding we do not have. */}
          <Text fontSize="sm" color="slate.700" fontWeight="600">
            อยู่ในเขตผังเมืองรวมจังหวัด — ไม่ทราบประเภทการใช้ประโยชน์ที่ดิน
          </Text>
          {provincial.planName && (
            <Text fontSize="10px" color="slate.500" mt={2} lineHeight="1.7">
              {provincial.planName}
            </Text>
          )}
          <Text fontSize="xs" color="slate.600" mt={1.5} lineHeight="1.6">
            จุดนี้อยู่ในขอบเขตผังเมืองรวมระดับจังหวัดที่ DPT เผยแพร่
            แต่ชั้นข้อมูลนั้นให้เฉพาะขอบเขตผัง ไม่มีรายละเอียดการใช้ประโยชน์ที่ดินรายแปลง
            จึงยังไม่ทราบว่าจุดนี้ถูกกำหนดให้เป็นพื้นที่ประเภทใด
            ตรวจสอบรายละเอียดได้ที่เว็บไซต์ DPT
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
