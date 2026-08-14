import React, { useRef } from "react";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Button,
  Box,
  Flex,
  Text,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  HStack,
  VStack,
  Badge,
  Icon,
} from "@chakra-ui/react";
import type { UserIncidentReport, UserProfile } from "../types/auth";
import { IMPACT_TYPE_META, FREQUENCY_META, DISTANCE_META, REPORT_DISCLAIMER } from "../types/report";

interface FactoryMeta {
  id: string;
  name: string;
  address?: string;
  province?: string;
  district?: string;
  factory_type?: string;
  horsepower?: number;
  capital_investment?: number;
  total_workers?: number;
  juristic_name?: string;
  juristic_id?: string;
  zoning_label?: string;
  lat?: number;
  lng?: number;
}

interface DossierPrintModalProps {
  isOpen: boolean;
  onClose: () => void;
  reports: UserIncidentReport[];
  factoryMeta?: FactoryMeta | null;
  userProfile?: UserProfile | null;
  userEmail?: string | null;
}

import type { IconProps } from "@chakra-ui/react";

const PrintIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </Icon>
);

export const DossierPrintModal: React.FC<DossierPrintModalProps> = ({
  isOpen,
  onClose,
  reports,
  factoryMeta,
  userProfile,
  userEmail,
}) => {
  const printAreaRef = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    window.print();
  };

  const generatedDate = new Date().toLocaleDateString("th-TH", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const targetFactoryName = factoryMeta?.name || reports[0]?.factory_name || "โรงงานตามรายการบันทึก";
  const targetFactoryId = factoryMeta?.id || reports[0]?.factory_id || "-";

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="5xl" scrollBehavior="inside">
      <ModalOverlay bg="blackAlpha.600" backdropFilter="blur(3px)" />
      <ModalContent borderRadius="2xl" maxW="900px" bg="white" color="slate.800">
        <ModalHeader borderBottom="1px solid" borderColor="slate.100" py={4}>
          <Flex align="center" justify="space-between" pr={6}>
            <Box>
              <Text fontSize="md" fontWeight="700" color="slate.800">
                เอกสารสรุปบันทึกข้อเท็จจริงและรายงานผลกระทบ (Citizen Complaint Dossier)
              </Text>
              <Text fontSize="xs" fontWeight="400" color="slate.500">
                จัดรูปแบบพร้อมพิมพ์เป็นหลักฐานยื่นเรื่องต่อหน่วยงานราชการ
              </Text>
            </Box>
            <Button
              size="sm"
              bg="primary.500"
              color="white"
              leftIcon={<PrintIcon boxSize={4} />}
              onClick={handlePrint}
              _hover={{ bg: "primary.600" }}
              _active={{ bg: "primary.700" }}
              borderRadius="lg"
            >
              พิมพ์เอกสาร (Print / PDF)
            </Button>
          </Flex>
        </ModalHeader>
        <ModalCloseButton />

        <ModalBody p={{ base: 4, md: 8 }} bg="slate.50">
          {/* Print Stylesheet */}
          <style>{`
            @media print {
              body * {
                visibility: hidden;
              }
              #dossier-print-root, #dossier-print-root * {
                visibility: visible;
              }
              #dossier-print-root {
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
                margin: 0;
                padding: 15mm;
                background: white !important;
                color: black !important;
                font-family: 'IBM Plex Sans Thai', 'TH Sarabun New', sans-serif !important;
                box-shadow: none !important;
                border: none !important;
              }
              .no-print {
                display: none !important;
              }
            }
          `}</style>

          {/* Printable Document Container */}
          <Box
            id="dossier-print-root"
            ref={printAreaRef}
            bg="white"
            p={{ base: 6, md: 10 }}
            borderRadius="xl"
            boxShadow="sm"
            border="1px solid"
            borderColor="slate.200"
          >
            {/* 1. Official Header */}
            <Box borderBottom="2px solid" borderColor="slate.800" pb={4} mb={6}>
              <Flex justify="space-between" align="flex-start" wrap="wrap" gap={2}>
                <Box>
                  <Text fontSize="lg" fontWeight="800" color="slate.900" letterSpacing="tight">
                    บันทึกข้อเท็จจริงและรายงานผลกระทบสิ่งแวดล้อมภาคประชาชน
                  </Text>
                  <Text fontSize="xs" fontWeight="600" color="slate.600">
                    CITIZEN ENVIRONMENTAL IMPACT & FACT-FINDING REPORT
                  </Text>
                  <Text fontSize="xs" color="slate.500" mt={1}>
                    เอกสารประกอบการยื่นเรื่องร้องเรียน: สำนักงานอุตสาหกรรมจังหวัด / กรมโรงงานฯ / ศูนย์ดำรงธรรม / อปท.
                  </Text>
                </Box>
                <Box textAlign={{ base: "left", sm: "right" }}>
                  <Badge colorScheme="blue" fontSize="10px" px={2} py={0.5} borderRadius="md">
                    เอกสารรวบรวมโดยประชาชน
                  </Badge>
                  <Text fontSize="11px" color="slate.500" mt={1}>
                    วันที่ออกเอกสาร: {generatedDate}
                  </Text>
                </Box>
              </Flex>
            </Box>

            {/* 2. Target Factory Section */}
            <Box mb={6} p={4} bg="slate.50" borderRadius="lg" border="1px solid" borderColor="slate.200">
              <Text fontSize="xs" fontWeight="700" textTransform="uppercase" color="primary.600" mb={2}>
                ๑. ข้อมูลโรงงานเป้าหมาย (จากฐานข้อมูลเปิดภาครัฐ กรมโรงงานอุตสาหกรรม & DBD)
              </Text>
              <VStack align="stretch" spacing={2} fontSize="xs" color="slate.700">
                <Flex justify="space-between" wrap="wrap" gap={2}>
                  <Text>
                    <strong>ชื่อโรงงาน:</strong> {targetFactoryName}
                  </Text>
                  <Text>
                    <strong>เลขทะเบียนโรงงาน:</strong> {targetFactoryId}
                  </Text>
                </Flex>
                {factoryMeta?.juristic_name && (
                  <Flex justify="space-between" wrap="wrap" gap={2}>
                    <Text>
                      <strong>นิติบุคคลผู้ประกอบการ (DBD):</strong> {factoryMeta.juristic_name}
                    </Text>
                    {factoryMeta.juristic_id && (
                      <Text>
                        <strong>เลขนิติบุคคล:</strong> {factoryMeta.juristic_id}
                      </Text>
                    )}
                  </Flex>
                )}
                <Flex justify="space-between" wrap="wrap" gap={2}>
                  <Text>
                    <strong>ที่ตั้ง:</strong> {factoryMeta?.address || `${reports[0]?.district || ""} ${reports[0]?.province || ""}` || "-"}
                  </Text>
                  {factoryMeta?.zoning_label && (
                    <Text>
                      <strong>ผังเมือง (DPT):</strong> {factoryMeta.zoning_label}
                    </Text>
                  )}
                </Flex>
                {factoryMeta?.lat && factoryMeta?.lng && (
                  <Text fontFamily="'Inter', monospace" fontSize="11px" color="slate.500">
                    <strong>พิกัดแผนที่:</strong> {factoryMeta.lat.toFixed(6)}, {factoryMeta.lng.toFixed(6)}
                  </Text>
                )}
              </VStack>
            </Box>

            {/* 3. Complainant Section */}
            <Box mb={6} p={4} bg="slate.50" borderRadius="lg" border="1px solid" borderColor="slate.200">
              <Text fontSize="xs" fontWeight="700" textTransform="uppercase" color="primary.600" mb={2}>
                ๒. ข้อมูลผู้บันทึก / ผู้ร้องเรียน (Complainant Profile)
              </Text>
              <Flex justify="space-between" wrap="wrap" gap={4} fontSize="xs" color="slate.700">
                <Text>
                  <strong>ชื่อ-สกุล:</strong> {userProfile?.full_name || "ประชาชนผู้ได้รับผลกระทบ"}
                </Text>
                <Text>
                  <strong>อีเมลติดต่อ:</strong> {userEmail || "-"}
                </Text>
                {userProfile?.phone && (
                  <Text>
                    <strong>เบอร์โทรศัพท์:</strong> {userProfile.phone}
                  </Text>
                )}
                <Text>
                  <strong>จำนวนเหตุการณ์ที่บันทึก:</strong> {reports.length} ครั้ง
                </Text>
              </Flex>
            </Box>

            {/* 4. Incident Chronology Table */}
            <Box mb={6}>
              <Text fontSize="xs" fontWeight="700" textTransform="uppercase" color="primary.600" mb={2}>
                ๓. ตารางบันทึกเหตุการณ์และผลกระทบต่อเนื่อง (Incident Chronology Log)
              </Text>
              <Table variant="simple" size="sm" border="1px solid" borderColor="slate.200">
                <Thead bg="slate.100">
                  <Tr>
                    <Th fontSize="10px" color="slate.700" w="100px">วัน/เวลาเกิดเหตุ</Th>
                    <Th fontSize="10px" color="slate.700" w="120px">ประเภทผลกระทบ</Th>
                    <Th fontSize="10px" color="slate.700" w="110px">ความถี่ / ระยะทาง</Th>
                    <Th fontSize="10px" color="slate.700">รายละเอียดเหตุการณ์ & บันทึกช่วยจำ</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {reports.map((report) => (
                    <Tr key={report.id} _hover={{ bg: "slate.50" }}>
                      <Td fontSize="xs" verticalAlign="top">
                        <Text fontWeight="600" color="slate.800">
                          {report.incident_date || report.created_at.slice(0, 10)}
                        </Text>
                        <Text fontSize="10px" color="slate.400">
                          บันทึก: {new Date(report.created_at).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                      </Td>
                      <Td fontSize="xs" verticalAlign="top">
                        <VStack align="start" spacing={1}>
                          {report.impact_types.map((type) => (
                            <Badge
                              key={type}
                              colorScheme="red"
                              variant="subtle"
                              fontSize="10px"
                              px={1.5}
                              borderRadius="md"
                            >
                              {IMPACT_TYPE_META[type]?.label || type}
                            </Badge>
                          ))}
                        </VStack>
                      </Td>
                      <Td fontSize="xs" verticalAlign="top">
                        <Text color="slate.700">
                          {report.frequency ? FREQUENCY_META[report.frequency] : "-"}
                        </Text>
                        <Text fontSize="10px" color="slate.500">
                          {report.distance_band ? DISTANCE_META[report.distance_band] : "-"}
                        </Text>
                      </Td>
                      <Td fontSize="xs" verticalAlign="top">
                        {report.description && (
                          <Text color="slate.800" mb={1}>
                            {report.description}
                          </Text>
                        )}
                        {report.private_note && (
                          <Box bg="amber.50" p={2} borderRadius="md" borderLeft="3px solid" borderColor="amber.400">
                            <Text fontSize="11px" color="amber.900">
                              <strong>บันทึกเพิ่มเติม:</strong> {report.private_note}
                            </Text>
                          </Box>
                        )}
                        {!report.description && !report.private_note && (
                          <Text color="slate.400" fontStyle="italic">ไม่ได้ระบุข้อความเพิ่มเติม</Text>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>

            {/* 5. Citizen Declaration & Signature Block */}
            <Box mt={8} pt={4} borderTop="1px solid" borderColor="slate.200">
              <Text fontSize="11px" color="slate.500" mb={6} lineHeight="tall">
                <strong>คำรับรองของผู้ร้องเรียน:</strong> ข้าพเจ้าขอรับรองว่าข้อมูลและบันทึกเหตุการณ์ข้างต้นเป็นความจริงตามที่ข้าพเจ้าได้ประสบและสังเกตการณ์ด้วยตนเอง ข้าพเจ้าจัดทำเอกสารนี้ขึ้นเพื่อใช้เป็นหลักฐานและข้อมูลประกอบการตรวจสอบข้อเท็จจริงตามอำนาจหน้าที่ของหน่วยงานราชการที่เกี่ยวข้อง ({REPORT_DISCLAIMER})
              </Text>

              <Flex justify="space-between" align="flex-end" pt={4} wrap="wrap" gap={6}>
                <Box>
                  <Text fontSize="11px" color="slate.500">
                    จัดทำผ่านระบบ: <strong>โรงงานใกล้ฉัน (Factory Near Me)</strong>
                  </Text>
                  <Text fontSize="10px" color="slate.400">
                    Thai PBS & Civic Tech Industrial Transparency Initiative
                  </Text>
                </Box>

                <Box textAlign="center" minW="220px">
                  <Box borderBottom="1px dotted" borderColor="slate.400" h="40px" mb={2} />
                  <Text fontSize="xs" color="slate.700">
                    (ลงชื่อ) ..............................................................
                  </Text>
                  <Text fontSize="11px" color="slate.500" mt={1}>
                    ({userProfile?.full_name || ".............................................................."})
                  </Text>
                  <Text fontSize="10px" color="slate.400">
                    ผู้ร้องเรียน / วันที่ ........../........../..........
                  </Text>
                </Box>
              </Flex>
            </Box>
          </Box>
        </ModalBody>

        <ModalFooter borderTop="1px solid" borderColor="slate.100" py={3}>
          <HStack spacing={3}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              ปิด
            </Button>
            <Button
              size="sm"
              bg="primary.500"
              color="white"
              leftIcon={<PrintIcon boxSize={4} />}
              onClick={handlePrint}
              _hover={{ bg: "primary.600" }}
            >
              พิมพ์เอกสาร (Print / PDF)
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
