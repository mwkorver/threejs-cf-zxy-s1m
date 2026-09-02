import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { TileManager, type TileNode } from "./tileManager";
import { BundleCache } from "./bundleCache";
import { BuildingCache } from "./buildingCache";
import { tileKey, tileBoundsMercator, type TileId } from "./mercator";
import type { BuildingRecord } from "./buildingMesh";
import type { TileLoadResult } from "./workerTypes";

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

vi.mock("./tileLoader", () => ({
  loadTerrain: vi.fn(() =>
    Promise.resolve({ heights: new Float32Array(512 * 512), demSource: "farfield" }),
  ),
  loadImageryFor: vi.fn(() => Promise.resolve(null)),
  loadStaticFootprints: vi.fn(() =>
    Promise.resolve({ type: "FeatureCollection", features: [] }),
  ),
}));

// A z16 tile and the z14 source that owns its buildings.
const Z16: TileId = { z: 16, x: 19299, y: 24629 };
const SOURCE = BuildingCache.sourceTileFor(Z16, 14);

/** One building covering the middle of the z16 tile, in source-tile metres. */
function records(): BuildingRecord[] {
  const span = 40075016.685578488 / 2 ** 14;
  // Offset of the z16 tile inside its z14 parent, so the footprint lands in it.
  const shift = Z16.z - 14;
  const sub = span / 2 ** shift;
  const ox = (Z16.x - (SOURCE.x << shift)) * sub;
  const oy = -(Z16.y - (SOURCE.y << shift)) * sub;
  const x0 = ox + sub * 0.4;
  const x1 = ox + sub * 0.6;
  const y0 = oy - sub * 0.6;
  const y1 = oy - sub * 0.4;
  return [
    {
      id: "b1",
      height: 40,
      centroid: [(x0 + x1) / 2, (y0 + y1) / 2],
      bbox: [x0, y0, x1, y1],
      polygons: [[[x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]]],
    },
  ];
}

function result(withBuildings: boolean): TileLoadResult {
  const g = 8;
  return {
    meshData: {
      positions: new Float32Array(g * g * 3),
      uvs: new Float32Array(g * g * 2),
      normals: new Float32Array(g * g * 3),
      indices: new Uint32Array([0, 1, 2]),
      // On meshData, not alongside it: buildBundleFromResult reads
      // meshData.gridSize, and a bundle without it leaves node.gridSize unset,
      // which attachPendingBuildings requires.
      gridSize: g,
    },
    demSource: "farfield",
    centerElevation: 0,
    minElevation: 0,
    maxElevation: 1,
    buildingRecords: withBuildings ? records() : null,
    imageBitmap: null,
    imageryPending: false,
    imageryCache: "unknown",
  } as unknown as TileLoadResult;
}

function makeTm(): TileManager {
  const tm = new TileManager(new THREE.Scene(), new BundleCache(512 * 1024 * 1024), {
    baseUrl: "http://t", layer: "l", year: 2023, worldAnchor: [0, 0],
    maxZoom: 18, cullTiles: false,
  });
  tm.showBuildings = true;
  tm.buildingSourceZoom = 14;
  return tm;
}

function node(tile: TileId): TileNode {
  const bounds = tileBoundsMercator(tile);
  return {
    key: tileKey(tile), tile, bounds,
    centerMercator: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
    loading: false, loaded: false, visible: false,
  };
}

/** Push `n` unrelated sources through the cache to age SOURCE out of its LRU. */
function floodCache(tm: TileManager, n: number): void {
  for (let i = 0; i < n; i++) {
    tm.buildings.recordResult({ z: 14, x: 1 + i, y: 1 }, records(), false);
  }
}

describe("a building source whose records are evicted while in use", () => {
  it("loses its buildings, and cannot get them back", async () => {
    const tm = makeTm();
    const pool = (tm as any).workerPool;
    // The worker only fetches buildings for a tile AT the source zoom, so the
    // stub answers the same way: records for z14, nothing for anything finer.
    pool.requestTile = vi.fn((t: TileId) => Promise.resolve(result(t.z === 14)));

    // The source is warm, so the z16 tile builds with its building.
    tm.buildings.recordResult(SOURCE, records(), false);
    const n = node(Z16);
    // Hang it off a root, as the LOD tree does -- attachPendingBuildings walks
    // down from rootNodes, so a standalone node would be unreachable.
    (tm as any).rootNodes.set("r", { ...node({ z: 14, x: SOURCE.x, y: SOURCE.y }), children: [n] });
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(n.mesh?.getObjectByName("buildingMesh"), "built while warm").toBeDefined();

    // Flight moves on. forTile only refreshes recency when a mesh is built, so
    // a source still on screen ages out once enough others have been built.
    floodCache(tm, 64);
    expect(tm.buildings.needsFootprintsFor(SOURCE)).toBe(true); // aged out

    // That tile is rebuilt later -- an LOD swap, a prune and reload, any of the
    // churn that happens constantly at speed.
    (tm as any).pruneNode(n);
    n.loaded = false;
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0)); // source fetch resolves a tick later

    // The z14 ancestor is subdivided and hidden, so nothing re-requests it, and
    // attachPendingBuildings only fires when records ARRIVE. This ground is now
    // permanently building-less however long you fly around.
    const requestedSource = pool.requestTile.mock.calls.some(
      (c: unknown[]) => (c[0] as TileId).z === 14,
    );
    expect(requestedSource, "nothing asks for the source again").toBe(true);
    expect(n.mesh?.getObjectByName("buildingMesh"), "buildings come back").toBeDefined();
  });
});

describe("a source tile whose buildings fetch failed", () => {
  /** A result where buildings came back null -- for the given reason. */
  function noRecords(failed: boolean): TileLoadResult {
    return { ...(result(false) as any), buildingsFailed: failed } as TileLoadResult;
  }

  const Z14: TileId = { z: 14, x: SOURCE.x, y: SOURCE.y };

  // Overture retired the release the manifest named, so every source tile
  // started answering with nothing. Recorded as "no buildings here", that would
  // have written emptiness over real cities and stopped the client asking for
  // the rest of the session -- outlasting the outage that caused it.
  it("is not recorded as empty ground", async () => {
    const tm = makeTm();
    (tm as any).workerPool.requestTile = vi.fn(() => Promise.resolve(noRecords(true)));

    const n = node(Z14);
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));

    // Still unknown, so the next tile over this ground will ask again.
    expect(tm.buildings.needsFootprintsFor(SOURCE)).toBe(true); // aged out
  });

  // The opposite case has to keep working, or ensureBuildingSource re-requests
  // open water on every mesh build forever.
  it("still records genuinely empty ground so the asking stops", async () => {
    const tm = makeTm();
    (tm as any).workerPool.requestTile = vi.fn(() => Promise.resolve(noRecords(false)));

    const n = node(Z14);
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));

    expect(tm.buildings.needsFootprintsFor(SOURCE)).toBe(false); // known
    expect(tm.buildings.needsFootprintsFor(Z14)).toBe(false); // known, and empty
  });
});
