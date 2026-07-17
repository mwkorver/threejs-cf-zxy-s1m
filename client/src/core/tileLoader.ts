/**
 * Browser tile loading (engine-agnostic). Fetches WebP tiles from the tiler
 * (or baked static dir) and decodes terrain to elevations via the shared
 * Terrarium decoder. Imagery stays an ImageBitmap the engine uploads directly.
 */

import { decodeTerrarium } from "./terrarium";
import { tileBoundsMercator, type TileId } from "./mercator";

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
export async function loadTerrain(
  baseUrl: string,
  t: TileId,
  usgsMinZoom?: number,
  s1mMinZoom?: number
): Promise<DecodedTerrain> {
  let url = `${baseUrl}/terrain/${t.z}/${t.x}/${t.y}.webp`;
  const params = [];
  if (usgsMinZoom !== undefined && usgsMinZoom !== null) params.push(`usgs_min_zoom=${usgsMinZoom}`);
  if (s1mMinZoom !== undefined && s1mMinZoom !== null) params.push(`s1m_min_zoom=${s1mMinZoom}`);
  if (params.length > 0) url += `?${params.join("&")}`;

  const res = await fetchTile(url, `terrain ${t.z}/${t.x}/${t.y}`);
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

/** Imagery from the USGS Imagery Only Tile Server (directly fetching pre-cached XYZ tiles).
 *  Used for low zooms where the COG tiler is slow/coverage-capped. */
export async function loadImageryExternal(baseUrl: string, t: TileId): Promise<ImageBitmap> {
  // 512px basemap stitched by the tiler from USDA NAIP cache children.
  const res = await fetchTile(`${baseUrl}/basemap/${t.z}/${t.x}/${t.y}.webp`, `basemap ${t.z}/${t.x}/${t.y}`);
  return createImageBitmap(await res.blob());
}

/** Imagery from the official OpenStreetMap tile server. */
export async function loadImageryOSM(t: TileId): Promise<ImageBitmap> {
  const url = `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
  const res = await fetchTile(url, `osm ${t.z}/${t.x}/${t.y}`);
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

/**
 * Fetch the two static, immutable footprint files (s1m + usgs13) and merge them.
 *
 * The whole CONUS dataset is ~360 KB gzipped, so rather than tile the footprints
 * or run a per-viewport query on every camera move, the client pulls both files
 * once and clips client-side. They're served straight from S3 via CloudFront
 * (path-only, immutable) — see tiler/scripts/build_footprints.py. Kept as two
 * files because usgs13 is static while s1m grows.
 */
export async function loadStaticFootprints(baseUrl: string): Promise<FootprintCollection> {
  const [s1m, usgs13] = await Promise.all([
    fetchTile(`${baseUrl}/footprints/s1m.json`, "footprints s1m").then((r) => r.json()),
    fetchTile(`${baseUrl}/footprints/usgs13.json`, "footprints usgs13").then((r) => r.json()),
  ]);
  return {
    type: "FeatureCollection",
    features: [...(s1m.features ?? []), ...(usgs13.features ?? [])],
  };
}
