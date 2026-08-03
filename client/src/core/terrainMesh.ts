/**
 * Terrain tile -> regular-grid mesh with skirts.
 *
 * Server tiles are vanilla 512px Terrarium rasters, standard registration,
 * no overlap ring. Seam hiding is entirely this module's job: one extra
 * vertex ring copied from the edge and dropped by a per-zoom skirt height
 * handles both same-zoom hairline cracks and cross-LOD T-junctions.
 * O(perimeter) on an O(area) pass — generated in the same loop as the grid.
 *
 * World = Mercator meters, Z-up. Positions are emitted relative to the tile's
 * NW anchor as float32 (raw Mercator X for CONUS is ~1e7, where
 * float32 is ~1 m — useless against 8 cm imagery). Elevation is true meters
 * scaled by mercatorScale(lat): horizontal is stretched Mercator meters, so
 * vertical must match or slopes flatten.
 */

import {
  EARTH_CIRCUMFERENCE,
  mercatorScale,
  mercatorToLonLat,
  tileBoundsMercator,
  type TileId,
} from "./mercator";

export interface TerrainMesh {
  /** Tile-anchor-relative positions, float32 [x, y, z, ...]. Z-up. */
  positions: Float32Array;
  /** Texture coords into the tile's imagery, [u, v, ...] in [0,1]. */
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Mercator-meter NW anchor (float64) positions are relative to. */
  anchor: [number, number];
  tile: TileId;
  /** Vertices per side of the interior grid (skirt adds a ring beyond). */
  gridSize: number;
}

/**
 * Per-zoom skirt drop in world (Mercator) meters. Scales with the tile's
 * ground resolution so it stays visually constant across zooms: a few source
 * texels deep is enough to hide same-zoom cracks and LOD T-junctions without
 * a tall smeared wall on oblique low passes. Cesium's formula ties this to
 * geometric error; texel-proportional is the cheap
 * equivalent and easy to tune with one constant.
 */
export function skirtHeight(tile: TileId, tileSize = 512, texels = 4): number {
  const tileMeters = EARTH_CIRCUMFERENCE / 2 ** tile.z;
  return (tileMeters / tileSize) * texels;
}

/**
 * Flat sea-level quad for low zooms, where relief is subpixel anyway.
 * Replaces the whole terrain pipeline below TileManager.terrainMinZoom:
 * no terrain fetch, no grid, no skirts (coplanar neighbors can't crack).
 * Same TerrainMesh contract so the manager treats it like any tile.
 */
