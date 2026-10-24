import React, { useState, useMemo } from "react";
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
  Input,
  InputGroup,
  InputLeftElement,
  HStack,
  Badge,
  Icon,
  SimpleGrid,
} from "@chakra-ui/react";
import { FACTORY_TYPE_NAMES } from "../utils/factoryTypes";
import { HAZARD_GROUPS } from "../utils/hazard";

interface IndustryTypeModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedTypes: string[];
  onChangeTypes: (types: string[]) => void;
}

const POPULAR_HAZARDS = [101, 105, 106, 42, 43, 45, 50, 60, 88];
const POPULAR_GENERALS = [9, 10, 14, 34, 52, 53];

export const IndustryTypeModal: React.FC<IndustryTypeModalProps> = ({
  isOpen,
  onClose,
  selectedTypes,
  onChangeTypes,
}) => {
  const [search, setSearch] = useState("");

  const toggleType = (codeStr: string) => {
    if (selectedTypes.includes(codeStr)) {
      onChangeTypes(selectedTypes.filter((t) => t !== codeStr));
    } else {
      onChangeTypes([...selectedTypes, codeStr]);
    }
  };

  const clearAll = () => {
    onChangeTypes([]);
  };

  const allTypes = useMemo(() => {
    return Object.entries(FACTORY_TYPE_NAMES).map(([code, name]) => ({
      code: parseInt(code, 10),
      codeStr: code,
      name,
      isHazard: Boolean(HAZARD_GROUPS[parseInt(code, 10)]),
    }));
  }, []);

  const filteredTypes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allTypes;
    return allTypes.filter(
      (item) =>
        item.codeStr.includes(q) ||
        item.name.toLowerCase().includes(q)
    );
  }, [allTypes, search]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg" isCentered motionPreset="slideInBottom">
      <ModalOverlay backdropFilter="blur(4px)" bg="blackAlpha.400" />
      <ModalContent borderRadius="2xl" maxH="85vh" overflow="hidden" m={4}>
        <ModalHeader borderBottom="1px solid" borderColor="slate.100" pb={3}>
          <Flex align="center" gap={2}>
            <Box
              w="32px"
              h="32px"
              borderRadius="lg"
              bg="primary.50"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4} color="primary.600">
                <path d="M2 20h20M4 20V10l5 3V10l5 3V7l5 3v10" />
              </Icon>
            </Box>
            <Box>
              <Text fontSize="md" fontWeight="bold" color="slate.800">
                เลือกประเภทโรงงานอุตสาหกรรม
              </Text>
              <Text fontSize="xs" color="slate.500" fontWeight="normal">
                จำแนกตามลำดับที่ 1–107 บัญชีท้ายกฎกระทรวง พ.ร.บ.โรงงาน
              </Text>
            </Box>
          </Flex>
        </ModalHeader>
        <ModalCloseButton />

        <ModalBody p={4} overflowY="auto">
          {/* Search bar */}
          <InputGroup size="md" mb={4}>
            <InputLeftElement pointerEvents="none" color="slate.400">
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={4}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </Icon>
            </InputLeftElement>
            <Input
              placeholder="ค้นหาชื่อกิจการ หรือ ลำดับที่ เช่น เคมี, ขยะ, 106..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              borderRadius="xl"
              bg="slate.50"
              border="none"
              _focus={{ bg: "white", boxShadow: "0 0 0 2px rgba(240, 82, 35, 0.2)" }}
            />
          </InputGroup>

          {/* Quick-pick sections when not searching */}
          {!search && (
            <Box mb={4}>
              <Flex align="center" gap={1.5} mb={2}>
                <Icon viewBox="0 0 24 24" fill="none" stroke="#B91C1C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5}>
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </Icon>
                <Text fontSize="xs" fontWeight="700" color="red.700">
                  กลุ่มอุตสาหกรรมเสี่ยงมลพิษยอดนิยม
                </Text>
              </Flex>
              <HStack spacing={1.5} wrap="wrap" mb={3}>
                {POPULAR_HAZARDS.map((code) => {
                  const codeStr = String(code);
                  const isSelected = selectedTypes.includes(codeStr);
                  const name = FACTORY_TYPE_NAMES[code];
                  return (
                    <Button
                      key={`hazard-${code}`}
                      size="xs"
                      borderRadius="full"
                      variant={isSelected ? "solid" : "outline"}
                      colorScheme={isSelected ? "red" : "gray"}
                      borderColor={isSelected ? undefined : "slate.200"}
                      color={isSelected ? "white" : "slate.700"}
                      onClick={() => toggleType(codeStr)}
                      fontWeight={isSelected ? "bold" : "medium"}
                    >
                      {code} · {name}
                    </Button>
                  );
                })}
              </HStack>

              <Flex align="center" gap={1.5} mb={2}>
                <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" boxSize={3.5} color="slate.600">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </Icon>
                <Text fontSize="xs" fontWeight="700" color="slate.600">
                  ประเภทอุตสาหกรรมทั่วไปยอดนิยม
                </Text>
              </Flex>
              <HStack spacing={1.5} wrap="wrap">
                {POPULAR_GENERALS.map((code) => {
                  const codeStr = String(code);
                  const isSelected = selectedTypes.includes(codeStr);
                  const name = FACTORY_TYPE_NAMES[code];
                  return (
                    <Button
                      key={`general-${code}`}
                      size="xs"
                      borderRadius="full"
                      variant={isSelected ? "solid" : "outline"}
                      colorScheme={isSelected ? "primary" : "gray"}
                      borderColor={isSelected ? undefined : "slate.200"}
                      color={isSelected ? "white" : "slate.700"}
                      onClick={() => toggleType(codeStr)}
                      fontWeight={isSelected ? "bold" : "medium"}
                    >
                      {code} · {name}
                    </Button>
                  );
                })}
              </HStack>
            </Box>
          )}

          {/* Full matching list */}
          <Text fontSize="xs" fontWeight="700" color="slate.700" mb={2}>
            {search ? `ผลการค้นหา (${filteredTypes.length})` : "รายการทั้งหมด (107 ประเภท)"}
          </Text>

          <SimpleGrid columns={{ base: 1, sm: 2 }} spacing={2}>
            {filteredTypes.map((item) => {
              const isSelected = selectedTypes.includes(item.codeStr);
              return (
                <Box
                  key={item.codeStr}
                  as="button"
                  onClick={() => toggleType(item.codeStr)}
                  textAlign="left"
                  p={2.5}
                  borderRadius="lg"
                  border="1px solid"
                  borderColor={isSelected ? "primary.400" : "slate.200"}
                  bg={isSelected ? "primary.50" : "white"}
                  _hover={{ borderColor: isSelected ? "primary.500" : "slate.300", bg: isSelected ? "primary.50" : "slate.50" }}
                  transition="all 0.15s ease"
                  display="flex"
                  alignItems="center"
                  justifyContent="space-between"
                >
                  <Box minW={0} flex="1" mr={2}>
                    <HStack spacing={1.5}>
                      <Badge
                        fontSize="2xs"
                        borderRadius="full"
                        px={1.5}
                        bg={item.isHazard ? "red.100" : "slate.100"}
                        color={item.isHazard ? "red.800" : "slate.700"}
                      >
                        {item.code}
                      </Badge>
                      <Text fontSize="xs" fontWeight={isSelected ? "700" : "500"} color={isSelected ? "primary.800" : "slate.800"} noOfLines={1}>
                        {item.name}
                      </Text>
                    </HStack>
                  </Box>
                  <Box
                    w="16px"
                    h="16px"
                    borderRadius="md"
                    border="1.5px solid"
                    borderColor={isSelected ? "primary.500" : "slate.300"}
                    bg={isSelected ? "primary.500" : "transparent"}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    flexShrink={0}
                  >
                    {isSelected && (
                      <Icon viewBox="0 0 20 20" fill="currentColor" boxSize={3} color="white">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </Icon>
                    )}
                  </Box>
                </Box>
              );
            })}
          </SimpleGrid>
        </ModalBody>

        <ModalFooter borderTop="1px solid" borderColor="slate.100" py={3} px={4} display="flex" justifyContent="space-between">
          <Button
            size="sm"
            variant="ghost"
            color="slate.500"
            onClick={clearAll}
            isDisabled={selectedTypes.length === 0}
          >
            ล้างตัวเลือก ({selectedTypes.length})
          </Button>
          <Button
            size="sm"
            bg="primary.600"
            color="white"
            _hover={{ bg: "primary.700" }}
            onClick={onClose}
          >
            เสร็จสิ้น {selectedTypes.length > 0 ? `(${selectedTypes.length} ประเภท)` : ""}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
