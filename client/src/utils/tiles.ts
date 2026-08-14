/**
 * Basemap tile sources, shared by the main map and the location-correction
 * modal so the two can't drift apart.
 *
 * Esri's World_Imagery carries no place names, which makes it easy to get lost
 * in when you are looking for one specific roof. SATELLITE_LABELS_URL is a
 * transparent reference layer meant to be drawn on top of it — pair the two
 * whenever imagery is shown, or the viewer loses the road names they navigate by.
 */
export const TILE_URLS = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
  satellite:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  openstreet: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
} as const;

export const TILE_ATTRIBUTIONS = {
  light: '© <a href="https://carto.com/">CARTO</a>',
  dark: '© <a href="https://carto.com/">CARTO</a>',
  satellite: '© <a href="https://www.esri.com/">Esri</a>',
  openstreet:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
} as const;

/** Transparent roads + place names, to overlay on satellite imagery. */
export const SATELLITE_LABELS_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

/**
 * Last zoom level Esri covers everywhere in Thailand.
 *
 * Measured 2026-08-14 against server.arcgisonline.com: z18 returns real imagery
 * nationwide (~12 KB/tile rural). At z19 only dense urban areas do — Bangkok
 * returns 15.5 KB, while rural Prachinburi and Mae Hong Son both return exactly
 * 2,521 bytes, which is Esri's "no data available" placeholder rather than an
 * error. z20 is that placeholder everywhere tested.
 *
 * A 200 carrying a placeholder is invisible to normal error handling, so the cap
 * matters: with maxNativeZoom Leaflet upscales the sharp z18 tile past this
 * level, instead of covering rural Thailand in Esri's grey "no data" grid.
 * Re-measure before raising it.
 */
export const SATELLITE_MAX_NATIVE_ZOOM = 18;

export type TileStyle = keyof typeof TILE_URLS;
