import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { TileManager, type TileNode } from "./tileManager";
import { BundleCache, type Bundle } from "./bundleCache";

// Suppress noisy console output from tile loading warnings
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// Mock tileLoader to avoid real network in unit tests.
// The worker pool falls back to main-thread loading (no Worker in Node),
// which calls these functions indirectly through loadOnMainThread.
vi.mock("./tileLoader", () => ({
  loadTerrain: vi.fn(() =>
    Promise.resolve({ heights: new Float32Array(512 * 512), demSource: "farfield" }),
  ),
  loadImagery: vi.fn(() => Promise.resolve(null)),
  loadImageryExternal: vi.fn(() => Promise.resolve(null)),
  loadImageryOSM: vi.fn(() => Promise.resolve(null)),
  loadFootprints: vi.fn(() =>
    Promise.resolve({ type: "FeatureCollection", features: [] }),
  ),
  loadViewportFootprints: vi.fn(() =>
    Promise.resolve({ type: "FeatureCollection", features: [] }),
  ),
}));

// Helper: extract private fields for test assertions
function internals(tm: TileManager) {
  return {
    rootNodes: (tm as any).rootNodes as Map<string, TileNode>,
    transitionNodes: (tm as any).transitionNodes as Map<string, TileNode>,
    baseZoom: (tm as any).baseZoom as number,
  };
}

function makeManager(
  overrides: Partial<{
    baseZoom: number;
    maxZoom: number;
    lodFactor: number;
    cullTiles: boolean;
    worldAnchor: [number, number];
  }> = {},
): TileManager {
  const scene = new THREE.Scene();
  const cache = new BundleCache(64 * 1024 * 1024); // 64MB — large enough to never evict during tests
  return new TileManager(
    "http://test-tiler",
    "test-layer",
    2023,
    scene,
    cache,
    overrides.worldAnchor ?? [0, 0],
    overrides.baseZoom ?? 12,
    overrides.maxZoom ?? 12,
    overrides.lodFactor ?? 2.2,
    overrides.cullTiles ?? false,
  );
}

// ---- Root node initialization ----

describe("TileManager root initialization", () => {
  it("creates a 3x3 grid of root nodes at base zoom", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes } = internals(tm);
    expect(rootNodes.size).toBe(9); // 3x3

    // All roots are at base zoom
    for (const node of rootNodes.values()) {
      expect(node.tile.z).toBe(12);
    }
  });

  it("active keys include all 9 root tiles", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(tm.getActiveKeys().size).toBe(9);
  });

  it("all root nodes are initialized with correct bounds", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      expect(node.bounds).toBeDefined();
      expect(node.bounds.east).toBeGreaterThan(node.bounds.west);
      expect(node.bounds.north).toBeGreaterThan(node.bounds.south);
      expect(node.centerMercator).toHaveLength(2);
    }
  });

  it("root nodes are not yet loaded or subdivided on first update", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      expect(node.children).toBeUndefined();
      expect(node.loaded).toBe(false);
      // loading may be true because the main-thread fallback resolves synchronously
      // and triggerLoad sets node.loading = true before the async resolution.
      // The node will be loaded on the next microtask tick.
    }
  });
});

// ---- Eviction at distance ----

describe("TileManager root eviction", () => {
  it("evicts root nodes beyond Chebyshev distance 2 from center", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes: before } = internals(tm);
    const keysBefore = new Set(before.keys());

    // Move camera 3+ tiles away
    tm.update(new THREE.Vector3(500000, 500000, 1000));

    const { rootNodes: after } = internals(tm);
    // Should still have exactly 9 roots around the new center
    expect(after.size).toBe(9);
    // Most old keys should be gone
    let overlap = 0;
    for (const key of keysBefore) {
      if (after.has(key)) overlap++;
    }
    expect(overlap).toBeLessThan(keysBefore.size);
  });

  it("removes mesh from scene when node is evicted", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 12, 2.2, false,
    );

    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes } = internals(tm);
    // Force-add a mesh to one node to verify scene cleanup
    const node = rootNodes.values().next().value!;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    node.mesh = mesh;
    node.loaded = true;
    node.visible = true;
    scene.add(mesh);
    expect(scene.children).toContain(mesh);

    // Move far away to trigger eviction
    tm.update(new THREE.Vector3(2000000, 2000000, 1000));

    // The old mesh should have been removed from the scene
    expect(scene.children).not.toContain(mesh);
  });
});

