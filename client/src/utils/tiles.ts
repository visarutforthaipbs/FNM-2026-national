/**
 * Basemap tile sources, shared by the main map and the location-correction
 * modal so the two can't drift apart.
 *
 * Switching from CARTO to Esri Canvas (Light/Dark Gray) & OpenStreetMap:
 * As of August 2026, CARTO requires an API key on raster tiles and watermarks
 * unauthenticated requests with "API KEY REQUIRED". Esri Canvas & OpenStreetMap
 * provide clean, reliable basemaps with no API key requirement or watermark.
 *
 * Esri's World_Imagery carries no place names, which makes it easy to get lost
 * in when you are looking for one specific roof. SATELLITE_LABELS_URL is a
 * transparent reference layer meant to be drawn on top of it — pair the two
 * whenever imagery is shown, or the viewer loses the road names they navigate by.
 * Similarly, Esri Canvas (Light & Dark) provides reference layers for place names & roads.
 */

// If a CARTO API key is provided via env, allow using CARTO with key;
// otherwise default to Esri Canvas with no API key requirement.
const cartoKey = import.meta.env.VITE_CARTO_API_KEY;

// GISTDA Sphere Map API Key (https://sphere.gistda.or.th)
const sphereKey =
  import.meta.env.VITE_SPHERE_API_KEY ||
  "9AB0F0CB83DC4C339E81C745A767401B";

export const HAS_SPHERE_KEY = Boolean(sphereKey);

export const TILE_URLS = {
  light: cartoKey
    ? `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=${cartoKey}`
    : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  dark: cartoKey
    ? `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${cartoKey}`
    : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  satellite:
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  openstreet: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  sphere_streets: `https://basemap.sphere.gistda.or.th/wmts/sphere_streets/GLOBAL_WEBMERCATOR/{z}/{x}/{y}.png?key=${sphereKey}`,
  sphere_hybrid: `https://basemap.sphere.gistda.or.th/wmts/sphere_hybrid/GLOBAL_WEBMERCATOR/{z}/{x}/{y}.jpeg?key=${sphereKey}`,
} as const;

export const TILE_ATTRIBUTIONS = {
  light: cartoKey
    ? '© <a href="https://carto.com/">CARTO</a>'
    : '© <a href="https://www.esri.com/">Esri</a>',
  dark: cartoKey
    ? '© <a href="https://carto.com/">CARTO</a>'
    : '© <a href="https://www.esri.com/">Esri</a>',
  satellite: '© <a href="https://www.esri.com/">Esri</a>',
  openstreet:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  sphere_streets:
    '© <a href="https://sphere.gistda.or.th/">GISTDA Sphere</a>',
  sphere_hybrid:
    '© <a href="https://sphere.gistda.or.th/">GISTDA Sphere</a>',
} as const;

/** Transparent reference layers (roads + place names) to overlay on basemaps */
export const TILE_LABELS_URLS: Record<keyof typeof TILE_URLS, string | null> = {
  light: cartoKey
    ? null
    : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  dark: cartoKey
    ? null
    : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  satellite:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  openstreet: null,
  sphere_streets: null,
  sphere_hybrid: null,
};

/** Transparent roads + place names, to overlay on satellite imagery. */
export const SATELLITE_LABELS_URL = TILE_LABELS_URLS.satellite!;

/**
 * Last zoom level each provider covers natively in Thailand.
 *
 * Esri Canvas (Light & Dark Gray) covers up to z16 in Thailand (z17+ returns 2,521-byte placeholder).
 * Esri World_Imagery covers up to z18 in Thailand (measured 2026-08-14).
 * OpenStreetMap covers up to z19.
 * GISTDA Sphere (Streets & Hybrid) covers up to z19 in Thailand.
 *
 * With maxNativeZoom, Leaflet upscales the sharp native tiles past these levels,
 * preventing grey "no data" placeholder grids.
 */
export const TILE_MAX_NATIVE_ZOOM: Record<keyof typeof TILE_URLS, number> = {
  light: cartoKey ? 19 : 16,
  dark: cartoKey ? 19 : 16,
  satellite: 18,
  openstreet: 19,
  sphere_streets: 19,
  sphere_hybrid: 19,
};

export const SATELLITE_MAX_NATIVE_ZOOM = TILE_MAX_NATIVE_ZOOM.satellite;

export type TileStyle = keyof typeof TILE_URLS;
