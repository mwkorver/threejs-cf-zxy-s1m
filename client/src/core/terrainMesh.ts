/**
 * Terrain tile -> regular-grid mesh with skirts (plan §4.2, §5.3 — settled).
 *
 * Server tiles are vanilla 512px Terrarium rasters, standard registration,
 * no overlap ring. Seam hiding is entirely this module's job: one extra
 * vertex ring copied from the edge and dropped by a per-zoom skirt height
 * handles both same-zoom hairline cracks and cross-LOD T-junctions.
 * O(perimeter) on an O(area) pass — generated in the same loop as the grid.
 *
 * TODO(Phase 0):
 *  - buildTerrainMesh(heights, tile, gridStep): positions (tile-anchor-
 *    relative float32, plan §5.1), uvs, indices, + skirt ring.
 *  - skirtHeight(z): start from Cesium's published per-level geometric-error
 *    formula; tune against oblique low-pass views (texture-stretch risk).
 *  - Mercator Z: heights are true meters -> multiply by mercatorScale(lat)
 *    at the tile anchor before they enter world space.
 *  - sampleHeight(heights, u, v): bilinear — used for building seating
 *    (plan §4.3; never raycast the mesh, skirts would pollute hits).
 */

import type { TileId } from "./mercator";

export interface TerrainMesh {
  /** Tile-anchor-relative positions, float32 [x, y, z, ...]. */
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /** Mercator-meter anchor (float64) this mesh is relative to. */
  anchor: [number, number];
  tile: TileId;
}

export function buildTerrainMesh(
  _heights: Float32Array,
  _tile: TileId,
  _gridStep = 4, // vertices every N texels; LOD manager picks per SSE
): TerrainMesh {
  throw new Error("not implemented — Phase 0 step 4 (see module TODO)");
}