// ---- LOD subdivision ----

describe("TileManager LOD subdivision", () => {
  it("creates 4 children when camera is within lodFactor * tileWidth", () => {
    const tm = makeManager({ maxZoom: 14, lodFactor: 5.0 });
    tm.update(new THREE.Vector3(0, 0, 50));

    const { rootNodes } = internals(tm);
    let foundSubdivided = false;
    for (const node of rootNodes.values()) {
      if (node.children) {
        expect(node.children.length).toBe(4);
        // Children are at z+1
        for (const child of node.children) {
          expect(child.tile.z).toBe(node.tile.z + 1);
        }
        foundSubdivided = true;
        break;
      }
    }
    expect(foundSubdivided).toBe(true);
  }, 15000);

  it("children tile IDs are the correct quadtree subdivisions", () => {
    const tm = makeManager({ maxZoom: 14, lodFactor: 5.0 });
    tm.update(new THREE.Vector3(0, 0, 50));

    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      if (node.children) {
        const { z, x, y } = node.tile;
        const childTiles = node.children.map((c) => c.tile);
        // TL, TR, BL, BR offsets
        expect(childTiles).toContainEqual({ z: z + 1, x: 2 * x, y: 2 * y });
        expect(childTiles).toContainEqual({ z: z + 1, x: 2 * x + 1, y: 2 * y });
        expect(childTiles).toContainEqual({ z: z + 1, x: 2 * x, y: 2 * y + 1 });
        expect(childTiles).toContainEqual({ z: z + 1, x: 2 * x + 1, y: 2 * y + 1 });
        break;
      }
    }
  }, 15000);

  it("does not subdivide when maxZoom equals baseZoom", () => {
    const tm = makeManager({ maxZoom: 12, lodFactor: 5.0 });
    tm.update(new THREE.Vector3(0, 0, 10));

    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      expect(node.children).toBeUndefined();
    }
  });

  it("does not subdivide roots when camera is far from tiles (low lodFactor)", () => {
    const tm = makeManager({ maxZoom: 14, lodFactor: 0.01 });
    // Very low lodFactor: camera must be within 0.01 * tileWidth to subdivide.
    // At altitude 100m with z12 tiles (~9.8km wide), 0.01 * 9800 = 98m.
    // Camera at 100m altitude with horizontal offset means distance >> 98m.
    tm.update(new THREE.Vector3(0, 0, 100));

    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      expect(node.children).toBeUndefined();
    }
  });
});

// ---- Dynamic base zoom ----

describe("TileManager dynamic base zoom", () => {
  it("computes base zoom z3 from high altitude (>1.28M m)", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 1300000));
    expect(internals(tm).baseZoom).toBe(3);
  });

  it("computes base zoom z12 from low altitude (<5K m)", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(internals(tm).baseZoom).toBe(12);
  });

  it("transitions root nodes when base zoom drops from z12 to z3", () => {
    const tm = makeManager({ maxZoom: 14 });

    // z12 roots
    tm.update(new THREE.Vector3(0, 0, 1000));
    const { rootNodes: z12roots } = internals(tm);
    expect(z12roots.size).toBe(9);

    // Drop to z3 altitude — old roots should move to transitionNodes
    tm.update(new THREE.Vector3(0, 0, 1300000));
    const { rootNodes: z3roots, transitionNodes } = internals(tm);

    // New roots at z3
    expect(z3roots.size).toBe(9);
    for (const node of z3roots.values()) {
      expect(node.tile.z).toBe(3);
    }

    // Transition nodes should hold old z12 nodes that aren't reclaimed
    // (different zoom = different keys, so none are reclaimed)
    expect(transitionNodes.size).toBeGreaterThan(0);
  });

  it("cancels loading tasks in transition node subtrees", () => {
    const tm = makeManager({ maxZoom: 14 });

    // Initial base zoom 12 roots: start loading
    tm.update(new THREE.Vector3(0, 0, 1000));
    const { rootNodes } = internals(tm);
    for (const node of rootNodes.values()) {
      node.loading = true; // simulate active loading
    }

    // Zoom out to change base zoom to 6: roots should move to transitionNodes and have their loading aborted
    tm.update(new THREE.Vector3(0, 0, 170000));
    const { transitionNodes } = internals(tm);
    expect(transitionNodes.size).toBeGreaterThan(0);
    for (const node of transitionNodes.values()) {
      expect(node.loading).toBe(false); // verified aborted
    }
  });
});

