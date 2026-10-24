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

import { evaluateObjectiveMatch, getTsicDescription } from "../utils/tsic";

interface DbdOwnershipSectionProps {
  factoryId: string;
  /** English province name — selects which static ownership file to load. */
  provinceEn: string | null;
  /** Factory operation permitted by DIW (ประกอบกิจการ) */
  factoryObjective?: string | null;
  /** Factory industry type/class (จำพวก/ประเภทโรงงาน) */
  factoryType?: string | null;
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

const PersonIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Icon>
);

const CheckCircleIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </Icon>
);

const AlertTriangleIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Icon>
);

const BriefcaseIcon = () => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
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

const DbdOwnershipSection: React.FC<DbdOwnershipSectionProps> = ({
  factoryId,
  provinceEn,
  factoryObjective,
  factoryType,
}) => {
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

      {/* BUSINESS TYPE & PERMIT COMPARISON (วัตถุประสงค์นิติบุคคล DBD เทียบกับใบอนุญาต DIW) */}
      {(() => {
        const objectiveText = profile.businessObjective || detail?.businessObjective;
        const tsic = profile.tsicCode || detail?.tsicCode;
        const tsicDesc = getTsicDescription(tsic);
        const matchResult = evaluateObjectiveMatch(factoryObjective, objectiveText, tsic);

        return (
          <Box mt={3.5} pt={3.5} borderTop="1px solid" borderColor="#E4EDF1">
            <Flex align="center" justify="space-between" mb={2} wrap="wrap" gap={1.5}>
              <Flex align="center" gap={1.5} color="slate.600">
                <BriefcaseIcon />
                <Text fontSize="xs" fontWeight="700">ประเภทธุรกิจ (DBD)</Text>
              </Flex>
              <Flex align="center" gap={1.5}>
                {tsic && (
                  <Badge
                    bg="blue.50"
                    color="blue.700"
                    borderRadius="full"
                    px={2}
                    py={0.2}
                    fontSize="9px"
                    fontWeight="700"
                  >
                    TSIC {tsic}
                  </Badge>
                )}
                {objectiveText && (
                  <Badge
                    bg={
                      matchResult.status === "match"
                        ? "green.50"
                        : matchResult.status === "discrepancy"
                        ? "amber.50"
                        : "slate.100"
                    }
                    color={
                      matchResult.status === "match"
                        ? "green.700"
                        : matchResult.status === "discrepancy"
                        ? "amber.800"
                        : "slate.600"
                    }
                    border="1px solid"
                    borderColor={
                      matchResult.status === "match"
                        ? "green.200"
                        : matchResult.status === "discrepancy"
                        ? "amber.300"
                        : "slate.200"
                    }
                    borderRadius="full"
                    px={2}
                    py={0.2}
                    fontSize="9px"
                    fontWeight="700"
                  >
                    {matchResult.label}
                  </Badge>
                )}
              </Flex>
            </Flex>

            {/* DBD Objective Content */}
            <Box p={2.5} bg="slate.50" borderRadius="lg" border="1px solid" borderColor="slate.200">
              <Text fontSize="xs" color="slate.800" fontWeight="500" lineHeight="1.5">
                {objectiveText || (
                  tsicDesc ? (
                    <Text as="span" color="slate.700">{tsicDesc}</Text>
                  ) : (
                    <Text as="span" color="slate.400" fontStyle="italic">
                      อยู่ระหว่างรวบรวมข้อมูลวัตถุประสงค์ DBD
                    </Text>
                  )
                )}
              </Text>
            </Box>

            {/* Comparison against DIW Permit */}
            {factoryObjective && (
              <Box mt={2} p={2.5} bg="white" borderRadius="lg" border="1px dashed" borderColor="#CBD5E1">
                <Flex align="center" justify="space-between" mb={1} wrap="wrap" gap={1}>
                  <Text fontSize="10px" fontWeight="700" color="slate.500">
                    เทียบกับประเภทกิจการตามใบอนุญาตโรงงาน (DIW)
                  </Text>
                  {factoryType && (
                    <Badge fontSize="9px" colorScheme="gray" variant="subtle" borderRadius="full" px={1.5}>
                      {factoryType.startsWith("ลำดับ") ? factoryType : `จำพวก/ลำดับที่ ${factoryType}`}
                    </Badge>
                  )}
                </Flex>
                <Text fontSize="xs" color="slate.700" lineHeight="1.5">
                  {factoryObjective}
                </Text>
                {matchResult.reason && objectiveText && (
                  <Text fontSize="10px" color={matchResult.status === "discrepancy" ? "amber.700" : "slate.400"} mt={1}>
                    หมายเหตุ: {matchResult.reason}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        );
      })()}

      {/* LAYER 2: Minimal Visual Shareholder Nationality Breakdown */}
      <Box mt={4} pt={4} borderTop="1px solid" borderColor="#E4EDF1">
        <Flex align="center" justify="space-between" mb={2.5} wrap="wrap" gap={2}>
          <Flex align="center" gap={2} color="slate.600">
            <GlobeIcon />
            <Text fontSize="xs" fontWeight="700">สัญชาติผู้ถือหุ้น</Text>
            {profile.hasShareholderCheck && (
              <Badge
                bg="teal.50"
                color="teal.700"
                border="1px solid"
                borderColor="teal.200"
                borderRadius="full"
                px={2}
                py={0.5}
                fontSize="9px"
                fontWeight="700"
                display="inline-flex"
                alignItems="center"
                gap={1}
              >
                <CheckCircleIcon />
                บอจ.5 ตรวจสอบแล้ว
              </Badge>
            )}
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

          {/* SHAREHOLDERS LIST (บอจ.5 / รายชื่อผู้ถือหุ้น) */}
          {detail?.owners && detail.owners.length > 0 && (
            <>
              <Box>
                <Flex align="center" justify="space-between" mb={2.5}>
                  <Flex align="center" gap={2} color="slate.600">
                    <PeopleIcon />
                    <Text fontSize="xs" fontWeight="700">
                      {profile.hasShareholderCheck ? "รายชื่อผู้ถือหุ้น (บอจ.5)" : "รายชื่อผู้มีอำนาจ / หุ้นส่วน"}
                    </Text>
                  </Flex>
                  {detail.shareholderMeta?.totalShares ? (
                    <Text fontSize="10px" color="slate.400">
                      {detail.shareholderMeta.totalShares.toLocaleString()} หุ้น
                    </Text>
                  ) : null}
                </Flex>

                {detail.shareholderMeta?.hasOffshore && (
                  <Box mb={3} p={2.5} bg="amber.50" border="1px solid" borderColor="amber.200" borderRadius="lg">
                    <Flex align="flex-start" gap={2}>
                      <Box color="amber.600" mt={0.5} flexShrink={0}>
                        <AlertTriangleIcon />
                      </Box>
                      <Box>
                        <Text fontSize="xs" fontWeight="700" color="amber.900">
                          ตรวจพบนิติบุคคลจดทะเบียนต่างแดน / แดนภาษี (Offshore)
                        </Text>
                        <Text fontSize="10px" color="amber.800" mt={0.5}>
                          {detail.shareholderMeta.offshoreEntities?.join(", ")}
                        </Text>
                      </Box>
                    </Flex>
                  </Box>
                )}

                <VStack align="stretch" spacing={2}>
                  {detail.owners.map((owner, idx) => (
                    <Box
                      key={`${owner.name}-${idx}`}
                      p={2.5}
                      bg="white"
                      borderRadius="lg"
                      border="1px solid"
                      borderColor="#E4EDF1"
                    >
                      <Flex justify="space-between" align="center" gap={2} mb={1}>
                        <Flex align="center" gap={1.5} minW={0}>
                          <Box color={owner.isCorporate ? "#0B3558" : "slate.500"} flexShrink={0}>
                            {owner.isCorporate ? <BuildingIcon /> : <PersonIcon />}
                          </Box>
                          <Text fontSize="xs" fontWeight="700" color="slate.800" noOfLines={1} title={owner.name}>
                            {owner.name}
                          </Text>
                        </Flex>
                        <Flex align="center" gap={1.5} flexShrink={0}>
                          <Badge
                            fontSize="9px"
                            borderRadius="full"
                            px={1.5}
                            py={0.2}
                            bg={owner.isCorporate ? "blue.50" : "gray.100"}
                            color={owner.isCorporate ? "blue.700" : "slate.600"}
                          >
                            {owner.isCorporate ? "นิติบุคคล" : "บุคคลธรรมดา"}
                          </Badge>
                          {owner.nationality && (
                            <Badge
                              fontSize="9px"
                              borderRadius="full"
                              px={1.5}
                              py={0.2}
                              bg={owner.nationality === "ไทย" ? "primary.50" : "#0B3558"}
                              color={owner.nationality === "ไทย" ? "primary.700" : "white"}
                            >
                              {owner.nationality}
                            </Badge>
                          )}
                        </Flex>
                      </Flex>

                      <Flex justify="space-between" align="center" mt={1}>
                        <Text fontSize="10px" color="slate.500">
                          {owner.shareAmount ? `${owner.shareAmount.toLocaleString()} หุ้น` : "—"}
                        </Text>
                        {owner.sharePercent !== null && (
                          <Text fontSize="10px" fontWeight="700" color="#0B3558">
                            {formatPercent(owner.sharePercent)}
                          </Text>
                        )}
                      </Flex>

                      {owner.sharePercent !== null && (
                        <Box h="3px" bg="slate.100" borderRadius="full" overflow="hidden" mt={1}>
                          <Box
                            h="full"
                            bg={owner.nationality === "ไทย" ? "primary.500" : "#0B3558"}
                            w={`${Math.min(owner.sharePercent, 100)}%`}
                          />
                        </Box>
                      )}
                    </Box>
                  ))}
                </VStack>
              </Box>

              <Divider borderColor="#E4EDF1" />
            </>
          )}

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
