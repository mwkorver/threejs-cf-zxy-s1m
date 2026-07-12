import { describe, expect, it } from "vitest";
import { mercatorScale, mercatorToLonLat, tileBoundsMercator } from "./mercator";
import { buildTerrainMesh, skirtHeight } from "./terrainMesh";

const TILE = { z: 15, x: 9588, y: 12348 }; // central NJ

function flatHeights(v = 0): Float32Array {
  return new Float32Array(512 * 512).fill(v);
}

describe("buildTerrainMesh", () => {
  it("emits a consistent interior grid + skirt ring", () => {
    const m = buildTerrainMesh(flatHeights(), TILE, 8);
    const n = 512 / 8;
    const g = n + 1;
    const edge = g * 4 - 4;
    expect(m.gridSize).toBe(g);
    expect(m.positions.length).toBe((g * g + edge) * 3);
    expect(m.uvs.length).toBe((g * g + edge) * 2);
    expect(m.normals.length).toBe((g * g + edge) * 3);
    // quad tris + skirt tris
    expect(m.indices.length).toBe(n * n * 6 + edge * 6);
  });

  it("every index is in range", () => {
    const m = buildTerrainMesh(flatHeights(3), TILE, 16);
    const verts = m.positions.length / 3;
    for (const i of m.indices) expect(i).toBeLessThan(verts);
  });

  it("positions are anchor-relative and span the tile in Mercator meters", () => {
    const m = buildTerrainMesh(flatHeights(), TILE, 8);
    const b = tileBoundsMercator(TILE);
    expect(m.anchor).toEqual([b.west, b.north]);
    // interior X in [0, tileWidth], Y in [-tileHeight, 0]
    const w = b.east - b.west;
    const h = b.north - b.south;
    let maxX = 0, minY = 0;
    for (let i = 0; i < (m.gridSize * m.gridSize) * 3; i += 3) {
      maxX = Math.max(maxX, m.positions[i]!);
      minY = Math.min(minY, m.positions[i + 1]!);
    }
    expect(maxX).toBeCloseTo(w, 3);
    expect(minY).toBeCloseTo(-h, 3);
    // anchor-relative keeps values ~1e3 (one tile wide), not the ~1e7 of raw
    // Mercator X — that's what buys sub-meter float32 precision (plan §5.1).
    expect(maxX).toBeLessThan(2000);
  });

  it("scales elevation by sec(lat) so slopes survive the Mercator stretch", () => {
    const m = buildTerrainMesh(flatHeights(100), TILE, 32);
    const [, lat] = mercatorToLonLat(
      (tileBoundsMercator(TILE).west + tileBoundsMercator(TILE).east) / 2,
      (tileBoundsMercator(TILE).north + tileBoundsMercator(TILE).south) / 2,
    );
    const expectedZ = 100 * mercatorScale(lat);
    // an interior vertex Z (skirts come after g*g)
    expect(m.positions[2]).toBeCloseTo(expectedZ, 3);
  });

  it("skirt vertices sit below their edge twins", () => {
    const m = buildTerrainMesh(flatHeights(50), TILE, 16);
    const interior = m.gridSize * m.gridSize;
    const drop = skirtHeight(TILE) * mercatorScale(
      mercatorToLonLat(
        (tileBoundsMercator(TILE).west + tileBoundsMercator(TILE).east) / 2,
        (tileBoundsMercator(TILE).north + tileBoundsMercator(TILE).south) / 2,
      )[1],
    );
    // first skirt vertex mirrors the NW corner (interior index 0), dropped
    expect(m.positions[interior * 3]).toBeCloseTo(m.positions[0]!, 5); // same X
    expect(m.positions[interior * 3 + 2]).toBeCloseTo(m.positions[2]! - drop, 3);
  });

  it("uvs cover the full tile [0,1]", () => {
    const m = buildTerrainMesh(flatHeights(), TILE, 8);
    let uMax = 0, vMax = 0;
    for (let i = 0; i < m.gridSize * m.gridSize * 2; i += 2) {
      uMax = Math.max(uMax, m.uvs[i]!);
      vMax = Math.max(vMax, m.uvs[i + 1]!);
    }
    expect(uMax).toBeCloseTo(1, 6);
    expect(vMax).toBeCloseTo(1, 6);
  });
});
