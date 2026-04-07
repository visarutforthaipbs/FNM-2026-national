

import {
    Box,
    Flex,
    HStack,
    Link,
    IconButton,
    useDisclosure,
    Stack,
    Text,
    Icon,
} from '@chakra-ui/react';
import { CloseIcon, HamburgerIcon } from '@chakra-ui/icons';
import { Link as RouterLink, useLocation } from 'react-router-dom';

// SIGNAL 39: Layer 1 — Subconscious Hook
// The navbar must convey "where I am" without reading. Active state = visual weight only.
const Navbar = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
    const location = useLocation();

    // Rule of Three: max 3 primary navigation chunks
    const Links = [
        { name: 'แผนที่', path: '/' },
        { name: 'ภาพรวม', path: '/dashboard' },
        { name: 'แจ้งเบาะแส', path: '#' },
    ];

    return (
        <Box
            bg="white"
            color="slate.800"
            borderBottom="1px solid"
            borderColor="slate.100"
            zIndex="sticky"
            position="sticky"
            top={0}
        >
            <Flex h={14} alignItems="center" justifyContent="space-between" px={6}>
                <IconButton
                    size="sm"
                    icon={isOpen ? <CloseIcon boxSize={3} /> : <HamburgerIcon />}
                    aria-label="Open Menu"
                    display={{ md: 'none' }}
                    onClick={isOpen ? onClose : onOpen}
                    variant="ghost"
                    color="slate.500"
                />

                <HStack spacing={10} alignItems="center">
                    {/* Logo — Zero decorative pixels, semantic icon only */}
                    <Flex alignItems="center" gap={2.5}>
                        <Box
                            w="28px"
                            h="28px"
                            bg="primary.500"
                            borderRadius="lg"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            color="white"
                            flexShrink={0}
                        >
                            <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" boxSize={4}>
                                <rect x="4" y="2" width="16" height="20" rx="2" />
                                <path d="M9 22v-4h6v4" />
                                <path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01" />
                            </Icon>
                        </Box>
                        <Text
                            fontSize="md"
                            fontWeight="700"
                            letterSpacing="tight"
                            color="slate.800"
                            lineHeight="1"
                        >
                            Factory Near Me
                        </Text>
                    </Flex>

                    {/* Navigation — Chunked, max 3 items, generous spacing */}
                    <HStack
                        as="nav"
                        spacing={1}
                        display={{ base: 'none', md: 'flex' }}
                    >
                        {Links.map((link) => {
                            const isActive = location.pathname === link.path;
                            return (
                                <Link
                                    as={RouterLink}
                                    to={link.path}
                                    key={link.name}
                                    px={3}
                                    py={1.5}
                                    rounded="lg"
                                    fontSize="sm"
                                    fontWeight={isActive ? "600" : "400"}
                                    color={isActive ? "primary.600" : "slate.500"}
                                    bg={isActive ? "primary.50" : "transparent"}
                                    _hover={{
                                        textDecoration: 'none',
                                        color: 'primary.600',
                                        bg: 'slate.50',
                                    }}
                                >
                                    {link.name}
                                </Link>
                            );
                        })}
                    </HStack>
                </HStack>

                {/* Right side — intentionally empty for cognitive breathing room */}
                <Box w={{ base: "32px", md: "0" }} />
            </Flex>

            {/* Mobile menu — same chunked structure */}
            {isOpen ? (
                <Box pb={4} px={6} display={{ md: 'none' }}>
                    <Stack as="nav" spacing={1}>
                        {Links.map((link) => {
                            const isActive = location.pathname === link.path;
                            return (
                                <Link
                                    as={RouterLink}
                                    to={link.path}
                                    key={link.name}
                                    px={3}
                                    py={2}
                                    rounded="lg"
                                    fontSize="sm"
                                    fontWeight={isActive ? "600" : "400"}
                                    color={isActive ? "primary.600" : "slate.600"}
                                    bg={isActive ? "primary.50" : "transparent"}
                                    _hover={{
                                        textDecoration: 'none',
                                        bg: 'slate.50',
                                    }}
                                >
                                    {link.name}
                                </Link>
                            );
                        })}
                    </Stack>
                </Box>
            ) : null}
        </Box>
    );
}

export default Navbar;
