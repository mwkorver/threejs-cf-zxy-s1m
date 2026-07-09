/**
 * Browser tile loading (engine-agnostic). Fetches WebP tiles from the tiler
 * (or baked static dir) and decodes terrain to elevations via the shared
 * Terrarium decoder. Imagery stays an ImageBitmap the engine uploads directly.
 */

import { decodeTerrarium } from "./terrarium";
import type { TileId } from "./mercator";

export interface TileManifest {
  layer: string;
  year: number;
  z: number;
  x: [number, number];
  y: [number, number];
  center: { lat: number; lon: number };
}

async function bitmapToRgba(bmp: ImageBitmap): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { rgba: data, w: bmp.width, h: bmp.height };
}

/** Decoded terrain elevations (true meters), row-major, north-first. */
export async function loadTerrain(baseUrl: string, t: TileId): Promise<Float32Array> {
  const res = await fetch(`${baseUrl}/terrain/${t.z}/${t.x}/${t.y}.webp`);
  if (!res.ok) throw new Error(`terrain ${t.z}/${t.x}/${t.y}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const { rgba, w, h } = await bitmapToRgba(bmp);
  bmp.close();
  return decodeTerrarium(rgba, w, h);
}

/** Imagery tile as an ImageBitmap ready for GPU upload. */
export async function loadImagery(
  baseUrl: string,
  layer: string,
  year: number,
  t: TileId,
): Promise<ImageBitmap> {
  const res = await fetch(`${baseUrl}/imagery/${layer}/${year}/${t.z}/${t.x}/${t.y}.webp`);
  if (!res.ok) throw new Error(`imagery ${t.z}/${t.x}/${t.y}: ${res.status}`);
  return createImageBitmap(await res.blob());
}

export async function loadManifest(baseUrl: string): Promise<TileManifest> {
  const res = await fetch(`${baseUrl}/manifest.json`);
  if (!res.ok) throw new Error(`manifest: ${res.status}`);
  return res.json();
}
