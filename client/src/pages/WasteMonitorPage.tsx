import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Grid,
  GridItem,
  HStack,
  Icon,
  Link,
  SimpleGrid,
  Skeleton,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Link as RouterLink } from "react-router-dom";
import Navbar from "../components/Navbar";

type WasteType = "101" | "105" | "106";
type TypeFilter = WasteType | "all";

interface DashboardStats {
  countByIndustry?: Record<string, number>;
  wasteByProvince?: Record<string, Record<string, number>>;
}

interface ProvinceRecord {
  province: string;
  tier: "core" | "additional";
  counts: Record<WasteType, number>;
}

const OFFICIAL_SOURCE = "https://www.diw.go.th/webdiw/pr68-709/";

const TYPE_META: Record<WasteType, { label: string; short: string; color: string; pale: string }> = {
  "101": { label: "บำบัดของเสียรวม", short: "บำบัด", color: "#0B3558", pale: "#E8F1F4" },
  "105": { label: "คัดแยกหรือฝังกลบ", short: "คัดแยก / ฝังกลบ", color: "#D23F15", pale: "#FFF0EB" },
  "106": { label: "นำของเสียกลับมาใช้ใหม่", short: "รีไซเคิล", color: "#B45309", pale: "#FFF7E6" },
};

// Static definition of DIW monitoring targets and additional assessment areas.
// Counts are resolved dynamically from the database stats.
const WATCH_PROVINCES_BASE = [
  { province: "ชลบุรี", tier: "core" as const },
  { province: "ฉะเชิงเทรา", tier: "core" as const },
  { province: "สมุทรปราการ", tier: "core" as const },
  { province: "สมุทรสาคร", tier: "core" as const },
  { province: "ระยอง", tier: "core" as const },
  { province: "สระบุรี", tier: "core" as const },
  { province: "ปราจีนบุรี", tier: "core" as const },
  { province: "ราชบุรี", tier: "core" as const },
  { province: "เพชรบุรี", tier: "core" as const },
  { province: "สระแก้ว", tier: "core" as const },
  { province: "นครราชสีมา", tier: "core" as const },
  { province: "ลพบุรี", tier: "core" as const },
  { province: "ปทุมธานี", tier: "additional" as const },
  { province: "พระนครศรีอยุธยา", tier: "additional" as const },
  { province: "นครปฐม", tier: "additional" as const },
  { province: "นนทบุรี", tier: "additional" as const },
  { province: "สงขลา", tier: "additional" as const },
];

const totalFor = (row: ProvinceRecord, filter: TypeFilter) =>
  filter === "all"
    ? row.counts["101"] + row.counts["105"] + row.counts["106"]
    : row.counts[filter];

const NumberBlock = ({ value, label, note }: { value: string; label: string; note: string }) => (
  <Box borderLeft="1px solid" borderColor="whiteAlpha.300" pl={{ base: 4, md: 6 }}>
    <Text fontFamily="'Inter', sans-serif" fontSize={{ base: "2xl", md: "4xl" }} fontWeight="800" lineHeight="1" color="white">
      {value}
    </Text>
    <Text mt={2} color="white" fontWeight="700" fontSize="sm">{label}</Text>
    <Text mt={1} color="whiteAlpha.700" fontSize="xs">{note}</Text>
  </Box>
);

