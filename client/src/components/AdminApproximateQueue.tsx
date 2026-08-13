import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Input,
  Link,
  Select,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import AdminSetPositionModal from "./AdminSetPositionModal";

/**
 * Review queue for factories that are on the map in roughly the wrong place.
 *
 * These are the faded pins: a position derived from the tambon gazetteer
 * (±2–5 km) or geocoded from an address string, rather than surveyed. They are
 * invisible to the "ยังไม่มีพิกัด" queue, which filters on `lat IS NULL` —
 * these all have coordinates, which is exactly the problem: a wrong position
 * looks the same as a right one to anyone who does not read the badge.
 */

const PAGE_SIZE = 30;

type Precision = "" | "tambon" | "street";
type Sort = "location" | "impact";

export interface ApproximateFactory {
  id: string;
  name: string | null;
  address_full: string | null;
  province: string | null;
  district: string | null;
  sub_district: string | null;
  factory_type: string | null;
  capital_investment: number | null;
  total_workers: number | null;
  lat: number;
  lng: number;
  coord_source: string;
  coord_precision: string | null;
}

interface Props {
  authFetch: <T>(path: string, init?: RequestInit) => Promise<T>;
  onTotalChange?: (total: number) => void;
}

const PRECISION_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  tambon: { label: "ระดับตำบล ±2–5 กม.", bg: "orange.50", color: "orange.700" },
  street: { label: "จากที่อยู่", bg: "yellow.50", color: "yellow.800" },
};

