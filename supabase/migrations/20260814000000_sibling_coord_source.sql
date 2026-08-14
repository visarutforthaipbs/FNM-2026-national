-- Add 'sibling' as a coord_source: the factory had no coordinate of its own,
-- so it inherited the exact position of another licence at the SAME address
-- (same province/district/tambon/address_full).
--
-- Why this exists: ~2% of operating licences sit on a site that holds more
-- than one licence (one plant, several ทะเบียนโรงงาน — e.g. a waste operator
-- licensed separately for คัดแยก 105 and รีไซเคิล 106). When only one of the
-- licences carried a government coordinate, the others fell through to the
-- Longdo geocoder or the tambon centroid and landed up to 99 km away from
-- their own address twin. Inheriting the co-located coordinate is free, needs
-- no API quota, and is strictly more accurate than either fallback.
--
-- Treated as exact (no approximate badge — see export_markers.py QUALITY_FLAGS,
-- which flags only 'geocoded'/'centroid'). Deliberately NOT added to the
-- PROTECTED list in pipeline.py apply_gov_coordinates: an inherited position is
-- a stand-in for missing government data, so a real DIW coordinate should
-- overwrite it, unlike a 'community' or 'admin' pin.

alter table public.factories drop constraint factories_coord_source_check;
alter table public.factories add constraint factories_coord_source_check
  check (coord_source in ('gov', 'repaired', 'geocoded', 'centroid', 'community', 'admin', 'sibling'));
