/**
 * Shared scene load for the spikes/renderer: fetch a tile block and build the
 * CPU meshes once. Two sources:
 *
 * - live (default): the deployed CloudFront distribution — real streamed
 *   tiles, browser -> CDN -> tiler -> COGs. Block chosen by ?lat/?lon/?z/?grid.
 * - ?src=local: the baked block in client/public/tiles (bake.py), for offline
 *   dev and the perf benchmark (no network variance).
 */

import { buildTerrainMesh, type TerrainMesh } from "../../core/terrainMesh";
import { lonLatToMercator, mercatorToTile, tileBoundsMercator } from "../../core/mercator";
import { loadImagery, loadManifest, loadTerrain, type TileManifest } from "../../core/tileLoader";
import type { PathConfig } from "./flightPath";

// The deployed edge (infra/edge.yaml). CORS is applied at the distribution.
const LIVE_BASE = import.meta.env.VITE_TILE_BASE_URL ?? "https://d2ua3aiihdkajg.cloudfront.net";
const LOCAL_BASE = "/tiles";
export const VERTICAL_EXAGGERATION = 4;

// Load knobs, tunable via URL so the benchmark can be pushed past vsync without
// rebuilds: ?step=2 densifies the mesh (quads/tile = 512/step squared),
// ?rep=3 tiles the block into a rep x rep supergrid (draw-call/fill load).
const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
export const GRID_STEP = Number(params.get("step") ?? 4);
export const REPLICATE = Number(params.get("rep") ?? 1);

/** Live-mode manifest computed from URL params (defaults: the NJ corridor). */
function liveManifest(): TileManifest {
  const lat = Number(params.get("lat") ?? 40.48);
  const lon = Number(params.get("lon") ?? -74.66);
  const z = Number(params.get("z") ?? 14);
  const grid = Number(params.get("grid") ?? 4);
  const [mx, my] = lonLatToMercator(lon, lat);
  const c = mercatorToTile(mx, my, z);
  const half = Math.floor(grid / 2);
  return {
    layer: params.get("layer") ?? "naip-visualization",
    year: Number(params.get("year") ?? 2023),
    z,
    x: [c.x - half, c.x + grid - half - 1],
    y: [c.y - half, c.y + grid - half - 1],
    center: { lat, lon },
  };
}

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
  const local = params.get("src") === "local";
  const base = local ? LOCAL_BASE : LIVE_BASE;
  const m = local ? await loadManifest(LOCAL_BASE) : liveManifest();
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
          const [terrain, imagery] = await Promise.all([
            loadTerrain(base, t),
            loadImagery(base, m.layer, m.year, t).catch(() => null),
          ]);
          const mesh = buildTerrainMesh(terrain.heights, t, GRID_STEP);
          tiles.push({ mesh, imagery, offset: [mesh.anchor[0] - worldAnchor[0], mesh.anchor[1] - worldAnchor[1]] });
        })(),
      );
    }
  }
  await Promise.allSettled(jobs);

  const nx = m.x[1] - m.x[0] + 1;
  const ny = m.y[1] - m.y[0] + 1;

  // Replicate the baked block into a REPLICATE x REPLICATE supergrid to raise
  // draw-call and fill load. Meshes + imagery are shared by reference; each
  // engine still creates its own GPU objects, which is the point of the stress.
  if (REPLICATE > 1) {
    const base = tiles.slice();
    tiles.length = 0;
    for (let i = 0; i < REPLICATE; i++) {
      for (let j = 0; j < REPLICATE; j++) {
        for (const t of base) {
          tiles.push({
            mesh: t.mesh,
            imagery: t.imagery,
            offset: [t.offset[0] + i * nx * tileW, t.offset[1] - j * ny * tileW],
          });
        }
      }
    }
  }

  const gx = nx * REPLICATE;
  const gy = ny * REPLICATE;
  const path: PathConfig = {
    centerX: (gx / 2) * tileW,
    centerY: -(gy / 2) * tileW,
    radius: Math.max(gx, gy) * tileW * 0.9,
    minH: tileW * 0.4,
    maxH: tileW * 2.0,
  };
  const label = `${local ? "local" : "live·cdn"} · ${m.layer} ${m.year} z${m.z} · ${tiles.length} tiles · step ${GRID_STEP}`;
  return { tiles, worldAnchor, tileW, path, label };
}