const WasteMonitorPage = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activeType, setActiveType] = useState<TypeFilter>("all");
  const [showAdditional, setShowAdditional] = useState(false);

  useEffect(() => {
    fetch("/data/dashboard_stats.json")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setStats)
      .catch((error) => console.error("Unable to load waste-monitor stats", error));
  }, []);

  const currentCounts = useMemo(() => ({
    "101": stats?.countByIndustry?.["101"] ?? 0,
    "105": stats?.countByIndustry?.["105"] ?? 0,
    "106": stats?.countByIndustry?.["106"] ?? 0,
  }), [stats]);
  const catalogTotal = currentCounts["101"] + currentCounts["105"] + currentCounts["106"];

  const watchProvinces = useMemo<ProvinceRecord[]>(() => {
    const wasteData = stats?.wasteByProvince || {};
    return WATCH_PROVINCES_BASE.map((p) => ({
      province: p.province,
      tier: p.tier,
      counts: {
        "101": wasteData[p.province]?.["101"] ?? 0,
        "105": wasteData[p.province]?.["105"] ?? 0,
        "106": wasteData[p.province]?.["106"] ?? 0,
      },
    }));
  }, [stats]);

  const visibleProvinces = useMemo(() => {
    const rows = showAdditional ? watchProvinces : watchProvinces.filter((row) => row.tier === "core");
    return [...rows].sort((a, b) => totalFor(b, activeType) - totalFor(a, activeType));
  }, [watchProvinces, activeType, showAdditional]);
  const maxProvinceCount = Math.max(...visibleProvinces.map((row) => totalFor(row, activeType)), 1);

  return (
    <Box minH="100vh" bg="slate.50" color="slate.800">
      <Navbar />

      <Box bg="slate.900" color="white" position="relative" overflow="hidden">
        <Box position="absolute" insetY={0} right={0} w={{ base: "42%", lg: "34%" }} opacity={0.16}
          bgImage="repeating-linear-gradient(135deg, transparent 0 18px, #F05223 18px 20px)" />
        <Box position="absolute" top="-90px" right="12%" boxSize="250px" border="1px solid" borderColor="whiteAlpha.200" borderRadius="full" />
        <Box maxW="1240px" mx="auto" px={{ base: 5, md: 8 }} py={{ base: 10, md: 16 }} position="relative">
          <HStack spacing={2} mb={5}>
            <Box boxSize="8px" bg="#F05223" borderRadius="full" boxShadow="0 0 0 6px rgba(240,82,35,.18)" />
            <Text fontFamily="'Inter', sans-serif" fontSize="xs" fontWeight="800" letterSpacing="1.6px" color="whiteAlpha.800">
              WASTE FACILITY WATCH
            </Text>
          </HStack>

          <Grid templateColumns={{ base: "1fr", lg: "1.1fr .9fr" }} gap={{ base: 9, lg: 16 }} alignItems="end">
            <Box>
              <Text as="h1" fontSize={{ base: "3xl", md: "5xl" }} fontWeight="800" lineHeight={{ base: 1.22, md: 1.12 }} letterSpacing="-.03em" maxW="760px">
                เฝ้าระวังโรงงานกากอุตสาหกรรม
                <Text as="span" color="#FF7A52"> 101 · 105 · 106</Text>
              </Text>
              <Text mt={5} maxW="680px" color="whiteAlpha.800" fontSize={{ base: "sm", md: "md" }} lineHeight="1.9">
                มองเห็นพื้นที่ที่ต้องจับตา แยกตามบทบาทของโรงงาน และเชื่อมต่อไปยังตำแหน่งจริงบนแผนที่
                โดยไม่เหมารวมว่าโรงงานทุกแห่งมีการกระทำผิด
              </Text>
            </Box>
            <Box bg="whiteAlpha.100" border="1px solid" borderColor="whiteAlpha.200" p={{ base: 5, md: 6 }} borderRadius="2xl" backdropFilter="blur(8px)">
              <Text fontSize="xs" fontWeight="800" letterSpacing="1px" color="#FF9A7B">ขนาดของปัญหา · ข้อมูลปี 2567</Text>
              <Flex mt={4} align="baseline" gap={2}>
                <Text fontFamily="'Inter', sans-serif" fontSize={{ base: "4xl", md: "5xl" }} fontWeight="800" lineHeight="1">41.14</Text>
                <Text fontWeight="700">ล้านตัน</Text>
              </Flex>
              <Flex mt={5} gap={5}>
                <Box>
                  <Text fontFamily="'Inter', sans-serif" fontWeight="800">39.28</Text>
                  <Text fontSize="xs" color="whiteAlpha.700">ไม่อันตราย</Text>
                </Box>
                <Box w="1px" bg="whiteAlpha.300" />
                <Box>
                  <Text fontFamily="'Inter', sans-serif" fontWeight="800" color="#FF9A7B">1.86</Text>
                  <Text fontSize="xs" color="whiteAlpha.700">อันตราย</Text>
                </Box>
              </Flex>
            </Box>
          </Grid>

          <SimpleGrid columns={{ base: 1, sm: 3 }} spacing={{ base: 5, md: 0 }} mt={{ base: 10, md: 14 }}>
            <NumberBlock value="2,940" label="โรงงานในกรอบกำกับ" note="ตัวเลข DIW · พ.ย. 2568" />
            <NumberBlock value="12 + 5" label="จังหวัดที่ต้องจับตา" note="12 พื้นที่หลัก + 5 พื้นที่ประเมินเพิ่ม" />
            <NumberBlock value="2569" label="กรอบดำเนินการเร่งด่วน" note="และขยายผลในปีต่อไป" />
          </SimpleGrid>
        </Box>
      </Box>

      <Box maxW="1240px" mx="auto" px={{ base: 5, md: 8 }} py={{ base: 10, md: 14 }}>
        <Flex justify="space-between" gap={5} align={{ base: "start", md: "end" }} direction={{ base: "column", md: "row" }} mb={6}>
          <Box>
            <Text fontSize="xs" fontWeight="800" color="primary.600" letterSpacing="1.2px">ฐานข้อมูลโรงงานใกล้ฉัน</Text>
            <Text as="h2" mt={1} fontSize={{ base: "2xl", md: "3xl" }} fontWeight="800" letterSpacing="-.02em">สามประเภทที่ระบบติดตาม</Text>
          </Box>
          <Skeleton isLoaded={stats !== null} borderRadius="full">
            <Badge px={4} py={2} borderRadius="full" bg="white" color="slate.600" border="1px solid" borderColor="slate.200" textTransform="none">
              พบในบัญชีปัจจุบัน {catalogTotal.toLocaleString("th-TH")} แห่ง
            </Badge>
          </Skeleton>
        </Flex>

        <SimpleGrid columns={{ base: 1, md: 3 }} spacing={4}>
          {(Object.keys(TYPE_META) as WasteType[]).map((code) => {
            const meta = TYPE_META[code];
            return (
              <Box key={code} bg="white" borderRadius="xl" p={6} border="1px solid" borderColor="slate.200" boxShadow="sm">
                <Flex justify="space-between" align="start">
                  <Text fontFamily="'Inter', sans-serif" fontSize="3xl" fontWeight="800" color={meta.color}>{code}</Text>
                  <Skeleton isLoaded={stats !== null} borderRadius="md">
                    <Text fontFamily="'Inter', sans-serif" fontSize="2xl" fontWeight="800">{currentCounts[code].toLocaleString("th-TH")}</Text>
                  </Skeleton>
                </Flex>
                <Text mt={5} fontWeight="800" fontSize="lg">{meta.label}</Text>
                <Text mt={2} fontSize="sm" color="slate.500" lineHeight="1.7">
                  {code === "101" && "สถานที่บำบัดหรือกำจัดของเสียจากหลายแหล่งรวมกัน"}
                  {code === "105" && "สถานที่คัดแยกหรือฝังกลบสิ่งปฏิกูลและวัสดุที่ไม่ใช้แล้ว"}
                  {code === "106" && "สถานที่นำผลิตภัณฑ์อุตสาหกรรมหรือของเสียกลับมาใช้ประโยชน์ใหม่"}
                </Text>
              </Box>
            );
          })}
        </SimpleGrid>

        <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1.45fr) minmax(300px, .55fr)" }} gap={5} mt={{ base: 10, md: 14 }}>
          <GridItem bg="white" border="1px solid" borderColor="slate.200" borderRadius="xl" p={{ base: 5, md: 7 }} boxShadow="sm">
            <Flex justify="space-between" gap={4} direction={{ base: "column", md: "row" }} align={{ base: "start", md: "center" }}>
              <Box>
                <Text as="h2" fontSize="xl" fontWeight="800">พื้นที่เฝ้าระวังตามกรอบ DIW</Text>
                <Text mt={1} fontSize="sm" color="slate.500">จำนวนเฉพาะระเบียนที่มีพิกัดในชุดข้อมูลแผนที่ปัจจุบัน</Text>
              </Box>
              <HStack spacing={1} bg="slate.100" p={1} borderRadius="xl" flexWrap="wrap">
                {(["all", "101", "105", "106"] as TypeFilter[]).map((filter) => (
                  <Button key={filter} size="sm" variant="ghost" borderRadius="lg"
                    bg={activeType === filter ? "white" : "transparent"}
                    color={activeType === filter ? "slate.900" : "slate.500"}
                    boxShadow={activeType === filter ? "sm" : "none"}
                    onClick={() => setActiveType(filter)}>
                    {filter === "all" ? "รวม" : filter}
                  </Button>
                ))}
              </HStack>
            </Flex>

            <VStack align="stretch" spacing={4} mt={7}>
              {visibleProvinces.map((row, index) => {
                const count = totalFor(row, activeType);
                return (
                  <Grid key={row.province} templateColumns={{ base: "28px 90px 1fr 38px", md: "32px 130px 1fr 48px" }} gap={3} alignItems="center">
                    <Text fontFamily="'Inter', sans-serif" fontSize="xs" color="slate.400">{String(index + 1).padStart(2, "0")}</Text>
                    <Box minW={0}>
                      <Text fontWeight="700" fontSize="sm" noOfLines={1}>{row.province}</Text>
                      {row.tier === "additional" && <Text fontSize="9px" color="slate.400">ประเมินเพิ่ม</Text>}
                    </Box>
                    <Box h="9px" bg="slate.100" borderRadius="full" overflow="hidden">
                      <Box h="full" w={`${Math.max((count / maxProvinceCount) * 100, count > 0 ? 2 : 0)}%`} borderRadius="full"
                        bg={activeType === "all" ? "#D23F15" : TYPE_META[activeType].color} transition="width .25s ease" />
                    </Box>
                    <Text fontFamily="'Inter', sans-serif" fontWeight="800" fontSize="sm" textAlign="right">{count}</Text>
                  </Grid>
                );
              })}
            </VStack>

            <Button mt={7} variant="outline" size="sm" onClick={() => setShowAdditional((value) => !value)}>
              {showAdditional ? "ซ่อน 5 พื้นที่ประเมินเพิ่ม" : "ดูอีก 5 พื้นที่ประเมินเพิ่ม"}
            </Button>
          </GridItem>

          <GridItem>
            <VStack align="stretch" spacing={5} h="full">
              <Box bg="primary.500" color="white" p={6} borderRadius="xl" position="relative" overflow="hidden">
                <Icon viewBox="0 0 24 24" boxSize={8} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3 2.8 19h18.4L12 3Z" strokeLinejoin="round"/><path d="M12 9v4.5M12 17h.01" strokeLinecap="round"/>
                </Icon>
                <Text mt={8} fontSize="xl" fontWeight="800">พื้นที่เสี่ยง ไม่เท่ากับ โรงงานผิดกฎหมาย</Text>
                <Text mt={3} fontSize="sm" lineHeight="1.8" color="whiteAlpha.900">
                  หน้านี้ใช้เพื่อจัดลำดับการเฝ้าระวังจากประเภทกิจการและความหนาแน่น ไม่ใช่คำวินิจฉัยการกระทำผิดของโรงงานรายแห่ง
                </Text>
              </Box>

              <Box bg="slate.800" color="white" p={6} borderRadius="xl" flex="1">
                <Text fontSize="xs" fontWeight="800" letterSpacing="1px" color="whiteAlpha.600">ไปต่อจากข้อมูลนี้</Text>
                <Text mt={3} fontSize="xl" fontWeight="800">เปิดตำแหน่งจริงบนแผนที่</Text>
                <Text mt={2} fontSize="sm" lineHeight="1.7" color="whiteAlpha.700">ระบบจะกรองประเภท 101, 105, 106 ให้โดยอัตโนมัติ (กรุณาเลือกจังหวัดบนแผนที่เพื่อแสดงตำแหน่งโรงงาน เพื่อป้องกันการโหลดข้อมูลที่หนาแน่นเกินไป)</Text>
                <Button as={RouterLink} to="/?type=101,105,106" mt={7} bg="white" color="slate.800" _hover={{ bg: "slate.100", transform: "translateY(-1px)" }}>
                  ดูโรงงานบนแผนที่
                </Button>
              </Box>
            </VStack>
          </GridItem>
        </Grid>

        <Box mt={{ base: 10, md: 14 }} borderTop="1px solid" borderColor="slate.300" pt={7}>
          <SimpleGrid columns={{ base: 1, md: 3 }} spacing={6}>
            <Box>
              <Text fontSize="xs" fontWeight="800" color="slate.500" letterSpacing="1px">ขอบเขตข้อมูล</Text>
              <Text mt={2} fontSize="sm" color="slate.600" lineHeight="1.75">ตัวเลข 2,940 แห่ง และปริมาณกากเป็นฐานนโยบายจาก DIW ส่วนจำนวนรายประเภทและรายจังหวัดมาจากชุดข้อมูลของเว็บไซต์นี้</Text>
            </Box>
            <Box>
              <Text fontSize="xs" fontWeight="800" color="slate.500" letterSpacing="1px">ข้อจำกัด</Text>
              <Text mt={2} fontSize="sm" color="slate.600" lineHeight="1.75">ยอดบนแผนที่นับได้เฉพาะโรงงานที่มีพิกัด จึงต่ำกว่ายอดทะเบียน และไม่ควรใช้แทนข้อมูลการตรวจสอบหรือใบอนุญาตล่าสุด</Text>
            </Box>
            <Box>
              <Text fontSize="xs" fontWeight="800" color="slate.500" letterSpacing="1px">แหล่งอ้างอิง</Text>
              <Link href={OFFICIAL_SOURCE} isExternal mt={2} display="inline-flex" alignItems="center" gap={2} fontSize="sm" fontWeight="700" color="primary.700">
                กรมโรงงานอุตสาหกรรม · 18 พ.ย. 2568
                <Text as="span" aria-hidden="true">↗</Text>
              </Link>
            </Box>
          </SimpleGrid>
        </Box>
      </Box>
    </Box>
  );
};

export default WasteMonitorPage;
