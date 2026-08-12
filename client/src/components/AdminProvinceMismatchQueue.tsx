import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Input,
  Link,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import AdminSetPositionModal from "./AdminSetPositionModal";

/**
 * Factories plotted outside the province they are tagged with.
 *
 * The pin and the badge disagree, which is wrong in both directions at once:
 * the factory is missing from the province a neighbour would search, and
 * present in one it has nothing to do with.
 *
 * 217 of the 221 carry `gov` coordinates, so this is the government feed rather
 * than our geocoding tiers — tambon centroids cannot land in the wrong province
 * by construction, and street geocoding is province-validated. It has to be
 * fixed by hand, which is what this queue is for.
 *
 * Worst distance first: how far outside is the best available proxy for how
 * obviously wrong a record is, and the far end of the list is unambiguous —
 * a factory registered in อุดรธานี plotted 1,052 km away in กระบี่.
 */

const PAGE_SIZE = 25;

export interface MismatchRow {
  id: string;
  name: string;
  tagged: string;
  actual: string | null;
  lat: number;
  lng: number;
  km_outside: number;
  coord_source: string;
  district?: string | null;
  address_full?: string | null;
}

interface Props {
  authFetch: (path: string, init?: RequestInit) => Promise<unknown>;
  onTotalChange?: (total: number) => void;
}

const AdminProvinceMismatchQueue: React.FC<Props> = ({ authFetch, onTotalChange }) => {
  const [rows, setRows] = useState<MismatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<MismatchRow | null>(null);

  const load = useCallback(
    async (nextOffset: number, nextSearch: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(nextOffset),
        });
        if (nextSearch.trim()) params.set("search", nextSearch.trim());
        const data = (await authFetch(`/api/admin/province-mismatch?${params}`)) as {
          rows: MismatchRow[];
          total: number;
        };
        setRows(data.rows);
        setTotal(data.total);
        setOffset(nextOffset);
        if (!nextSearch.trim()) onTotalChange?.(data.total);
      } catch (err) {
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setIsLoading(false);
      }
    },
    [authFetch, onTotalChange]
  );

  useEffect(() => {
    load(0, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box>
      <Flex gap={2} mb={3} wrap="wrap">
        <Input
          placeholder="ค้นหาชื่อ / เลขทะเบียน / จังหวัด..."
          size="xs"
          bg="white"
          borderRadius="lg"
          flex="1"
          minW="220px"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(0, search);
          }}
        />
        <Button size="xs" onClick={() => load(0, search)}>
          ค้นหา
        </Button>
      </Flex>

      <Text fontSize="xs" color="slate.500" mb={4} lineHeight="1.7">
        โรงงานที่พิกัดตกอยู่นอกจังหวัดที่ระบุไว้ในทะเบียน — ทำให้หายไปจากจังหวัดที่ควรอยู่
        และไปโผล่ในจังหวัดที่ไม่เกี่ยวข้อง ส่วนใหญ่เป็นพิกัดจากกรมโรงงานฯ โดยตรง
        เรียงจากที่คลาดเคลื่อนมากที่สุด
      </Text>

      {error && (
        <Text mb={4} fontSize="sm" color="red.500" fontWeight="600">
          {error}
        </Text>
      )}
      {isLoading && <Spinner color="primary.500" mb={4} />}
      {!isLoading && rows.length === 0 && (
        <Text color="slate.400" fontSize="sm">
          ไม่มีรายการพิกัดผิดจังหวัด
        </Text>
      )}

      <VStack align="stretch" spacing={3}>
        {rows.map((f) => {
          const far = f.km_outside >= 200;
          const address =
            [f.address_full, f.district, f.tagged].filter(Boolean).join(" ") || "";
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
              border="1px solid"
              borderColor={far ? "red.200" : "slate.100"}
            >
              <Box minW="0" flex="1">
                <Flex align="center" gap={2} wrap="wrap">
                  <Text fontWeight="700" color="slate.800" fontSize="sm" noOfLines={1}>
                    {f.name || f.id}
                  </Text>
                  <Badge
                    bg={far ? "red.50" : "orange.50"}
                    color={far ? "red.700" : "orange.700"}
                    borderRadius="full"
                    px={2}
                    fontSize="9px"
                  >
                    ห่างจากจังหวัดที่ระบุ {f.km_outside.toLocaleString("th-TH")} กม.
                  </Badge>
                </Flex>

                <Flex align="center" gap={1.5} mt={1} fontSize="xs" wrap="wrap">
                  <Text color="slate.500">ทะเบียนระบุ</Text>
                  <Text color="slate.800" fontWeight="700">{f.tagged}</Text>
                  <Text color="slate.400">→</Text>
                  <Text color="slate.500">พิกัดตกใน</Text>
                  <Text color="red.600" fontWeight="700">
                    {f.actual || "นอกเขตประเทศไทย"}
                  </Text>
                </Flex>

                <Text fontSize="xs" color="slate.400" noOfLines={1} mt={0.5}>
                  ทะเบียน {f.id}
                  {f.address_full ? ` · ${f.address_full}` : ""}
                </Text>

                <Flex gap={3} mt={1} wrap="wrap">
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
                      ค้นที่อยู่ตามทะเบียน ↗
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
            onClick={() => load(Math.max(0, offset - PAGE_SIZE), search)}
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
            onClick={() => load(offset + PAGE_SIZE, search)}
          >
            ถัดไป
          </Button>
        </Flex>
      )}

      <AdminSetPositionModal
        isOpen={target !== null}
        onClose={() => setTarget(null)}
        factory={
          target && {
            id: target.id,
            name: target.name,
            address_full: target.address_full ?? null,
            province: target.tagged,
            district: target.district ?? null,
            sub_district: null,
            lat: target.lat,
            lng: target.lng,
            coord_precision: null,
          }
        }
        authFetch={authFetch}
        endpoint="/api/admin/province-mismatch"
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

export default AdminProvinceMismatchQueue;
