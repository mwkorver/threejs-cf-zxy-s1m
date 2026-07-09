/**
 * Shared scene load for the engine spikes (plan §10.2): fetch the baked block
 * and build the CPU meshes ONCE, identically, so each engine differs only in
 * how it uploads and draws them. Keeps the perf comparison honest.
 */

import { buildTerrainMesh, type TerrainMesh } from "../../core/terrainMesh";
import { tileBoundsMercator } from "../../core/mercator";
import { loadImagery, loadManifest, loadTerrain } from "../../core/tileLoader";
import type { PathConfig } from "./flightPath";

const BASE = "/tiles";
export const GRID_STEP = 4; // 128x128 quads/tile — real load for the benchmark
export const VERTICAL_EXAGGERATION = 4;

export interface BlockTile {
  mesh: TerrainMesh;
  imagery: ImageBitmap | null;
  /** World-space offset (Mercator meters, relative to world anchor), Z-up. */
  offset: [number, number];
}

export interface Block {
  tiles: BlockTile[];
  worldAnchor: [number, number];
  tileW: number;
  path: PathConfig;
  label: string;
}

export async function loadBlock(): Promise<Block> {
  const m = await loadManifest(BASE);
  const cx = Math.floor((m.x[0] + m.x[1]) / 2);
  const cy = Math.floor((m.y[0] + m.y[1]) / 2);
  const cb = tileBoundsMercator({ z: m.z, x: cx, y: cy });
  const worldAnchor: [number, number] = [cb.west, cb.north];
  const tileW = cb.east - cb.west;

  const tiles: BlockTile[] = [];
  const jobs: Promise<void>[] = [];
  for (let x = m.x[0]; x <= m.x[1]; x++) {
    for (let y = m.y[0]; y <= m.y[1]; y++) {
      const t = { z: m.z, x, y };
      jobs.push(
        (async () => {
          const [heights, imagery] = await Promise.all([
            loadTerrain(BASE, t),
            loadImagery(BASE, m.layer, m.year, t).catch(() => null),
          ]);
          const mesh = buildTerrainMesh(heights, t, GRID_STEP);
          tiles.push({ mesh, imagery, offset: [mesh.anchor[0] - worldAnchor[0], mesh.anchor[1] - worldAnchor[1]] });
        })(),
      );
    }
  }
  await Promise.allSettled(jobs);

  const nx = m.x[1] - m.x[0] + 1;
  const ny = m.y[1] - m.y[0] + 1;
  const path: PathConfig = {
    centerX: (nx / 2) * tileW,
    centerY: -(ny / 2) * tileW,
    radius: Math.max(nx, ny) * tileW * 0.9,
    minH: tileW * 0.4,
    maxH: tileW * 2.0,
  };
  return { tiles, worldAnchor, tileW, path, label: `${m.layer} ${m.year} z${m.z} · ${tiles.length} tiles` };
}
