# Signal 39 Design: Code Examples

**Before/after examples showing Signal 39 principles in React + TypeScript.**

---

## Example 1: Factory List Item

### ❌ Before (Cognitive Overload)

```tsx
// Too much information up front, no visual hierarchy
<Box p={4} border="1px solid gray" mb={2}>
  <Text fontSize="sm">{factory.properties.ชื่อโรงงาน}</Text>
  <Text fontSize="xs">{factory.properties.ผู้ประกอบก}</Text>
  <Text fontSize="xs">{factory.properties.ประกอบกิจก}</Text>
  <Text fontSize="xs">{factory.properties.ที่อยู่}</Text>
  <Text fontSize="xs">ประเภท: {factory.properties.ประเภท}</Text>
  <Text fontSize="xs">ระยะทาง: {distance} กม.</Text>
  <Text fontSize="xs">เงินลงทุน: {capital} บาท</Text>
</Box>
```

**Problems:**
- No Layer 1 (no color coding, all text)
- Too much Layer 3 data visible (7 fields)
- User must read everything to find high-risk factories
- No progressive disclosure

---

### ✅ After (Signal 39 Compliant)

```tsx
// Layer 1: Color dot, Layer 2: Name + distance, Layer 3: On click
<Box
  py={4}
  px={4}
  bg={isSelected ? "white" : "transparent"}
  borderRadius="xl"
  border="1px solid"
  borderColor={isSelected ? "slate.200" : "transparent"}
  cursor="pointer"
  onClick={onClick}
  position="relative"
>
  {/* Layer 1: Risk indicator (subconscious, no reading needed) */}
  <Flex align="center" gap={3}>
    <Box
      w="8px"
      h="8px"
      borderRadius="full"
      bg={isHighRisk ? "#EF4444" : "#10B981"}
      flexShrink={0}
    />
    
    {/* Layer 2: Key chunked info (name + distance) */}
    <Box flex="1">
      <Text fontWeight="600" color="slate.800" fontSize="sm" noOfLines={1}>
        {factory.properties.ชื่อโรงงาน}
      </Text>
    </Box>
    
    {distance && (
      <Text fontSize="xs" fontWeight="500" color="slate.400">
        {distance < 1 
          ? `${(distance * 1000).toFixed(0)} ม.`
          : `${distance.toFixed(1)} กม.`}
      </Text>
    )}
  </Flex>
  
  {/* Layer 3: Details only if user clicked (progressive disclosure) */}
  {isSelected && hasDetails && (
    <VStack align="start" mt={2} spacing={1}>
      <Text fontSize="xs" color="slate.600">
        ผู้ประกอบการ: {factory.properties.ผู้ประกอบก}
      </Text>
      <Text fontSize="xs" color="slate.600" noOfLines={1}>
        {factory.properties.ประกอบกิจก}
      </Text>
    </VStack>
  )}
</Box>
```

**Improvements:**
- ✅ Layer 1: Risk dot (red/green) visible without reading
- ✅ Layer 2: Only name + distance (chunked)
- ✅ Layer 3: Full details on click (progressive disclosure)
- ✅ Passes blur test (color indicates risk)

---

## Example 2: Filter Controls

### ❌ Before (Decision Paralysis)

```tsx
// Too many options, no grouping, flat hierarchy
<VStack spacing={2} align="start">
  <Checkbox>โรงงานประเภท 1</Checkbox>
  <Checkbox>โรงงานประเภท 2</Checkbox>
  <Checkbox>โรงงานประเภท 3</Checkbox>
  <Checkbox>โรงงานปิด</Checkbox>
  <Checkbox>โรงงานเปิด</Checkbox>
  <Checkbox>มีพนักงาน > 100</Checkbox>
  <Checkbox>เงินลงทุน > 10 ล้าน</Checkbox>
  <Checkbox>ใกล้ฉัน 5 กม.</Checkbox>
  <Checkbox>ใกล้ฉัน 10 กม.</Checkbox>
  <Checkbox>ใกล้ฉัน 20 กม.</Checkbox>
</VStack>
```

