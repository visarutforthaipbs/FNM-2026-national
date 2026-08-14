import React, { useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Icon,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Text,
  Textarea,
  VStack,
  useDisclosure,
} from "@chakra-ui/react";
import type { FactoryFeature } from "../types/factory";
import type {
  DistanceBand,
  ImpactType,
  ReportCountSummary,
  ReportFrequency,
} from "../types/report";
import {
  DISTANCE_META,
  FREQUENCY_META,
  IMPACT_TYPE_META,
  REPORT_DISCLAIMER,
} from "../types/report";
import { submitReport } from "../hooks/useReports";

const MegaphoneIcon = (props: React.ComponentProps<typeof Icon>) => (
  <Icon
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M3 11v3a1 1 0 0 0 1 1h2l3.5 4a1 1 0 0 0 1.5-.9V6.9a1 1 0 0 0-1.5-.9L6 10H4a1 1 0 0 0-1 1Z" />
    <path d="M14 8.5a4 4 0 0 1 0 7M17 6a8 8 0 0 1 0 12" />
  </Icon>
);

const ImpactTypeIcon: React.FC<{
  type: ImpactType;
  boxSize?: number | string;
}> = ({ type, boxSize = 3.5 }) => {
  if (type === "smell") {
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        boxSize={boxSize}
      >
        <path d="M7 16c0-1.6 1.4-2.2 1.4-3.8S7 10.1 7 8.6" />
        <path d="M12 17c0-1.6 1.4-2.2 1.4-3.8S12 11.1 12 9.6" />
        <path d="M17 16c0-1.6 1.4-2.2 1.4-3.8S17 10.1 17 8.6" />
      </Icon>
    );
  }
  if (type === "noise") {
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        boxSize={boxSize}
      >
        <path d="M4 10v4h3l4 3V7l-4 3H4Z" />
        <path d="M15 9a4.5 4.5 0 0 1 0 6M18 7a7.5 7.5 0 0 1 0 10" />
      </Icon>
    );
  }
  if (type === "water") {
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        boxSize={boxSize}
      >
        <path d="M12 4c3 4 5 6.1 5 9a5 5 0 0 1-10 0c0-2.9 2-5 5-9Z" />
      </Icon>
    );
  }
  if (type === "dust") {
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        boxSize={boxSize}
      >
        <path d="M4 14.5c1.1-1.3 2.3-1.7 3.8-1.7 1.1 0 2 .3 2.8.9.7-.6 1.7-.9 2.8-.9 1.6 0 3 .5 4.2 1.9" />
        <circle cx="6" cy="8" r="1" />
        <circle cx="12" cy="7" r="1" />
        <circle cx="18" cy="9" r="1" />
      </Icon>
    );
  }
  if (type === "vibration") {
    return (
      <Icon
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        boxSize={boxSize}
      >
        <path d="M6 7v10M18 7v10" />
        <path d="m9.5 10 2.5 2-2.5 2" />
        <path d="m14.5 10-2.5 2 2.5 2" />
      </Icon>
    );
  }
  return (
    <Icon
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      boxSize={boxSize}
    >
      <path d="M12 4 3.8 19h16.4L12 4Z" />
      <path d="M12 9v4.5M12 16.5h.01" />
    </Icon>
  );
};

// Selectable chip — the single interaction primitive of the whole form
const Chip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <Button
    size="sm"
    borderRadius="full"
    variant="ghost"
    bg={active ? "primary.50" : "slate.50"}
    color={active ? "primary.700" : "slate.600"}
    fontWeight={active ? "700" : "400"}
    border="1px solid"
    borderColor={active ? "primary.200" : "transparent"}
    onClick={onClick}
    _hover={{ bg: active ? "primary.100" : "slate.100" }}
    flexShrink={0}
  >
    {children}
  </Button>
);

interface ReportSectionProps {
  factory: FactoryFeature;
  counts?: ReportCountSummary;
}

import { useAuth } from "../context/useAuth";

/**
 * Citizen impact reporting — counts of approved reports + the submission
 * modal. SIGNAL 39: one decision per step, chips over free text, everything
 * after step 1 optional.
 */
