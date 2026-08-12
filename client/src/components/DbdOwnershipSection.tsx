import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Collapse,
  Divider,
  Flex,
  Icon,
  SimpleGrid,
  Skeleton,
  SkeletonText,
  Text,
  VStack,
} from "@chakra-ui/react";
import { useDbdDetail, useDbdProfile } from "../hooks/useDbdProfile";
import { summarizeNationalities } from "../utils/nationality";
import type { NationalityShare } from "../utils/nationality";

interface DbdOwnershipSectionProps {
  factoryId: string;
  /** English province name — selects which static ownership file to load. */
  provinceEn: string | null;
}

const compactBaht = new Intl.NumberFormat("th-TH", {
  notation: "compact",
  maximumFractionDigits: 1,
});

// Distinct navy-family shades for foreign shareholder segments in the
// nationality bar, so multiple foreign nationalities stay distinguishable.
// Thai (slate) and unknown (pale) are handled separately at the call site.
const FOREIGN_BAR_COLORS = ["#0B3558", "#2F6987", "#5D91A8", "#8FB9C9"];

function formatBaht(value: number | null): string {
  if (value === null) return "—";
  return `${compactBaht.format(value)} บาท`;
}

/** Trim trailing zeros so 99.96% keeps its precision and 80% stays "80%". */
function formatPercent(value: number): string {
  return `${Number(value.toFixed(2)).toLocaleString("th-TH")}%`;
}

/**
 * Say what DBD said. A shareholding percentage where one was published; a
 * headcount otherwise — the two are never silently interchanged.
 */
function describeShare(share: NationalityShare): string {
  if (share.percent !== null) return formatPercent(share.percent);
  return `${share.holders ?? 0} ราย`;
}

/**
 * Why a shareholder list is missing, in the source's own terms.
 */
function undisclosedReason(juristicType: string | null): string {
  if (juristicType && juristicType.startsWith("บริษัท")) {
    return "ชุดข้อมูลสาธารณะของ DBD ไม่เปิดเผยรายชื่อผู้ถือหุ้นของบริษัทจำกัด (เปิดเผยเฉพาะห้างหุ้นส่วน) จึงยังไม่ทราบสัญชาติผู้ถือหุ้นของโรงงานนี้";
  }
  return "DBD ไม่ได้เปิดเผยรายชื่อผู้ถือหุ้นของนิติบุคคลนี้ จึงยังไม่ทราบสัญชาติ";
}

const BuildingIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={4}>
    <path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M16 9h3a1 1 0 0 1 1 1v11M2 21h20" />
    <path d="M8 7h4M8 11h4M8 15h4M8 19h4" />
  </Icon>
);

const PeopleIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

const GlobeIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
  </Icon>
);

/**
 * Section shell. Every state — loading, error, unmatched, loaded — renders
 * inside it, so this panel never reads as one more DIW field: DIW says what the
 * factory is, DBD says who owns it, and the two sources have to stay separately
 * attributable to the reader.
 */
const DbdShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    as="section"
    aria-label="ข้อมูลนิติบุคคลจากกรมพัฒนาธุรกิจการค้า"
    borderRadius="2xl"
    border="1px solid"
    borderColor="#DCE7EC"
    bg="#FAFCFD"
    overflow="hidden"
  >
    <Flex align="center" gap={2} px={4} py={2.5} bg="#E8F1F4" color="#0B3558">
      <BuildingIcon />
      <Text fontSize="10px" fontWeight="800" letterSpacing=".06em" lineHeight="1.4">
        ใครเป็นเจ้าของ · กรมพัฒนาธุรกิจการค้า (DBD)
      </Text>
    </Flex>
    <Box px={4} py={4}>
      {children}
    </Box>
  </Box>
);

