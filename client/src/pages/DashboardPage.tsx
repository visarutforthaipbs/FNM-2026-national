import { useState, useEffect, useMemo } from 'react';
import {
  Box,
  Flex,
  Text,
  VStack,
  HStack,
  SimpleGrid,
  Spinner,
  Icon,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  TableContainer,
  Progress,
  Badge,
  Select,
  Input,
  InputGroup,
  InputLeftElement,
  Button,
  useDisclosure,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton
} from '@chakra-ui/react';
import type { IconProps } from '@chakra-ui/react';
import Navbar from '../components/Navbar';
import { factoryTypeName } from '../utils/factoryTypes';
import { parseFactoryTypeCode } from '../utils/hazard';

interface DashboardStats {
  total: number;
  highRiskCount: number;
  totalCapital: number;
  totalWorkers: number;
  countByType: Record<string, number>;
  countByProvince?: Record<string, number>;
  countByIndustry?: Record<string, number>;
  /** Where each pin came from — keys are factories.coord_source, plus "none"
   *  for rows with no position at all. Written by export_dashboard.py. */
  countByCoordSource?: Record<string, number>;
  sortedProvinces: Array<[string, number]>;
  topProvinces: Array<[string, number]>;
  totalProvinces: number;
}

interface MetricCardProps {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ComponentType<IconProps>;
  color: string;
}

interface TypeStatCardProps {
  type?: string;
  name: string;
  count: number;
  total: number;
  color: string;
  bg: string;
}

interface FactoryExplorerItem {
  id: string;
  name: string;
  factory_type: string;
  district: string;
  province: string;
  capital_investment: number;
  horsepower: number;
  total_workers: number;
  address_full: string;
  status: string;
  businesses?: {
    legal_name?: string;
    objective?: string;
  };
}

interface ZoningSummary {
  factories_tested: number;
  /** Inside any plan polygon that carries a land-use code — both zoned tiers. */
  inside_a_dpt_zone: number;
  /** The ผังเมืองรวมเมือง/ชุมชน share of the above. Optional: pre-2026-09 summaries lack it. */
  zoned_by_municipal_plan?: number;
  /** The ผังเมืองรวมจังหวัด share of the above. */
  zoned_by_province_plan?: number;
  /**
   * Inside a ผังเมืองรวมจังหวัด footprint only. Those footprints carry no
   * land-use attribute, so these factories are covered by a plan whose zoning
   * we do not hold — a different answer from both of the other two, and the
   * reason the grid below has four mutually exclusive cards that sum to the
   * total. Optional because a summary written before the provincial tier
   * existed does not have it.
   */
  inside_province_plan_only?: number;
  no_dpt_plan_data: number;
  by_family: Record<string, number>;
  provinces_without_dpt_coverage: string[];
}