const ReportSection: React.FC<ReportSectionProps> = ({ factory, counts }) => {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const { user } = useAuth();
  const factoryId = factory.properties.เลขทะเบียน;

  // Form state
  const [step, setStep] = useState(0);
  const [impactTypes, setImpactTypes] = useState<ImpactType[]>([]);
  const [frequency, setFrequency] = useState<ReportFrequency | null>(null);
  const [distanceBand, setDistanceBand] = useState<DistanceBand | null>(null);
  const [description, setDescription] = useState("");
  const [incidentDate, setIncidentDate] = useState("");
  const [contact, setContact] = useState("");
  const [privateNote, setPrivateNote] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countChips = useMemo(() => {
    if (!counts) return [];
    return (Object.entries(counts.byType) as [ImpactType, number][])
      .sort((a, b) => b[1] - a[1]);
  }, [counts]);

  const toggleImpact = (t: ImpactType) =>
    setImpactTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );

  const resetAndClose = () => {
    onClose();
    // Delay reset so the closing animation doesn't flash step 1
    setTimeout(() => {
      setStep(0);
      setImpactTypes([]);
      setFrequency(null);
      setDistanceBand(null);
      setDescription("");
      setIncidentDate("");
      setContact("");
      setPrivateNote("");
      setHoneypot("");
      setIsSubmitted(false);
      setError(null);
    }, 250);
  };

  const handleSubmit = async () => {
    // Honeypot filled → bot; pretend success without sending
    if (honeypot) {
      setIsSubmitted(true);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await submitReport({
        factory_id: factoryId,
        impact_types: impactTypes,
        frequency: frequency ?? undefined,
        distance_band: distanceBand ?? undefined,
        description: description.trim() || undefined,
        incident_date: incidentDate || undefined,
        reporter_contact: contact.trim() || undefined,
        user_id: user?.id,
        private_note: privateNote.trim() || undefined,
      });
      setIsSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ส่งรายงานไม่สำเร็จ");
    } finally {
      setIsSubmitting(false);
    }
  };

  const stepTitles = [
    "ได้รับผลกระทบแบบไหน?",
    "บ่อยแค่ไหน และอยู่ใกล้แค่ไหน?",
    "เล่าเพิ่มเติม (ไม่บังคับ)",
  ];

  return (
    <Box
      mt={1}
      p={4}
      bg="primary.50"
      borderRadius="2xl"
      border="1px solid"
      borderColor="primary.100"
    >
      {/* Approved-report counts (Layer 1: signal without reading) */}
      {counts && counts.total > 0 ? (
        <Box mb={3}>
          <Flex align="center" gap={2} mb={2}>
            <MegaphoneIcon color="primary.600" boxSize={4} />
            <Text fontSize="sm" fontWeight="700" color="slate.800">
              รายงานจากประชาชน {counts.total.toLocaleString()} รายการ
            </Text>
          </Flex>
          <Flex wrap="wrap" gap={1.5}>
            {countChips.map(([type, n]) => (
              <Badge
                key={type}
                bg="white"
                color="primary.700"
                borderRadius="full"
                px={2.5}
                py={0.5}
                fontSize="11px"
                fontWeight="600"
                display="inline-flex"
                alignItems="center"
                gap={1}
              >
                <ImpactTypeIcon type={type} boxSize={3} />
                {IMPACT_TYPE_META[type].label} × {n}
              </Badge>
            ))}
          </Flex>
          <Text mt={2} fontSize="10px" color="slate.400" lineHeight="1.5">
            {REPORT_DISCLAIMER}
          </Text>
        </Box>
      ) : (
        <Text fontSize="xs" color="slate.500" mb={3} lineHeight="1.6">
          อยู่ใกล้โรงงานนี้และได้รับผลกระทบ เช่น กลิ่น เสียง หรือน้ำเสีย?
          บอกให้ชุมชนรู้
        </Text>
      )}

      <Button
        w="full"
        size="md"
        bg="primary.600"
        color="white"
        borderRadius="xl"
        fontWeight="600"
        _hover={{ bg: "primary.700" }}
        _active={{ bg: "primary.800" }}
        leftIcon={<MegaphoneIcon boxSize={4} />}
        onClick={onOpen}
      >
        รายงานผลกระทบ
      </Button>

      {/* ── Submission modal ── */}
      <Modal isOpen={isOpen} onClose={resetAndClose} isCentered motionPreset="slideInBottom" size="md">
        <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.400" />
        <ModalContent borderRadius="2xl" boxShadow="xl" mx={4}>
          {isSubmitted ? (
            <ModalBody py={10} textAlign="center">
              <Flex
                w="56px"
                h="56px"
                mx="auto"
                mb={4}
                borderRadius="full"
                bg="green.50"
                align="center"
                justify="center"
              >
                <Icon viewBox="0 0 24 24" boxSize={7} fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </Icon>
              </Flex>
              <Text fontWeight="700" color="slate.800" fontSize="lg">
                ได้รับรายงานของคุณแล้ว
              </Text>
              <Text mt={2} fontSize="sm" color="slate.500" lineHeight="1.7">
                รายงานจะแสดงบนแผนที่หลังผ่านการตรวจสอบ
                <br />
                หากเป็นเหตุฉุกเฉิน โทรสายด่วนกรมโรงงานฯ <b>1564</b>
              </Text>
              <Button mt={6} w="full" variant="outline" borderRadius="xl" onClick={resetAndClose}>
                ปิด
              </Button>
            </ModalBody>
          ) : (
            <>
              <ModalHeader pb={1}>
                <Text fontSize="xs" color="slate.400" fontWeight="500" noOfLines={1}>
                  {factory.properties.ชื่อโรงงาน}
                </Text>
                <Flex align="center" justify="space-between" mt={1}>
                  <Text fontSize="lg" fontWeight="700" color="slate.800">
                    {stepTitles[step]}
                  </Text>
                  <HStack spacing={1}>
                    {[0, 1, 2].map((i) => (
                      <Box
                        key={i}
                        w="6px"
                        h="6px"
                        borderRadius="full"
                        bg={i <= step ? "primary.500" : "slate.200"}
                      />
                    ))}
                  </HStack>
                </Flex>
              </ModalHeader>

              <ModalBody pb={6}>
                {/* Honeypot — invisible to humans, bots fill it */}
                <Input
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  position="absolute"
                  left="-9999px"
                  aria-hidden="true"
                />

                {step === 0 && (
                  <>
                    <Flex wrap="wrap" gap={2} mt={2}>
                      {(Object.keys(IMPACT_TYPE_META) as ImpactType[]).map((t) => (
                        <Chip key={t} active={impactTypes.includes(t)} onClick={() => toggleImpact(t)}>
                          <Flex as="span" align="center" gap={1.5}>
                            <ImpactTypeIcon type={t} boxSize={3.5} />
                            <Text as="span">{IMPACT_TYPE_META[t].label}</Text>
                          </Flex>
                        </Chip>
                      ))}
                    </Flex>
                    <Text mt={3} fontSize="xs" color="slate.400">
                      เลือกได้มากกว่า 1 ข้อ
                    </Text>
                    <Button
                      mt={5}
                      w="full"
                      bg="primary.600"
                      color="white"
                      borderRadius="xl"
                      isDisabled={impactTypes.length === 0}
                      onClick={() => setStep(1)}
                      _hover={{ bg: "primary.700" }}
                    >
                      ถัดไป
                    </Button>
                  </>
                )}

                {step === 1 && (
                  <VStack align="stretch" spacing={4} mt={2}>
                    <Box>
                      <Text fontSize="sm" fontWeight="600" color="slate.700" mb={2}>
                        เกิดขึ้นบ่อยแค่ไหน?
                      </Text>
                      <Flex wrap="wrap" gap={2}>
                        {(Object.keys(FREQUENCY_META) as ReportFrequency[]).map((f) => (
                          <Chip key={f} active={frequency === f} onClick={() => setFrequency(frequency === f ? null : f)}>
                            {FREQUENCY_META[f]}
                          </Chip>
                        ))}
                      </Flex>
                    </Box>
                    <Box>
                      <Text fontSize="sm" fontWeight="600" color="slate.700" mb={2}>
                        บ้านคุณอยู่ห่างโรงงานประมาณเท่าไร?
                      </Text>
                      <Flex wrap="wrap" gap={2}>
                        {(Object.keys(DISTANCE_META) as DistanceBand[]).map((d) => (
                          <Chip key={d} active={distanceBand === d} onClick={() => setDistanceBand(distanceBand === d ? null : d)}>
                            {DISTANCE_META[d]}
                          </Chip>
                        ))}
                      </Flex>
                      <Text mt={2} fontSize="10px" color="slate.400">
                        เราเก็บเป็นช่วงระยะเท่านั้น ไม่เก็บพิกัดบ้านของคุณ
                      </Text>
                    </Box>
                    <Flex gap={2}>
                      <Button variant="ghost" color="slate.400" borderRadius="xl" onClick={() => setStep(0)}>
                        ย้อนกลับ
                      </Button>
                      <Button
                        flex="1"
                        bg="primary.600"
                        color="white"
                        borderRadius="xl"
                        onClick={() => setStep(2)}
                        _hover={{ bg: "primary.700" }}
                      >
                        ถัดไป
                      </Button>
                    </Flex>
                  </VStack>
                )}

                {step === 2 && (
                  <VStack align="stretch" spacing={3} mt={2}>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
                      placeholder="เล่าสิ่งที่เกิดขึ้น เช่น ช่วงเวลา ลักษณะกลิ่น/เสียง ผลที่เกิดกับครอบครัวคุณ..."
                      aria-label="รายละเอียดเหตุการณ์ที่เกิดขึ้น"
                      rows={4}
                      bg="slate.50"
                      border="none"
                      borderRadius="xl"
                      fontSize="sm"
                      _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.15)" }}
                    />
                    <Box>
                      <Text fontSize="xs" fontWeight="600" color="slate.600" mb={1}>
                        วันที่เกิดเหตุ (ถ้าจำได้)
                      </Text>
                      <Input
                        type="date"
                        aria-label="วันที่เกิดเหตุ"
                        value={incidentDate}
                        max={new Date().toISOString().slice(0, 10)}
                        onChange={(e) => setIncidentDate(e.target.value)}
                        size="sm"
                        bg="slate.50"
                        border="none"
                        borderRadius="xl"
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" fontWeight="600" color="slate.600" mb={1}>
                        เบอร์โทรหรือ LINE ID (ไม่บังคับ)
                      </Text>
                      <Input
                        value={contact}
                        aria-label="เบอร์โทรหรือ LINE ID"
                        onChange={(e) => setContact(e.target.value.slice(0, 200))}
                        placeholder="สำหรับติดตามผลเท่านั้น"
                        size="sm"
                        bg="slate.50"
                        border="none"
                        borderRadius="xl"
                      />
                      <Text mt={1} fontSize="10px" color="slate.500">
                        ข้อมูลติดต่อจะไม่ถูกเผยแพร่ ใช้เพื่อติดตามผลเท่านั้น
                      </Text>
                    </Box>

                    {user && (
                      <Box bg="slate.50" p={3} borderRadius="xl" border="1px solid" borderColor="slate.200">
                        <HStack spacing={1.5} mb={1.5}>
                          <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="primary.500">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                          </Icon>
                          <Text fontSize="xs" fontWeight="600" color="slate.700">
                            บันทึกช่วยจำส่วนตัว (ไม่แสดงบนแผนที่สาธารณะ):
                          </Text>
                        </HStack>
                        <Textarea
                          value={privateNote}
                          aria-label="บันทึกช่วยจำส่วนตัว"
                          onChange={(e) => setPrivateNote(e.target.value)}
                          placeholder="เช่น ทิศทางลม, สภาพอากาศ, ผลกระทบต่อเด็ก/ผู้สูงอายุในบ้าน..."
                          size="sm"
                          rows={2}
                          bg="white"
                          fontSize="xs"
                          borderRadius="lg"
                        />
                      </Box>
                    )}

                    {error && (
                      <Text fontSize="xs" color="red.500" fontWeight="600">
                        {error}
                      </Text>
                    )}

                    <Flex gap={2} pt={1}>
                      <Button variant="ghost" color="slate.400" borderRadius="xl" onClick={() => setStep(1)}>
                        ย้อนกลับ
                      </Button>
                      <Button
                        flex="1"
                        bg="primary.600"
                        color="white"
                        borderRadius="xl"
                        isLoading={isSubmitting}
                        loadingText="กำลังส่ง..."
                        onClick={handleSubmit}
                        _hover={{ bg: "primary.700" }}
                      >
                        ส่งรายงาน
                      </Button>
                    </Flex>
                    <Text fontSize="10px" color="slate.400" textAlign="center" lineHeight="1.5">
                      รายงานเป็นแบบไม่ระบุตัวตน และจะแสดงต่อสาธารณะหลังผ่านการตรวจสอบ
                    </Text>
                  </VStack>
                )}
              </ModalBody>
            </>
          )}
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default ReportSection;