// ---- Frustum culling ----

describe("TileManager frustum culling", () => {
  it("culls nodes outside the view frustum when cullTiles is true", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 12, 2.2, true, // cullTiles = true
    );

    // Camera looking straight down at (0, 0, 1000) with narrow FOV
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    tm.update(camera.position, camera);

    // Culled tiles stay pinned in activeKeys (so the cache can't dispose their
    // retained meshes) but are marked invisible. Frustum culling is therefore
    // measured by how many roots are actually visible, not by activeKeys size.
    const { rootNodes } = internals(tm);
    let visibleRoots = 0;
    for (const node of rootNodes.values()) {
      if (node.visible) visibleRoots++;
    }
    expect(visibleRoots).toBeLessThan(9);
    expect(visibleRoots).toBeGreaterThan(0);
  });

  it("does not cull when cullTiles is false", () => {
    const tm = makeManager({ maxZoom: 12, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(tm.getActiveKeys().size).toBe(9);
  });

  it("retains children structure for culled nodes and only hides them when camera rotates away", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 14, 2.2, true, // baseZoom = 12, maxZoom = 14, cullTiles = true
    );

    // 1. Position camera looking down at (0, 0, 1000) to force subdivision of roots
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    camera.position.set(0, 0, 1000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    tm.update(camera.position, camera);

    // Verify some root nodes subdivided and created children
    const { rootNodes } = internals(tm);
    let hasChildren = false;
    for (const [key, node] of rootNodes.entries()) {
      console.log(`Node ${key}: hasChildren=${!!node.children}, visible=${node.visible}`);
      if (node.children && node.children.length > 0) {
        hasChildren = true;
        break;
      }
    }
    expect(hasChildren).toBe(true);

    // 2. Rotate camera to look far away horizontally (away from the tiles at (0,0))
    camera.lookAt(1000000, 1000000, 1000);
    camera.updateMatrixWorld(true);
    tm.update(camera.position, camera);

    // Some root nodes are now culled, check that their children list was NOT deleted
    let retainedChildren = false;
    for (const node of rootNodes.values()) {
      if (node.children && node.children.length > 0) {
        retainedChildren = true;
        // Verify children and subtree are set to invisible
        for (const child of node.children) {
          expect(child.visible).toBe(false);
        }
      }
    }
    expect(retainedChildren).toBe(true);
  });
});

// ---- Clear / reset ----

describe("TileManager clear", () => {
  it("clears all state and removes meshes from scene", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 12, 2.2, false,
    );

    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(tm.getActiveKeys().size).toBe(9);

    tm.clear();

    expect(tm.getActiveKeys().size).toBe(0);
    const { rootNodes, transitionNodes } = internals(tm);
    expect(rootNodes.size).toBe(0);
    expect(transitionNodes.size).toBe(0);
    // No meshes left in the scene
    expect(scene.children.length).toBe(0);
  });

  it("clear is idempotent", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    tm.clear();
    tm.clear();

    expect(tm.getActiveKeys().size).toBe(0);
    const { rootNodes, transitionNodes } = internals(tm);
    expect(rootNodes.size).toBe(0);
    expect(transitionNodes.size).toBe(0);
  });
});

// ---- Setting changes ----

