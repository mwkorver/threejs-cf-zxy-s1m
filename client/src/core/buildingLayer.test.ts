/**
 * BuildingLayer on its own, with fake dependencies.
 *
 * These used to live in buildingRebuild.test.ts, where they built a whole
 * TileManager -- scene, bundle cache, worker pool -- to reach one method, then
 * cast through `as any` to seed a private cache. The layer takes its
 * collaborators as BuildingLayerDeps, so the tree it walks can just be an array
 * and the worker pool need not exist at all.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { BuildingLayer } from "./buildingLayer";
import { BuildingCache } from "./buildingCache";
import { EARTH_CIRCUMFERENCE, tileBoundsMercator, tileKey, type TileId } from "./mercator";
import type { TileNode } from "./tileManager";
import type { BuildingRecord } from "./buildingMesh";
import type { TileWorkerTaskOptions } from "./workerTypes";

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

const Z15: TileId = { z: 15, x: 19294, y: 24626 };
const SOURCE = BuildingCache.sourceTileFor(Z15, 14);
const SPAN15 = EARTH_CIRCUMFERENCE / 2 ** 15;
const RECS = [record(SPAN15 * 0.4, -SPAN15 * 0.6, SPAN15 * 0.6, -SPAN15 * 0.4)];

/**
 * A node as the LOD leaves it once drawn: a terrain mesh whose interior
 * vertices are the grid the extrusion samples for ground height, and a material
 * the roofs will share.
 */
function drawnNode(tile: TileId, grid = 8): TileNode {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(grid * grid * 3), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(grid * grid * 2), 2));
  geom.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(grid * grid * 3), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));

  const bounds = tileBoundsMercator(tile);
  return {
    key: tileKey(tile),
    tile,
    bounds,
    centerMercator: [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2],
    loading: false,
    loaded: true,
    visible: true,
    gridSize: grid,
    mesh: new THREE.Mesh(geom, new THREE.MeshBasicMaterial()),
  } as unknown as TileNode;
}

/** A layer whose "tree" is whatever nodes the test hands it. */
function makeLayer(nodes: TileNode[]): BuildingLayer {
  return new BuildingLayer({
    // ensureSource is not exercised here; nothing may call it without failing.
    workerPool: {
      requestTile: () => {
        throw new Error("workerPool must not be used by these tests");
      },
    } as never,
    requestOptions: () => ({}) as TileWorkerTaskOptions,
    forEachNode: (visit) => nodes.forEach(visit),
  });
}

describe("BuildingLayer.attachPending", () => {
  it("extrudes onto a node already drawn without buildings", () => {
    const node = drawnNode(Z15);
    const layer = makeLayer([node]);
    expect(node.mesh?.getObjectByName("buildingMesh")).toBeUndefined();

    layer.recordResult(SOURCE, RECS, false);

    expect(node.mesh?.getObjectByName("buildingMesh")).toBeDefined();
  });

  it("leaves nodes belonging to a different source alone", () => {
    // Far enough away to sit under another z14 source entirely.
    const other = drawnNode({ z: 15, x: Z15.x + 64, y: Z15.y + 64 });
    const layer = makeLayer([other]);

    layer.recordResult(SOURCE, RECS, false);

    expect(other.mesh?.getObjectByName("buildingMesh")).toBeUndefined();
  });

  it("does not extrude twice onto the same node", () => {
    const node = drawnNode(Z15);
    const layer = makeLayer([node]);

    layer.recordResult(SOURCE, RECS, false);
    const first = node.mesh?.getObjectByName("buildingMesh");
    layer.attachPending(SOURCE);

    expect(node.mesh?.getObjectByName("buildingMesh")).toBe(first);
  });

  it("skips a node that has not finished loading", () => {
    const node = drawnNode(Z15);
    (node as { loaded: boolean }).loaded = false;
    const layer = makeLayer([node]);

    layer.recordResult(SOURCE, RECS, false);

    expect(node.mesh?.getObjectByName("buildingMesh")).toBeUndefined();
  });
});

describe("BuildingLayer.recordResult", () => {
  // The rule that kept the client asking after Overture retired a release:
  // empty ground is an answer worth recording, a failed fetch is not.
  it("records genuinely empty ground, so the asking stops", () => {
    const layer = makeLayer([]);
    layer.recordResult(SOURCE, null, false);
    expect(layer.needsFootprintsFor(SOURCE)).toBe(false);
  });

  it("does not record a failed fetch, so the next tile asks again", () => {
    const layer = makeLayer([]);
    layer.recordResult(SOURCE, null, true);
    expect(layer.needsFootprintsFor(SOURCE)).toBe(true);
  });

  it("records delivered footprints", () => {
    const layer = makeLayer([]);
    layer.recordResult(SOURCE, RECS, false);
    expect(layer.needsFootprintsFor(SOURCE)).toBe(false);
  });
});

describe("BuildingLayer GPU accounting", () => {
  it("counts extruded geometry, and gives it back on disposal", () => {
    const node = drawnNode(Z15);
    const layer = makeLayer([node]);
    expect(layer.getBytes()).toBe(0);

    layer.recordResult(SOURCE, RECS, false);
    const withBuildings = layer.getBytes();
    expect(withBuildings).toBeGreaterThan(0);

    layer.disposeMesh(node);
    expect(layer.getBytes()).toBe(0);
    expect(node.mesh?.getObjectByName("buildingMesh")).toBeUndefined();
  });

  it("reports a dirty budget once, then settles", () => {
    const node = drawnNode(Z15);
    const layer = makeLayer([node]);
    layer.recordResult(SOURCE, RECS, false);

    expect(layer.takeBudgetDirty()).toBe(true);
    expect(layer.takeBudgetDirty()).toBe(false);
  });
});
