import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Link,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import Navbar from "../components/Navbar";
import type { ImpactType } from "../types/report";
import { IMPACT_TYPE_META, FREQUENCY_META, DISTANCE_META } from "../types/report";
import type { DistanceBand, ReportFrequency } from "../types/report";

// Same-origin in production (Vercel routes /api/* to the Express function);
// override with VITE_API_BASE for local dev against `npm run dev` in server/.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

interface AdminReport {
  id: string;
  factory_id: string;
  factory_name: string | null;
  province: string | null;
  impact_types: ImpactType[];
  frequency: ReportFrequency | null;
  distance_band: DistanceBand | null;
  description: string | null;
  incident_date: string | null;
  reporter_contact: string | null;
  created_at: string;
}

interface AdminCorrection {
  id: string;
  factory_id: string;
  factory_name: string | null;
  current_name: string | null;
  province: string | null;
  district: string | null;
  lat: number;
  lng: number;
  current_lat: number | null;
  current_lng: number | null;
  current_coord_source: string | null;
  note: string | null;
  created_at: string;
}

type Tab = "reports" | "corrections";

const TOKEN_KEY = "factory-nearme-admin-token";

const AdminPage = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState<Tab>("reports");
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [corrections, setCorrections] = useState<AdminCorrection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-item rejection reason drafts
  const [rejectDrafts, setRejectDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const authFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
        throw new Error("Token ไม่ถูกต้อง");
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    [token]
  );

  const loadQueues = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        authFetch("/api/admin/reports?status=pending"),
        authFetch("/api/admin/corrections?status=pending"),
      ]);
      setReports(r);
      setCorrections(c);
    } catch (err) {
      setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setIsLoading(false);
    }
  }, [authFetch]);

  useEffect(() => {
    if (token) loadQueues();
  }, [token, loadQueues]);

  const moderate = async (
    kind: Tab,
    id: string,
    action: "approve" | "reject"
  ) => {
    setBusyId(id);
    setError(null);
    try {
      await authFetch(`/api/admin/${kind}/${id}`, {
        method: "POST",
        body: JSON.stringify({
          action,
          reject_reason: action === "reject" ? rejectDrafts[id] || null : null,
        }),
      });
      if (kind === "reports") setReports((prev) => prev.filter((r) => r.id !== id));
      else setCorrections((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "ดำเนินการไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  };

  // ── Token gate ──
  if (!token) {
    return (
      <Box minH="100vh" bg="slate.50">
        <Navbar />
        <Flex align="center" justify="center" pt={24} px={4}>
          <VStack
            bg="white"
            p={8}
            borderRadius="2xl"
            boxShadow="lg"
            spacing={4}
            w="full"
            maxW="360px"
          >
            <Text fontWeight="700" color="slate.800">
              ผู้ดูแลระบบ
            </Text>
            <Input
              type="password"
              placeholder="Admin token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tokenInput.trim()) {
                  sessionStorage.setItem(TOKEN_KEY, tokenInput.trim());
                  setToken(tokenInput.trim());
                }
              }}
            />
            <Button
              w="full"
              bg="primary.600"
              color="white"
              _hover={{ bg: "primary.700" }}
              isDisabled={!tokenInput.trim()}
              onClick={() => {
                sessionStorage.setItem(TOKEN_KEY, tokenInput.trim());
                setToken(tokenInput.trim());
              }}
            >
              เข้าสู่ระบบ
            </Button>
          </VStack>
        </Flex>
      </Box>
    );
  }

  return (
    <Box minH="100vh" bg="slate.50">
      <Navbar />
      <Box maxW="880px" mx="auto" px={{ base: 4, md: 6 }} py={8}>
        <Flex align="center" justify="space-between" mb={6} wrap="wrap" gap={3}>
          <Text fontSize="xl" fontWeight="800" color="slate.800">
            คิวตรวจสอบ
          </Text>
          <HStack>
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "reports" ? "primary.600" : "white"}
              color={tab === "reports" ? "white" : "slate.600"}
              _hover={{ bg: tab === "reports" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("reports")}
            >
              รายงานผลกระทบ ({reports.length})
            </Button>
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "corrections" ? "primary.600" : "white"}
              color={tab === "corrections" ? "white" : "slate.600"}
              _hover={{ bg: tab === "corrections" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("corrections")}
            >
              แก้ไขตำแหน่ง ({corrections.length})
            </Button>
            <Button size="sm" variant="ghost" color="slate.400" onClick={loadQueues}>
              รีเฟรช
            </Button>
          </HStack>
        </Flex>

        {error && (
          <Text mb={4} fontSize="sm" color="red.500" fontWeight="600">
            {error}
          </Text>
        )}
        {isLoading && <Spinner color="primary.500" />}

        {/* ── Impact reports queue ── */}
        {tab === "reports" && (
          <VStack align="stretch" spacing={4}>
            {!isLoading && reports.length === 0 && (
              <Text color="slate.400" fontSize="sm">
                ไม่มีรายงานรอตรวจสอบ
              </Text>
            )}
            {reports.map((r) => (
              <Box key={r.id} bg="white" borderRadius="2xl" p={5} boxShadow="sm">
                <Flex justify="space-between" gap={3} wrap="wrap">
                  <Box>
                    <Text fontWeight="700" color="slate.800" fontSize="sm">
                      {r.factory_name || r.factory_id}
                    </Text>
                    <Text fontSize="xs" color="slate.400">
                      {r.province || "?"} · ทะเบียน {r.factory_id} ·{" "}
                      {new Date(r.created_at).toLocaleString("th-TH")}
                    </Text>
                  </Box>
                  <HStack spacing={1.5} flexWrap="wrap">
                    {r.impact_types.map((t) => (
                      <Badge key={t} bg="primary.50" color="primary.700" borderRadius="full" px={2}>
                        {IMPACT_TYPE_META[t]?.label ?? t}
                      </Badge>
                    ))}
                  </HStack>
                </Flex>

                <HStack mt={2} spacing={3} fontSize="xs" color="slate.500">
                  {r.frequency && <Text>ความถี่: {FREQUENCY_META[r.frequency]}</Text>}
                  {r.distance_band && <Text>ระยะ: {DISTANCE_META[r.distance_band]}</Text>}
                  {r.incident_date && <Text>วันที่เกิดเหตุ: {r.incident_date}</Text>}
                </HStack>

                {r.description && (
                  <Text mt={3} fontSize="sm" color="slate.700" whiteSpace="pre-wrap">
                    {r.description}
                  </Text>
                )}
                {r.reporter_contact && (
                  <Text mt={2} fontSize="xs" color="orange.600">
                    ติดต่อ (ไม่เผยแพร่): {r.reporter_contact}
                  </Text>
                )}

                <Flex mt={4} gap={2} align="center" wrap="wrap">
                  <Button
                    size="sm"
                    colorScheme="green"
                    isLoading={busyId === r.id}
                    onClick={() => moderate("reports", r.id, "approve")}
                  >
                    อนุมัติ
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    colorScheme="red"
                    isLoading={busyId === r.id}
                    onClick={() => moderate("reports", r.id, "reject")}
                  >
                    ปฏิเสธ
                  </Button>
                  <Textarea
                    placeholder="เหตุผลที่ปฏิเสธ (ไม่บังคับ)"
                    size="sm"
                    rows={1}
                    flex="1"
                    minW="200px"
                    borderRadius="lg"
                    value={rejectDrafts[r.id] ?? ""}
                    onChange={(e) =>
                      setRejectDrafts((prev) => ({ ...prev, [r.id]: e.target.value }))
                    }
                  />
                </Flex>
              </Box>
            ))}
          </VStack>
        )}

        {/* ── Location corrections queue ── */}
        {tab === "corrections" && (
          <VStack align="stretch" spacing={4}>
            {!isLoading && corrections.length === 0 && (
              <Text color="slate.400" fontSize="sm">
                ไม่มีการแก้ไขตำแหน่งรอตรวจสอบ
              </Text>
            )}
            {corrections.map((c) => (
              <Box key={c.id} bg="white" borderRadius="2xl" p={5} boxShadow="sm">
                <Text fontWeight="700" color="slate.800" fontSize="sm">
                  {c.current_name || c.factory_name || c.factory_id}
                </Text>
                <Text fontSize="xs" color="slate.400">
                  {[c.district, c.province].filter(Boolean).join(" · ") || "?"} · ทะเบียน{" "}
                  {c.factory_id} · {new Date(c.created_at).toLocaleString("th-TH")}
                </Text>

                <Flex mt={3} gap={6} fontSize="xs" wrap="wrap">
                  <Box>
                    <Text color="slate.400">ตำแหน่งปัจจุบัน ({c.current_coord_source ?? "ไม่มีพิกัด"})</Text>
                    {c.current_lat != null && c.current_lng != null ? (
                      <Link
                        href={`https://www.google.com/maps?q=${c.current_lat},${c.current_lng}`}
                        isExternal
                        color="slate.600"
                        fontFamily="'Inter', monospace"
                      >
                        {c.current_lat.toFixed(5)}, {c.current_lng.toFixed(5)} ↗
                      </Link>
                    ) : (
                      <Text color="slate.300">—</Text>
                    )}
                  </Box>
                  <Box>
                    <Text color="slate.400">ตำแหน่งที่เสนอ</Text>
                    <Link
                      href={`https://www.google.com/maps?q=${c.lat},${c.lng}`}
                      isExternal
                      color="primary.600"
                      fontWeight="600"
                      fontFamily="'Inter', monospace"
                    >
                      {c.lat.toFixed(5)}, {c.lng.toFixed(5)} ↗
                    </Link>
                  </Box>
                </Flex>

                {c.note && (
                  <Text mt={3} fontSize="sm" color="slate.700">
                    “{c.note}”
                  </Text>
                )}

                <Flex mt={4} gap={2} align="center" wrap="wrap">
                  <Button
                    size="sm"
                    colorScheme="green"
                    isLoading={busyId === c.id}
                    onClick={() => moderate("corrections", c.id, "approve")}
                  >
                    อนุมัติ (ใช้ตำแหน่งนี้)
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    colorScheme="red"
                    isLoading={busyId === c.id}
                    onClick={() => moderate("corrections", c.id, "reject")}
                  >
                    ปฏิเสธ
                  </Button>
                  <Textarea
                    placeholder="เหตุผลที่ปฏิเสธ (ไม่บังคับ)"
                    size="sm"
                    rows={1}
                    flex="1"
                    minW="200px"
                    borderRadius="lg"
                    value={rejectDrafts[c.id] ?? ""}
                    onChange={(e) =>
                      setRejectDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))
                    }
                  />
                </Flex>
              </Box>
            ))}
          </VStack>
        )}
      </Box>
    </Box>
  );
};

export default AdminPage;