const DashboardPage = () => {
  // Counted zoning figures. Loaded separately so a missing file simply hides
  // the panel rather than showing numbers we cannot stand behind.
  const [zoningSummary, setZoningSummary] = useState<ZoningSummary | null>(null);
  useEffect(() => {
    fetch("/data/zoning_summary.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setZoningSummary(d))
      .catch(() => setZoningSummary(null));
  }, []);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Province-level Explorer States
  const [selectedProvince, setSelectedProvince] = useState<string>("");
  const [provinceFactories, setProvinceFactories] = useState<FactoryExplorerItem[]>([]);
  const [isProvinceLoading, setIsProvinceLoading] = useState(false);
  const [provinceError, setProvinceError] = useState<string | null>(null);

  // Filters State
  const [explorerSearch, setExplorerSearch] = useState("");
  const [explorerDistrict, setExplorerDistrict] = useState("");
  const [explorerType, setExplorerType] = useState("");
  const [explorerIndustry, setExplorerIndustry] = useState("");

  // Sorting & Pagination States
  const [sortField, setSortField] = useState<keyof FactoryExplorerItem | "">("");
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // Row Details Modal State
  const { isOpen: isDetailsOpen, onOpen: onDetailsOpen, onClose: onDetailsClose } = useDisclosure();
  const [selectedExplorerFactory, setSelectedExplorerFactory] = useState<FactoryExplorerItem | null>(null);

  // 1. Load initial nationwide static stats
  useEffect(() => {
    fetch("/data/dashboard_stats.json")
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const sortedProvinces: Array<[string, number]> = (Object.entries(data.countByProvince || {}) as Array<[string, number]>)
            .sort((a, b) => b[1] - a[1]);

        setStats({
            ...data,
            total: data.total ?? 0,
            highRiskCount: data.highRiskCount ?? 0,
            totalCapital: data.totalCapital ?? 0,
            totalWorkers: data.totalWorkers ?? 0,
            countByType: data.countByType ?? {},
            sortedProvinces,
            topProvinces: sortedProvinces.slice(0, 15),
            totalProvinces: sortedProvinces.length
        });
        setIsLoading(false);
      })
      .catch(err => {
        console.error("Error loading dashboard stats:", err);
        setIsLoading(false);
      });
  }, []);

  // 2. Fetch all active factories in a province dynamically from Supabase
  useEffect(() => {
    if (!selectedProvince) {
      setProvinceFactories([]);
      return;
    }

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey || !/^[\x20-\x7E]+$/.test(supabaseKey)) {
      setProvinceError("ระบบฐานข้อมูลไม่พร้อมใช้งาน (Missing or invalid credentials)");
      return;
    }

    setIsProvinceLoading(true);
    setProvinceError(null);
    setExplorerSearch("");
    setExplorerDistrict("");
    setExplorerType("");
    setExplorerIndustry("");
    setCurrentPage(1);
    setSortField("");

    // PostgREST caps every request at 1,000 rows, so paginate with a keyset
    // (order by id, then id=gt.<last>) until a page comes back short —
    // otherwise every large province appears to have exactly 1,000 factories.
    // status=eq.ดำเนินการ keeps this consistent with the rest of the app
    // (the metric card says "โรงงานที่เปิดดำเนินการ").
    const baseUrl =
      `${supabaseUrl}/rest/v1/factories` +
      `?province=eq.${encodeURIComponent(selectedProvince)}` +
      `&is_active=eq.true&status=eq.${encodeURIComponent("ดำเนินการ")}` +
      `&select=id,name,factory_type,district,capital_investment,total_workers,horsepower,address_full,status,businesses(legal_name,objective)` +
      `&order=id.asc&limit=1000`;
    const headers = {
      "apikey": supabaseKey,
      "Authorization": `Bearer ${supabaseKey}`,
    };

    let cancelled = false;

    (async () => {
      try {
        const all: FactoryExplorerItem[] = [];
        let lastId: string | null = null;

        for (;;) {
          const url = lastId
            ? `${baseUrl}&id=gt.${encodeURIComponent(lastId)}`
            : baseUrl;
          const res = await fetch(url, { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const page: FactoryExplorerItem[] = await res.json();
          all.push(...page);
          if (page.length < 1000) break;
          lastId = page[page.length - 1].id;
        }

        if (!cancelled) {
          setProvinceFactories(all);
          setIsProvinceLoading(false);
        }
      } catch (err) {
        console.error("Error fetching province factories:", err);
        if (!cancelled) {
          setProvinceError("ไม่สามารถดึงข้อมูลได้ กรุณาลองใหม่อีกครั้ง");
          setIsProvinceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedProvince]);

  // Extract sorted provinces list from data
  const provincesList = useMemo(() => {
    if (!stats || !stats.countByProvince) return [];
    return Object.keys(stats.countByProvince).sort((a, b) => a.localeCompare(b, 'th'));
  }, [stats]);

  // Extract unique districts from province data
  const districts = useMemo(() => {
    const set = new Set<string>();
    provinceFactories.forEach(f => {
      if (f.district) set.add(f.district.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [provinceFactories]);

  // Industry types (DIW ลำดับที่) present in the province, with counts
  const industryOptions = useMemo(() => {
    const counts = new Map<number, number>();
    provinceFactories.forEach(f => {
      const code = parseFactoryTypeCode(f.id);
      if (code !== null) counts.set(code, (counts.get(code) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [provinceFactories]);

  // Apply search query, filters, and sorting client-side
  const filteredFactories = useMemo(() => {
    let result = provinceFactories;

    if (explorerSearch) {
      const term = explorerSearch.toLowerCase();
      result = result.filter(f => 
        (f.name && f.name.toLowerCase().includes(term)) ||
        (f.id && f.id.toLowerCase().includes(term)) ||
        (f.businesses?.legal_name && f.businesses.legal_name.toLowerCase().includes(term))
      );
    }

    if (explorerDistrict) {
      result = result.filter(f => f.district === explorerDistrict);
    }

    if (explorerType) {
      result = result.filter(f => f.factory_type === explorerType);
    }

    if (explorerIndustry) {
      const code = parseInt(explorerIndustry, 10);
      result = result.filter(f => parseFactoryTypeCode(f.id) === code);
    }

    if (sortField) {
      result = [...result].sort((a, b) => {
        const valA = a[sortField];
        const valB = b[sortField];

        if (sortField === 'name' || sortField === 'district') {
          const strA = (valA as string || "").toLowerCase();
          const strB = (valB as string || "").toLowerCase();
          return sortOrder === 'asc' 
            ? strA.localeCompare(strB, 'th')
            : strB.localeCompare(strA, 'th');
        }

        const numA = Number(valA) || 0;
        const numB = Number(valB) || 0;
        return sortOrder === 'asc' ? numA - numB : numB - numA;
      });
    }

    return result;
  }, [provinceFactories, explorerSearch, explorerDistrict, explorerType, explorerIndustry, sortField, sortOrder]);

  // Dynamically compute stats depending on active selections
  const displayStats = useMemo(() => {
    if (!selectedProvince) return stats;

    const total = filteredFactories.length;
    let highRiskCount = 0;
    let totalCapital = 0;
    let totalWorkers = 0;
    const countByType: Record<string, number> = { "1": 0, "2": 0, "3": 0, "-": 0 };

    filteredFactories.forEach(f => {
      const t = f.factory_type || "-";
      if (t === "3") highRiskCount++;
      countByType[t] = (countByType[t] || 0) + 1;
      totalCapital += Number(f.capital_investment) || 0;
      totalWorkers += Number(f.total_workers) || 0;
    });

    return {
      total,
      highRiskCount,
      totalCapital,
      totalWorkers,
      countByType
    };
  }, [selectedProvince, filteredFactories, stats]);

  // Handle pagination slicing
  const paginatedFactories = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return filteredFactories.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredFactories, currentPage]);

  const totalPages = Math.max(1, Math.ceil(filteredFactories.length / itemsPerPage));

  // Sorting handlers
  const handleSort = (field: keyof FactoryExplorerItem) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
    setCurrentPage(1);
  };

  const SortIndicator = ({ field }: { field: keyof FactoryExplorerItem }) => {
    if (sortField !== field) return null;
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        boxSize={3}
        ml={1}
        display="inline-block"
        verticalAlign="middle"
        aria-hidden="true"
      >
        {sortOrder === 'asc' ? (
          <polyline points="18 15 12 9 6 15" />
        ) : (
          <polyline points="6 9 12 15 18 9" />
        )}
      </Icon>
    );
  };

  if (isLoading) {
    return (
      <Box h="100vh" w="full" bg="slate.50">
        <Navbar />
        <Flex h="calc(100vh - 64px)" align="center" justify="center" direction="column" gap={4}>
          <Spinner size="xl" color="primary.500" thickness="4px" />
          <Text color="slate.600" fontWeight="medium">กำลังรวบรวมข้อมูลโรงงาน...</Text>
        </Flex>
      </Box>
    );
  }

  if (!stats || !displayStats) return null;

  return (
    <Box minH="100vh" w="full" bg="slate.50">
      <Navbar />
      
      <Box maxW="1200px" mx="auto" p={{ base: 4, md: 6 }}>
        {/* Header Section with Dropdown Selector */}
        <Flex justify="space-between" align={{ base: "start", md: "center" }} direction={{ base: "column", md: "row" }} gap={4} mb={8}>
          <Box>
            <Text fontSize={{ base: "xl", md: "3xl" }} fontWeight="800" color="primary.700" letterSpacing="tight" lineHeight="1.25">
              {selectedProvince ? `ข้อมูลอุตสาหกรรม จังหวัด${selectedProvince}` : "ภาพรวมโรงงานอุตสาหกรรมในประเทศไทย"}
            </Text>
            <Text color="slate.500" fontSize={{ base: "sm", md: "md" }} mt={1}>
              {selectedProvince ? `สำรวจข้อมูลโรงงานที่กรองแล้วในพื้นที่จังหวัด${selectedProvince}` : "ข้อมูลเชิงลึกและการกระจายตัวของโรงงานที่เปิดดำเนินการในปัจจุบัน"}
            </Text>
          </Box>
          <Box minW="240px" w={{ base: "full", md: "auto" }}>
            <Text fontSize="xs" fontWeight="700" color="slate.400" mb={1} textTransform="uppercase" letterSpacing="0.5px">
              ขอบเขตพื้นที่สำรวจ
            </Text>
            <Select
              placeholder="ภาพรวมทั้งประเทศ"
              value={selectedProvince}
              onChange={(e) => setSelectedProvince(e.target.value)}
              bg="white"
              borderColor="slate.200"
              borderRadius="xl"
              fontWeight="600"
              color={selectedProvince ? "primary.500" : "slate.600"}
              _focus={{ borderColor: "primary.500", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
            >
              {provincesList.map((p) => (
                <option key={p} value={p}>
                  จังหวัด{p}
                </option>
              ))}
            </Select>
          </Box>
        </Flex>

        {/* Top Key Metrics */}
        <SimpleGrid columns={{ base: 2, lg: 4 }} spacing={{ base: 3, md: 6 }} mb={8}>
          <MetricCard 
            title="จำนวนโรงงานทั้งหมด" 
            value={displayStats.total.toLocaleString()} 
            subtitle="โรงงานที่เปิดดำเนินการ"
            icon={BuildingIcon}
            color="slate"
          />
          <MetricCard 
            title="โรงงานจำพวก 3" 
            value={displayStats.highRiskCount.toLocaleString()} 
            subtitle="กลุ่มที่ต้องขอใบอนุญาต ร.ง.4"
            icon={AlertIcon}
            color="red"
          />
          <MetricCard 
            title="เงินลงทุนรวม (ล้านบาท)" 
            value={(displayStats.totalCapital / 1000000).toLocaleString(undefined, { maximumFractionDigits: 0 })} 
            subtitle="เงินลงทุนในธุรกิจอุตสาหกรรม"
            icon={TrendingUpIcon}
            color="green"
          />
          <MetricCard 
            title="จำนวนผู้ปฏิบัติงาน" 
            value={displayStats.totalWorkers.toLocaleString()} 
            subtitle="คนงานทั้งหมด"
            icon={MapPinIcon}
            color="primary"
          />
        </SimpleGrid>

        {/* Where the pins come from. Placed immediately above the zoning grid
            because the zoning numbers are computed FROM these coordinates — a
            factory sitting on a tambon centroid can fall in the wrong polygon,
            so the reader needs the precision of the input before reading the
            output. Counted from coord_source, never estimated. */}
        {!selectedProvince && stats.countByCoordSource && (
          <CoordinateProvenanceCard counts={stats.countByCoordSource} />
        )}

        {/* Town-planning coverage, counted rather than assumed.
            This grid previously multiplied whatever total was on screen by
            fixed national ratios (8.3 / 18.9 / 64.7 / 8.1), so every province
            displayed invented counts — and three of the four categories were
            never produced by the spatial audit at all. These four numbers come
            from zoning_summary.json, written by the same point-in-polygon pass
            that fills the per-factory cards. */}
        {zoningSummary && (
          <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="2xl" boxShadow="sm" border="1px solid" borderColor="slate.200" mb={8}>
            <Flex align="center" justify="space-between" mb={1} wrap="wrap" gap={2}>
              <Flex align="center" gap={2}>
                <Box w="10px" h="10px" borderRadius="full" bg="purple.500" />
                <Text fontSize="lg" fontWeight="bold" color="slate.800">
                  ผังเมืองรวมกับที่ตั้งโรงงาน (DPT)
                </Text>
              </Flex>
              <Badge colorScheme="gray" p={2} borderRadius="lg" fontSize="xs">
                ตรวจสอบพิกัดกับแปลงผังเมือง 42,219 แปลง และแปลงผังจังหวัด 32,187 แปลง
              </Badge>
            </Flex>
            <Text fontSize="xs" color="slate.500" mb={4} lineHeight="1.7">
              ตัวเลขนี้บอกว่าโรงงานตั้งอยู่ในเขตผังเมืองประเภทใด ไม่ได้ชี้ว่าโรงงานใดถูกหรือผิดกฎหมาย —
              การพิจารณาต้องดูจำพวกโรงงาน ขนาดเครื่องจักร บัญชีแนบท้ายกฎกระทรวงของผังนั้น
              และวันที่ได้รับใบอนุญาตเทียบกับวันประกาศใช้ผัง
            </Text>

            <SimpleGrid columns={{ base: 1, sm: 2, md: 4 }} spacing={4}>
              <Box bg="slate.50" p={4} borderRadius="xl" border="1px solid" borderColor="slate.200">
                <Text fontSize="xs" color="slate.600" fontWeight="600">โรงงานที่ตรวจสอบ</Text>
                <Text fontSize="xl" fontWeight="bold" color="slate.900">
                  {zoningSummary.factories_tested.toLocaleString()}
                </Text>
                <Text fontSize="2xs" color="slate.600" mt={1}>โรงงานที่มีพิกัดบนแผนที่</Text>
              </Box>

              <Box bg="purple.50" p={4} borderRadius="xl" border="1px solid" borderColor="purple.200">
                <Text fontSize="xs" color="purple.700" fontWeight="600">ทราบประเภทการใช้ที่ดิน</Text>
                <Text fontSize="xl" fontWeight="bold" color="purple.900">
                  {zoningSummary.inside_a_dpt_zone.toLocaleString()}
                </Text>
                <Text fontSize="2xs" color="slate.600" mt={1}>
                  ผังเมือง/ชุมชน {(zoningSummary.zoned_by_municipal_plan ?? 0).toLocaleString()} ·
                  ผังจังหวัด {(zoningSummary.zoned_by_province_plan ?? 0).toLocaleString()}
                </Text>
              </Box>

              {/* The category that used to be counted as "no data". A
                  ผังเมืองรวมจังหวัด footprint says a plan covers the point and
                  carries no land use at all, so it is neither zoned nor
                  unplanned — it is its own answer, and merging it into either
                  neighbour is what made this figure wrong before. */}
              <Box bg="blue.50" p={4} borderRadius="xl" border="1px solid" borderColor="blue.200">
                <Text fontSize="xs" color="blue.700" fontWeight="600">มีผังครอบคลุม ยังไม่ทราบประเภท</Text>
                <Text fontSize="xl" fontWeight="bold" color="blue.900">
                  {(zoningSummary.inside_province_plan_only ?? 0).toLocaleString()}
                </Text>
                <Text fontSize="2xs" color="slate.600" mt={1}>
                  อยู่ในขอบเขตผังจังหวัดที่ DPT เผยแพร่เฉพาะขอบเขต
                </Text>
              </Box>

              <Box bg="slate.50" p={4} borderRadius="xl" border="1px solid" borderColor="slate.200">
                <Text fontSize="xs" color="slate.600" fontWeight="600">ไม่มีข้อมูลผังเมือง</Text>
                <Text fontSize="xl" fontWeight="bold" color="slate.900">
                  {zoningSummary.no_dpt_plan_data.toLocaleString()}
                  <Text as="span" fontSize="sm" fontWeight="600" color="slate.500">
                    {" "}({Math.round((zoningSummary.no_dpt_plan_data / Math.max(zoningSummary.factories_tested, 1)) * 100)}%)
                  </Text>
                </Text>
                <Text fontSize="2xs" color="slate.600" mt={1}>
                  ไม่พบทั้งผังระดับเมือง/ชุมชน และระดับจังหวัด
                </Text>
              </Box>
            </SimpleGrid>

            {/* The land-use split is a breakdown OF the first card, not a
                fifth category — stated as a subset so the four numbers above
                keep summing to the total. */}
            <Text fontSize="2xs" color="slate.600" mt={3} lineHeight="1.7">
              ในกลุ่มที่ทราบประเภทการใช้ที่ดิน {zoningSummary.inside_a_dpt_zone.toLocaleString()} แห่ง —
              ผังเมืองสีม่วง (อุตสาหกรรมและคลังสินค้า) {(zoningSummary.by_family.industrial ?? 0).toLocaleString()} แห่ง ·
              เขตที่อยู่อาศัย {(zoningSummary.by_family.residential ?? 0).toLocaleString()} แห่ง ·
              ชนบทและเกษตรกรรม {(zoningSummary.by_family.rural_agricultural ?? 0).toLocaleString()} แห่ง
            </Text>

            <Text fontSize="2xs" color="slate.500" mt={3} lineHeight="1.7">
              ที่มา: แปลงผังเมืองรวมเมือง/ชุมชน (PLLU_ALL) และแปลงผังเมืองรวมจังหวัด (PLLU_PROV)
              กรมโยธาธิการและผังเมือง · จุดที่อยู่ในทั้งสองผัง นับตามผังเมือง/ชุมชนซึ่งเฉพาะเจาะจงกว่า
              จึงไม่นำมาบวกกัน · กรุงเทพมหานครใช้ผังเมืองรวมกรุงเทพมหานครซึ่งออกโดย กทม.
            </Text>
          </Box>
        )}

        {/* Callout to select province when view is national overview */}
        {!selectedProvince && (
          <Box 
            bg="primary.50" 
            border="1px dashed" 
            borderColor="primary.200" 
            p={6} 
            borderRadius="2xl" 
            textAlign="center" 
            mb={8}
            boxShadow="sm"
          >
            <Text fontSize="lg" fontWeight="semibold" color="primary.700" mb={1}>
              ต้องการสำรวจข้อมูลเชิงลึกเป็นรายโรงงาน?
            </Text>
            <Text fontSize="sm" color="slate.500" mb={4}>
              เลือกจังหวัดที่ท่านสนใจในมุมขวาบน เพื่อสืบค้นข้อมูลรายอำเภอ ค้นหาชื่อโรงงาน เรียงข้อมูลตามเงินลงทุน หรือพนักงานได้ทันที
            </Text>
          </Box>
        )}

        <SimpleGrid columns={{ base: 1, lg: 3 }} spacing={{ base: 5, lg: 8 }}>
          {/* Main Content Area */}
          {selectedProvince ? (
            /* Left side: Interactive Data Grid */
            <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200" gridColumn={{ lg: "span 2" }}>
              <Box mb={6}>
                <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color="slate.800">
                  เครื่องมือสืบค้นและสำรวจข้อมูลโรงงาน
                </Text>
                <Text fontSize="xs" color="slate.400" mt={1}>
                  พบ {filteredFactories.length.toLocaleString()} โรงงานที่ตรงตามเงื่อนไข (คลิกเพื่อดูรายละเอียดเชิงลึก)
                </Text>
              </Box>

              {/* Grid Filter controls */}
              <SimpleGrid columns={{ base: 1, md: 2, xl: 4 }} spacing={4} mb={6}>
                <Box>
                  <Text fontSize="xs" fontWeight="600" color="slate.500" mb={1.5}>สืบค้นข้อความ</Text>
                  <InputGroup size={{ base: "md", md: "sm" }}>
                    <InputLeftElement pointerEvents="none" color="slate.300">
                      <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </Icon>
                    </InputLeftElement>
                    <Input 
                      placeholder="ชื่อโรงงาน / เลขทะเบียน / ผู้ประกอบการ..." 
                      value={explorerSearch} 
                      onChange={e => { setExplorerSearch(e.target.value); setCurrentPage(1); }}
                      borderRadius="lg"
                      bg="slate.50"
                      border="none"
                      _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
                    />
                  </InputGroup>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="600" color="slate.500" mb={1.5}>เขตอำเภอ</Text>
                  <Select 
                    placeholder="ทุกอำเภอ" 
                    size={{ base: "md", md: "sm" }}
                    value={explorerDistrict} 
                    onChange={e => { setExplorerDistrict(e.target.value); setCurrentPage(1); }}
                    borderRadius="lg"
                    bg="slate.50"
                    border="none"
                    _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
                  >
                    {districts.map(d => (
                      <option key={d} value={d}>อ.{d}</option>
                    ))}
                  </Select>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="600" color="slate.500" mb={1.5}>ระดับความเสี่ยง</Text>
                  <Select 
                    placeholder="ทุกจำพวก" 
                    size={{ base: "md", md: "sm" }}
                    value={explorerType} 
                    onChange={e => { setExplorerType(e.target.value); setCurrentPage(1); }}
                    borderRadius="lg"
                    bg="slate.50"
                    border="none"
                    _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
                  >
                    <option value="1">จำพวก 1 (ความเสี่ยงต่ำ)</option>
                    <option value="2">จำพวก 2 (ความเสี่ยงปานกลาง)</option>
                    <option value="3">จำพวก 3 (ความเสี่ยงสูง)</option>
                  </Select>
                </Box>

                <Box>
                  <Text fontSize="xs" fontWeight="600" color="slate.500" mb={1.5}>ประเภทอุตสาหกรรม (ลำดับที่)</Text>
                  <Select
                    placeholder="ทุกประเภท"
                    size={{ base: "md", md: "sm" }}
                    value={explorerIndustry}
                    onChange={e => { setExplorerIndustry(e.target.value); setCurrentPage(1); }}
                    borderRadius="lg"
                    bg="slate.50"
                    border="none"
                    _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
                  >
                    {industryOptions.map(([code, count]) => (
                      <option key={code} value={code}>
                        {code} · {factoryTypeName(code)} ({count.toLocaleString()})
                      </option>
                    ))}
                  </Select>
                </Box>
              </SimpleGrid>

              {/* Data Table */}
              {isProvinceLoading ? (
                <Flex direction="column" align="center" justify="center" py={16} gap={3}>
                  <Spinner size="md" color="primary.500" />
                  <Text fontSize="sm" color="slate.400">กำลังสืบค้นข้อมูลจังหวัด{selectedProvince}...</Text>
                </Flex>
              ) : provinceError ? (
                <Flex direction="column" align="center" justify="center" py={16} color="red.500">
                  <Text fontWeight="semibold">{provinceError}</Text>
                </Flex>
              ) : filteredFactories.length === 0 ? (
                <Flex direction="column" align="center" justify="center" py={16} color="slate.400" textAlign="center">
                  <Text fontWeight="semibold">ไม่พบข้อมูลโรงงานตามเงื่อนไขดังกล่าว</Text>
                  <Text fontSize="xs" mt={1}>ลองปรับเงื่อนไขการค้นหาหรือเลือกเขตอำเภออื่น</Text>
                </Flex>
              ) : (
                <>
                  <TableContainer border="1px solid" borderColor="slate.100" borderRadius="lg" overflowY="auto" overflowX="auto" maxH="600px">
                    <Table variant="simple" size="sm">
                      <Thead bg="slate.50" position="sticky" top={0} zIndex={1}>
                        <Tr>
                          <Th cursor="pointer" onClick={() => handleSort('name')} w="38%">
                            ชื่อโรงงาน <SortIndicator field="name" />
                          </Th>
                          <Th cursor="pointer" onClick={() => handleSort('district')} w="15%" display={{ base: "none", md: "table-cell" }}>
                            อำเภอ <SortIndicator field="district" />
                          </Th>
                          <Th cursor="pointer" onClick={() => handleSort('factory_type')} w="12%">
                            จำพวก <SortIndicator field="factory_type" />
                          </Th>
                          <Th cursor="pointer" onClick={() => handleSort('capital_investment')} isNumeric w="20%" display={{ base: "none", sm: "table-cell" }}>
                            เงินลงทุน (บาท) <SortIndicator field="capital_investment" />
                          </Th>
                          <Th cursor="pointer" onClick={() => handleSort('total_workers')} isNumeric w="15%">
                            คนงาน <SortIndicator field="total_workers" />
                          </Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {paginatedFactories.map((factory) => (
                          <Tr 
                            key={factory.id} 
                            _hover={{ bg: "slate.50", cursor: "pointer" }}
                            onClick={() => {
                              setSelectedExplorerFactory(factory);
                              onDetailsOpen();
                            }}
                          >
                            <Td overflow="hidden" maxW="200px">
                              <Text fontWeight="semibold" color="slate.800" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                {factory.name || "—"}
                              </Text>
                              {(() => {
                                const code = parseFactoryTypeCode(factory.id);
                                const industry = code !== null ? `${code} · ${factoryTypeName(code)}` : "";
                                return (
                                  <Text fontSize="2xs" color="slate.400" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                    {industry}
                                    <Text as="span" display={{ base: "inline", md: "none" }}>
                                      {industry && factory.district ? " · " : ""}{factory.district ? `อ.${factory.district}` : ""}
                                    </Text>
                                  </Text>
                                );
                              })()}
                            </Td>
                            <Td color="slate.600" display={{ base: "none", md: "table-cell" }}>{factory.district || "—"}</Td>
                            <Td>
                              <Badge 
                                bg={factory.factory_type === "3" ? "red.50" : "green.50"} 
                                color={factory.factory_type === "3" ? "red.700" : "green.700"}
                                px={2}
                                py={0.5}
                                fontSize="2xs"
                                fontWeight="bold"
                              >
                                จำพวก {factory.factory_type || "—"}
                              </Badge>
                            </Td>
                            <Td isNumeric fontWeight="semibold" color="slate.700" display={{ base: "none", sm: "table-cell" }}>
                              {factory.capital_investment ? factory.capital_investment.toLocaleString() : "0"}
                            </Td>
                            <Td isNumeric fontWeight="semibold" color="slate.700">
                              {factory.total_workers ? factory.total_workers.toLocaleString() : "0"}
                            </Td>
                          </Tr>
                        ))}
                      </Tbody>
                    </Table>
                  </TableContainer>

                  {/* Pagination control block */}
                  <Flex justify="space-between" align="center" mt={4} wrap="wrap" gap={3}>
                    <Text fontSize="xs" color="slate.400">
                      แสดง {(currentPage - 1) * itemsPerPage + 1} – {Math.min(currentPage * itemsPerPage, filteredFactories.length)} จาก {filteredFactories.length.toLocaleString()} โรงงาน
                    </Text>
                    <HStack spacing={1}>
                      <Button 
                        size="xs" 
                        onClick={() => { setCurrentPage(prev => Math.max(1, prev - 1)); }}
                        isDisabled={currentPage === 1}
                        variant="outline"
                      >
                        ก่อนหน้า
                      </Button>
                      {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                        let pageNum = i + 1;
                        if (currentPage > 3 && totalPages > 5) {
                          pageNum = currentPage - 3 + i;
                          if (pageNum + (5 - i - 1) > totalPages) {
                            pageNum = totalPages - 4 + i;
                          }
                        }
                        return (
                          <Button
                            key={pageNum}
                            size="xs"
                            onClick={() => setCurrentPage(pageNum)}
                            variant={currentPage === pageNum ? "solid" : "outline"}
                            bg={currentPage === pageNum ? "primary.500" : "white"}
                            color={currentPage === pageNum ? "white" : "slate.600"}
                            _hover={{ bg: currentPage === pageNum ? "primary.600" : "slate.50" }}
                          >
                            {pageNum}
                          </Button>
                        );
                      })}
                      <Button 
                        size="xs" 
                        onClick={() => { setCurrentPage(prev => Math.min(totalPages, prev + 1)); }}
                        isDisabled={currentPage === totalPages}
                        variant="outline"
                      >
                        ถัดไป
                      </Button>
                    </HStack>
                  </Flex>
                </>
              )}
            </Box>
          ) : (
            /* Left side (National view): original Top 15 Provinces progress list */
            <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200" gridColumn={{ lg: "span 2" }}>
              <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color="slate.800" mb={6}>
                15 จังหวัดที่มีปริมาณโรงงานสูงสุด
              </Text>
              
              <VStack spacing={4} align="stretch">
                {stats.topProvinces.map(([province, count]: [string, number], idx: number) => {
                  const max = stats.topProvinces[0]?.[1] || 1;
                  const percentage = (count / max) * 100;
                  return (
                    <Box key={province}>
                      <Flex justify="space-between" mb={1}>
                        <Text fontSize="sm" fontWeight="semibold" color="slate.700">
                          {idx + 1}. {province}
                        </Text>
                        <Text fontSize="sm" fontWeight="bold" color="primary.600">
                          {count.toLocaleString()}
                        </Text>
                      </Flex>
                      <Progress 
                        value={percentage} 
                        colorScheme="primary" 
                        size="sm" 
                        borderRadius="full" 
                        bg="slate.100"
                      />
                    </Box>
                  )
                })}
              </VStack>
            </Box>
          )}

          {/* Right Column (Factory types + Regional summary) */}
          <VStack spacing={8} align="stretch">
            
            {/* Factory Risk Types proportion (dynamically adapts) */}
            <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200">
              <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color="slate.800" mb={6}>
                สัดส่วนตามจำพวกโรงงาน
              </Text>
              
              <VStack spacing={5} align="stretch">
                <TypeStatCard 
                  type="3" 
                  name="จำพวก 3 (ต้องขอใบอนุญาต ร.ง.4)" 
                  count={displayStats.countByType["3"] || 0} 
                  total={displayStats.total}
                  color="red.500" 
                  bg="red.50"
                />
                <TypeStatCard 
                  type="2" 
                  name="จำพวก 2 (ต้องแจ้งก่อนประกอบกิจการ)" 
                  count={displayStats.countByType["2"] || 0} 
                  total={displayStats.total}
                  color="orange.500" 
                  bg="orange.50"
                />
                <TypeStatCard 
                  type="1" 
                  name="จำพวก 1 (ประกอบกิจการได้ทันที)" 
                  count={displayStats.countByType["1"] || 0} 
                  total={displayStats.total}
                  color="green.500" 
                  bg="green.50"
                />
                <TypeStatCard 
                  type="-" 
                  name="ไม่ระบุ/อื่นๆ" 
                  count={(displayStats.countByType[""] || 0) + (displayStats.countByType["-"] || 0)} 
                  total={displayStats.total}
                  color="slate.500" 
                  bg="slate.50"
                />
              </VStack>
            </Box>

            {/* Regional Table Summary (only relevant on national overview) */}
            {!selectedProvince && (
              <Box bg="white" p={0} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200" overflow="hidden">
                 <Box p={5} borderBottom="1px solid" borderColor="slate.100" bg="slate.50">
                   <Text fontSize="md" fontWeight="bold" color="slate.800">
                     ภูมิภาคที่น่าสนใจ
                   </Text>
                 </Box>
                 <TableContainer>
                   <Table variant="simple" size="sm">
                     <Thead>
                       <Tr>
                         <Th>ภาค/เขตพื้นที่</Th>
                         <Th isNumeric>จำนวนโรงงาน</Th>
                       </Tr>
                     </Thead>
                     <Tbody>
                        <Tr>
                          <Td fontWeight="medium">กรุงเทพฯ และปริมณฑล</Td>
                          <Td isNumeric fontWeight="bold" color="primary.600">
                             {stats.sortedProvinces.filter((p: [string, number]) => ["กรุงเทพมหานคร", "สมุทรปราการ", "นนทบุรี", "ปทุมธานี", "สมุทรสาคร", "นครปฐม"].includes(p[0]))
                                  .reduce((acc: number, curr: [string, number]) => acc + curr[1], 0).toLocaleString()}
                          </Td>
                        </Tr>
                        <Tr>
                          <Td fontWeight="medium">ภาคตะวันออก (EEC)</Td>
                          <Td isNumeric fontWeight="bold" color="primary.600">
                             {stats.sortedProvinces.filter((p: [string, number]) => ["ชลบุรี", "ระยอง", "ฉะเชิงเทรา"].includes(p[0]))
                                  .reduce((acc: number, curr: [string, number]) => acc + curr[1], 0).toLocaleString()}
                          </Td>
                        </Tr>
                        <Tr>
                          <Td fontWeight="medium">ภาคตะวันออกเฉียงเหนือ</Td>
                          <Td isNumeric fontWeight="bold" color="primary.600">
                            {stats.sortedProvinces.filter((p: [string, number]) => ["นครราชสีมา", "ขอนแก่น", "อุบลราชธานี", "อุดรธานี"].includes(p[0]))
                                  .reduce((acc: number, curr: [string, number]) => acc + curr[1], 0).toLocaleString()}+ 
                          </Td>
                        </Tr>
                     </Tbody>
                   </Table>
                 </TableContainer>
              </Box>
            )}
          </VStack>
        </SimpleGrid>

        {/* National view: industry-type ranking (DIW ลำดับที่ 1-107) */}
        {!selectedProvince && stats.countByIndustry && (
          <IndustryRanking countByIndustry={stats.countByIndustry} total={stats.total} />
        )}
      </Box>

      {/* Row Details Modal — Progressive Disclosure (Signal 39 Layer 3) */}
      {selectedExplorerFactory && (
        <Modal isOpen={isDetailsOpen} onClose={onDetailsClose} isCentered size="md" motionPreset="slideInBottom" scrollBehavior="inside">
          <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.300" />
          <ModalContent borderRadius="2xl" boxShadow="xl" p={2}>
            <ModalHeader color="slate.800" pb={1}>
              <Flex align="center" gap={2.5}>
                <Box w="8px" h="8px" borderRadius="full" bg={selectedExplorerFactory.factory_type === "3" ? "red.500" : "green.500"} />
                <Text fontSize="lg" fontWeight="bold">รายละเอียดข้อมูลโรงงาน</Text>
              </Flex>
            </ModalHeader>
            <ModalCloseButton color="slate.400" _hover={{ color: "slate.600" }} top={5} right={5} />
            <ModalBody pb={6}>
              <VStack spacing={4} align="stretch">
                <Box>
                  <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>ชื่อโรงงาน</Text>
                  <Text fontSize="md" fontWeight="bold" color="slate.800" lineHeight="1.3">
                    {selectedExplorerFactory.name || "—"}
                  </Text>
                </Box>

                <SimpleGrid columns={2} spacing={4}>
                  <Box>
                    <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>เลขทะเบียน</Text>
                    <Text fontSize="sm" color="slate.700" fontFamily="monospace" fontWeight="medium">
                      {selectedExplorerFactory.id || "—"}
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>ระดับความเสี่ยง</Text>
                    <Badge 
                      bg={selectedExplorerFactory.factory_type === "3" ? "red.50" : "green.50"} 
                      color={selectedExplorerFactory.factory_type === "3" ? "red.700" : "green.700"}
                      fontSize="xs"
                      fontWeight="bold"
                    >
                      จำพวก {selectedExplorerFactory.factory_type || "—"}
                    </Badge>
                  </Box>
                </SimpleGrid>

                {(() => {
                  const code = parseFactoryTypeCode(selectedExplorerFactory.id);
                  return code !== null ? (
                    <Box>
                      <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>ประเภทอุตสาหกรรม</Text>
                      <Text fontSize="sm" color="slate.700" fontWeight="semibold">
                        ลำดับที่ {code} · {factoryTypeName(code)}
                      </Text>
                    </Box>
                  ) : null;
                })()}

                <Box>
                  <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>ผู้ประกอบการ</Text>
                  <Text fontSize="sm" color="slate.700" fontWeight="semibold">
                    {selectedExplorerFactory.businesses?.legal_name || "—"}
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>วัตถุประสงค์การประกอบกิจการ</Text>
                  <Text fontSize="sm" color="slate.600" lineHeight="1.4">
                    {selectedExplorerFactory.businesses?.objective || "—"}
                  </Text>
                </Box>

                <Box>
                  <Text fontSize="2xs" color="slate.400" fontWeight="600" mb={0.5}>ที่ตั้งโรงงาน</Text>
                  <Text fontSize="sm" color="slate.700" lineHeight="1.4">
                    {selectedExplorerFactory.address_full || "—"}
                  </Text>
                </Box>

                <SimpleGrid columns={3} spacing={3} pt={4} borderTop="1px solid" borderColor="slate.100">
                  <Box>
                    <Text fontSize="2xs" color="slate.400" fontWeight="500">เงินลงทุน</Text>
                    <Text fontSize="sm" fontWeight="bold" color="green.600">
                      {selectedExplorerFactory.capital_investment ? `${selectedExplorerFactory.capital_investment.toLocaleString()} บาท` : "—"}
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="2xs" color="slate.400" fontWeight="500">กำลังเครื่องจักร</Text>
                    <Text fontSize="sm" fontWeight="bold" color="orange.600">
                      {selectedExplorerFactory.horsepower ? `${selectedExplorerFactory.horsepower.toLocaleString()} HP` : "—"}
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="2xs" color="slate.400" fontWeight="500">จำนวนพนักงาน</Text>
                    <Text fontSize="sm" fontWeight="bold" color="blue.600">
                      {selectedExplorerFactory.total_workers ? `${selectedExplorerFactory.total_workers.toLocaleString()} คน` : "—"}
                    </Text>
                  </Box>
                </SimpleGrid>
              </VStack>
            </ModalBody>
          </ModalContent>
        </Modal>
      )}
    </Box>
  );
};

// MetricCard component — Chunked semantic units
const MetricCard = ({ title, value, subtitle, icon: IconCmp, color }: MetricCardProps) => (
  <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200">
    <Flex align="center" gap={3} mb={3}>
      <Box
        p={{ base: 2, md: 3 }}
        bg={`${color}.50`}
        borderRadius="lg"
      >
        <IconCmp boxSize={{ base: 5, md: 6 }} color={`${color}.600`} />
      </Box>
    </Flex>

    <Text fontSize={{ base: "xl", md: "3xl" }} fontWeight="bold" color="slate.800">
      {value}
    </Text>
    
    <Text fontSize={{ base: "xs", md: "sm" }} fontWeight="medium" color="slate.600" mt={1}>
      {title}
    </Text>
    <Text fontSize="xs" color="slate.400" display={{ base: "none", sm: "block" }}>
      {subtitle}
    </Text>
  </Box>
);

// TypeStatCard — Risk-coded factory type breakdown
const TypeStatCard = ({ name, count, total, color, bg }: TypeStatCardProps) => {
  const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
  return (
    <Box p={4} bg={bg} borderRadius="lg" border="1px solid" borderColor={`${color.split('.')[0]}.100`}>
      <Flex align="center" gap={3} mb={2}>
        <Box w="4px" h="32px" bg={color} borderRadius="full" flexShrink={0} />
        <Box flex="1">
          <Flex justify="space-between" align="start" mb={1}>
            <Text fontSize="sm" fontWeight="semibold" color="slate.700" flex="1">
              {name}
            </Text>
            <Badge bg="white" color={color} px={2} py={0.5} borderRadius="full" fontSize="xs" fontWeight="bold">
              {percentage}%
            </Badge>
          </Flex>
          
          <Text fontSize="2xl" fontWeight="bold" color="slate.800">
            {count.toLocaleString()}
          </Text>
        </Box>
      </Flex>
      
      <Progress value={parseFloat(percentage as string)} colorScheme={color.split(".")[0]} size="sm" borderRadius="full" bg="white" />
    </Box>
  )
}

// CoordinateProvenanceCard — how the map's pins were obtained.
//
// The map plots ~62,600 factories, and it would be easy to read every pin as a
// surveyed location. Only about 63% are. This states the split rather than
// letting the map imply a precision it does not have.
//
// SIGNAL 39: collapsed to three chunks (Rule of Three) — exact / approximate /
// unmapped — with a single stacked bar as the Layer 1 hook, so the shape is
// readable before a word is. The per-source detail sits underneath as Layer 3.
const CoordinateProvenanceCard = ({ counts }: { counts: Record<string, number> }) => {
  const get = (k: string) => counts[k] ?? 0;
  // 'sibling' is exact: a surveyed position inherited from another licence at
  // the same address. 'repaired'/'community'/'admin' are exact by definition too.
  const exact = get("gov") + get("repaired") + get("community") + get("admin") + get("sibling");
  const approximate = get("geocoded") + get("centroid");
  const unmapped = get("none");
  const total = exact + approximate + unmapped;
  if (total === 0) return null;
  const pct = (n: number) => (n / total) * 100;

  const groups = [
    {
      key: "exact",
      label: "พิกัดจากราชการ",
      note: "กรมโรงงานฯ ให้พิกัดมาโดยตรง หรือยืนยันแล้ว",
      count: exact,
      color: "#0B3558",
    },
    {
      key: "approximate",
      label: "ตำแหน่งโดยประมาณ",
      note: "แปลงจากที่อยู่หรือใช้จุดกึ่งกลางตำบล คลาดเคลื่อนได้ถึง 5 กม.",
      count: approximate,
      color: "#F59E0B",
    },
    {
      key: "unmapped",
      label: "ยังไม่มีพิกัด",
      note: "มีทะเบียนโรงงาน แต่ไม่ปรากฏบนแผนที่",
      count: unmapped,
      color: "#CBD5E1",
    },
  ];

  return (
    <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="2xl" boxShadow="sm" border="1px solid" borderColor="slate.200" mb={8}>
      <Flex align="center" justify="space-between" mb={1} wrap="wrap" gap={2}>
        <Flex align="center" gap={2}>
          <Box w="10px" h="10px" borderRadius="full" bg="#0B3558" />
          <Text fontSize="lg" fontWeight="bold" color="slate.800">
            ที่มาของพิกัดบนแผนที่
          </Text>
        </Flex>
        <Badge colorScheme="gray" p={2} borderRadius="lg" fontSize="xs">
          {(exact + approximate).toLocaleString()} โรงงานบนแผนที่
        </Badge>
      </Flex>
      <Text fontSize="xs" color="slate.500" mb={4} lineHeight="1.7">
        หมุดบนแผนที่ไม่ได้แม่นยำเท่ากันทุกจุด — ส่วนหนึ่งได้พิกัดจากกรมโรงงานฯ โดยตรง
        อีกส่วนหนึ่งประมาณจากที่อยู่หรือจุดกึ่งกลางตำบล ตัวเลขชุดนี้บอกสัดส่วนตามจริง
        เพื่อไม่ให้เข้าใจผิดว่าทุกหมุดคือตำแหน่งที่รังวัดแล้ว
      </Text>

      {/* Layer 1 — one bar, no reading required */}
      <Flex h="10px" borderRadius="full" overflow="hidden" mb={4} bg="slate.100">
        {groups.map((g) =>
          g.count > 0 ? (
            <Box key={g.key} w={`${pct(g.count)}%`} bg={g.color} />
          ) : null
        )}
      </Flex>

      <SimpleGrid columns={{ base: 1, sm: 3 }} spacing={4}>
        {groups.map((g) => (
          <Box key={g.key} bg="slate.50" p={4} borderRadius="xl" border="1px solid" borderColor="slate.200">
            <Flex align="center" gap={2} mb={1}>
              <Box w="8px" h="8px" borderRadius="full" bg={g.color} flexShrink={0} />
              <Text fontSize="xs" color="slate.600" fontWeight="600">
                {g.label}
              </Text>
            </Flex>
            <Flex align="baseline" gap={2}>
              <Text fontSize="xl" fontWeight="bold" color="slate.900">
                {g.count.toLocaleString()}
              </Text>
              <Text fontSize="xs" color="slate.500" fontWeight="600">
                {pct(g.count).toFixed(1)}%
              </Text>
            </Flex>
            <Text fontSize="2xs" color="slate.600" mt={1} lineHeight="1.6">
              {g.note}
            </Text>
          </Box>
        ))}
      </SimpleGrid>

      {get("sibling") > 0 && (
        <Text fontSize="2xs" color="slate.500" mt={3} lineHeight="1.7">
          ในจำนวนพิกัดจากราชการ มี {get("sibling").toLocaleString()} โรงงานที่ใช้พิกัดของอีกใบอนุญาต
          ซึ่งจดทะเบียนที่อยู่เดียวกัน — โรงงานหนึ่งแห่งมักถือหลายใบอนุญาต และมีเพียงใบเดียวที่มีพิกัดกำกับ
        </Text>
      )}
    </Box>
  );
};

// SIGNAL 39 Layer 3: IndustryRanking — deep-dive into DIW industry types
// (ลำดับที่ 1-107). Each row links to the map filtered to that industry.
const IndustryRanking = ({
  countByIndustry,
  total,
}: {
  countByIndustry: Record<string, number>;
  total: number;
}) => {
  const [showAll, setShowAll] = useState(false);

  const ranked = useMemo(
    () =>
      Object.entries(countByIndustry)
        .filter(([code]) => code !== "unknown")
        .map(([code, count]) => ({ code: parseInt(code, 10), count }))
        .sort((a, b) => b.count - a.count),
    [countByIndustry]
  );

  const rows = showAll ? ranked : ranked.slice(0, 15);
  const max = ranked[0]?.count || 1;

  return (
    <Box bg="white" p={{ base: 4, md: 6 }} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200" mt={8}>
      <Flex justify="space-between" align="flex-start" mb={1} wrap="wrap" gap={2}>
        <Box>
          <Text fontSize={{ base: "lg", md: "xl" }} fontWeight="bold" color="slate.800">
            ประเภทอุตสาหกรรม (ลำดับที่ 1–107)
          </Text>
          <Text fontSize="xs" color="slate.400" mt={1}>
            ตามบัญชีประเภทโรงงานของกรมโรงงานอุตสาหกรรม — คลิกเพื่อดูโรงงานประเภทนั้นบนแผนที่
          </Text>
        </Box>
        <Badge bg="slate.50" color="slate.500" borderRadius="full" px={3} py={1} fontSize="xs">
          {ranked.length} ประเภท
        </Badge>
      </Flex>

      <SimpleGrid columns={{ base: 1, md: 2 }} spacingX={{ md: 6, lg: 10 }} spacingY={3} mt={5}>
        {rows.map(({ code, count }, idx) => (
          <Flex
            key={code}
            as="a"
            href={`/?type=${code}`}
            align="center"
            gap={3}
            p={2}
            mx={-2}
            borderRadius="lg"
            _hover={{ bg: "slate.50", textDecoration: "none" }}
            title={`ดูโรงงาน${factoryTypeName(code)}บนแผนที่`}
          >
            <Text fontSize="xs" color="slate.300" fontWeight="600" w="24px" textAlign="right" flexShrink={0}>
              {idx + 1}
            </Text>
            <Badge
              bg="primary.50"
              color="primary.700"
              borderRadius="md"
              px={1.5}
              fontSize="2xs"
              fontWeight="700"
              flexShrink={0}
              minW="30px"
              textAlign="center"
            >
              {code}
            </Badge>
            <Box flex="1" minW={0}>
              <Flex justify="space-between" align="center" mb={0.5} gap={2}>
                <Text fontSize="sm" fontWeight="500" color="slate.700" noOfLines={1}>
                  {factoryTypeName(code)}
                </Text>
                <Text fontSize="xs" fontWeight="700" color="primary.600" flexShrink={0}>
                  {count.toLocaleString()}
                </Text>
              </Flex>
              <Progress
                value={(count / max) * 100}
                colorScheme="primary"
                size="xs"
                borderRadius="full"
                bg="slate.100"
              />
            </Box>
          </Flex>
        ))}
      </SimpleGrid>

      {ranked.length > 15 && (
        <Flex justify="center" mt={4}>
          <Button size="sm" variant="ghost" color="slate.500" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "แสดงเฉพาะ 15 อันดับแรก" : `แสดงทั้งหมด ${ranked.length} ประเภท (${(total - rows.reduce((s, r) => s + r.count, 0)).toLocaleString()} โรงงานที่เหลือ)`}
          </Button>
        </Flex>
      )}
    </Box>
  );
};

// Icons
const BuildingIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" />
    <path d="M16 6h.01" />
    <path d="M12 6h.01" />
    <path d="M12 10h.01" />
    <path d="M12 14h.01" />
    <path d="M16 10h.01" />
    <path d="M16 14h.01" />
    <path d="M8 10h.01" />
    <path d="M8 14h.01" />
  </Icon>
);

const AlertIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);

const MapPinIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </Icon>
);

const TrendingUpIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </Icon>
);

export default DashboardPage;