**Problems:**
- 10 options = exponential cognitive tax (Hick's Law)
- No semantic grouping
- No visual hierarchy
- Violates Rule of Three

---

### ✅ After (Rule of Three)

```tsx
// Max 3 primary filters, chunked by meaning
<VStack spacing={3} align="stretch">
  {/* Primary Filter: Province (Layer 2 gateway) */}
  <Select
    value={filters.selectedProvince}
    onChange={(e) => onFilterChange({ selectedProvince: e.target.value })}
    size="md"
    borderRadius="xl"
  >
    <option value="">ทุกจังหวัด</option>
    {provinces.map(p => (
      <option key={p.name} value={p.name}>
        {p.name} ({p.count})
      </option>
    ))}
  </Select>

  {/* Filter Pills: Max 3 visible options (Layer 2) */}
  <HStack spacing={2} flexWrap="wrap">
    <Button
      size="sm"
      borderRadius="full"
      variant="ghost"
      bg={filters.showHighRisk ? "red.50" : "slate.50"}
      color={filters.showHighRisk ? "red.600" : "slate.500"}
      fontWeight={filters.showHighRisk ? "600" : "400"}
      onClick={() => onFilterChange({ showHighRisk: !filters.showHighRisk })}
    >
      {filters.showHighRisk && "● "}เสี่ยงสูง
    </Button>

    {userLocation && (
      <Button
        size="sm"
        borderRadius="full"
        variant="ghost"
        bg={filters.showOnlyInRadius ? "primary.50" : "slate.50"}
        color={filters.showOnlyInRadius ? "primary.600" : "slate.500"}
        fontWeight={filters.showOnlyInRadius ? "600" : "400"}
        onClick={() => onFilterChange({ showOnlyInRadius: !filters.showOnlyInRadius })}
      >
        {filters.showOnlyInRadius && "● "}ใกล้ฉัน 10 กม.
      </Button>
    )}
  </HStack>
</VStack>
```

**Improvements:**
- ✅ Reduced from 10 to 3 primary options
- ✅ Semantic grouping (Province + 2 filters)
- ✅ Visual state (colored when active = Layer 1)
- ✅ Rule of Three compliance

---

## Example 3: Map Markers

### ❌ Before (Generic Icons)

```tsx
// Default Leaflet markers, no semantic meaning
const markerIcon = L.icon({
  iconUrl: '/marker.png',
  iconSize: [25, 41],
});

<Marker 
  position={[lat, lng]} 
  icon={markerIcon}
/>
```

**Problems:**
- No Layer 1 differentiation (all markers identical)
- Can't distinguish high-risk factories without clicking
- No visual feedback for selection

---

### ✅ After (Layer 1 Color Coding)

```tsx
// Risk-coded markers with semantic SVG
const getFactoryIcon = (isHighRisk: boolean, isSelected: boolean) => {
  const size = isSelected ? 32 : 24;
  const color = isHighRisk ? "#EF4444" : "#10B981";
  
  return L.divIcon({
    html: `
      <div style="width: ${size}px; height: ${size}px;">
        ${isSelected ? `
          <div style="
            position: absolute;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            background: rgba(26,54,93,0.4);
            animation: pulse 1.5s infinite;
          "></div>
        ` : ''}
        <svg width="${size}" height="${size}" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/>
          <path d="M9 16V10H15V16" stroke="white" stroke-width="1.5"/>
        </svg>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
  });
};

<Marker 
  position={[lat, lng]} 
  icon={getFactoryIcon(isHighRisk, isSelected)}
