import React, { useState } from "react";
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalCloseButton,
  Button,
  VStack,
  Text,
  Box,
  HStack,
  Icon,
  Alert,
  AlertIcon,
} from "@chakra-ui/react";
import { useAuth } from "../context/useAuth";

import type { IconProps } from "@chakra-ui/react";

// Google Icon SVG
const GoogleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      fill="#EA4335"
    />
  </svg>
);

const ShieldIcon = (props: IconProps) => (
  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Icon>
);

export const AuthModal: React.FC = () => {
  const { isAuthModalOpen, closeAuthModal, signInWithGoogle } = useAuth();
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    const { error } = await signInWithGoogle();
    if (error) {
      setErrorMsg(error.message || "เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      setIsLoading(false);
    }
  };

  return (
    <Modal isOpen={isAuthModalOpen} onClose={closeAuthModal} isCentered size="md">
      <ModalOverlay bg="blackAlpha.600" backdropFilter="blur(4px)" />
      <ModalContent borderRadius="2xl" p={2} bg="white" boxShadow="2xl">
        <ModalHeader pb={1}>
          <HStack spacing={2} align="center">
            <Box p={2} bg="primary.50" color="primary.500" borderRadius="lg">
              <ShieldIcon boxSize={5} />
            </Box>
            <Box>
              <Text fontSize="lg" fontWeight="700" color="slate.800">
                เข้าสู่ระบบภาคประชาชน
              </Text>
              <Text fontSize="xs" fontWeight="400" color="slate.500">
                ติดตามโรงงาน บันทึกผลกระทบ และออกเอกสารยื่นราชการ
              </Text>
            </Box>
          </HStack>
        </ModalHeader>
        <ModalCloseButton />

        <ModalBody py={4}>
          <VStack spacing={4} align="stretch">
            {errorMsg && (
              <Alert status="error" borderRadius="xl" fontSize="xs">
                <AlertIcon />
                {errorMsg}
              </Alert>
            )}

            {/* Feature Benefits list */}
            <Box bg="slate.50" p={4} borderRadius="xl" border="1px solid" borderColor="slate.200">
              <Text fontSize="xs" fontWeight="700" color="slate.700" mb={2}>
                สิทธิประโยชน์เมื่อเข้าสู่ระบบด้วย Gmail:
              </Text>
              <VStack spacing={2.5} align="start" fontSize="xs" color="slate.600">
                <HStack align="start" spacing={2}>
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="primary.500" mt={0.5} flexShrink={0}>
                    <polyline points="20 6 9 17 4 12" />
                  </Icon>
                  <Text><strong>ระบบติดตามโรงงาน (Watchlist):</strong> บันทึกโรงงานหรือประเภทอุตสาหกรรมที่สนใจ</Text>
                </HStack>
                <HStack align="start" spacing={2}>
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="primary.500" mt={0.5} flexShrink={0}>
                    <polyline points="20 6 9 17 4 12" />
                  </Icon>
                  <Text><strong>สมุดบันทึกผลกระทบส่วนตัว (Impact Diary):</strong> เก็บประวัติเหตุการณ์ วัน เวลา กลิ่น/ควัน/เสียง</Text>
                </HStack>
                <HStack align="start" spacing={2}>
                  <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="primary.500" mt={0.5} flexShrink={0}>
                    <polyline points="20 6 9 17 4 12" />
                  </Icon>
                  <Text><strong>ออกเอกสารร้องเรียน (Official Dossier):</strong> รวบรวมหลักฐานพิมพ์ยื่น กรมโรงงานฯ/ศูนย์ดำรงธรรม/อบต.</Text>
                </HStack>
              </VStack>
            </Box>

            {/* Google Sign-in Button */}
            <Button
              size="lg"
              w="full"
              variant="outline"
              borderColor="slate.300"
              leftIcon={<GoogleIcon />}
              onClick={handleGoogleLogin}
              isLoading={isLoading}
              loadingText="กำลังเชื่อมต่อ Google..."
              borderRadius="xl"
              fontWeight="600"
              fontSize="sm"
              color="slate.800"
              _hover={{ bg: "slate.100", borderColor: "slate.400" }}
              _active={{ bg: "slate.200" }}
              py={6}
            >
              ดำเนินการต่อด้วย Google (Gmail)
            </Button>

            {/* Privacy Promise */}
            <HStack spacing={1.5} justify="center" align="start" px={2}>
              <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5} color="slate.400" mt={0.5} flexShrink={0}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </Icon>
              <Text fontSize="11px" color="slate.500" lineHeight="short">
                <strong>ความปลอดภัยและความเป็นส่วนตัว:</strong> ข้อมูลส่วนบุคคลจะไม่ถูกแสดงบนแผนที่สาธารณะ ใช้เฉพาะการจัดการประวัติและการออกเอกสารของคุณเท่านั้น
              </Text>
            </HStack>
          </VStack>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
};
