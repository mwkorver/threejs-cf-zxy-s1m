/**
 * Terrarium Terrain-RGB decode (settled: Terrarium, not Mapbox Terrain-RGB).
 *
 *   elevation = (R * 256 + G + B / 256) - 32768
 *
 * One decoder for the whole planet: S1M near-field tiles and
 * elevation-tiles-prod far-field tiles use the same packing by design.
 * In the render path this runs in the vertex shader; this CPU version is
 * for mesh building and height sampling (building seating).
 */

export const TERRARIUM_OFFSET = 32768;

/** Decode one RGBA pixel (as from ImageData) to elevation in meters. */
export function decodeTerrariumPixel(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - TERRARIUM_OFFSET;
}

/** Decode an RGBA buffer (width*height*4) to a Float32Array of elevations. */
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = rgba[o]! * 256 + rgba[o + 1]! + rgba[o + 2]! / 256 - TERRARIUM_OFFSET;
  }
  return out;
}
