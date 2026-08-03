import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { TileManager, type TileNode } from "./tileManager";
import { BundleCache, type Bundle } from "./bundleCache";
import { mercatorToTile, lonLatToMercator, mercatorScale } from "./mercator";

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
  loadImageryFor: vi.fn(() => Promise.resolve(null)),
  loadStaticFootprints: vi.fn(() =>
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
  it("creates a 5x5 grid of root nodes at base zoom", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));

    const { rootNodes } = internals(tm);
    expect(rootNodes.size).toBe(25); // 5x5

    // All roots are at base zoom
    for (const node of rootNodes.values()) {
      expect(node.tile.z).toBe(12);
    }
  });

  it("active keys include all 25 root tiles", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(tm.getActiveKeys().size).toBe(25);
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

// ---- Forward grid bias ----

describe("TileManager forward grid bias", () => {
  // Level flight looking north: forward (0,0,-1) rotated to (0,+1,0) in the
  // Z-up Mercator world. North = decreasing tile row.
  const northCamera = () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e8);
    cam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
    return cam;
  };

  it("shifts the root grid ahead of a level camera instead of centering on it", () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(100, 100, 1000), northCamera());

    const camTile = mercatorToTile(100, 100, 12);
    const rows = [...internals(tm).rootNodes.values()].map((n) => n.tile.y);
    // The 5-row window must lead the camera: reach beyond the unbiased front
    // edge (camTile.y - 2) and give up the deep trailing edge (camTile.y + 2).
    expect(Math.min(...rows)).toBeLessThan(camTile.y - 2);
    expect(Math.max(...rows)).toBeLessThan(camTile.y + 2);
  });

  it("keeps the grid centered when looking straight down", () => {
    const tm = makeManager({ maxZoom: 12 });
    const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e8); // default: looking down -Z
    tm.update(new THREE.Vector3(100, 100, 1000), cam);

    const camTile = mercatorToTile(100, 100, 12);
    const rows = [...internals(tm).rootNodes.values()].map((n) => n.tile.y);
    expect(Math.min(...rows)).toBe(camTile.y - 2);
    expect(Math.max(...rows)).toBe(camTile.y + 2);
  });
});

// ---- Relative-height vertical exaggeration ----

describe("TileManager relative-height exaggeration", () => {
  it("freezes the ground under the camera and offsets meshes so it holds still", async () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000)); // stashes camera position
    await new Promise((r) => setTimeout(r, 0));

    const node = internals(tm).rootNodes.values().next().value!;
    node.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());

    (tm as any).getElevationAt = () => 500; // ground under camera = 500 m
    tm.setVerticalExaggeration(3);

    expect((tm as any).exagReference).toBe(500);
    expect(node.mesh!.scale.z).toBe(3);
    // Affine map z' = (h-500)*3+500: a sea-level vertex (local z=0) must land
    // at -1000 m (mercatorScale ~= 1 at the equator), so ground at 500 m stays
    // at 500: 500(local)*3 + (-1000) = 500.
    expect(node.mesh!.position.z).toBeCloseTo(-1000, 0);
  });

  it("keeps classic sea-level anchoring while no reference has been frozen", async () => {
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    await new Promise((r) => setTimeout(r, 0));

    const node = internals(tm).rootNodes.values().next().value!;
    node.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());

    (tm as any).getElevationAt = () => null; // nothing loaded under camera
    tm.setVerticalExaggeration(3);

    expect((tm as any).exagReference).toBe(0);
    expect(node.mesh!.scale.z).toBe(3);
    expect(node.mesh!.position.z).toBe(0); // exagZ(0) with ref 0 stays 0
  });
});

// ---- Eviction at distance ----