/>
```

**Improvements:**
- ✅ Layer 1: Color indicates risk (red/green)
- ✅ Layer 1: Size indicates selection (32px vs 24px)
- ✅ Layer 1: Pulse animation for selected (shows state change)
- ✅ Passes blur test (can identify high-risk on zoomed-out map)

---

## Example 4: Welcome Modal

### ❌ Before (Cognitive Overload)

```tsx
// Wall of text, multiple CTAs, no hierarchy
<Modal isOpen={showWelcome}>
  <ModalHeader>ยินดีต้อนรับสู่ Factory Near Me</ModalHeader>
  <ModalBody>
    <Text mb={4}>
      แอปพลิเคชันนี้แสดงข้อมูลโรงงานอุตสาหกรรมทั่วประเทศไทย จากข้อมูลกรมโรงงานอุตสาหกรรม 
      คุณสามารถค้นหาโรงงานใกล้บ้าน ตรวจสอบประเภทโรงงาน ดูข้อมูลผู้ประกอบการ และดูรายละเอียด
      ต่างๆ เพื่อเพิ่มความโปร่งใสในอุตสาหกรรม
    </Text>
    <Text mb={4}>
      ระบบจะขอเข้าถึงตำแหน่งของคุณเพื่อแสดงโรงงานใกล้เคียง หากคุณไม่อนุญาต คุณสามารถค้นหาด้วย
      ชื่อจังหวัดได้
    </Text>
    <Text>คลิก "เริ่มใช้งาน" เพื่อเริ่มต้น หรือ "ดูวิธีใช้" เพื่ออ่านคู่มือ</Text>
  </ModalBody>
  <ModalFooter>
    <Button>ดูวิธีใช้</Button>
    <Button>ตั้งค่า</Button>
    <Button>เริ่มใช้งาน</Button>
  </ModalFooter>
</Modal>
```

**Problems:**
- 150+ words of text (high cognitive cost)
- 3 CTAs with unclear hierarchy
- No Layer 1 visual cue
- Violates Breath Rule

---

### ✅ After (High-Surprisal First)

```tsx
// One insight, one action, visual hierarchy
<Modal isOpen={showWelcome} size="lg">
  <ModalBody p={8}>
    <VStack spacing={6} align="center" textAlign="center">
      {/* Layer 1: Visual hook (icon shows purpose) */}
      <Box
        w="64px"
        h="64px"
        bg="primary.50"
        borderRadius="full"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <Icon as={MapPinIcon} boxSize={8} color="primary.600" />
      </Box>
      
      {/* Layer 2: One-sentence value prop */}
      <VStack spacing={2}>
        <Text fontSize="xl" fontWeight="bold" color="slate.800">
          ค้นหาโรงงานใกล้บ้านคุณ
        </Text>
        <Text fontSize="sm" color="slate.500">
          63,790+ โรงงานทั่วประเทศไทย
        </Text>
      </VStack>
      
      {/* Layer 2: Single primary CTA */}
      <Button
        size="lg"
        w="full"
        bg="primary.600"
        color="white"
        onClick={handleFindNearMe}
        isLoading={isLocating}
      >
        ค้นหาโรงงานใกล้ฉัน
      </Button>
      
      {/* Layer 3: Secondary action (low visual weight) */}
      <Button
        size="sm"
        variant="ghost"
        color="slate.500"
        onClick={handleSkipWelcome}
      >
        ข้าม
      </Button>
    </VStack>
  </ModalBody>
</Modal>
```

**Improvements:**
- ✅ Reduced from 150 words to 8 words
- ✅ Layer 1: Icon communicates purpose (map/location)
- ✅ Layer 2: One primary action (not 3)
- ✅ Layer 3: Skip hidden in low-contrast link
- ✅ Breath Rule: Generous whitespace between elements

---

## Example 5: Dashboard Stats

### ❌ Before (Data Dump)

```tsx
// Generic table, no hierarchy, forces serial search
<Table>
  <Thead>
    <Tr>
      <Th>Metric</Th>
      <Th>Value</Th>
    </Tr>
  </Thead>
  <Tbody>
    <Tr><Td>Total Factories</Td><Td>63790</Td></Tr>
    <Tr><Td>Type 1</Td><Td>32156</Td></Tr>
    <Tr><Td>Type 2</Td><Td>18423</Td></Tr>
    <Tr><Td>Type 3</Td><Td>13211</Td></Tr>
    <Tr><Td>Active</Td><Td>61245</Td></Tr>
    <Tr><Td>Closed</Td><Td>2545</Td></Tr>
    <Tr><Td>Total Capital (MB)</Td><Td>2456789</Td></Tr>
    <Tr><Td>Total Workers</Td><Td>1234567</Td></Tr>
  </Tbody>