describe("TileManager setting changes", () => {
  it("setImagerySource clears cache and resets nodes", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 100));

    // Preload a fake bundle into the cache
    const cache = (tm as any).bundleCache as BundleCache;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    cache.put({ key: "12/2048/2048", bytes: 100, geometry: geom });
    expect(cache.size()).toBeGreaterThan(0);

    tm.setImagerySource("osm");
    expect(cache.size()).toBe(0);
  });

  it("setTerrainMinZoom clears cache and resets nodes", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 100));

    const cache = (tm as any).bundleCache as BundleCache;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    cache.put({ key: "12/2048/2048", bytes: 100, geometry: geom });

    tm.setTerrainMinZoom(15);
    expect(cache.size()).toBe(0);
  });

  it("setExternalImageryMaxZoom clears cache and resets nodes", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 100));

    const cache = (tm as any).bundleCache as BundleCache;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    cache.put({ key: "12/2048/2048", bytes: 100, geometry: geom });

    tm.setExternalImageryMaxZoom(15);
    expect(cache.size()).toBe(0);
  });

  it("setUsgsMinZoom clears cache and resets nodes", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 100));

    const cache = (tm as any).bundleCache as BundleCache;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    cache.put({ key: "12/2048/2048", bytes: 100, geometry: geom });

    tm.setUsgsMinZoom(14);
    expect(cache.size()).toBe(0);
    expect(tm.usgsMinZoom).toBe(14);
  });

  it("setS1mMinZoom clears cache and resets nodes", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 100));

    const cache = (tm as any).bundleCache as BundleCache;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    cache.put({ key: "12/2048/2048", bytes: 100, geometry: geom });

    tm.setS1mMinZoom(16);
    expect(cache.size()).toBe(0);
    expect(tm.s1mMinZoom).toBe(16);
  });

  it("setShadingMode updates uniforms", () => {
    const tm = makeManager();
    tm.setShadingMode(2.0);
    expect(tm.shadingMode).toBe(2.0);
    expect(tm.globalUniforms.shadingMode.value).toBe(2.0);
    expect(tm.globalUniforms.showDemColors.value).toBe(false);

    tm.setShadingMode(1.0);
    expect(tm.shadingMode).toBe(1.0);
    expect(tm.globalUniforms.shadingMode.value).toBe(1.0);
    expect(tm.globalUniforms.showDemColors.value).toBe(true);
  });

  it("setHypsometricBlend updates uniform", () => {
    const tm = makeManager();
    tm.setHypsometricBlend(0.85);
    expect(tm.hypsometricBlend).toBe(0.85);
    expect(tm.globalUniforms.hypsometricBlend.value).toBe(0.85);
  });

  it("setUseLocalHypso updates uniforms", () => {
    const tm = makeManager();
    tm.setUseLocalHypso(true);
    expect(tm.globalUniforms.useLocalHypso.value).toBe(1.0);

    tm.setUseLocalHypso(false);
    expect(tm.globalUniforms.useLocalHypso.value).toBe(0.0);
  });

  it("update calculates local visible elevations", () => {
    const tm = makeManager();
    tm.update(new THREE.Vector3(0, 0, 100));

    const { rootNodes } = internals(tm);
    let count = 0;
    for (const node of rootNodes.values()) {
      node.loaded = true;
      node.minElevation = 100 + count * 50;
      node.maxElevation = 200 + count * 50;
      node.demSource = "s1m";
      node.visible = true;
      count++;
    }

    tm.update(new THREE.Vector3(0, 0, 100));

    expect(tm.globalUniforms.localMinElev.value).toBe(100);
    expect(tm.globalUniforms.localMaxElev.value).toBe(600);
  });
});

// ---- Vertical exaggeration ----

describe("TileManager vertical exaggeration", () => {
  it("setVerticalExaggeration updates existing mesh scale.z", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 12, 2.2, false,
    );

    tm.update(new THREE.Vector3(0, 0, 1000));

    // Inject a mesh into a node
    const { rootNodes } = internals(tm);
    const node = rootNodes.values().next().value!;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    node.mesh = mesh;
    node.loaded = true;
    node.visible = true;

    tm.setVerticalExaggeration(2.0);
    expect(mesh.scale.z).toBe(2.0);

    tm.setVerticalExaggeration(0.5);
    expect(mesh.scale.z).toBe(0.5);
  });
});

// ---- Active keys ----

describe("TileManager active keys", () => {
  it("active keys at high altitude produce many subdivided tiles", () => {
    const tm = makeManager({ maxZoom: 14, lodFactor: 5.0 });
    // At 1M altitude, dynamic base zoom is z3, but with high lodFactor and maxZoom 18,
    // tiles near the camera will subdivide deeply, producing many active keys.
    tm.update(new THREE.Vector3(0, 0, 1000000));
    const keys = tm.getActiveKeys();
    // Should be many more than 9 due to deep subdivision
    expect(keys.size).toBeGreaterThan(9);
  }, 15000);

  it("active keys change when camera moves to a different tile region", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    const keys1 = new Set(tm.getActiveKeys());
    expect(keys1.size).toBe(9);

    // Move far enough to shift the 3x3 center
    tm.update(new THREE.Vector3(2000000, 2000000, 1000));
    const keys2 = new Set(tm.getActiveKeys());
    expect(keys2.size).toBe(9);

    // Completely different tiles at the new position (no overlap at z12)
    let overlap = 0;
    for (const k of keys1) {
      if (keys2.has(k)) overlap++;
    }
    expect(overlap).toBe(0);
  });
});
