import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Input,
  Link,
  SimpleGrid,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";

/**
 * Human review of DIW operator -> DBD company links.
 *
 * The resolver refuses to guess: whatever it cannot settle is recorded as
 * `probable` or `ambiguous`, and the public view publishes only `exact` or
 * human-verified links. Everything in this queue is therefore currently
 * invisible on the site, and this screen is the only way it can ever be
 * published — or, for a wrong automatic link, withdrawn.
 */

const PAGE_SIZE = 25;

// DBD's public profile page. Verified to resolve for a bare juristic id.
const DBD_PROFILE = "https://datawarehouse.dbd.go.th/company/profile";

type Queue = "pending" | "exact" | "verified";

export interface DbdMatch {
  business_id: string;
  legal_name: string;
  core_name: string | null;
  matched_query: string | null;
  expected_form: string | null;
  jp_no: string | null;
  outcome: string;
  candidates: number | null;
  isic_agrees: boolean | null;
  province_agrees: boolean | null;
  resolved_at: string | null;
  verified_by: string | null;
  verified_at: string | null;
  verified_note: string | null;
  jp_name: string | null;
  jp_type_desc: string | null;
  jp_status_desc: string | null;
  jp_province: string | null;
  register_capital: number | string | null;
  factory_count: number;
  factory_names: string[] | null;
  factory_provinces: string[] | null;
}

interface Props {
  authFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  onPendingTotal?: (total: number) => void;
}

const QUEUE_LABELS: Record<Queue, string> = {
  pending: "รอตรวจสอบ",
  exact: "ลิงก์อัตโนมัติ (ตรวจย้อนหลัง)",
  verified: "ตรวจแล้ว",
};

const OUTCOME_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  probable: { bg: "orange.50", color: "orange.700", label: "น่าจะใช่" },
  ambiguous: { bg: "red.50", color: "red.700", label: "กำกวม" },
  exact: { bg: "green.50", color: "green.700", label: "ตรงกัน" },
};

function formatCapital(value: number | string | null): string {
  if (value === null || value === "") return "—";
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return "—";
  return `${amount.toLocaleString("th-TH")} บาท`;
}

/** A yes/no/unknown corroboration signal the matcher did not itself use. */
const Signal = ({ label, value }: { label: string; value: boolean | null }) => (
  <Flex align="center" gap={1.5}>
    <Box
      boxSize="7px"
      borderRadius="full"
      bg={value === true ? "green.400" : value === false ? "red.400" : "slate.200"}
      flexShrink={0}
    />
    <Text fontSize="10px" color={value === false ? "red.600" : "slate.500"}>
      {label}
      {value === null ? " (ไม่ทราบ)" : value ? " ตรง" : " ไม่ตรง"}
    </Text>
  </Flex>
);

