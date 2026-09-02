import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { TileManager } from "./tileManager";
import { BundleCache } from "./bundleCache";
import { BuildingCache } from "./buildingCache";
import { tileKey, tileBoundsMercator, EARTH_CIRCUMFERENCE, type TileId } from "./mercator";
import type { BuildingRecord } from "./buildingMesh";

vi.mock("./tileLoader", () => ({
  loadTerrain: vi.fn(() =>
    Promise.resolve({ heights: new Float32Array(512 * 512), demSource: "farfield" }),
  ),
  loadImageryFor: vi.fn(() => Promise.resolve(null)),
  loadStaticFootprints: vi.fn(() =>
    Promise.resolve({ type: "FeatureCollection", features: [] }),
  ),
}));

/** One building, in the target tile's local metre frame. */
function record(x0: number, y0: number, x1: number, y1: number): BuildingRecord {
  return {
    id: "b1",
    height: 50,
    centroid: [(x0 + x1) / 2, (y0 + y1) / 2],
    bbox: [x0, y0, x1, y1],
    polygons: [[[x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]]],
  };
}

/** A node already drawn from a bundle, as the LOD would leave it. */
function loadedNode(tm: TileManager, tile: TileId, cache: BundleCache) {
  const grid = 8;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(grid * grid * 3), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(grid * grid * 2), 2));
  geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(grid * grid * 3), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));

  const bundle: any = {
    key: tileKey(tile), bytes: 1024, geometry: geom, gridSize: grid,
    centerElevation: 0, demSource: "farfield", minElevation: 0, maxElevation: 1,
  };
  cache.put(bundle);

  const bounds = tileBoundsMercator(tile);
  const node: any = {
    key: tileKey(tile), tile, bounds,
    centerMercator: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
    loading: false, loaded: true, visible: true,
  };
  (tm as any).createMeshFromBundle(node, bundle);
  return node;
}

function makeTm(cache: BundleCache): TileManager {
  const tm = new TileManager(
    "http://t", "l", 2023, new THREE.Scene(), cache, [0, 0], 12, 18, 2.2, false,
  );
  tm.showBuildings = true;
  return tm;
}

// A z15 tile drawn before its z14 source delivered footprints.
const Z15: TileId = { z: 15, x: 19294, y: 24626 };
const SOURCE = BuildingCache.sourceTileFor(Z15, 14);
const SPAN15 = EARTH_CIRCUMFERENCE / 2 ** 15;
const RECS = [record(SPAN15 * 0.4, -SPAN15 * 0.6, SPAN15 * 0.6, -SPAN15 * 0.4)];

describe("buildings arriving after the tile was drawn", () => {
  it("extrudes onto a tile whose bundle is still cached", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    const node = loadedNode(tm, Z15, cache);
    expect(node.mesh.getObjectByName("buildingMesh")).toBeUndefined();

    (tm as any).rootNodes.set("r", { key: "r", tile: SOURCE, children: [node] });
    (tm as any).buildings.cache.put(SOURCE, RECS);
    (tm as any).buildings.attachPending(SOURCE);

    expect(node.mesh.getObjectByName("buildingMesh")).toBeDefined();
  });

  // A mesh outlives its bundle: eviction spares only PINNED keys, so a loaded
  // node that is currently hidden keeps its mesh while its bundle goes. The old
  // path asked BundleCache for that bundle and silently gave up without it.
  it("extrudes onto a tile whose bundle has been evicted", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    const node = loadedNode(tm, Z15, cache);

    cache.setByteBudget(0, new Set()); // nothing pinned: the bundle goes
    expect(cache.get(tileKey(Z15))).toBeUndefined();

    (tm as any).rootNodes.set("r", { key: "r", tile: SOURCE, children: [node] });
    (tm as any).buildings.cache.put(SOURCE, RECS);
    (tm as any).buildings.attachPending(SOURCE);

    expect(node.mesh.getObjectByName("buildingMesh")).toBeDefined();
  });

  // A base-zoom change parks whole subtrees in transitionNodes, and those tiles
  // are on screen like any other. The walk used to start only from rootNodes.
  it("extrudes onto a tile parked in transitionNodes", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    const node = loadedNode(tm, Z15, cache);

    (tm as any).transitionNodes.set("t", { key: "t", tile: SOURCE, children: [node] });
    (tm as any).buildings.cache.put(SOURCE, RECS);
    (tm as any).buildings.attachPending(SOURCE);

    expect(node.mesh.getObjectByName("buildingMesh")).toBeDefined();
  });
});

describe("source tile whose footprints aged out of BuildingCache", () => {
  // BuildingCache holds 64 source tiles; BundleCache holds hundreds of MB. The
  // records age out first, and the bundle short-circuit meant the /buildings
  // request was never reissued -- so every finer tile over that ground drew
  // nothing for as long as the terrain bundle lived.
  it("goes back to the worker instead of serving the cached bundle", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    const node = loadedNode(tm, SOURCE, cache);
    node.loaded = false; // re-entering view

    expect((tm as any).buildings.cache.has(SOURCE)).toBe(false);
    expect(cache.get(tileKey(SOURCE))).toBeDefined(); // terrain still warm

    (tm as any).triggerLoad(node, 0);

    expect(node.loading).toBe(true); // worker consulted
    expect(node.loaded).toBe(false); // not served from the bundle
  });

  it("still serves from the bundle once the footprints are cached", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    const node = loadedNode(tm, SOURCE, cache);
    node.loaded = false;

    (tm as any).buildings.cache.put(SOURCE, RECS);
    (tm as any).triggerLoad(node, 0);

    expect(node.loaded).toBe(true); // short-circuit intact
    expect(node.loading).toBe(false);
  });

  it("still serves from the bundle when buildings are off", () => {
    const cache = new BundleCache(512 * 1024 * 1024);
    const tm = makeTm(cache);
    tm.showBuildings = false;
    const node = loadedNode(tm, SOURCE, cache);
    node.loaded = false;

    (tm as any).triggerLoad(node, 0);

    expect(node.loaded).toBe(true); // no needless refetch
  });
});
