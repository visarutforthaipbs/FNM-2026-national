// Shared geospatial helpers

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two points in kilometers (haversine). */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const rLat1 = (lat1 * Math.PI) / 180;
  const rLat2 = (lat2 * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format a distance in km as Thai text ("450 ม." / "2.3 กม."). */
export function formatDistanceTh(km: number): string {
  return km < 1 ? `${(km * 1000).toFixed(0)} ม.` : `${km.toFixed(1)} กม.`;
}
