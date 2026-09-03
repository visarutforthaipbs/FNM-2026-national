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
    Button,
    Avatar,
    Menu,
    MenuButton,
    MenuList,
    MenuItem,
    MenuDivider,
    Badge,
    Icon,
} from '@chakra-ui/react';
import { CloseIcon, HamburgerIcon } from '@chakra-ui/icons';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import { useWatchlist } from '../hooks/useWatchlist';
import { AuthModal } from './AuthModal';

// SIGNAL 39: Layer 1 — Subconscious Hook
// The navbar must convey "where I am" without reading. Active state = visual weight only.
const Navbar = () => {
    const { isOpen, onOpen, onClose } = useDisclosure();
    const location = useLocation();
    const { user, profile, openAuthModal, signOut } = useAuth();
    const { totalWatchedCount } = useWatchlist();

    const Links = [
        { name: 'แผนที่', path: '/' },
        { name: 'ภาพรวม', path: '/dashboard' },
        { name: 'สมุดบันทึกผลกระทบ', path: '/diary' },
    ];

    return (
        <>
            <Box
                bg="white"
                color="slate.800"
                borderBottom="1px solid"
                borderColor="slate.100"
                zIndex="sticky"
                position="sticky"
                top={0}
            >
                <Flex h={14} alignItems="center" justifyContent="space-between" px={{ base: 3, md: 6 }}>
                    <HStack spacing={3}>
                        <IconButton
                            size="sm"
                            icon={isOpen ? <CloseIcon boxSize={3} /> : <HamburgerIcon />}
                            aria-label={isOpen ? "ปิดเมนู" : "เปิดเมนู"}
                            display={{ md: 'none' }}
                            onClick={isOpen ? onClose : onOpen}
                            variant="ghost"
                            color="slate.500"
                            minW="44px"
                            minH="44px"
                        />

                        {/* Product signature */}
                        <RouterLink to="/" style={{ textDecoration: 'none' }}>
                            <Flex alignItems="center" gap={3}>
                                <Image
                                    src="/assets/thai-pbs-logo.svg"
                                    alt="ไทยพีบีเอส"
                                    h="32px"
                                    w="auto"
                                    flexShrink={0}
                                    display={{ base: 'none', sm: 'block' }}
                                />
                                <Box h="20px" w="1px" bg="slate.200" flexShrink={0} display={{ base: 'none', sm: 'block' }} />
                                <Image
                                    src="/assets/project-favicon.svg"
                                    alt="โรงงานใกล้ฉัน"
                                    h="34px"
                                    w="auto"
                                    flexShrink={0}
                                    display={{ base: 'block', sm: 'none' }}
                                />
                                <Image
                                    src="/assets/project-logo.svg"
                                    alt="โรงงานใกล้ฉัน"
                                    h="32px"
                                    w="auto"
                                    flexShrink={0}
                                    display={{ base: 'none', sm: 'block' }}
                                />
                            </Flex>
                        </RouterLink>
                    </HStack>

                    {/* Navigation — Chunked, generous spacing */}
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
                                    position="relative"
                                >
                                    {link.name}
                                    {link.path === '/diary' && totalWatchedCount > 0 && (
                                        <Badge
                                            ml={1.5}
                                            colorScheme="orange"
                                            variant="solid"
                                            fontSize="10px"
                                            borderRadius="full"
                                            px={1.5}
                                        >
                                            {totalWatchedCount}
                                        </Badge>
                                    )}
                                </Link>
                            );
                        })}
                    </HStack>

                    {/* Right side — User Auth & Profile */}
                    <HStack spacing={2}>
                        {user ? (
                            <Menu placement="bottom-end">
                                <MenuButton
                                    as={Button}
                                    variant="ghost"
                                    p={1}
                                    borderRadius="full"
                                    _hover={{ bg: 'slate.100' }}
                                    _active={{ bg: 'slate.200' }}
                                >
                                    <HStack spacing={2}>
                                        <Avatar
                                            size="sm"
                                            name={profile?.full_name || user.email || 'Citizen'}
                                            src={profile?.avatar_url || (user.user_metadata?.avatar_url as string)}
                                            bg="primary.500"
                                            color="white"
                                        />
                                        <Text
                                            fontSize="xs"
                                            fontWeight="600"
                                            color="slate.700"
                                            display={{ base: 'none', lg: 'block' }}
                                            maxW="120px"
                                            isTruncated
                                        >
                                            {profile?.full_name || user.email?.split('@')[0]}
                                        </Text>
                                    </HStack>
                                </MenuButton>
                                <MenuList
                                    boxShadow="xl"
                                    borderColor="slate.100"
                                    borderRadius="xl"
                                    py={2}
                                    zIndex={2000}
                                >
                                    <Box px={4} py={2}>
                                        <Text fontSize="xs" fontWeight="700" color="slate.800">
                                            {profile?.full_name || 'ประชาชนผู้ใช้งาน'}
                                        </Text>
                                        <Text fontSize="11px" color="slate.400" isTruncated>
                                            {user.email}
                                        </Text>
                                    </Box>
                                    <MenuDivider />
                                    <MenuItem
                                        as={RouterLink}
                                        to="/diary"
                                        fontSize="sm"
                                        icon={
                                            <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                                                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                                                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                                            </Icon>
                                        }
                                    >
                                        สมุดบันทึกผลกระทบ
                                    </MenuItem>
                                    <MenuItem
                                        as={RouterLink}
                                        to="/diary?tab=watchlist"
                                        fontSize="sm"
                                        icon={
                                            <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                            </Icon>
                                        }
                                    >
                                        โรงงานที่ติดตาม ({totalWatchedCount})
                                    </MenuItem>
                                    <MenuDivider />
                                    <MenuItem
                                        fontSize="sm"
                                        color="red.600"
                                        onClick={() => signOut()}
                                        icon={
                                            <Icon viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" boxSize={3.5}>
                                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                                <polyline points="16 17 21 12 16 7" />
                                                <line x1="21" y1="12" x2="9" y2="12" />
                                            </Icon>
                                        }
                                    >
                                        ออกจากระบบ
                                    </MenuItem>
                                </MenuList>
                            </Menu>
                        ) : (
                            <Button
                                size="sm"
                                variant="solid"
                                bg="primary.500"
                                color="white"
                                _hover={{ bg: "primary.600" }}
                                _active={{ bg: "primary.700" }}
                                borderRadius="lg"
                                fontSize="xs"
                                fontWeight="600"
                                px={{ base: 3, md: 4 }}
                                onClick={openAuthModal}
                            >
                                เข้าสู่ระบบ (Gmail)
                            </Button>
                        )}
                    </HStack>
                </Flex>

                {/* Mobile menu */}
                {isOpen ? (
                    <Box pb={4} px={4} display={{ md: 'none' }} borderTop="1px solid" borderColor="slate.100" bg="white">
                        <Stack as="nav" spacing={1} pt={2}>
                            {Links.map((link) => {
                                const isActive = location.pathname === link.path;
                                return (
                                    <Link
                                        as={RouterLink}
                                        to={link.path}
                                        key={link.name}
                                        px={3}
                                        py={2}
                                        minH="44px"
                                        display="flex"
                                        alignItems="center"
                                        justifyContent="space-between"
                                        rounded="lg"
                                        fontSize="sm"
                                        fontWeight={isActive ? "600" : "400"}
                                        color={isActive ? "primary.600" : "slate.600"}
                                        bg={isActive ? "primary.50" : "transparent"}
                                        onClick={onClose}
                                        _hover={{
                                            textDecoration: 'none',
                                            bg: 'slate.50',
                                        }}
                                    >
                                        <Text>{link.name}</Text>
                                        {link.path === '/diary' && totalWatchedCount > 0 && (
                                            <Badge colorScheme="orange" variant="solid" fontSize="10px" borderRadius="full">
                                                {totalWatchedCount}
                                            </Badge>
                                        )}
                                    </Link>
                                );
                            })}
                        </Stack>
                    </Box>
                ) : null}
            </Box>

            {/* Google Authentication Modal */}
            <AuthModal />
        </>
    );
};

export default Navbar;