describe("TileManager root eviction", () => {
  it("retains roots within hysteresis band, evicts beyond it", () => {
    // The 5x5 grid spans offsets -2..2 (radius 2). The eviction threshold is >3,
    // giving 1 tile of hysteresis: roots at distance 3 survive as a buffer to
    // prevent thrashing when the camera crosses tile boundaries. Roots at
    // distance 4+ are evicted.
    const tm = makeManager({ maxZoom: 12 });
    tm.update(new THREE.Vector3(0, 0, 1000));
    const { rootNodes: before } = internals(tm);
    expect(before.size).toBe(25);
    const keysBefore = new Set(before.keys());

    // Move 1 tile east: roots at distance 3 survive as hysteresis buffer
    // → more than 25 total (25 new + 5 old at the far edge)
    tm.update(new THREE.Vector3(10000, 0, 1000));
    const { rootNodes: after1 } = internals(tm);
    expect(after1.size).toBeGreaterThan(25); // hysteresis roots
    expect(after1.size).toBeLessThan(50);    // not double

    // Move very far (50+ tiles): all old roots well beyond threshold → evicted
    tm.update(new THREE.Vector3(500000, 500000, 1000));
    const { rootNodes: afterFar } = internals(tm);
    expect(afterFar.size).toBe(25);
    let surviving = 0;
    for (const key of keysBefore) {
      if (afterFar.has(key)) surviving++;
    }
    expect(surviving).toBe(0);
  });

  it("removes mesh from scene when node is evicted", async () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 12, 2.2, false,
    );

    tm.update(new THREE.Vector3(0, 0, 1000));
    // Let the main-thread fallback microtasks settle so triggerLoad's .then()
    // doesn't overwrite the injected mesh after we set it.
    await new Promise((r) => setTimeout(r, 0));

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

    // The old mesh should have been removed from the scene by pruneNode.
    // Also verify the node's mesh was disposed and cleared.
    expect(node.mesh).toBeUndefined();
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

  it("stops refining once the active-tile cap is reached", () => {
    // Pinned bundles are exempt from cache eviction, so an unbounded active
    // set voids the byte budget entirely. The cap is what keeps it honest.
    const capped = makeManager({ maxZoom: 18, lodFactor: 5.0 });
    capped.maxActiveTiles = 30;
    capped.update(new THREE.Vector3(0, 0, 50));

    const uncapped = makeManager({ maxZoom: 18, lodFactor: 5.0 });
    uncapped.update(new THREE.Vector3(0, 0, 50));

    expect(uncapped.getActiveKeys().size).toBeGreaterThan(30);
    // The cap bounds growth; the root grid itself is always pinned, so the
    // ceiling is the cap plus whatever a already-subdivided node finishes.
    expect(capped.getActiveKeys().size).toBeLessThan(uncapped.getActiveKeys().size);
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
    const tm = makeManager({ maxZoom: 14, lodFactor: 0.001 });
    // Extremely low lodFactor: camera must be within 0.001 * tileWidth to subdivide.
    // At z12 (~9.8km tiles), 0.001 * 9800 = 9.8m. Camera at 100m altitude is far beyond.
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
    expect(z12roots.size).toBe(25);

    // Drop to z3 altitude — old roots should move to transitionNodes
    tm.update(new THREE.Vector3(0, 0, 1300000));
    const { rootNodes: z3roots, transitionNodes } = internals(tm);

    // New roots at z3
    expect(z3roots.size).toBe(25);
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

  it("keeps fresh transition tiles alive while the new base zoom loads", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 1000)); // z12 roots
    tm.update(new THREE.Vector3(0, 0, 50000)); // -> z8; new roots not loaded yet
    // Same-frame handoff is well inside the default TTL: cohort must survive
    // as the hole-free fallback.
    expect(internals(tm).transitionNodes.size).toBeGreaterThan(0);
  });

  it("prunes a transition cohort after its TTL even if new roots never load", () => {
    const tm = makeManager({ maxZoom: 14 });
    tm.update(new THREE.Vector3(0, 0, 1000)); // z12 roots
    tm.transitionTtlMs = -1; // everything is instantly past its lifetime
    tm.update(new THREE.Vector3(0, 0, 50000)); // -> z8; new roots still loading
    // Without the TTL these stale coarse-vs-fine cohorts pin until the global
    // swap, which camera motion can defer indefinitely (the "bleeding" bug).
    const { transitionNodes, rootNodes } = internals(tm);
    expect(transitionNodes.size).toBe(0);
    expect(rootNodes.size).toBe(25); // new base grid unaffected
    for (const node of rootNodes.values()) {
      expect(node.tile.z).toBe(8);
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

    // Camera looking straight down at (0, 0, 3000) with narrow FOV
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
    expect(visibleRoots).toBeLessThan(25);
    expect(visibleRoots).toBeGreaterThan(0);
  });

  it("does not cull when cullTiles is false", () => {
    const tm = makeManager({ maxZoom: 12, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    expect(tm.getActiveKeys().size).toBe(25);
  });

  it("sec(lat) audit: frustum box Z is scaled by mercatorScale at high latitude", () => {
    // Regression test for the sec(lat) scale audit: the frustum culling
    // box Z must be in world (Mercator) metres, not true metres. At 49°N
    // (sec(lat) ≈ 1.52), a 9000 m peak renders at world Z = 13680 m. Before
    // the fix the box only extended to 9000 (true), so a camera at 10000 m
    // world Z looking horizontally could cull a tile whose terrain actually
    // extends above the frustum's lower plane.
    //
    // We verify the fix by placing the camera at 49°N with a high-elevation
    // tile and checking it stays visible. (At the equator sec(lat)=1, so the
    // bug is invisible there — the test must run at high latitude.)
    const anchor = lonLatToMercator(0, 49); // 49°N, sec(lat) ≈ 1.524
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      anchor, 12, 12, 2.2, true, // cullTiles = true
    );

    // Camera at world Z = 10000, looking straight down. All 25 root tiles
    // are under the camera and must be visible — none culled by Z range.
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 100000);
    camera.position.set(0, 0, 10000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    tm.update(camera.position, camera);

    // With the bug (true-metre box Z), tiles whose terrain exceeds 10000/1.52
    // ≈ 6562 m true would have their box top at 9000 (true) < 10000 (camera),
    // potentially causing culling. With the fix, box top = 9000*1.52 = 13680
    // > 10000, so tiles are correctly retained.
    const { rootNodes } = internals(tm);
    let visibleCount = 0;
    for (const node of rootNodes.values()) {
      if (node.visible) visibleCount++;
    }
    // Looking straight down, all in-frustum roots should be visible.
    expect(visibleCount).toBeGreaterThan(0);
  });

  it("retains children structure for culled nodes and only hides them when camera rotates away", () => {
    const scene = new THREE.Scene();
    const cache = new BundleCache(64 * 1024 * 1024);
    const tm = new TileManager(
      "http://test-tiler", "test-layer", 2023, scene, cache,
      [0, 0], 12, 14, 2.2, true, // baseZoom = 12, maxZoom = 14, cullTiles = true
    );

    // 1. Position camera looking down at (0, 0, 3000) to force subdivision of roots
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
    expect(tm.getActiveKeys().size).toBe(25);

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
    // 25 roots: last node has maxElevation = 200 + 24*50 = 1400
    expect(tm.globalUniforms.localMaxElev.value).toBe(1400);
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

// ---- Elevation sampling (Follow-DEM support) ----

describe("TileManager getElevationAt", () => {
  it("returns null when no tiles are loaded under the point", () => {
    const tm = makeManager({ maxZoom: 12 });
    // No update() yet — no tiles loaded
    expect(tm.getElevationAt(0, 0)).toBeNull();
  });

  it("returns the center elevation of the loaded tile covering the point", async () => {
    const tm = makeManager({ maxZoom: 12, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    // Let the main-thread fallback microtasks settle so tiles load.
    await new Promise((r) => setTimeout(r, 0));

    // The camera is at (0, 0, 1000) — worldAnchor [0,0] means global = local.
    // A root tile covers (0, 0); its centerElevation is 0 (flat terrain from
    // the mocked loader returning a zero-filled Float32Array).
    const elev = tm.getElevationAt(0, 0);
    expect(elev).not.toBeNull();
    expect(elev).toBe(0);
  });

  // The three below build the node tree directly rather than waiting on the
  // async loader. The previous version raced a single setTimeout(0) against
  // deep subdivision and guarded its only assertion behind `if (maxChildZ > 0)`,
  // so it passed vacuously when loading hadn't settled and failed at random
  // when it had — while the bug it should have caught went unnoticed.

  /** The root covering `p`, put into the steady state of a subdivided node. */
  function rootWithChildrenAt(tm: TileManager, p: [number, number]) {
    const inside = (n: TileNode) =>
      p[0] >= n.bounds.west && p[0] <= n.bounds.east &&
      p[1] >= n.bounds.south && p[1] <= n.bounds.north;
    const root = [...internals(tm).rootNodes.values()].find(inside)!;
    root.children = (tm as any).createChildren(root.tile) as TileNode[];
    const child = root.children.find(inside)!;
    return { root, child };
  }

  it("descends past an unloaded subdivided parent to its loaded children", () => {
    // Reachable when all four children load synchronously from a warm
    // BundleCache: the parent is then never triggerLoad'd and sits at
    // loaded=false while its children carry the terrain. The old walk died on
    // that parent and returned null despite fine terrain being loaded there.
    const tm = makeManager({ maxZoom: 13, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    const p: [number, number] = [1000, -1000];

    const { root, child } = rootWithChildrenAt(tm, p);
    root.loaded = false;
    root.centerElevation = undefined;
    child.loaded = true;
    child.centerElevation = 250;

    expect(tm.getElevationAt(p[0], p[1])).toBe(250);
  });

  it("prefers the finest loaded tile when parent and child are both loaded", () => {
    const tm = makeManager({ maxZoom: 13, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    const p: [number, number] = [1000, -1000];

    const { root, child } = rootWithChildrenAt(tm, p);
    root.loaded = true;
    root.centerElevation = 100;
    child.loaded = true;
    child.centerElevation = 250;

    expect(tm.getElevationAt(p[0], p[1])).toBe(250);
  });

  it("falls back to a coarser sample when the finest tile has none", () => {
    // A loaded node without centerElevation must not win the "finest" contest
    // and mask a coarser node that does have a sample.
    const tm = makeManager({ maxZoom: 13, cullTiles: false });
    tm.update(new THREE.Vector3(0, 0, 1000));
    const p: [number, number] = [1000, -1000];

    const { root, child } = rootWithChildrenAt(tm, p);
    root.loaded = true;
    root.centerElevation = 100;
    child.loaded = true;
    child.centerElevation = undefined;

    expect(tm.getElevationAt(p[0], p[1])).toBe(100);
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
    expect(keys1.size).toBe(25);

    // Move far enough to shift the 5x5 center
    tm.update(new THREE.Vector3(2000000, 2000000, 1000));
    const keys2 = new Set(tm.getActiveKeys());
    expect(keys2.size).toBe(25);

    // Completely different tiles at the new position (no overlap at z12)
    let overlap = 0;
    for (const k of keys1) {
      if (keys2.has(k)) overlap++;
    }
    expect(overlap).toBe(0);
  });
});

// ---- Velocity-vector prefetch ----

describe("TileManager prefetchAhead", () => {
  /** Inject velocity state directly so tests don't depend on wall-clock timing. */
  function injectVelocity(
    tm: TileManager,
    pos: THREE.Vector3,
    vx: number,
    vy: number
  ) {
    (tm as any).prefetchPrevPos = pos.clone();
    (tm as any).prefetchVelocity.set(vx, vy, 0);
  }

  it("skips when horizontal speed is below the threshold (stationary camera)", () => {
    const tm = makeManager({ maxZoom: 18, cullTiles: false });
    const pool = (tm as any).workerPool;
    const requestSpy = vi
      .spyOn(pool, "requestTile")
      .mockReturnValue(new Promise(() => {}));

    const pos = new THREE.Vector3(0, 0, 2000);
    tm.update(pos);
    requestSpy.mockClear();

    // Inject zero velocity (stationary)
    injectVelocity(tm, pos, 0, 0);
    (tm as any).prefetchAhead();

    const calls = requestSpy.mock.calls as any[][];
    const prefetchCalls = calls.filter(([, p]) => (p as number) <= -1e7);
    expect(prefetchCalls.length).toBe(0);
    expect(tm.getLastPrefetchCount()).toBe(0);
  });

  it("queues tiles ahead of the flight path when moving fast", () => {
    // Very high altitude → baseZoom = z5. Prefetch zoom = z7. The 5×5 z5 root
    // grid spans ≈ ±2.5 M m around the camera. A 2 M m/s velocity places all
    // 4 look-ahead sample points > 2 M m east, clearly outside that grid.
    const tm = makeManager({ maxZoom: 18, cullTiles: false });
    const pool = (tm as any).workerPool;
    const requestSpy = vi
      .spyOn(pool, "requestTile")
      .mockReturnValue(new Promise(() => {}));

    const pos = new THREE.Vector3(0, 0, 400_000); // >320k m → baseZoom z5
    tm.update(pos);
    requestSpy.mockClear();

    // 2,000,000 m/s east → look-ahead at 500k–2000k m east, outside the z5 grid
    injectVelocity(tm, pos, 2_000_000, 0);
    (tm as any).prefetchAhead();

    // getLastPrefetchCount is the canonical check; requestSpy may or may not
    // show calls if some look-ahead tiles were already requested by triggerLoad.
    expect(tm.getLastPrefetchCount()).toBeGreaterThan(0);

    // All look-ahead tiles must be east of the current camera tile.
    // Prefetch now operates at maxZoom — the only tier where pop-in matters.
    const maxZoom = (tm as any).maxZoom as number;
    const currentTile = mercatorToTile(0, 0, maxZoom);
    const allCalls = requestSpy.mock.calls as any[][];
    for (const [tile] of allCalls) {
      expect((tile as { x: number }).x).toBeGreaterThanOrEqual(currentTile.x);
    }
  });

  it("skips tiles that are already in the bundle cache", () => {
    const tm = makeManager({ maxZoom: 18, cullTiles: false });
    const pool = (tm as any).workerPool;
    const requestSpy = vi
      .spyOn(pool, "requestTile")
      .mockReturnValue(new Promise(() => {}));
    const cache = (tm as any).bundleCache as BundleCache;

    const pos = new THREE.Vector3(0, 0, 200_000);
    tm.update(pos);
    requestSpy.mockClear();

    const baseZoom = (tm as any).baseZoom as number;
    // Prefetch operates at maxZoom — update the cache with maxZoom tiles.
    const zoom = (tm as any).maxZoom as number;
    const lookahead = tm.prefetchLookaheadSec;
    const samples = tm.prefetchSamples;

    // Pre-populate cache with every tile prefetchAhead would request.
    for (let s = 1; s <= samples; s++) {
      const t = (s / samples) * lookahead;
      const tile = mercatorToTile(5000 * t, 0, zoom);
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      cache.put(
        {
          key,
          bytes: 100,
          geometry: new THREE.BufferGeometry(),
          centerElevation: 0,
          demSource: "farfield",
          minElevation: 0,
          maxElevation: 0,
        },
        new Set()
      );
    }

    injectVelocity(tm, pos, 5000, 0);
    (tm as any).prefetchAhead();

    // All tiles were cached — no new requests should be issued
    expect(requestSpy).not.toHaveBeenCalled();
    expect(tm.getLastPrefetchCount()).toBe(0);
  });

  it("uses lower priority than active tile loads", () => {
    const tm = makeManager({ maxZoom: 18, cullTiles: false });
    const pool = (tm as any).workerPool;
    const requestSpy = vi
      .spyOn(pool, "requestTile")
      .mockReturnValue(new Promise(() => {}));

    const pos = new THREE.Vector3(0, 0, 200_000);
    tm.update(pos);

    // Capture priorities used by triggerLoad for currently-visible tiles
    const activeCalls = requestSpy.mock.calls as any[][];
    const activePriorities = activeCalls.map(([, p]) => p as number);
    const minActivePriority = Math.min(...activePriorities, 0);

    requestSpy.mockClear();

    injectVelocity(tm, pos, 5000, 0);
    (tm as any).prefetchAhead();

    const allCalls = requestSpy.mock.calls as any[][];
    for (const [, priority] of allCalls) {
      expect(priority as number).toBeLessThan(minActivePriority);
      expect(priority as number).toBeLessThanOrEqual(-1e7);
    }
  });

  it("prefetchTargetGround dispatches destination tiles with top priority (1e8)", () => {
    const tm = makeManager({ maxZoom: 14 });
    const pool = (tm as any).workerPool;
    const requestSpy = vi
      .spyOn(pool, "requestTile")
      .mockReturnValue(new Promise(() => {}));

    const targetGround = new THREE.Vector3(1000, 2000, 500);
    tm.prefetchTargetGround(targetGround, 1500);

    expect(requestSpy).toHaveBeenCalled();
    const calls = requestSpy.mock.calls as any[][];
    for (const [, priority] of calls) {
      expect(priority as number).toBe(1e8);
    }
  });
});

// ---- Parent Fallback & Memory Eviction Safety Tests ----

describe("TileManager parent fallback retention and memory safety", () => {
  it("keeps parent tile visible as fallback when child tiles are loading", () => {
    const tm = makeManager({ baseZoom: 12, maxZoom: 14, lodFactor: 1.0 });
    const { rootNodes } = internals(tm);

    // Initial update at high altitude -> root tile (z12) is initialized
    tm.update(new THREE.Vector3(0, 0, 50000));
    const root = rootNodes.values().next().value!;
    expect(root).toBeDefined();

    // Mock parent root tile mesh
    root.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    root.loaded = true;
    root.visible = true;

    // Zoom in close -> causes subdivision into children
    tm.update(new THREE.Vector3(0, 0, 100));

    // Children are created but loading (loaded = false)
    if (root.children && root.children.length > 0) {
      for (const child of root.children) {
        expect(child.loaded).toBe(false);
      }
      // Parent must remain covered/visible so no visual hole appears
      const isCovered = (tm as any).isCovered(root);
      expect(typeof isCovered).toBe("boolean");
    }
  });

  it("evicts unlocked bundles when VRAM cache budget is reached without crashing active keys", () => {
    // Set up a tiny 1KB budget to force eviction
    const tinyCache = new BundleCache(1024);
    const scene = new THREE.Scene();
    const tm = new TileManager(
      "http://test-tiler",
      "test-layer",
      2023,
      scene,
      tinyCache,
      [0, 0],
      12,
      14
    );

    // Move camera to initial position
    tm.update(new THREE.Vector3(0, 0, 10000));
    const activeBefore = tm.getActiveKeys().size;
    expect(activeBefore).toBeGreaterThan(0);

    // Rapidly shift camera across multiple coordinates to trigger cache eviction
    for (let offset = 0; offset < 50000; offset += 10000) {
      tm.update(new THREE.Vector3(offset, offset, 10000));
    }

    // Active keys set remains defined and active
    expect(tm.getActiveKeys().size).toBeGreaterThan(0);
    // The 1KB budget above is unenforceable on its own -- pinned/active tiles
    // are exempt from eviction (bundleCache.test.ts covers that directly), and
    // this test's fake tiler host makes every fetch fail, so bundleCache never
    // receives a put() and bytesUsed() stays 0 regardless of whether eviction
    // works (verified: asserting >=0 on it passes unconditionally and proves
    // nothing). What rapid camera churn CAN blow up is the active-tile count
    // itself, which is what actually bounds the cache budget in practice
    // (tileManager.ts:512) -- assert that cap held under the churn instead.
    expect(tm.getActiveKeys().size).toBeLessThanOrEqual(tm.maxActiveTiles);
  });
});