const DbdOwnershipSection: React.FC<DbdOwnershipSectionProps> = ({ factoryId, provinceEn }) => {
  const { profile, isLoading, hasLoaded, error, retry } = useDbdProfile(factoryId, provinceEn);
  const [isExpanded, setIsExpanded] = useState(false);
  // Directors, shareholders and financials are half the exported bytes and
  // only render here, so they are fetched the first time someone asks.
  const { detail, isLoading: isDetailLoading } =
    useDbdDetail(factoryId, provinceEn, isExpanded);

  useEffect(() => {
    setIsExpanded(false);
  }, [factoryId]);

  if (isLoading) {
    return (
      <DbdShell>
        <Flex align="center" gap={3}>
          <Skeleton boxSize="34px" borderRadius="full" />
          <SkeletonText flex="1" noOfLines={2} spacing={2} skeletonHeight="3" />
        </Flex>
      </DbdShell>
    );
  }

  if (error) {
    return (
      <DbdShell>
        <Flex align="center" justify="space-between" gap={3}>
          <Text fontSize="sm" color="slate.500">{error}</Text>
          <Button size="xs" variant="ghost" color="#0B3558" onClick={retry}>
            ลองใหม่
          </Button>
        </Flex>
      </DbdShell>
    );
  }

  if (!profile) {
    if (!hasLoaded) return null;
    return (
      <DbdShell>
        <Text fontSize="sm" color="slate.600">
          ยังไม่พบข้อมูลนิติบุคคลที่จับคู่ได้อย่างมั่นใจ
        </Text>
        <Text fontSize="xs" color="slate.400" mt={1} lineHeight="1.6">
          ผู้ประกอบการอาจเป็นบุคคลธรรมดา หรือชื่อใน DIW และ DBD ไม่ตรงกัน
        </Text>
      </DbdShell>
    );
  }

  const isActive = profile.legalStatus === "ยังดำเนินกิจการอยู่";
  const nationalities = summarizeNationalities(profile.nationalities, detail?.owners ?? []);
  const visibleDirectors = (detail?.directors ?? []).slice(0, 6);
  const remainingDirectors = Math.max(0, (detail?.directors.length ?? 0) - visibleDirectors.length);

  return (
    <DbdShell>
      {/* LAYER 2: the legal owner */}
      <Flex align="center" gap={2} wrap="wrap" mb={1}>
        {profile.legalStatus && (
          <Badge
            bg={isActive ? "green.50" : "slate.200"}
            color={isActive ? "green.700" : "slate.600"}
            fontSize="9px"
            borderRadius="full"
            px={2}
            textTransform="none"
          >
            {profile.legalStatus}
          </Badge>
        )}
        {!profile.humanVerified && (
          <Text fontSize="9px" color="slate.400">จับคู่อัตโนมัติจากชื่อ</Text>
        )}
      </Flex>
      <Text fontSize="md" color="#0B3558" fontWeight="700" lineHeight="1.35">
        {profile.juristicName}
      </Text>
      <Text fontSize="xs" color="slate.500" mt={1}>
        {profile.juristicType ? `${profile.juristicType} · ` : ""}
        เลขทะเบียน {profile.juristicId}
      </Text>

      {(profile.registeredCapital !== null || profile.registeredProvince) && (
        <SimpleGrid columns={2} spacing={3} mt={4}>
          {profile.registeredCapital !== null && (
            <Box>
              <Text fontSize="10px" color="slate.400">ทุนจดทะเบียน</Text>
              <Text
                fontSize="sm"
                color="slate.700"
                fontWeight="700"
                title={`${profile.registeredCapital.toLocaleString("th-TH")} บาท`}
              >
                {formatBaht(profile.registeredCapital)}
              </Text>
            </Box>
          )}
          {profile.registeredProvince && (
            <Box>
              <Text fontSize="10px" color="slate.400">จังหวัดที่จดทะเบียน</Text>
              <Text fontSize="sm" color="slate.700" fontWeight="600">
                {profile.registeredProvince}
              </Text>
            </Box>
          )}
        </SimpleGrid>
      )}

      {/* LAYER 2: Minimal Visual Shareholder Nationality Breakdown */}
      <Box mt={4} pt={4} borderTop="1px solid" borderColor="#E4EDF1">
        <Flex align="center" justify="space-between" mb={2.5}>
          <Flex align="center" gap={2} color="slate.600">
            <GlobeIcon />
            <Text fontSize="xs" fontWeight="700">สัญชาติผู้ถือหุ้น</Text>
          </Flex>
          {nationalities.hasForeign && (
            <Badge bg="#0B3558" color="white" borderRadius="full" px={2.5} py={0.5} fontSize="10px" fontWeight="700">
              {nationalities.foreignPercent !== null
                ? `ต่างชาติถือหุ้น ${formatPercent(nationalities.foreignPercent)}`
                : "มีต่างชาติถือหุ้น"}
            </Badge>
          )}
        </Flex>

        {nationalities.isUndisclosed ? (
          <Text fontSize="xs" color="slate.500" lineHeight="1.6">
            {undisclosedReason(profile.juristicType)}
            <Text as="span" color="slate.400"> (ไม่ได้แปลว่าเป็นของคนไทยทั้งหมด)</Text>
          </Text>
        ) : (
          <Box bg="slate.50" p={3} borderRadius="xl" border="1px solid" borderColor="slate.200">
            {/* Segment widths follow DBD's own shareholding percentages when it
                published them, and holder headcount only when it did not —
                never headcount dressed up as a shareholding figure. */}
            <Flex h="7px" borderRadius="full" overflow="hidden" bg="slate.200" mb={2.5}>
              {nationalities.shares.map((share, i) => (
                <Box
                  key={share.code ?? "unknown"}
                  w={`${share.weight}%`}
                  bg={
                    share.isUnknown
                      ? "#CBD5E1"
                      : share.isThai
                        ? "primary.500"
                        : FOREIGN_BAR_COLORS[i % FOREIGN_BAR_COLORS.length]
                  }
                  title={`${share.label}: ${describeShare(share)}`}
                />
              ))}
            </Flex>

            <Flex wrap="wrap" gap={2}>
              {nationalities.shares.map((share) => (
                <Badge
                  key={share.code ?? "unknown"}
                  borderRadius="lg"
                  px={2.5}
                  py={1}
                  fontSize="xs"
                  fontWeight="700"
                  textTransform="none"
                  {...(share.isUnknown
                    ? {
                        bg: "transparent",
                        color: "slate.400",
                        border: "1px dashed",
                        borderColor: "slate.300",
                      }
                    : share.isThai
                      ? { bg: "primary.50", color: "primary.700", border: "1px solid", borderColor: "primary.200" }
                      : { bg: "#0B3558", color: "white" })}
                >
                  {share.label} {describeShare(share)}
                </Badge>
              ))}
            </Flex>

            <Text fontSize="10px" color="slate.400" mt={2} lineHeight="1.6">
              {nationalities.basis === "share"
                ? "สัดส่วนการถือหุ้นตามที่ DBD เปิดเผย"
                : `นับจากผู้ถือหุ้น ${nationalities.totalHolders} รายที่ DBD เปิดเผย — เป็นจำนวนราย ไม่ใช่สัดส่วนการถือหุ้น`}
            </Text>
          </Box>
        )}
      </Box>

      {/* LAYER 3: Minimal directors and financial details collapse */}
      {profile.hasDetail && (
      <>
      <Button
        mt={4}
        minH="40px"
        w="full"
        variant="ghost"
        bg="#EFF5F7"
        color="#0B3558"
        _hover={{ bg: "#E4EDF1" }}
        justifyContent="space-between"
        fontSize="xs"
        fontWeight="700"
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
        rightIcon={
          <Icon
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            boxSize={4}
            transform={isExpanded ? "rotate(180deg)" : "none"}
            transition="transform 160ms ease"
          >
            <path d="m6 9 6 6 6-6" />
          </Icon>
        }
      >
        {isExpanded ? "ซ่อนกรรมการและงบการเงิน" : "ดูกรรมการและงบการเงิน"}
      </Button>

      <Collapse in={isExpanded} animateOpacity>
        {isDetailLoading && (
          <VStack align="stretch" spacing={3} pt={4}>
            <SkeletonText noOfLines={3} spacing={2} skeletonHeight="3" />
            <SkeletonText noOfLines={2} spacing={2} skeletonHeight="3" />
          </VStack>
        )}
        <VStack align="stretch" spacing={4} pt={4} display={isDetailLoading ? "none" : undefined}>
          <Box>
            <Flex align="center" gap={2} color="slate.600" mb={2}>
              <PeopleIcon />
              <Text fontSize="xs" fontWeight="700">กรรมการ</Text>
            </Flex>
            {visibleDirectors.length ? (
              <VStack align="stretch" spacing={1.5}>
                {visibleDirectors.map((director, index) => (
                  <Text key={`${director.name}-${index}`} fontSize="sm" color="slate.700">
                    {director.name}
                  </Text>
                ))}
                {remainingDirectors > 0 && (
                  <Text fontSize="xs" color="slate.400">และอีก {remainingDirectors} ราย</Text>
                )}
              </VStack>
            ) : (
              <Text fontSize="xs" color="slate.400">ยังไม่มีรายชื่อกรรมการในชุดข้อมูล</Text>
            )}
          </Box>

          <Divider borderColor="#E4EDF1" />

          <Box>
            <Text fontSize="xs" color="slate.600" fontWeight="700" mb={2}>
              งบการเงินล่าสุด{detail?.financial ? ` · ปี ${detail.financial.year}` : ""}
            </Text>
            {detail?.financial ? (
              <SimpleGrid columns={2} spacingX={4} spacingY={3}>
                <Box>
                  <Text fontSize="10px" color="slate.400">รายได้รวม</Text>
                  <Text fontSize="sm" color="slate.700" fontWeight="700">
                    {formatBaht(detail.financial.totalRevenue)}
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="10px" color="slate.400">กำไรสุทธิ</Text>
                  <Text fontSize="sm" color="slate.700" fontWeight="700">
                    {formatBaht(detail.financial.netProfit)}
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="10px" color="slate.400">สินทรัพย์รวม</Text>
                  <Text fontSize="sm" color="slate.700" fontWeight="700">
                    {formatBaht(detail.financial.totalAssets)}
                  </Text>
                </Box>
              </SimpleGrid>
            ) : (
              <Text fontSize="xs" color="slate.400">ยังไม่มีงบการเงินในชุดข้อมูล</Text>
            )}
          </Box>

          <Text fontSize="10px" color="slate.400" lineHeight="1.6">
            ที่มา: กรมพัฒนาธุรกิจการค้า (DBD) · เชื่อมโยงกับข้อมูลโรงงานของ DIW
            จากชื่อผู้ประกอบการที่ตรงกัน
          </Text>
        </VStack>
      </Collapse>
      </>
      )}
    </DbdShell>
  );
};

export default DbdOwnershipSection;
