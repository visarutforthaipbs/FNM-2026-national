-- Add 'admin' as a coord_source: a moderator manually verified and set a
-- factory's position (e.g. from the "unmapped factories" admin queue).
-- Treated as exact (no approximate badge, see export_markers.py), and
-- protected from the nightly gov sync the same way 'community' is
-- (see server/sync/pipeline.py apply_gov_coordinates).

alter table public.factories drop constraint factories_coord_source_check;
alter table public.factories add constraint factories_coord_source_check
  check (coord_source in ('gov', 'repaired', 'geocoded', 'centroid', 'community', 'admin'));