const AdminApproximateQueue: React.FC<Props> = ({ authFetch, onTotalChange }) => {
  const [rows, setRows] = useState<ApproximateFactory[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [precision, setPrecision] = useState<Precision>("tambon");
  const [sort, setSort] = useState<Sort>("location");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ApproximateFactory | null>(null);

  const load = useCallback(
    async (nextOffset: number, nextSearch: string, nextPrecision: Precision, nextSort: Sort) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
          sort: nextSort,
        });
        if (nextPrecision) params.set("precision", nextPrecision);
        if (nextSearch.trim()) params.set("search", nextSearch.trim());
        const data = await authFetch<{ rows: ApproximateFactory[]; total: number }>(
          `/api/admin/approximate-factories?${params}`
        );
        setRows(data.rows);
        setTotal(data.total);
        setOffset(nextOffset);
        onTotalChange?.(data.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setIsLoading(false);
      }
    },
    [authFetch, onTotalChange]
  );

  useEffect(() => {
    load(0, search, precision, sort);
    // Search is submitted explicitly; filters reload immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precision, sort]);

  return (
    <Box>
      <Flex gap={2} mb={3} wrap="wrap">
        <Select
          size="xs"
          bg="white"
          borderRadius="lg"
          w="auto"
          value={precision}
          onChange={(e) => setPrecision(e.target.value as Precision)}
        >
          <option value="tambon">ระดับตำบล (คลาดเคลื่อนมากสุด)</option>
          <option value="street">จากที่อยู่</option>
          <option value="">ทั้งหมดที่เป็นค่าประมาณ</option>
        </Select>
        <Select
          size="xs"
          bg="white"
          borderRadius="lg"
          w="auto"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="location">เรียงตามพื้นที่ (ตรวจทีละอำเภอ)</option>
          <option value="impact">เรียงตามขนาดโรงงาน (ผลกระทบมากก่อน)</option>
        </Select>
        <Input
          placeholder="ค้นหาชื่อ / เลขทะเบียน / ที่อยู่..."
          size="xs"
          bg="white"
          borderRadius="lg"
          flex="1"
          minW="200px"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(0, search, precision, sort);
          }}
        />
        <Button size="xs" onClick={() => load(0, search, precision, sort)}>
          ค้นหา
        </Button>
      </Flex>

      <Text fontSize="xs" color="slate.500" mb={4} lineHeight="1.7">
        โรงงานเหล่านี้แสดงบนแผนที่แล้ว แต่หมุดมาจากการประมาณ ไม่ใช่ตำแหน่งจริง —
        บนแผนที่จะเห็นเป็นหมุดจาง การใส่ตำแหน่งจริงจะเปลี่ยนเป็นหมุดปกติทันที
      </Text>

      {error && (
        <Text mb={4} fontSize="sm" color="red.500" fontWeight="600">
          {error}
        </Text>
      )}
      {isLoading && <Spinner color="primary.500" mb={4} />}
      {!isLoading && rows.length === 0 && (
        <Text color="slate.400" fontSize="sm">
          ไม่พบโรงงานที่ใช้ตำแหน่งโดยประมาณ
        </Text>
      )}

      <VStack align="stretch" spacing={3}>
        {rows.map((f) => {
          const badge = PRECISION_BADGE[f.coord_precision ?? ""] ?? {
            label: f.coord_precision ?? "ประมาณ",
            bg: "slate.100",
            color: "slate.600",
          };
          const address =
            [f.address_full, f.sub_district, f.district, f.province].filter(Boolean).join(" ") || "";
          return (
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
                <Flex align="center" gap={2} wrap="wrap">
                  <Text fontWeight="700" color="slate.800" fontSize="sm" noOfLines={1}>
                    {f.name || f.id}
                  </Text>
                  <Badge bg={badge.bg} color={badge.color} borderRadius="full" px={2} fontSize="9px">
                    {badge.label}
                  </Badge>
                </Flex>
                <Text fontSize="xs" color="slate.400" noOfLines={1}>
                  {[f.sub_district, f.district, f.province].filter(Boolean).join(" · ") || "?"}
                  {" · "}ทะเบียน {f.id}
                </Text>
                {f.address_full && (
                  <Text fontSize="xs" color="slate.500" noOfLines={1} mt={0.5}>
                    {f.address_full}
                  </Text>
                )}
                <Flex gap={3} mt={1} wrap="wrap" align="center">
                  <Link
                    href={`https://www.google.com/maps?q=${f.lat},${f.lng}`}
                    isExternal
                    fontSize="10px"
                    color="slate.500"
                    fontFamily="'Inter', monospace"
                  >
                    หมุดปัจจุบัน {f.lat.toFixed(5)}, {f.lng.toFixed(5)} ↗
                  </Link>
                  {address && (
                    <Link
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                      isExternal
                      fontSize="10px"
                      color="primary.600"
                      fontWeight="600"
                    >
                      ค้นที่อยู่นี้ ↗
                    </Link>
                  )}
                </Flex>
              </Box>
              <Button
                size="sm"
                bg="primary.600"
                color="white"
                borderRadius="lg"
                flexShrink={0}
                _hover={{ bg: "primary.700" }}
                onClick={() => setTarget(f)}
              >
                แก้ตำแหน่ง
              </Button>
            </Flex>
          );
        })}
      </VStack>

      {total > PAGE_SIZE && (
        <Flex mt={5} justify="center" align="center" gap={3}>
          <Button
            size="sm"
            variant="outline"
            isDisabled={offset === 0 || isLoading}
            onClick={() => load(Math.max(0, offset - PAGE_SIZE), search, precision, sort)}
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
            onClick={() => load(offset + PAGE_SIZE, search, precision, sort)}
          >
            ถัดไป
          </Button>
        </Flex>
      )}

      <AdminSetPositionModal
        isOpen={target !== null}
        onClose={() => setTarget(null)}
        factory={target}
        authFetch={authFetch}
        endpoint="/api/admin/approximate-factories"
        onSaved={(id) => {
          setRows((prev) => prev.filter((f) => f.id !== id));
          setTotal((prev) => {
            const next = Math.max(0, prev - 1);
            onTotalChange?.(next);
            return next;
          });
        }}
      />
    </Box>
  );
};

export default AdminApproximateQueue;
