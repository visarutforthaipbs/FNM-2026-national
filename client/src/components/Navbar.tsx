

import {
    Box,
    Flex,
    HStack,
    Link,
    IconButton,
    useDisclosure,
    Stack,
    Text,
    Image,
    VStack,
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
                    {/* Product signature — compact enough to remain legible on a map */}
                    <Flex alignItems="center" gap={3}>
                        <Image
                            src="/thai-pbs-logo.svg"
                            alt="Thai PBS Logo"
                            h="32px"
                            w="auto"
                            fallbackSrc="https://upload.wikimedia.org/wikipedia/commons/d/d3/Thai_PBS_Logo_2016.svg"
                            flexShrink={0}
                        />
                        <Box h="20px" w="1px" bg="slate.200" flexShrink={0} />
                        <Image
                            src="/assets/brand/brand-symbol.svg"
                            alt=""
                            aria-hidden="true"
                            boxSize="34px"
                            flexShrink={0}
                        />
                        <VStack align="start" spacing={0} flexShrink={0}>
                            <Text
                                fontSize="sm"
                                fontWeight="800"
                                letterSpacing="tight"
                                color="slate.800"
                                lineHeight="1.1"
                            >
                                โรงงานใกล้ฉัน
                            </Text>
                            <Text
                                fontSize="8px"
                                fontWeight="700"
                                color="slate.500"
                                letterSpacing="1.1px"
                                lineHeight="1.1"
                                mt="3px"
                            >
                                FACTORY NEAR ME
                            </Text>
                        </VStack>
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