</Table>
```

**Problems:**
- No Layer 1 (all text, same visual weight)
- Forces serial search (user must read all rows)
- No semantic grouping
- Numbers lack context (is 13211 high-risk good or bad?)

---

### ✅ After (Chunked Cards with Visual Hierarchy)

```tsx
// Max 4 key metrics, color-coded, chunked
<SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} spacing={6}>
  {/* Layer 2: Each card is a semantic chunk */}
  <MetricCard 
    title="จำนวนโรงงานทั้งหมด" 
    value={stats.total.toLocaleString()} 
    subtitle="โรงงานที่เปิดดำเนินการ"
    icon={BuildingIcon}
    color="primary"  // Layer 1: Color coding
  />
  
  <MetricCard 
    title="โรงงานจำพวก 3" 
    value={stats.highRiskCount.toLocaleString()} 
    subtitle="กลุ่มที่ต้องขอใบอนุญาต ร.ง.4"
    icon={AlertIcon}
    color="red"  // Layer 1: Red = attention
  />
  
  <MetricCard 
    title="เงินลงทุนรวม" 
    value={(stats.totalCapital / 1000000).toLocaleString()} 
    subtitle="ล้านบาท"
    icon={TrendingUpIcon}
    color="green"
  />
  
  <MetricCard 
    title="จำนวนผู้ปฏิบัติงาน" 
    value={stats.totalWorkers.toLocaleString()} 
    subtitle="คนงานทั้งหมด"
    icon={MapPinIcon}
    color="orange"
  />
</SimpleGrid>

// MetricCard component
const MetricCard = ({ title, value, subtitle, icon, color }) => (
  <Box bg="white" p={6} borderRadius="xl" boxShadow="sm">
    {/* Layer 1: Icon with semantic color */}
    <Flex align="center" gap={3} mb={3}>
      <Box
        p={3}
        bg={`${color}.50`}
        borderRadius="lg"
      >
        <Icon as={icon} boxSize={6} color={`${color}.600`} />
      </Box>
    </Flex>
    
    {/* Layer 2: Big number (chunked insight) */}
    <Text fontSize="3xl" fontWeight="bold" color="slate.800">
      {value}
    </Text>
    
    {/* Layer 3: Context */}
    <Text fontSize="sm" fontWeight="medium" color="slate.600">
      {title}
    </Text>
    <Text fontSize="xs" color="slate.400">
      {subtitle}
    </Text>
  </Box>
);
```

**Improvements:**
- ✅ Layer 1: Color-coded icons (red = alert, green = positive)
- ✅ Layer 2: 4 key metrics (not 8+), chunked in cards
- ✅ Layer 3: Context provided (subtitle explains significance)
- ✅ Rule of Three: Can grasp all 4 in one glance (paired semantically)
- ✅ Numbers formatted with commas (reduces reading tax)

---

## Common Patterns Summary

| Pattern | Layer | Implementation |
|---------|-------|----------------|
| Risk indicator | 1 | Color dot (8px, red/green) |
| Status badge | 1 | Background color + weight |
| Filter pills | 2 | Max 3, chunked semantically |
| Progressive disclosure | 3 | Show on click, hide by default |
| Distance metric | 2 | Formatted (km/m), not coordinates |
| Icon + label | 2 | Icon processed Layer 1, label Layer 2 |
| Primary CTA | 2 | Large, colored, single option |
| Secondary action | 3 | Ghost button, muted color |
| Whitespace | 1 | Generous padding (p-6 to p-8) |
| Metric cards | 2+3 | Big number (L2) + context (L3) |

---

## Testing Checklist

For each component:

```tsx
// Blur Test (Layer 1)
// Screenshot → Blur → Can you identify priority/risk?
✅ Color indicates status
✅ Size indicates importance
✅ Position indicates hierarchy

// 5-Second Test (Layer 2)
// Show to user for 5 seconds → Can they name:
✅ Component purpose
✅ Primary action
✅ Current state

// Cognitive Budget (Layer 3)
// Time interaction → Calculate bit cost
✅ (Seconds × 39 bps) justified by Surprisal value
✅ Non-obvious insight delivered
✅ User can act on information
```

---

## Quick Reference Commands

```bash
# When reviewing code:
1. Count visible options → Must be ≤ 3
2. Check color usage → Must encode data, not decoration
3. Test progressive disclosure → Details hidden until requested
4. Blur test → Priority visible without reading
5. Measure whitespace → p-6 to p-8 minimum between chunks
```

---

**Remember**: Code is cheap. User attention is expensive.  
Optimize for the scarce resource.
