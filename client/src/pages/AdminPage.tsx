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
import AdminSetPositionModal from "../components/AdminSetPositionModal";
import AdminDbdMatchQueue from "../components/AdminDbdMatchQueue";
import AdminApproximateQueue from "../components/AdminApproximateQueue";
import AdminProvinceMismatchQueue from "../components/AdminProvinceMismatchQueue";
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

interface UnmappedFactory {
  id: string;
  name: string | null;
  address_full: string | null;
  province: string | null;
  district: string | null;
  sub_district: string | null;
  factory_type: string | null;
  capital_investment: number | null;
}

type Tab = "reports" | "corrections" | "unmapped" | "approx" | "mismatch" | "dbd";

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

  // Unmapped-factories queue
  const [unmapped, setUnmapped] = useState<UnmappedFactory[]>([]);
  const [unmappedTotal, setUnmappedTotal] = useState(0);
  const [unmappedOffset, setUnmappedOffset] = useState(0);
  const [unmappedSearch, setUnmappedSearch] = useState("");
  const [unmappedLoading, setUnmappedLoading] = useState(false);
  const [positionTarget, setPositionTarget] = useState<UnmappedFactory | null>(null);
  const UNMAPPED_PAGE_SIZE = 30;

  // DBD ownership links awaiting a human decision. The queue owns its own
  // loading; this is only the count shown on the tab.
  const [dbdPending, setDbdPending] = useState<number | null>(null);

  // Factories already on the map, but at a derived position rather than a real
  // one. Distinct from `unmapped`, which is only those with no position at all.
  const [approxTotal, setApproxTotal] = useState<number | null>(null);
  const [mismatchTotal, setMismatchTotal] = useState<number | null>(null);

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

  const loadUnmapped = useCallback(
    async (offset: number, search: string) => {
      setUnmappedLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: String(UNMAPPED_PAGE_SIZE),
          offset: String(offset),
        });
        if (search.trim()) params.set("search", search.trim());
        const data = await authFetch(`/api/admin/unmapped-factories?${params}`);
        const { rows, total } = data as { rows: UnmappedFactory[]; total: number };
        setUnmapped(rows);
        setUnmappedTotal(total);
        setUnmappedOffset(offset);
      } catch (err) {
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setUnmappedLoading(false);
      }
    },
    [authFetch]
  );

  useEffect(() => {
    if (token && tab === "unmapped" && unmapped.length === 0 && !unmappedLoading) {
      loadUnmapped(0, "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tab]);

  const moderate = async (
    kind: "reports" | "corrections",
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
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "unmapped" ? "primary.600" : "white"}
              color={tab === "unmapped" ? "white" : "slate.600"}
              _hover={{ bg: tab === "unmapped" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("unmapped")}
            >
              ยังไม่มีพิกัด ({unmappedTotal.toLocaleString()})
            </Button>
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "approx" ? "primary.600" : "white"}
              color={tab === "approx" ? "white" : "slate.600"}
              _hover={{ bg: tab === "approx" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("approx")}
            >
              ตำแหน่งโดยประมาณ{approxTotal === null ? "" : ` (${approxTotal.toLocaleString()})`}
            </Button>
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "mismatch" ? "primary.600" : "white"}
              color={tab === "mismatch" ? "white" : "slate.600"}
              _hover={{ bg: tab === "mismatch" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("mismatch")}
            >
              พิกัดผิดจังหวัด{mismatchTotal === null ? "" : ` (${mismatchTotal.toLocaleString()})`}
            </Button>
            <Button
              size="sm"
              borderRadius="full"
              bg={tab === "dbd" ? "primary.600" : "white"}
              color={tab === "dbd" ? "white" : "slate.600"}
              _hover={{ bg: tab === "dbd" ? "primary.700" : "slate.100" }}
              onClick={() => setTab("dbd")}
            >
              เจ้าของ (DBD){dbdPending === null ? "" : ` (${dbdPending.toLocaleString()})`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              color="slate.400"
              isDisabled={tab === "dbd" || tab === "approx" || tab === "mismatch"}
              onClick={() => (tab === "unmapped" ? loadUnmapped(unmappedOffset, unmappedSearch) : loadQueues())}
            >
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

        {/* ── Unmapped factories queue ── */}
        {tab === "unmapped" && (
          <Box>
            <Flex gap={2} mb={4}>
              <Input
                placeholder="ค้นหาชื่อ / เลขทะเบียน / ที่อยู่..."
                size="sm"
                bg="white"
                borderRadius="lg"
                value={unmappedSearch}
                onChange={(e) => setUnmappedSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") loadUnmapped(0, unmappedSearch);
                }}
              />
              <Button size="sm" onClick={() => loadUnmapped(0, unmappedSearch)}>
                ค้นหา
              </Button>
            </Flex>

            {unmappedLoading && <Spinner color="primary.500" mb={4} />}
            {!unmappedLoading && unmapped.length === 0 && (
              <Text color="slate.400" fontSize="sm">
                ไม่พบโรงงานที่ไม่มีพิกัด
              </Text>
            )}

            <VStack align="stretch" spacing={3}>
              {unmapped.map((f) => (
                <Flex
                  key={f.id}
                  bg="white"
                  borderRadius="xl"
                  p={4}
                  boxShadow="sm"
                  align="center"
                  justify="space-between"
                  gap={3}
                  wrap="wrap"
                >
                  <Box minW="0" flex="1">
                    <Text fontWeight="700" color="slate.800" fontSize="sm" noOfLines={1}>
                      {f.name || f.id}
                    </Text>
                    <Text fontSize="xs" color="slate.400" noOfLines={1}>
                      {[f.sub_district, f.district, f.province].filter(Boolean).join(" · ") || "?"}
                      {" · "}ทะเบียน {f.id}
                    </Text>
                    {f.address_full && (
                      <Text fontSize="xs" color="slate.500" noOfLines={1} mt={0.5}>
                        {f.address_full}
                      </Text>
                    )}
                    {(() => {
                      const text = `${f.name || ""} ${f.address_full || ""}`;
                      const deedMatch = text.match(/(โฉนด|เลขที่โฉนด|โฉนดที่ดิน)\s*เลขที่?\s*(\d+[\d/|-]*)/);
                      const landMatch = text.match(/(เลขที่ดิน|ดินเลขที่)\s*(\d+[\d/|-]*)/);
                      const deedNo = deedMatch ? deedMatch[2] : null;
                      const landNo = landMatch ? landMatch[2] : null;

                      if (!deedNo && !landNo) return null;

                      return (
                        <Flex align="center" gap={2} mt={1.5} wrap="wrap">
                          <Badge colorScheme="purple" fontSize="10px" borderRadius="md" px={2}>
                            {deedNo ? `โฉนดเลขที่ ${deedNo}` : ''} {landNo ? `เลขที่ดิน ${landNo}` : ''}
                          </Badge>
                          <Link
                            href="https://landsmaps.dol.go.th/"
                            isExternal
                            fontSize="10px"
                            color="purple.600"
                            fontWeight="600"
                          >
                            ค้นหาใน LandsMaps ↗
                          </Link>
                        </Flex>
                      );
                    })()}
                  </Box>
                  <Button
                    size="sm"
                    bg="primary.600"
                    color="white"
                    borderRadius="lg"
                    flexShrink={0}
                    _hover={{ bg: "primary.700" }}
                    onClick={() => setPositionTarget(f)}
                  >
                    ตั้งพิกัด
                  </Button>
                </Flex>
              ))}
            </VStack>

            {unmappedTotal > UNMAPPED_PAGE_SIZE && (
              <Flex mt={5} justify="center" align="center" gap={3}>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={unmappedOffset === 0 || unmappedLoading}
                  onClick={() => loadUnmapped(Math.max(0, unmappedOffset - UNMAPPED_PAGE_SIZE), unmappedSearch)}
                >
                  ก่อนหน้า
                </Button>
                <Text fontSize="xs" color="slate.500">
                  {unmappedOffset + 1}–{Math.min(unmappedOffset + UNMAPPED_PAGE_SIZE, unmappedTotal)} จาก{" "}
                  {unmappedTotal.toLocaleString()}
                </Text>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={unmappedOffset + UNMAPPED_PAGE_SIZE >= unmappedTotal || unmappedLoading}
                  onClick={() => loadUnmapped(unmappedOffset + UNMAPPED_PAGE_SIZE, unmappedSearch)}
                >
                  ถัดไป
                </Button>
              </Flex>
            )}
          </Box>
        )}

        {/* ── Approximate positions ──
            On the map already, but derived rather than surveyed. */}
        {tab === "approx" && (
          <AdminApproximateQueue authFetch={authFetch} onTotalChange={setApproxTotal} />
        )}

        {/* ── Province tag vs coordinates ──
            On the map, but in the wrong province: missing from where a
            neighbour would look, present where it does not belong. */}
        {tab === "mismatch" && (
          <AdminProvinceMismatchQueue authFetch={authFetch} onTotalChange={setMismatchTotal} />
        )}

        {/* ── DBD ownership match review ──
            Nothing here is public yet; confirming is what publishes it. */}
        {tab === "dbd" && (
          <AdminDbdMatchQueue authFetch={authFetch} onPendingTotal={setDbdPending} />
        )}
      </Box>

      <AdminSetPositionModal
        isOpen={positionTarget !== null}
        onClose={() => setPositionTarget(null)}
        factory={positionTarget}
        authFetch={authFetch}
        onSaved={(id) => {
          setUnmapped((prev) => prev.filter((f) => f.id !== id));
          setUnmappedTotal((prev) => Math.max(0, prev - 1));
        }}
      />
    </Box>
  );
};

export default AdminPage;
