import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { TileManager, type TileNode } from "./tileManager";
import { BundleCache } from "./bundleCache";

// Mocking dependencies that perform fetch requests
vi.mock("./tileLoader", () => ({
  loadTerrain: vi.fn(() => Promise.resolve(new Float32Array(512 * 512))),
  loadImagery: vi.fn(() => Promise.resolve(null)),
  loadFootprints: vi.fn(() => Promise.resolve({ type: "FeatureCollection", features: [] })),
}));

describe("TileManager", () => {
  const mockScene = new THREE.Scene();
  const mockCache = new BundleCache(1024 * 1024);
  const worldAnchor: [number, number] = [0, 0];

  it("should initialize root nodes around camera on update", () => {
    const tileManager = new TileManager(
      "http://test-tiler",
      "test-layer",
      2023,
      mockScene,
      mockCache,
      worldAnchor,
      12, // baseZoom
      12, // maxZoom = baseZoom to prevent subdivision
      2.0 // lodFactor
    );

    // Camera placed exactly at the worldAnchor (local coordinate 0,0,1000)
    const cameraPos = new THREE.Vector3(0, 0, 1000);
    tileManager.update(cameraPos);

    // The active keys should include the center root tile and its 3x3 neighbors
    const activeKeys = tileManager.getActiveKeys();
    expect(activeKeys.size).toBe(9); // 3x3 grid centered around (0,0) at z=12
  });

  it("should subdivide nodes when camera is very close", () => {
    const tileManager = new TileManager(
      "http://test-tiler",
      "test-layer",
      2023,
      mockScene,
      mockCache,
      worldAnchor,
      12, // baseZoom
      16, // maxZoom
      3.0 // high lodFactor to trigger easy splitting
    );

    // Camera positioned very close to the center of root node z12/x1024/y1024 (center is near 0,0)
    // Zoom 12 tile size is ~9.7km. If we place camera at altitude 100m, it's well within 3.0 * tileWidth.
    const cameraPos = new THREE.Vector3(0, 0, 100);
    tileManager.update(cameraPos);

    // Find the center root node
    // Global coordinate (0,0) at z12 should correspond to x = 2^11 = 2048, y = 2048 (Web Mercator coordinate midpoint)
    // Let's inspect the created root node structure
    // Since we're in Z-up right-handed coordinate system, let's verify that children were instantiated
    // We can access private properties using bracket notation or casts for unit testing
    const rootNodes = (tileManager as any).rootNodes as Map<string, TileNode>;
    expect(rootNodes.size).toBeGreaterThan(0);

    // Find a node that has children instantiated
    let hasChildren = false;
    for (const node of rootNodes.values()) {
      const dist = cameraPos.distanceTo(new THREE.Vector3(node.centerMercator[0], node.centerMercator[1], 0));
      const tileW = node.bounds.east - node.bounds.west;
      if (dist < tileW * tileManager.lodFactor) {
        expect(node.children).toBeDefined();
        expect(node.children!.length).toBe(4);
        hasChildren = true;
        break;
      }
    }
    expect(hasChildren).toBe(true);
  });

  it("should prune and remove children when camera moves far away", () => {
    const tileManager = new TileManager(
      "http://test-tiler",
      "test-layer",
      2023,
      mockScene,
      mockCache,
      worldAnchor,
      12, // baseZoom
      16, // maxZoom
      1.0 // low lodFactor
    );

    // 1. Move camera close to trigger potential child creation (e.g. at 0,0)
    const cameraPosClose = new THREE.Vector3(0, 0, 50);
    tileManager.update(cameraPosClose);

    const rootNodes = (tileManager as any).rootNodes as Map<string, TileNode>;
    const rootNode = rootNodes.values().next().value!;
    
    // Subdivide manually if needed, or check if it has children
    if (!rootNode.children) {
      rootNode.children = (tileManager as any).createChildren(rootNode.tile);
    }
    expect(rootNode.children).toBeDefined();

    // 2. Move camera extremely far away
    const cameraPosFar = new THREE.Vector3(1000000, 1000000, 10000);
    tileManager.update(cameraPosFar);

    // The old root node should be pruned (distance > Chebyshev threshold) or collapsed
    // Let's verify that the old node's children are gone or it is pruned
    expect(rootNodes.has(rootNode.key)).toBe(false);
    expect(rootNode.children).toBeUndefined();
  });
});
