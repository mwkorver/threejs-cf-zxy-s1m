import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { TileManager, type TileNode } from "./tileManager";
import { BundleCache } from "./bundleCache";
import { tileKey, tileBoundsMercator, type TileId } from "./mercator";
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

const TILE: TileId = { z: 9, x: 151, y: 192 };

function makeTm(): TileManager {
  return new TileManager(
    "http://t", "l", 2023, new THREE.Scene(), new BundleCache(512 * 1024 * 1024),
    [0, 0], 12, 18, 2.2, false,
  );
}

function node(): TileNode {
  const bounds = tileBoundsMercator(TILE);
  return {
    key: tileKey(TILE), tile: TILE, bounds,
    centerMercator: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
    loading: false, loaded: false, visible: false,
  };
}

/** A worker result carrying terrain but no imagery, as a 5xx now produces. */
function resultWithoutImagery(imageryPending: boolean): TileLoadResult {
  const g = 8;
  return {
    meshData: {
      positions: new Float32Array(g * g * 3),
      uvs: new Float32Array(g * g * 2),
      normals: new Float32Array(g * g * 3),
      indices: new Uint32Array([0, 1, 2]),
    },
    gridSize: g,
    demSource: "farfield",
    centerElevation: 0,
    minElevation: 0,
    maxElevation: 1,
    buildingRecords: null,
    imageBitmap: null,
    imageryPending,
  } as unknown as TileLoadResult;
}

/** Replace the worker pool's fetch with a canned outcome. */
function stubPool(tm: TileManager, outcome: () => Promise<TileLoadResult>) {
  const pool = (tm as any).workerPool;
  pool.requestTile = vi.fn(outcome);
  return pool.requestTile as ReturnType<typeof vi.fn>;
}

describe("imagery that fails transiently", () => {
  // The tile used to be thrown away wholesale, so an upstream 503 on one
  // basemap tile left no mesh at all -- a hole with the sky showing through.
  it("still draws the tile, and keeps it eligible for a retry", async () => {
    const tm = makeTm();
    stubPool(tm, () => Promise.resolve(resultWithoutImagery(true)));
    const n = node();

    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));

    expect(n.loaded).toBe(true); // terrain survived
    expect(n.mesh).toBeDefined(); // and there is something on screen
    expect(n.imageryPending).toBe(true); // but imagery is still owed
    expect(n.retryAfter).toBeGreaterThan(performance.now()); // paced, not hot
  });

  it("re-requests once the cooldown expires, and not before", async () => {
    const tm = makeTm();
    const request = stubPool(tm, () => Promise.resolve(resultWithoutImagery(true)));
    const n = node();

    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalledTimes(1);

    // Inside the cooldown: no second request.
    (tm as any).triggerLoad(n, 0);
    expect(request).toHaveBeenCalledTimes(1);

    // Past it: the tile tries again rather than settling for flat colour.
    n.retryAfter = performance.now() - 1;
    (tm as any).triggerLoad(n, 0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("gives up after a few attempts rather than billing forever", async () => {
    const tm = makeTm();
    const request = stubPool(tm, () => Promise.resolve(resultWithoutImagery(true)));
    const n = node();

    // Ten chances to retry, with the cooldown forced open every time.
    for (let i = 0; i < 10; i++) {
      n.retryAfter = performance.now() - 1;
      (tm as any).triggerLoad(n, 0);
      await new Promise((r) => setTimeout(r, 0));
    }

    // Still drawn, but no longer chasing an upstream that keeps failing. Each
    // of those requests costs up to five attempts inside fetchTile, against a
    // requester-pays bucket, so the cap is the point.
    expect(n.loaded).toBe(true);
    expect(n.imageryPending).toBe(false);
    expect(request.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("clears the pending state when imagery finally arrives", async () => {
    const tm = makeTm();
    let pending = true;
    stubPool(tm, () => Promise.resolve(resultWithoutImagery(pending)));
    const n = node();

    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(n.imageryPending).toBe(true);

    pending = false;
    n.retryAfter = performance.now() - 1;
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));

    expect(n.imageryPending).toBe(false);
    expect(n.retryAfter).toBeUndefined();
  });
});

describe("a tile whose load fails outright", () => {
  // retryAfter was declared, read by triggerLoad's guard, and cleared on
  // success -- but never assigned, so the cooldown did nothing and a failing
  // tile was re-requested every single frame.
  it("backs off instead of re-requesting every frame", async () => {
    const tm = makeTm();
    const request = stubPool(tm, () => Promise.reject(new Error("basemap: 503")));
    const n = node();

    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));

    expect(n.loading).toBe(false);
    expect(n.retryAfter).toBeGreaterThan(performance.now());

    // A second attempt in the same frame is refused by the cooldown.
    (tm as any).triggerLoad(n, 0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("rebuilding a node that already has a mesh", () => {
  // syncScene only ever adds/removes node.mesh, so a mesh left in the scene
  // when node.mesh is reassigned can never be removed again. It kept drawing
  // in the same footprint as its replacement -- the mottled z-fight the LOD
  // swap logic avoids everywhere else.
  it("leaves exactly one mesh in the scene", async () => {
    const tm = makeTm();
    const scene = (tm as any).scene as THREE.Scene;
    stubPool(tm, () => Promise.resolve(resultWithoutImagery(true)));
    const n = node();

    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    n.visible = true;
    (tm as any).syncScene(n);

    const first = n.mesh;
    expect(scene.children).toContain(first);

    // The retry rebuilds the tile with a fresh bundle.
    n.retryAfter = performance.now() - 1;
    (tm as any).triggerLoad(n, 0);
    await new Promise((r) => setTimeout(r, 0));
    n.visible = true;
    (tm as any).syncScene(n);

    expect(n.mesh).not.toBe(first);
    expect(scene.children).not.toContain(first); // the old one is gone
    expect(scene.children.filter((c) => c instanceof THREE.Mesh)).toHaveLength(1);
  });
});
