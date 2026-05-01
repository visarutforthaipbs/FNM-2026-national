import { useState, useEffect } from 'react';
import {
  Box,
  Flex,
  Text,
  VStack,
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
  Badge
} from '@chakra-ui/react';
import Navbar from '../components/Navbar';

const DashboardPage = () => {
  const [stats, setStats] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/data/dashboard_stats.json")
      .then(res => res.json())
      .then((data) => {
        // Transform the key-value province into an array for sorting
        const sortedProvinces = Object.entries(data.countByProvince || {})
            .sort((a: any, b: any) => b[1] - a[1]);

        setStats({
            ...data,
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

  if (isLoading) {
    return (
      <Box h="100vh" w="100vw" bg="slate.50">
        <Navbar />
        <Flex h="calc(100vh - 64px)" align="center" justify="center" direction="column" gap={4}>
          <Spinner size="xl" color="primary.500" thickness="4px" />
          <Text color="slate.600" fontWeight="medium">กำลังรวบรวมข้อมูลโรงงาน...</Text>
        </Flex>
      </Box>
    );
  }

  if (!stats) return null;

  return (
    <Box minH="100vh" w="100vw" bg="slate.50">
      <Navbar />
      
      <Box maxW="1200px" mx="auto" p={6}>
        <Box mb={8}>
          <Text fontSize="3xl" fontWeight="800" color="primary.700" letterSpacing="tight">
            ภาพรวมโรงงานอุตสาหกรรมในประเทศไทย
          </Text>
          <Text color="slate.500" fontSize="lg">
            ข้อมูลเชิงลึกและการกระจายตัวของโรงงานที่เปิดดำเนินการในปัจจุบัน
          </Text>
        </Box>

        {/* Top Key Metrics */}
        <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} spacing={6} mb={8}>
          <MetricCard 
            title="จำนวนโรงงานทั้งหมด" 
            value={stats.total.toLocaleString()} 
            subtitle="โรงงานที่เปิดดำเนินการ"
            icon={BuildingIcon}
            color="primary"
          />
          <MetricCard 
            title="โรงงานจำพวก 3" 
            value={stats.highRiskCount.toLocaleString()} 
            subtitle="กลุ่มที่ต้องขอใบอนุญาต ร.ง.4"
            icon={AlertIcon}
            color="red"
          />
          <MetricCard 
            title="เงินลงทุนรวม (ล้านบาท)" 
            value={(stats.totalCapital / 1000000).toLocaleString(undefined, { maximumFractionDigits: 0 })} 
            subtitle="เงินลงทุนในธุรกิจอุตสาหกรรม"
            icon={TrendingUpIcon}
            color="green"
          />
          <MetricCard 
            title="จำนวนผู้ปฏิบัติงาน" 
            value={stats.totalWorkers.toLocaleString()} 
            subtitle="คนงานทั้งหมด"
            icon={MapPinIcon}
            color="orange"
          />
        </SimpleGrid>

        <SimpleGrid columns={{ base: 1, lg: 3 }} spacing={8}>
          
          {/* Top Provinces Chart */}
          <Box bg="white" p={6} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200" gridColumn={{ lg: "span 2" }}>
            <Text fontSize="xl" fontWeight="bold" color="slate.800" mb={6}>
              15 จังหวัดที่มีปริมาณโรงงานสูงสุด
            </Text>
            
            <VStack spacing={4} align="stretch">
              {stats.topProvinces.map(([province, count]: any, idx: number) => {
                const max = stats.topProvinces[0][1];
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

          {/* Right Column */}
          <VStack spacing={8} align="stretch">
            
            {/* Factory Types */}
            <Box bg="white" p={6} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200">
              <Text fontSize="xl" fontWeight="bold" color="slate.800" mb={6}>
                สัดส่วนตามจำพวกโรงงาน
              </Text>
              
              <VStack spacing={5} align="stretch">
                <TypeStatCard 
                  type="3" 
                  name="จำพวก 3 (ต้องขอใบอนุญาต ร.ง.4)" 
                  count={stats.countByType["3"] || 0} 
                  total={stats.total}
                  color="red.500" 
                  bg="red.50"
                />
                <TypeStatCard 
                  type="2" 
                  name="จำพวก 2 (ต้องแจ้งก่อนประกอบกิจการ)" 
                  count={stats.countByType["2"] || 0} 
                  total={stats.total}
                  color="orange.500" 
                  bg="orange.50"
                />
                <TypeStatCard 
                  type="1" 
                  name="จำพวก 1 (ประกอบกิจการได้ทันที)" 
                  count={stats.countByType["1"] || 0} 
                  total={stats.total}
                  color="green.500" 
                  bg="green.50"
                />
                <TypeStatCard 
                  type="-" 
                  name="ไม่ระบุ/อื่นๆ" 
                  count={(stats.countByType[""] || 0) + (stats.countByType["-"] || 0)} 
                  total={stats.total}
                  color="slate.500" 
                  bg="slate.50"
                />
              </VStack>
            </Box>

            {/* Total Table Summary */}
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
                       <Th isNumeric>จำนวนพบคราวๆ</Th>
                     </Tr>
                   </Thead>
                   <Tbody>
                      {/* Simple hardcoded approximations just to show data layout richness */}
                      <Tr>
                        <Td fontWeight="medium">กรุงเทพฯ และปริมณฑล</Td>
                        <Td isNumeric fontWeight="bold" color="primary.600">
                           {stats.sortedProvinces.filter((p: any) => ["กรุงเทพมหานคร", "สมุทรปราการ", "นนทบุรี", "ปทุมธานี", "สมุทรสาคร", "นครปฐม"].includes(p[0]))
                                .reduce((acc: any, curr: any) => acc + curr[1], 0).toLocaleString()}
                        </Td>
                      </Tr>
                      <Tr>
                        <Td fontWeight="medium">ภาคตะวันออก (EEC)</Td>
                        <Td isNumeric fontWeight="bold" color="primary.600">
                           {stats.sortedProvinces.filter((p: any) => ["ชลบุรี", "ระยอง", "ฉะเชิงเทรา"].includes(p[0]))
                                .reduce((acc: any, curr: any) => acc + curr[1], 0).toLocaleString()}
                        </Td>
                      </Tr>
                      <Tr>
                        <Td fontWeight="medium">ภาคตะวันออกเฉียงเหนือ</Td>
                        <Td isNumeric fontWeight="bold" color="primary.600">
                          {stats.sortedProvinces.filter((p: any) => ["นครราชสีมา", "ขอนแก่น", "อุบลราชธานี", "อุดรธานี"].includes(p[0]))
                                .reduce((acc: any, curr: any) => acc + curr[1], 0).toLocaleString()}+ 
                        </Td>
                      </Tr>
                   </Tbody>
                 </Table>
               </TableContainer>
            </Box>
          </VStack>
        </SimpleGrid>
      </Box>
    </Box>
  );
};

// SIGNAL 39 Layer 2: MetricCard component — Chunked semantic units
// Icon (Layer 1) → Big number (Layer 2) → Context (Layer 3)
const MetricCard = ({ title, value, subtitle, icon: IconCmp, color }: any) => (
  <Box bg="white" p={6} borderRadius="xl" boxShadow="sm" border="1px solid" borderColor="slate.200">
    {/* Layer 1: Semantic color icon (pre-attentive processing) */}
    <Flex align="center" gap={3} mb={3}>
      <Box
        p={3}
        bg={`${color}.50`}
        borderRadius="lg"
      >
        <IconCmp boxSize={6} color={`${color}.600`} />
      </Box>
    </Flex>
    
    {/* Layer 2: Big number — primary insight */}
    <Text fontSize="3xl" fontWeight="bold" color="slate.800">
      {value}
    </Text>
    
    {/* Layer 3: Context — supporting details */}
    <Text fontSize="sm" fontWeight="medium" color="slate.600" mt={1}>
      {title}
    </Text>
    <Text fontSize="xs" color="slate.400">
      {subtitle}
    </Text>
  </Box>
);

// SIGNAL 39 Layer 2: TypeStatCard — Risk-coded factory type breakdown
const TypeStatCard = ({ name, count, total, color, bg }: any) => {
  const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
  return (
    <Box p={4} bg={bg} borderRadius="lg" border="1px solid" borderColor={`${color.split('.')[0]}.100`}>
      {/* Layer 1: Color indicator bar */}
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
          
          {/* Layer 2: Big number */}
          <Text fontSize="2xl" fontWeight="bold" color="slate.800">
            {count.toLocaleString()}
          </Text>
        </Box>
      </Flex>
      
      {/* Layer 3: Progress bar for comparison */}
      <Progress value={parseFloat(percentage as string)} colorScheme={color.split(".")[0]} size="sm" borderRadius="full" bg="white" />
    </Box>
  )
}

// Icons
const BuildingIcon = (props: any) => (
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

const AlertIcon = (props: any) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);

const MapPinIcon = (props: any) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </Icon>
);

const TrendingUpIcon = (props: any) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
    <polyline points="16 7 22 7 22 13" />
  </Icon>
);

export default DashboardPage;