export function buildFlatMesh(tile: TileId): TerrainMesh {
  const b = tileBoundsMercator(tile);
  const anchor: [number, number] = [b.west, b.north]; // NW corner
  const tileW = b.east - b.west;
  const tileH = b.north - b.south;

  // 2x2 vertices: NW, NE, SW, SE (anchor-relative, Z-up, elevation 0).
  const positions = new Float32Array([
    0, 0, 0,
    tileW, 0, 0,
    0, -tileH, 0,
    tileW, -tileH, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
  // Up-normals: the shared hillshade formula then shades flat tiles exactly
  // like flat ground inside terrain tiles, so no brightness step at the
  // flat->terrain boundary.
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  // Same +Z winding as the interior grid triangles above.
  const indices = new Uint32Array([0, 2, 1, 1, 2, 3]);

  return { positions, uvs, normals, indices, anchor, tile, gridSize: 2 };
}

/**
 * @param heights  decoded Terrarium elevations (true meters), row-major,
 *                 length tileSize*tileSize (row 0 = north edge).
 * @param gridStep vertices every N source texels; LOD manager picks per SSE.
 */
export function buildTerrainMesh(
  heights: Float32Array,
  tile: TileId,
  gridStep = 8,
  tileSize = 512,
): TerrainMesh {
  const b = tileBoundsMercator(tile);
  const anchor: [number, number] = [b.west, b.north]; // NW corner
  const tileW = b.east - b.west;
  const tileH = b.north - b.south;

  // Ground-meter -> Mercator-meter vertical scale, evaluated once per tile at
  // its center latitude.
  const [, centerLat] = mercatorToLonLat((b.west + b.east) / 2, (b.north + b.south) / 2);
  const zScale = mercatorScale(centerLat);

  const n = Math.floor(tileSize / gridStep); // quads per side
  const g = n + 1; // interior vertices per side
  const sampleAt = (i: number) => Math.min(i * gridStep, tileSize - 1);

  // Interior grid + a perimeter skirt ring. Skirt verts duplicate the edge
  // ring's XY/UV but sit zScale*skirt below, so they render as vertical walls.
  const skirtDrop = skirtHeight(tile, tileSize) * zScale;
  const edgeCount = g * 4 - 4;
  const vertCount = g * g + edgeCount;

  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const normals = new Float32Array(vertCount * 3);

  // Step size in ground meters for normal calculations
  const dx_ground = tileW / (n * zScale);
  const dy_ground = tileH / (n * zScale);

  const setVert = (vi: number, col: number, row: number, dz: number) => {
    const u = col / n;
    const v = row / n;
    const h = heights[sampleAt(row) * tileSize + sampleAt(col)] ?? 0;
    positions[vi * 3] = u * tileW; // X east, anchor-relative
    positions[vi * 3 + 1] = -v * tileH; // Y north (row grows south -> negative)
    positions[vi * 3 + 2] = h * zScale - dz; // Z up
    uvs[vi * 2] = u;
    uvs[vi * 2 + 1] = v;
  };

  // Interior vertices, row-major.
  for (let row = 0; row <= n; row++) {
    for (let col = 0; col <= n; col++) {
      const vi = row * g + col;
      setVert(vi, col, row, 0);

      // Compute true unexaggerated normal at this vertex using central differences
      const colLeft = Math.max(0, col - 1);
      const colRight = Math.min(n, col + 1);
      const rowTop = Math.max(0, row - 1);
      const rowBottom = Math.min(n, row + 1);

      const hLeft = heights[sampleAt(row) * tileSize + sampleAt(colLeft)] ?? 0;
      const hRight = heights[sampleAt(row) * tileSize + sampleAt(colRight)] ?? 0;
      const hTop = heights[sampleAt(rowTop) * tileSize + sampleAt(col)] ?? 0;
      const hBottom = heights[sampleAt(rowBottom) * tileSize + sampleAt(col)] ?? 0;

      const distX = (colRight - colLeft) * dx_ground;
      const distY = (rowBottom - rowTop) * dy_ground;

      const slopeX = distX > 0 ? (hRight - hLeft) / distX : 0;
      const slopeY = distY > 0 ? (hTop - hBottom) / distY : 0;

      // Tangents: T_x = (1, 0, slopeX), T_y = (0, 1, slopeY)
      // Normal: T_x x T_y = (-slopeX, -slopeY, 1)
      const len = Math.sqrt(slopeX * slopeX + slopeY * slopeY + 1.0);
      normals[vi * 3] = -slopeX / len;
      normals[vi * 3 + 1] = -slopeY / len;
      normals[vi * 3 + 2] = 1.0 / len;
    }
  }

  const interiorIdx = (col: number, row: number) => row * g + col;

  // Interior triangles (two per quad).
  const quadTris = n * n * 6;
  const skirtTris = edgeCount * 6; // one quad per edge segment
  const indices = new Uint32Array(quadTris + skirtTris);
  let k = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const a = interiorIdx(col, row);
      const bb = interiorIdx(col + 1, row);
      const c = interiorIdx(col, row + 1);
      const d = interiorIdx(col + 1, row + 1);
      indices[k++] = a; indices[k++] = c; indices[k++] = bb;
      indices[k++] = bb; indices[k++] = c; indices[k++] = d;
    }
  }

  // Perimeter ring, clockwise from NW: top edge L->R, right T->B, bottom R->L,
  // left B->T. Each skirt vertex mirrors an interior edge vertex, dropped.
  const ring: number[] = [];
  for (let col = 0; col < g; col++) ring.push(interiorIdx(col, 0));
  for (let row = 1; row < g; row++) ring.push(interiorIdx(g - 1, row));
  for (let col = g - 2; col >= 0; col--) ring.push(interiorIdx(col, g - 1));
  for (let row = g - 2; row >= 1; row--) ring.push(interiorIdx(0, row));

  let skirtBase = g * g;
  for (let e = 0; e < ring.length; e++) {
    const top = ring[e]!;
    // Copy the edge vertex's XY/UV, drop Z.
    positions[skirtBase * 3] = positions[top * 3]!;
    positions[skirtBase * 3 + 1] = positions[top * 3 + 1]!;
    positions[skirtBase * 3 + 2] = positions[top * 3 + 2]! - skirtDrop;
    uvs[skirtBase * 2] = uvs[top * 2]!;
    uvs[skirtBase * 2 + 1] = uvs[top * 2 + 1]!;

    // Copy the true normal to the skirt vertex
    normals[skirtBase * 3] = normals[top * 3]!;
    normals[skirtBase * 3 + 1] = normals[top * 3 + 1]!;
    normals[skirtBase * 3 + 2] = normals[top * 3 + 2]!;

    skirtBase++;
  }

  // Skirt wall triangles connecting each edge segment to its dropped pair.
  for (let e = 0; e < ring.length; e++) {
    const next = (e + 1) % ring.length;
    const t0 = ring[e]!;
    const t1 = ring[next]!;
    const b0 = g * g + e;
    const b1 = g * g + next;
    indices[k++] = t0; indices[k++] = t1; indices[k++] = b0;
    indices[k++] = t1; indices[k++] = b1; indices[k++] = b0;
  }

  return { positions, uvs, normals, indices, anchor, tile, gridSize: g };
}
