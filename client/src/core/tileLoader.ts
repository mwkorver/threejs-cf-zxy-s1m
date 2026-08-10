/**
 * Browser tile loading (engine-agnostic). Fetches WebP tiles from the tiler
 * (or baked static dir) and decodes terrain to elevations via the shared
 * Terrarium decoder. Imagery stays an ImageBitmap the engine uploads directly.
 */

import { decodeTerrarium } from "./terrarium";
import { type TileId } from "./mercator";
import { withKey } from "./tileKey";
import {
  basemapRequest,
  cogImageryRequest,
  imageryRequest,
  osmRequest,
  terrainRequest,
  type ImageryRouting,
} from "./tileUrls";

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
  const { url, label } = terrainRequest(baseUrl, t);
  const res = await fetchTile(url, label);
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
  const { url, label } = cogImageryRequest(baseUrl, layer, year, t);
  const res = await fetchTile(url, label);
  return createImageBitmap(await res.blob());
}

/** Low-zoom basemap: 512px rendered by the tiler from the USGS NAIP service.
 *  Used where the COG tiler is slow/coverage-capped. */
export async function loadImageryExternal(baseUrl: string, t: TileId): Promise<ImageBitmap> {
  const { url, label } = basemapRequest(baseUrl, t);
  const res = await fetchTile(url, label);
  return createImageBitmap(await res.blob());
}

/** Imagery from the official OpenStreetMap tile server (third-party: the
 *  access key is never attached — see tileUrls.osmRequest). */
export async function loadImageryOSM(t: TileId): Promise<ImageBitmap> {
  const { url, label } = osmRequest(t);
  const res = await fetchTile(url, label);
  return createImageBitmap(await res.blob());
}

/**
 * Imagery for a tile, routed by the shared rule (OSM / basemap / COG mosaic).
 * This is what the main-thread fallback uses, so it exercises exactly the
 * routing the worker runs in the browser.
 */
export async function loadImageryFor(t: TileId, routing: ImageryRouting): Promise<ImageBitmap> {
  const { url, label } = imageryRequest(t, routing);
  const res = await fetchTile(url, label);
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
  // Discriminated on `type` rather than one loose `coordinates`, because the
  // two nest to different depths and the renderer loops accordingly: a Polygon
  // is rings, a MultiPolygon is polygons of rings. With `any` the two loops in
  // tileManager's footprint builder type-checked against each other, so
  // swapping them -- or dropping a level -- failed only at runtime, on data
  // that comes off the network.
  geometry:
    | { type: "Polygon"; coordinates: FootprintRing[] }
    | { type: "MultiPolygon"; coordinates: FootprintRing[][] };
}

/** GeoJSON linear ring: [lon, lat] positions. Elevation is never carried here. */
export type FootprintRing = [number, number][];

export interface FootprintCollection {
  type: "FeatureCollection";
  features: FootprintFeature[];
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
    fetchTile(withKey(`${baseUrl}/footprints/s1m.json`), "footprints s1m").then((r) => r.json()),
    fetchTile(withKey(`${baseUrl}/footprints/usgs13.json`), "footprints usgs13").then((r) => r.json()),
  ]);
  return {
    type: "FeatureCollection",
    features: [...(s1m.features ?? []), ...(usgs13.features ?? [])],
  };
}
