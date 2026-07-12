/**
 * Browser tile loading (engine-agnostic). Fetches WebP tiles from the tiler
 * (or baked static dir) and decodes terrain to elevations via the shared
 * Terrarium decoder. Imagery stays an ImageBitmap the engine uploads directly.
 */

import { decodeTerrarium } from "./terrarium";
import { tileBoundsMercator, type TileId } from "./mercator";

// USDA APFO NAIP ImageServer (CONUS). Serves a proper full-coverage NAIP mosaic
// via exportImage for an arbitrary Web-Mercator bbox — used for low zooms where
// the COG tiler is slow and coverage-capped. CORS is open, so fetch direct.
const USDA_IMAGESERVER =
  "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME/ImageServer";

export interface TileManifest {
  layer: string;
  year: number;
  z: number;
  x: [number, number];
  y: [number, number];
  center: { lat: number; lon: number };
}

/**
 * Fetch a tile, absorbing transient throttling. Cold tiles 429 when the tiler
 * hits its concurrency cap (each cold render holds a Lambda slot ~7s); the tile
 * is there, just not rendered yet. Retry 429/503 with exponential backoff +
 * jitter (honoring Retry-After if sent); 404 and other statuses are terminal.
 */
async function fetchTile(url: string, label: string, maxAttempts = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    const transient = res.status === 429 || res.status === 503;
    if (!transient || attempt >= maxAttempts - 1) {
      throw new Error(`${label}: ${res.status}`);
    }
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    const backoff = retryAfter > 0 ? retryAfter : 300 * 2 ** attempt * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, Math.min(backoff, 8000)));
  }
}

async function bitmapToRgba(bmp: ImageBitmap): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { rgba: data, w: bmp.width, h: bmp.height };
}

export interface DecodedTerrain {
  heights: Float32Array;
  demSource: string;
}

/** Decoded terrain elevations (true meters), row-major, north-first, plus the source DEM. */
export async function loadTerrain(baseUrl: string, t: TileId): Promise<DecodedTerrain> {
  const res = await fetchTile(`${baseUrl}/terrain/${t.z}/${t.x}/${t.y}.webp`, `terrain ${t.z}/${t.x}/${t.y}`);
  const demSource = res.headers.get("X-DEM-Source") || "farfield";
  const bmp = await createImageBitmap(await res.blob());
  const { rgba, w, h } = await bitmapToRgba(bmp);
  bmp.close();
  const heights = decodeTerrarium(rgba, w, h);
  return { heights, demSource };
}

/** Imagery tile as an ImageBitmap ready for GPU upload. */
export async function loadImagery(
  baseUrl: string,
  layer: string,
  year: number,
  t: TileId,
): Promise<ImageBitmap> {
  const res = await fetchTile(
    `${baseUrl}/imagery/${layer}/${year}/${t.z}/${t.x}/${t.y}.webp`,
    `imagery ${t.z}/${t.x}/${t.y}`,
  );
  return createImageBitmap(await res.blob());
}

/** Imagery from the USDA NAIP ImageServer (exportImage over the tile's 3857 bbox).
 *  Used for low zooms where the COG tiler is slow/coverage-capped. */
export async function loadImageryExternal(t: TileId): Promise<ImageBitmap> {
  const b = tileBoundsMercator(t);
  const url =
    `${USDA_IMAGESERVER}/exportImage?f=image&bboxSR=3857&imageSR=3857&size=512,512` +
    `&format=jpgpng&bbox=${b.west},${b.south},${b.east},${b.north}`;
  const res = await fetchTile(url, `usda ${t.z}/${t.x}/${t.y}`);
  return createImageBitmap(await res.blob());
}

export async function loadManifest(baseUrl: string): Promise<TileManifest> {
  const res = await fetch(`${baseUrl}/manifest.json`);
  if (!res.ok) throw new Error(`manifest: ${res.status}`);
  return res.json();
}

export interface FootprintFeature {
  type: "Feature";
  properties: {
    dataset: string;
    href: string;
    type?: string;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: any;
  };
}

export interface FootprintCollection {
  type: "FeatureCollection";
  features: FootprintFeature[];
}

export async function loadFootprints(baseUrl: string, t: TileId): Promise<FootprintCollection> {
  const res = await fetchTile(
    `${baseUrl}/terrain-footprints/${t.z}/${t.x}/${t.y}.json`,
    `footprints ${t.z}/${t.x}/${t.y}`
  );
  return res.json();
}

export async function loadViewportFootprints(
  baseUrl: string,
  west: number,
  south: number,
  east: number,
  north: number
): Promise<FootprintCollection> {
  const res = await fetchTile(
    `${baseUrl}/terrain-footprints/viewport/${west}/${south}/${east}/${north}`,
    `viewport footprints`
  );
  return res.json();
}