const AdminDbdMatchQueue: React.FC<Props> = ({ authFetch, onPendingTotal }) => {
  const [queue, setQueue] = useState<Queue>("pending");
  const [rows, setRows] = useState<DbdMatch[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const load = useCallback(
    async (nextQueue: Queue, nextOffset: number, nextSearch: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          queue: nextQueue,
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
        });
        if (nextSearch.trim()) params.set("search", nextSearch.trim());
        const data = await authFetch<{ rows: DbdMatch[]; total: number }>(
          `/api/admin/dbd-matches?${params}`
        );
        setRows(data.rows);
        setTotal(data.total);
        setOffset(nextOffset);
        if (nextQueue === "pending" && !nextSearch.trim()) onPendingTotal?.(data.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setIsLoading(false);
      }
    },
    [authFetch, onPendingTotal]
  );

  useEffect(() => {
    load(queue, 0, search);
    // Reloading on every keystroke would hammer the API; search is submitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const review = async (row: DbdMatch, action: "confirm" | "reject") => {
    setBusyId(row.business_id);
    setError(null);
    try {
      const override = overrides[row.business_id]?.trim();
      await authFetch(`/api/admin/dbd-matches/${encodeURIComponent(row.business_id)}`, {
        method: "POST",
        body: JSON.stringify({
          action,
          note: notes[row.business_id]?.trim() || null,
          ...(action === "confirm" && override ? { jp_no: override } : {}),
        }),
      });
      setRows((prev) => prev.filter((r) => r.business_id !== row.business_id));
      setTotal((prev) => Math.max(0, prev - 1));
      if (queue === "pending") onPendingTotal?.(Math.max(0, total - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : "ดำเนินการไม่สำเร็จ");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Box>
      <Flex gap={2} mb={4} wrap="wrap">
        {(Object.keys(QUEUE_LABELS) as Queue[]).map((key) => (
          <Button
            key={key}
            size="xs"
            borderRadius="full"
            bg={queue === key ? "#0B3558" : "white"}
            color={queue === key ? "white" : "slate.600"}
            _hover={{ bg: queue === key ? "#0B3558" : "slate.100" }}
            onClick={() => setQueue(key)}
          >
            {QUEUE_LABELS[key]}
          </Button>
        ))}
        <Input
          placeholder="ค้นหาชื่อผู้ประกอบการ / ชื่อบริษัท / เลขนิติบุคคล"
          size="xs"
          bg="white"
          borderRadius="lg"
          flex="1"
          minW="220px"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(queue, 0, search);
          }}
        />
        <Button size="xs" onClick={() => load(queue, 0, search)}>
          ค้นหา
        </Button>
      </Flex>

      <Text fontSize="xs" color="slate.500" mb={4} lineHeight="1.7">
        {queue === "pending" &&
          "ลิงก์เหล่านี้ยังไม่แสดงบนเว็บไซต์ จนกว่าจะมีคนยืนยัน — การยืนยันจะเผยแพร่ทันที และจะไม่ถูกเขียนทับโดยการรันตัวเก็บข้อมูลรอบถัดไป"}
        {queue === "exact" &&
          "ลิงก์ที่ระบบจับคู่เองและเผยแพร่อยู่แล้ว — กด “ไม่ใช่บริษัทนี้” เพื่อถอนออกจากเว็บไซต์"}
        {queue === "verified" && "การตัดสินใจที่มีคนตรวจแล้ว ย้อนกลับมาแก้ได้"}
      </Text>

      {error && (
        <Text mb={4} fontSize="sm" color="red.500" fontWeight="600">
          {error}
        </Text>
      )}
      {isLoading && <Spinner color="primary.500" mb={4} />}
      {!isLoading && rows.length === 0 && (
        <Text color="slate.400" fontSize="sm">
          ไม่มีรายการในคิวนี้
        </Text>
      )}

      <VStack align="stretch" spacing={4}>
        {rows.map((row) => {
          const style = OUTCOME_STYLE[row.outcome] ?? {
            bg: "slate.100",
            color: "slate.600",
            label: row.outcome,
          };
          // The tell a reviewer most often needs: DBD's head office against
          // where the factories actually are.
          const provinceMismatch =
            row.jp_province &&
            row.factory_provinces?.length &&
            !row.factory_provinces.includes(row.jp_province);

          return (
            <Box key={row.business_id} bg="white" borderRadius="2xl" p={5} boxShadow="sm">
              <Flex align="center" gap={2} wrap="wrap" mb={3}>
                <Badge bg={style.bg} color={style.color} borderRadius="full" px={2.5} fontSize="10px">
                  {style.label}
                </Badge>
                <Text fontSize="10px" color="slate.400">
                  {row.candidates ?? 0} ผลลัพธ์จาก DBD
                </Text>
                {row.factory_count > 0 && (
                  <Text fontSize="10px" color="slate.500" fontWeight="700">
                    · มีผลกับ {row.factory_count.toLocaleString()} โรงงานที่ยังดำเนินการ
                  </Text>
                )}
                {row.verified_by && (
                  <Badge bg="slate.100" color="slate.600" borderRadius="full" px={2} fontSize="10px">
                    ตรวจโดย {row.verified_by}
                  </Badge>
                )}
              </Flex>

              <SimpleGrid columns={{ base: 1, md: 2 }} spacing={4}>
                {/* What DIW says */}
                <Box>
                  <Text fontSize="10px" color="slate.400" fontWeight="700" letterSpacing=".05em">
                    DIW — ผู้ประกอบการ
                  </Text>
                  <Text fontSize="sm" color="slate.800" fontWeight="700" mt={1}>
                    {row.legal_name}
                  </Text>
                  {row.factory_provinces?.length ? (
                    <Text fontSize="xs" color="slate.500" mt={1}>
                      โรงงานอยู่ที่ {row.factory_provinces.join(" · ")}
                    </Text>
                  ) : null}
                  {row.factory_names?.length ? (
                    <Text fontSize="10px" color="slate.400" mt={1} noOfLines={3}>
                      {row.factory_names.join(" / ")}
                    </Text>
                  ) : null}
                </Box>

                {/* What DBD says */}
                <Box>
                  <Text fontSize="10px" color="slate.400" fontWeight="700" letterSpacing=".05em">
                    DBD — นิติบุคคลที่จับคู่ได้
                  </Text>
                  {row.jp_no ? (
                    <>
                      <Text fontSize="sm" color="#0B3558" fontWeight="700" mt={1}>
                        {row.jp_name || "(ไม่มีชื่อ)"}
                      </Text>
                      <Text fontSize="xs" color="slate.500" mt={1}>
                        {[row.jp_type_desc, row.jp_status_desc].filter(Boolean).join(" · ")}
                      </Text>
                      <Text
                        fontSize="xs"
                        color={provinceMismatch ? "red.600" : "slate.500"}
                        fontWeight={provinceMismatch ? "700" : "400"}
                      >
                        จดทะเบียนที่ {row.jp_province || "?"}
                        {provinceMismatch ? " — คนละจังหวัดกับโรงงาน" : ""}
                      </Text>
                      <Text fontSize="xs" color="slate.500">
                        ทุน {formatCapital(row.register_capital)}
                      </Text>
                      <Link
                        href={`${DBD_PROFILE}/${row.jp_no}`}
                        isExternal
                        color="primary.600"
                        fontSize="xs"
                        fontFamily="'Inter', monospace"
                        fontWeight="600"
                      >
                        {row.jp_no} ↗
                      </Link>
                    </>
                  ) : (
                    <Text fontSize="sm" color="slate.400" mt={1}>
                      ไม่มีบริษัทที่จับคู่ไว้
                    </Text>
                  )}
                </Box>
              </SimpleGrid>

              <Flex gap={4} mt={3} wrap="wrap">
                <Signal label="ประเภทกิจการ (ISIC)" value={row.isic_agrees} />
                <Signal label="จังหวัด" value={row.province_agrees} />
                {row.matched_query && (
                  <Text fontSize="10px" color="slate.400">
                    ค้นด้วย “{row.matched_query}”
                  </Text>
                )}
              </Flex>

              {row.verified_note && (
                <Text mt={3} fontSize="xs" color="slate.600">
                  บันทึก: {row.verified_note}
                </Text>
              )}

              <Flex mt={4} gap={2} align="center" wrap="wrap">
                <Button
                  size="sm"
                  colorScheme="green"
                  isLoading={busyId === row.business_id}
                  isDisabled={!row.jp_no && !overrides[row.business_id]?.trim()}
                  onClick={() => review(row, "confirm")}
                >
                  ยืนยัน — เผยแพร่
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  colorScheme="red"
                  isLoading={busyId === row.business_id}
                  onClick={() => review(row, "reject")}
                >
                  ไม่ใช่บริษัทนี้
                </Button>
                <Input
                  placeholder="เลขนิติบุคคลที่ถูกต้อง (ถ้าจับคู่ผิด)"
                  size="sm"
                  flex="1"
                  minW="200px"
                  borderRadius="lg"
                  fontFamily="'Inter', monospace"
                  value={overrides[row.business_id] ?? ""}
                  onChange={(e) =>
                    setOverrides((prev) => ({ ...prev, [row.business_id]: e.target.value }))
                  }
                />
              </Flex>
              <Textarea
                mt={2}
                placeholder="เหตุผล/หลักฐานที่ใช้ตัดสิน (ไม่บังคับ แต่ช่วยคนที่มาตรวจซ้ำ)"
                size="sm"
                rows={1}
                borderRadius="lg"
                value={notes[row.business_id] ?? ""}
                onChange={(e) =>
                  setNotes((prev) => ({ ...prev, [row.business_id]: e.target.value }))
                }
              />
            </Box>
          );
        })}
      </VStack>

      {total > PAGE_SIZE && (
        <Flex mt={5} justify="center" align="center" gap={3}>
          <Button
            size="sm"
            variant="outline"
            isDisabled={offset === 0 || isLoading}
            onClick={() => load(queue, Math.max(0, offset - PAGE_SIZE), search)}
          >
            ก่อนหน้า
          </Button>
          <Text fontSize="xs" color="slate.500">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total.toLocaleString()}
          </Text>
          <Button
            size="sm"
            variant="outline"
            isDisabled={offset + PAGE_SIZE >= total || isLoading}
            onClick={() => load(queue, offset + PAGE_SIZE, search)}
          >
            ถัดไป
          </Button>
        </Flex>
      )}
    </Box>
  );
};

export default AdminDbdMatchQueue;
