import { useState, useMemo, useEffect, useRef } from "react";
import {
  Box,
  Flex,
  Text,
  VStack,
  HStack,
  Button,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  Badge,
  Icon,
  Spinner,
  IconButton,
  Input,
  Select,
  Textarea,
  useToast,
  Container,
  Card,
  CardBody,
  Alert,
  AlertIcon,
  useDisclosure,
} from "@chakra-ui/react";
import type { IconProps } from "@chakra-ui/react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Navbar from "../components/Navbar";
import { useAuth } from "../context/useAuth";
import { useUserReports } from "../hooks/useUserReports";
import { useWatchlist } from "../hooks/useWatchlist";
import { DossierPrintModal } from "../components/DossierPrintModal";
import { IMPACT_TYPE_META, FREQUENCY_META, DISTANCE_META } from "../types/report";
import type { ImpactType } from "../types/report";
import type { FactoryProperties } from "../types/factory";
import { fetchFactoryDetail } from "../hooks/useFactoriesApi";

const PrintIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </Icon>
);

const TrashIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);

export default function UserDiaryPage() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get("tab") === "watchlist" ? 1 : 0;
  const [tabIndex, setTabIndex] = useState(initialTab);

  const { user, profile, openAuthModal, isLoading: isAuthLoading } = useAuth();
  const { reports, isLoading: isReportsLoading, updatePrivateNote, deleteReport } =
    useUserReports();
  const { watchedFactories, toggleWatchFactory, totalWatchedCount } = useWatchlist();

  const [selectedFactoryId, setSelectedFactoryId] = useState<string>("all");
  const [selectedImpact, setSelectedImpact] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [factoryMetadataMap, setFactoryMetadataMap] = useState<Record<string, Partial<FactoryProperties>>>({});

  const { isOpen: isDossierOpen, onOpen: onDossierOpen, onClose: onDossierClose } = useDisclosure();
  const [dossierFactoryId, setDossierFactoryId] = useState<string | null>(null);
  const toast = useToast();

  // Load basic details for factories in the user's report list or watchlist.
  // The requested ids are tracked in a ref rather than read off
  // factoryMetadataMap: keying on the map meant every resolved fetch re-ran the
  // effect and re-fired requests for everything still in flight, and any id
  // whose lookup returned null was retried forever.
  const requestedFactoryIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const idsToFetch = Array.from(
      new Set([...reports.map((r) => r.factory_id), ...watchedFactories])
    );
    idsToFetch.forEach((fid) => {
      if (requestedFactoryIds.current.has(fid)) return;
      requestedFactoryIds.current.add(fid);
      fetchFactoryDetail(fid).then((meta) => {
        if (meta) {
          setFactoryMetadataMap((prev) => ({ ...prev, [fid]: meta }));
        }
      });
    });
  }, [reports, watchedFactories]);

  // Unique factories in reports
  const uniqueReportedFactories = useMemo(() => {
    const map = new Map<string, string>();
    reports.forEach((r) => {
      if (!map.has(r.factory_id)) {
        map.set(r.factory_id, r.factory_name || r.factory_id);
      }
    });
    return Array.from(map.entries());
  }, [reports]);

  // Filtered reports
  const filteredReports = useMemo(() => {
    return reports.filter((r) => {
      if (selectedFactoryId !== "all" && r.factory_id !== selectedFactoryId) {
        return false;
      }
      if (selectedImpact !== "all" && !r.impact_types.includes(selectedImpact as ImpactType)) {
        return false;
      }
      if (searchTerm) {
        const text = `${r.factory_name || ""} ${r.description || ""} ${r.private_note || ""}`.toLowerCase();
        if (!text.includes(searchTerm.toLowerCase())) return false;
      }
      return true;
    });
  }, [reports, selectedFactoryId, selectedImpact, searchTerm]);

  // Handle Note Save
  const handleSaveNote = async (reportId: string) => {
    const ok = await updatePrivateNote(reportId, noteDraft);
    if (ok) {
      toast({
        title: "บันทึกโน้ตสำเร็จ",
        status: "success",
        duration: 2000,
        isClosable: true,
      });
      setEditingNoteId(null);
    } else {
      toast({
        title: "บันทึกไม่สำเร็จ",
        status: "error",
        duration: 2000,
      });
    }
  };

  // Handle Delete Report
  const handleDeleteReport = async (reportId: string) => {
    if (!confirm("คุณต้องการลบบันทึกเหตุการณ์นี้ใช่หรือไม่?")) return;
    const ok = await deleteReport(reportId);
    if (ok) {
      toast({
        title: "ลบรายงานแล้ว",
        status: "info",
        duration: 2000,
      });
    } else {
      // Approved reports are public evidence behind the map's report counts,
      // so they are no longer the author's to remove.
      toast({
        title: "ลบไม่สำเร็จ",
        description:
          "รายงานที่ผ่านการตรวจสอบแล้วจะถูกเก็บไว้เป็นข้อมูลสาธารณะ หากต้องการถอนรายงาน กรุณาติดต่อผู้ดูแลระบบ",
        status: "warning",
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // Reports to send to the Dossier Modal
  const dossierReports = useMemo(() => {
    if (!dossierFactoryId || dossierFactoryId === "all") {
      return filteredReports.length > 0 ? filteredReports : reports;
    }
    return reports.filter((r) => r.factory_id === dossierFactoryId);
  }, [dossierFactoryId, filteredReports, reports]);

  const dossierFactoryMeta = useMemo(() => {
    if (!dossierFactoryId || dossierFactoryId === "all") return null;
    const meta = factoryMetadataMap[dossierFactoryId];
    if (!meta) return null;
    return {
      id: dossierFactoryId,
      name: meta.ชื่อโรงงาน || "",
      address: meta.ที่อยู่ || "",
      province: meta.จังหวัด || "",
      district: meta.อำเภอ || "",
      factory_type: meta.ประเภท || "",
      juristic_name: meta.ผู้ประกอบก || "",
      horsepower: meta.แรงม้า,
      capital_investment: meta.เงินลงทุน,
      lat: meta.ละติจูด,
      lng: meta.ลองติจูด,
    };
  }, [dossierFactoryId, factoryMetadataMap]);

  return (
    <Box minH="100vh" bg="slate.50">
      <Navbar />

      <Container maxW="container.lg" py={8} px={{ base: 4, md: 8 }}>
        {/* Page Header */}
        <Flex
          direction={{ base: "column", md: "row" }}
          justify="space-between"
          align={{ base: "start", md: "center" }}
          mb={6}
          gap={4}
        >
          <Box>
            <HStack spacing={2} align="center">
              <Text fontSize="2xl" fontWeight="800" color="slate.800">
                สมุดบันทึกผลกระทบภาคประชาชน
              </Text>
              <Badge colorScheme="orange" fontSize="xs" borderRadius="full" px={2}>
                Citizen Diary
              </Badge>
            </HStack>
            <Text fontSize="sm" color="slate.500" mt={1}>
              รวบรวมประวัติเหตุการณ์สิ่งแวดล้อม ติดตามโรงงานใกล้เคียง และออกเอกสารยื่นเรื่องร้องเรียน
            </Text>
          </Box>

          {user && (
            <Button
              bg="primary.500"
              color="white"
              leftIcon={<PrintIcon boxSize={4} />}
              onClick={() => {
                setDossierFactoryId(selectedFactoryId !== "all" ? selectedFactoryId : null);
                onDossierOpen();
              }}
              isDisabled={reports.length === 0}
              _disabled={{
                bg: "slate.200",
                color: "slate.400",
                cursor: "not-allowed",
                boxShadow: "none",
                _hover: { bg: "slate.200" },
              }}
              _hover={{ bg: "primary.600" }}
              _active={{ bg: "primary.700" }}
              borderRadius="xl"
              boxShadow="sm"
            >
              ออกเอกสารยื่นราชการ (Dossier)
            </Button>
          )}
        </Flex>

        {/* Not Logged In Banner */}
        {!user && !isAuthLoading && (
          <Alert
            status="info"
            variant="subtle"
            borderRadius="2xl"
            mb={6}
            p={4}
            bg="primary.50"
            border="1px solid"
            borderColor="primary.200"
          >
            <AlertIcon color="primary.500" />
            <Box flex="1">
              <Text fontSize="sm" fontWeight="700" color="slate.800">
                เข้าสู่ระบบด้วย Gmail เพื่อเริ่มบันทึกประวัติส่วนตัว
              </Text>
              <Text fontSize="xs" color="slate.600" mt={0.5}>
                เมื่อเข้าสู่ระบบ ทุกรายงานที่คุณส่งจะถูกบันทึกในสมุดเล่มนี้เพื่อใช้ออกเอกสารหลักฐานยื่นหน่วยงานราชการ
              </Text>
            </Box>
            <Button
              size="sm"
              bg="primary.500"
              color="white"
              _hover={{ bg: "primary.600" }}
              onClick={openAuthModal}
              borderRadius="lg"
            >
              เข้าสู่ระบบด้วย Gmail
            </Button>
          </Alert>
        )}

        {/* Tabs: Incident Reports vs Watched Factories */}
        <Tabs
          index={tabIndex}
          onChange={(index) => setTabIndex(index)}
          variant="unstyled"
        >
          <TabList bg="white" p={1.5} borderRadius="2xl" border="1px solid" borderColor="slate.200" mb={6} gap={2}>
            <Tab
              fontSize="sm"
              fontWeight="600"
              borderRadius="xl"
              px={5}
              py={2.5}
              color="slate.600"
              _selected={{
                bg: "primary.500",
                color: "white",
                boxShadow: "sm",
              }}
              _hover={{
                bg: "slate.50",
                color: "slate.900",
              }}
              transition="all 0.15s ease-in-out"
            >
              <HStack spacing={2}>
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </Icon>
                <Text>ประวัติบันทึกผลกระทบ ({reports.length})</Text>
              </HStack>
            </Tab>
            <Tab
              fontSize="sm"
              fontWeight="600"
              borderRadius="xl"
              px={5}
              py={2.5}
              color="slate.600"
              _selected={{
                bg: "primary.500",
                color: "white",
                boxShadow: "sm",
              }}
              _hover={{
                bg: "slate.50",
                color: "slate.900",
              }}
              transition="all 0.15s ease-in-out"
            >
              <HStack spacing={2}>
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </Icon>
                <Text>โรงงานที่ติดตาม ({totalWatchedCount})</Text>
              </HStack>
            </Tab>
          </TabList>

          <TabPanels>
            {/* TAB 1: INCIDENT REPORTS DIARY */}
            <TabPanel p={0}>
              {isReportsLoading ? (
                <Flex justify="center" py={16}>
                  <Spinner color="primary.500" size="lg" />
                </Flex>
              ) : reports.length === 0 ? (
                <Card borderRadius="2xl" border="1px solid" borderColor="slate.200" bg="white" p={8} textAlign="center">
                  <CardBody>
                    <Flex justify="center" mb={4}>
                      <Box p={3} bg="slate.100" borderRadius="2xl" color="slate.400">
                        <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={8}>
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                        </Icon>
                      </Box>
                    </Flex>
                    <Text fontSize="lg" fontWeight="700" color="slate.800">
                      ยังไม่มีบันทึกรายงานผลกระทบ
                    </Text>
                    <Text fontSize="sm" color="slate.500" mt={1} maxW="md" mx="auto">
                      เมื่อคุณพบกลิ่นเหม็น ฝุ่นควัน เสียงดัง หรือน้ำเสียจากโรงงาน สามารถกด "รายงานผลกระทบ" ในหน้ารายละเอียดโรงงาน รายงานจะถูกบันทึกมาไว้ที่นี่อัตโนมัติ
                    </Text>
                    <Button
                      as={RouterLink}
                      to="/"
                      mt={6}
                      bg="primary.500"
                      color="white"
                      _hover={{ bg: "primary.600" }}
                      borderRadius="xl"
                    >
                      ค้นหาโรงงานบนแผนที่
                    </Button>
                  </CardBody>
                </Card>
              ) : (
                <VStack spacing={4} align="stretch">
                  {/* Filters Bar */}
                  <Card borderRadius="xl" bg="white" border="1px solid" borderColor="slate.200">
                    <CardBody p={3}>
                      <Flex direction={{ base: "column", md: "row" }} gap={3}>
                        <Input
                          placeholder="ค้นหาชื่อโรงงาน / รายละเอียด..."
                          size="sm"
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          borderRadius="lg"
                          flex="1"
                        />
                        <Select
                          size="sm"
                          value={selectedFactoryId}
                          onChange={(e) => setSelectedFactoryId(e.target.value)}
                          borderRadius="lg"
                          w={{ base: "full", md: "240px" }}
                        >
                          <option value="all">ทุกโรงงาน ({uniqueReportedFactories.length} แห่ง)</option>
                          {uniqueReportedFactories.map(([id, name]) => (
                            <option key={id} value={id}>
                              {name}
                            </option>
                          ))}
                        </Select>
                        <Select
                          size="sm"
                          value={selectedImpact}
                          onChange={(e) => setSelectedImpact(e.target.value)}
                          borderRadius="lg"
                          w={{ base: "full", md: "160px" }}
                        >
                          <option value="all">ทุกประเภทผลกระทบ</option>
                          {Object.entries(IMPACT_TYPE_META).map(([key, meta]) => (
                            <option key={key} value={key}>
                              {meta.label}
                            </option>
                          ))}
                        </Select>
                      </Flex>
                    </CardBody>
                  </Card>

                  {/* Reports Timeline List */}
                  {filteredReports.map((report) => (
                    <Card
                      key={report.id}
                      borderRadius="2xl"
                      border="1px solid"
                      borderColor="slate.200"
                      bg="white"
                      boxShadow="xs"
                      _hover={{ boxShadow: "sm" }}
                    >
                      <CardBody p={5}>
                        <Flex justify="space-between" align="flex-start" wrap="wrap" gap={2} mb={3}>
                          <Box>
                            <HStack spacing={2} align="center">
                              <Text fontSize="md" fontWeight="700" color="slate.800">
                                {report.factory_name}
                              </Text>
                              {report.province && (
                                <Badge colorScheme="gray" variant="subtle" fontSize="10px">
                                  {report.province}
                                </Badge>
                              )}
                            </HStack>
                            <Text fontSize="xs" color="slate.400" mt={0.5}>
                              เลขทะเบียน: {report.factory_id} · วันที่เกิดเหตุ: <strong>{report.incident_date || report.created_at.slice(0, 10)}</strong>
                            </Text>
                          </Box>

                          <HStack spacing={1}>
                            <Button
                              size="xs"
                              variant="outline"
                              colorScheme="orange"
                              borderRadius="lg"
                              leftIcon={<PrintIcon boxSize={3} />}
                              onClick={() => {
                                setDossierFactoryId(report.factory_id);
                                onDossierOpen();
                              }}
                            >
                              พิมพ์หลักฐานโรงงานนี้
                            </Button>
                            <IconButton
                              aria-label="ลบรายงาน"
                              icon={<TrashIcon boxSize={3.5} />}
                              size="xs"
                              variant="ghost"
                              colorScheme="red"
                              borderRadius="lg"
                              onClick={() => handleDeleteReport(report.id)}
                            />
                          </HStack>
                        </Flex>

                        {/* Impact Badges */}
                        <HStack spacing={2} flexWrap="wrap" mb={3}>
                          {report.impact_types.map((type) => (
                            <Badge
                              key={type}
                              colorScheme="red"
                              variant="subtle"
                              px={2}
                              py={0.5}
                              borderRadius="md"
                              fontSize="xs"
                            >
                              {IMPACT_TYPE_META[type]?.label || type}
                            </Badge>
                          ))}
                          {report.frequency && (
                            <Badge colorScheme="blue" variant="subtle" px={2} py={0.5} borderRadius="md" fontSize="xs">
                              {FREQUENCY_META[report.frequency]}
                            </Badge>
                          )}
                          {report.distance_band && (
                            <Badge colorScheme="gray" variant="outline" px={2} py={0.5} borderRadius="md" fontSize="xs">
                              {DISTANCE_META[report.distance_band]}
                            </Badge>
                          )}
                        </HStack>

                        {/* Citizen Description */}
                        {report.description && (
                          <Box bg="slate.50" p={3} borderRadius="xl" mb={3} border="1px solid" borderColor="slate.100">
                            <Text fontSize="xs" fontWeight="600" color="slate.500" mb={0.5}>
                              รายละเอียดที่รายงาน:
                            </Text>
                            <Text fontSize="sm" color="slate.700">
                              {report.description}
                            </Text>
                          </Box>
                        )}

                        {/* Citizen Private Note */}
                        <Box bg="amber.50" p={3} borderRadius="xl" border="1px solid" borderColor="amber.200">
                          <Flex justify="space-between" align="center" mb={1}>
                            <HStack spacing={1.5}>
                              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="amber.700">
                                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                              </Icon>
                              <Text fontSize="xs" fontWeight="700" color="amber.900">
                                บันทึกช่วยจำส่วนตัว:
                              </Text>
                            </HStack>
                            {editingNoteId !== report.id && (
                              <Button
                                size="xs"
                                variant="link"
                                colorScheme="orange"
                                onClick={() => {
                                  setEditingNoteId(report.id);
                                  setNoteDraft(report.private_note || "");
                                }}
                              >
                                {report.private_note ? "แก้ไข" : "+ เพิ่มบันทึกช่วยจำ"}
                              </Button>
                            )}
                          </Flex>

                          {editingNoteId === report.id ? (
                            <VStack spacing={2} align="stretch" mt={2}>
                              <Textarea
                                value={noteDraft}
                                onChange={(e) => setNoteDraft(e.target.value)}
                                placeholder="จดบันทึก เช่น ทิศทางลม, อาการเจ็บป่วย, ผลตรวจสุขภาพ..."
                                size="sm"
                                bg="white"
                                rows={2}
                                borderRadius="lg"
                              />
                              <HStack justify="flex-end" spacing={2}>
                                <Button size="xs" variant="ghost" onClick={() => setEditingNoteId(null)}>
                                  ยกเลิก
                                </Button>
                                <Button size="xs" colorScheme="orange" onClick={() => handleSaveNote(report.id)}>
                                  บันทึก
                                </Button>
                              </HStack>
                            </VStack>
                          ) : (
                            <Text fontSize="xs" color="amber.900">
                              {report.private_note || "ยังไม่มีบันทึกเพิ่มเติม (คลิกแก้ไขเพื่อเพิ่มรายละเอียดส่วนตัว)"}
                            </Text>
                          )}
                        </Box>
                      </CardBody>
                    </Card>
                  ))}
                </VStack>
              )}
            </TabPanel>

            {/* TAB 2: WATCHED FACTORIES */}
            <TabPanel p={0}>
              {watchedFactories.length === 0 ? (
                <Card borderRadius="2xl" border="1px solid" borderColor="slate.200" bg="white" p={8} textAlign="center">
                  <CardBody>
                    <Flex justify="center" mb={4}>
                      <Box p={3} bg="amber.50" borderRadius="2xl" color="amber.500">
                        <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={8}>
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </Icon>
                      </Box>
                    </Flex>
                    <Text fontSize="lg" fontWeight="700" color="slate.800">
                      ยังไม่มีโรงงานที่ติดตาม
                    </Text>
                    <Text fontSize="sm" color="slate.500" mt={1} maxW="md" mx="auto">
                      คุณสามารถกดปุ่มรูปดาวที่การ์ดโรงงานบนแผนที่ เพื่อบันทึกติดตามโรงงานที่อยู่ใกล้บ้านหรือสถานประกอบการที่ต้องการเฝ้าระวัง
                    </Text>
                    <Button
                      as={RouterLink}
                      to="/"
                      mt={6}
                      bg="primary.500"
                      color="white"
                      _hover={{ bg: "primary.600" }}
                      borderRadius="xl"
                    >
                      ไปที่แผนที่เพื่อเลือกโรงงาน
                    </Button>
                  </CardBody>
                </Card>
              ) : (
                <VStack spacing={3} align="stretch">
                  {watchedFactories.map((fid) => {
                    const meta = factoryMetadataMap[fid];
                    return (
                      <Card
                        key={fid}
                        borderRadius="xl"
                        border="1px solid"
                        borderColor="slate.200"
                        bg="white"
                        boxShadow="xs"
                        _hover={{ boxShadow: "sm" }}
                      >
                        <CardBody p={4}>
                          <Flex justify="space-between" align="center">
                            <Box flex="1">
                              <HStack spacing={2} align="center">
                                <Text fontSize="md" fontWeight="700" color="slate.800">
                                  {meta?.ชื่อโรงงาน || "กำลังโหลดข้อมูลโรงงาน..."}
                                </Text>
                                {meta?.จังหวัด && (
                                  <Badge bg="primary.50" color="primary.700" fontSize="10px">
                                    {meta.จังหวัด}
                                  </Badge>
                                )}
                              </HStack>
                              <Text fontSize="xs" color="slate.400" mt={0.5}>
                                ทะเบียน: {fid} {meta?.ประกอบกิจก ? `· ${meta.ประกอบกิจก}` : ""}
                              </Text>
                            </Box>

                            <HStack spacing={2}>
                              <Button
                                as={RouterLink}
                                to={`/?factory=${fid}${meta?.จังหวัด ? `&province=${meta.จังหวัด}` : ""}`}
                                size="xs"
                                variant="outline"
                                colorScheme="orange"
                                borderRadius="lg"
                              >
                                ดูบนแผนที่
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                colorScheme="red"
                                borderRadius="lg"
                                onClick={() => toggleWatchFactory(fid)}
                              >
                                เลิกติดตาม
                              </Button>
                            </HStack>
                          </Flex>
                        </CardBody>
                      </Card>
                    );
                  })}
                </VStack>
              )}
            </TabPanel>
          </TabPanels>
        </Tabs>
      </Container>

      {/* Official Authority Dossier Modal */}
      <DossierPrintModal
        isOpen={isDossierOpen}
        onClose={onDossierClose}
        reports={dossierReports}
        factoryMeta={dossierFactoryMeta}
        userProfile={profile}
        userEmail={user?.email}
      />
    </Box>
  );
}
