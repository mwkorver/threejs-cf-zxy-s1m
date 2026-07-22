/**
 * Single source of truth for tile URLs and imagery-source routing.
 *
 * These strings and the "which upstream serves this tile" rule used to be
 * copied across three call sites: the worker (what the browser actually runs),
 * the main-thread fallback (what the tests actually exercise), and the baked
 * debug letter. Production and the test suite therefore ran *different* copies
 * of the same logic, so a change to one could drift from the others silently —
 * including the letter claiming a source the fetch didn't use. Everything
 * routes through here now, so the tests cover the production rule.
 *
 * Applying the access key is centralized here too: withKey() belongs on OUR
 * CDN endpoints and must never be attached to a third-party server (OSM),
 * which would leak it into their logs. One place to get that right.
 */

import { type TileId } from "./mercator";
import { withKey } from "./tileKey";

export type ImagerySource = "satellite" | "osm";

/** Which upstream actually serves a tile's imagery. */
export type ImageryKind = "osm" | "basemap" | "imagery";

/** A tile fetch: the URL, plus the label used in error messages. */
export interface TileRequest {
  url: string;
  label: string;
}

export interface ImageryRouting {
  baseUrl: string;
  layer: string;
  year: number;
  imagerySource?: ImagerySource;
  /** z <= this uses the USDA basemap stitch; deeper zooms use the COG mosaic. */
  externalImageryMaxZoom: number;
}

/**
 * THE imagery routing rule. At/below externalImageryMaxZoom imagery comes from
 * the USDA NAIP ImageServer stitch (the COG mosaic is slow and coverage-capped
 * at low zoom); deeper zooms come from the NAIP COG mosaic. OSM overrides both.
 */
export function resolveImageryKind(
  z: number,
  imagerySource: ImagerySource | undefined,
  externalImageryMaxZoom: number,
): ImageryKind {
  if (imagerySource === "osm") return "osm";
  return z <= externalImageryMaxZoom ? "basemap" : "imagery";
}

/**
 * Terrain tile. Path-only: which DEM band serves a zoom is tiler config
 * (TILER_USGS_MIN_ZOOM / TILER_S1M_MIN_ZOOM), not a per-request parameter.
 */
export function terrainRequest(baseUrl: string, t: TileId): TileRequest {
  return {
    url: withKey(`${baseUrl}/terrain/${t.z}/${t.x}/${t.y}.webp`),
    label: `terrain ${t.z}/${t.x}/${t.y}`,
  };
}

/** NAIP COG mosaic imagery (high zoom), rendered by the tiler Lambda. */
export function cogImageryRequest(baseUrl: string, layer: string, year: number, t: TileId): TileRequest {
  return {
    url: withKey(`${baseUrl}/imagery/${layer}/${year}/${t.z}/${t.x}/${t.y}.webp`),
    label: `imagery ${t.z}/${t.x}/${t.y}`,
  };
}

/** Low-zoom basemap: the tiler stitches 4 USDA NAIP cache children into 512px. */
export function basemapRequest(baseUrl: string, t: TileId): TileRequest {
  return {
    url: withKey(`${baseUrl}/basemap/${t.z}/${t.x}/${t.y}.webp`),
    label: `basemap ${t.z}/${t.x}/${t.y}`,
  };
}

/** OpenStreetMap raster tiles. Third-party: never carries the access key. */
export function osmRequest(t: TileId): TileRequest {
  return {
    url: `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`,
    label: `osm ${t.z}/${t.x}/${t.y}`,
  };
}

/** The imagery request for a tile, routed by resolveImageryKind. */
export function imageryRequest(t: TileId, o: ImageryRouting): TileRequest {
  switch (resolveImageryKind(t.z, o.imagerySource, o.externalImageryMaxZoom)) {
    case "osm":
      return osmRequest(t);
    case "basemap":
      return basemapRequest(o.baseUrl, t);
    default:
      return cogImageryRequest(o.baseUrl, o.layer, o.year, t);
  }
}
