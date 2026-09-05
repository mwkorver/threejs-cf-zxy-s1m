/**
 * The buildings layer: fetching footprints, extruding them, and hanging the
 * result on terrain meshes that already exist.
 *
 * Split out of TileManager, which had accumulated nine building methods and
 * four pieces of building state among everything else it coordinates. This is
 * the part that separates cleanly: it owns the footprint cache, the in-flight
 * set and its share of the GPU budget, and it meets the tile tree at three
 * named points -- a mesh is built, a mesh is destroyed, or records arrive for
 * ground that has already been drawn.
 *
 * What it deliberately does NOT own is the tree. Walking nodes is the manager's
 * job and arrives here as `forEachNode`, so this module cannot subdivide,
 * prune, or reorder anything; it can only look at what is already on screen.
 */

import * as THREE from "three";

import { BuildingCache } from "./buildingCache";
import { buildTileBuildings, type BuildingRecord } from "./buildingMesh";
import {
  mercatorScale,
  mercatorToLonLat,
  tileBoundsMercator,
  tileKey,
  type TileId,
} from "./mercator";
import type { TileWorkerPool } from "./tileWorkerPool";
import type { TileWorkerTaskOptions } from "./workerTypes";
import type { TileNode } from "./tileManager";

/** Everything the layer needs from the manager, and nothing more. */
export interface BuildingLayerDeps {
  workerPool: TileWorkerPool;
  /**
   * Worker request options for a tile fetch. A function rather than a value
   * because these track live UI settings (imagery source, grid step) and must
   * be read at request time, not at construction.
   */
  requestOptions: () => TileWorkerTaskOptions;
  /**
   * Visit every node currently in the scene -- roots AND transitions. The
   * second half matters: a base-zoom change parks whole subtrees in
   * transitionNodes, and those tiles are on screen exactly like any other.
   */
  forEachNode: (visit: (node: TileNode) => void) => void;
}

/** Byte size of a building geometry's own buffers, for the live-memory counter. */
export function buildingGeometryBytes(g: THREE.BufferGeometry): number {
  let n = g.getIndex()?.array.byteLength ?? 0;
  for (const name of ["position", "normal", "uv"]) {
    // Indexed off .attributes rather than getAttribute(), whose type claims a
    // value is always present; under noUncheckedIndexedAccess this stays honest.
    const a = g.attributes[name];
    if (a) n += a.array.byteLength;
  }
  return n;
}

export class BuildingLayer {
  /** Draw buildings at all. Mirrors the SHOW 3D BUILDINGS control. */
  public enabled = true;
  public wallOpacity = 0.85;
  /** The zoom whose tiles carry footprints; finer tiles re-extrude from them. */
  public sourceZoom = 14;

  private readonly cache = new BuildingCache();
  private readonly sourcesInFlight = new Set<string>();
  private bytes = 0;
  /**
   * Set when `bytes` moves, cleared when the budget is reapplied. Exists
   * because disposal is reached from inside the manager's tree walk, when its
   * active set is only half rebuilt -- so the budget is settled once per frame
   * instead, where the pin set is known to be complete.
   */
  private budgetDirty = false;

  constructor(private readonly deps: BuildingLayerDeps) {}

  /** Live building geometry in bytes. Shares the GPU budget with BundleCache. */
  public getBytes(): number {
    return this.bytes;
  }

  /** True once, then false, until the byte total moves again. */
  public takeBudgetDirty(): boolean {
    const was = this.budgetDirty;
    this.budgetDirty = false;
    return was;
  }

  /**
   * Whether a cached bundle for this tile must still be refused because its
   * footprints are missing.
   *
   * BuildingCache holds 64 source tiles against a BundleCache measured in
   * hundreds of megabytes, so records age out first, and every finer tile over
   * that ground then reads a cold cache and draws no buildings for as long as
   * the terrain bundle lives.
   */
  public needsFootprintsFor(tile: TileId): boolean {
    return this.enabled && tile.z === this.sourceZoom && !this.cache.has(tile);
  }

  /**
   * Record what a tile load said about buildings.
   *
   * Three outcomes share one null: nobody asked, the ground is empty, and the
   * fetch failed. Only the middle one is safe to record as settled.
   *
   * The zoom separates the first, `buildingsFailed` the third. That third case
   * is not hypothetical -- Overture retired the release the manifest pointed
   * at, every source tile began answering 404-shaped failures, and without this
   * the client would have written "no buildings here" over real cities and
   * stopped asking for the rest of the session.
   *
   * A genuine 404 IS an answer -- the tiler says this ground has none -- so the
   * worker leaves `buildingsFailed` false for it and true for anything else.
   * Not recording a failure leaves has() false, so the next tile built over
   * this ground asks again.
   */
  public recordResult(
    tile: TileId,
    buildingRecords: BuildingRecord[] | null | undefined,
    buildingsFailed: boolean
  ): void {
    if (buildingRecords) {
      const source = BuildingCache.sourceTileFor(tile, this.sourceZoom);
      this.cache.put(source, buildingRecords);
      // Tiles over this ground that already drew without buildings can have
      // them now.
      this.attachPending(source);
    } else if (this.enabled && tile.z === this.sourceZoom && !buildingsFailed) {
      this.cache.put(BuildingCache.sourceTileFor(tile, this.sourceZoom), []);
    }
  }

  /**
   * Make sure the source tile owning `tile`'s buildings has been asked for.
   *
   * Fetching buildings is bolted onto loading the tile that happens to sit at
   * the source zoom, and past z14 that tile is an invisible ancestor: it
   * subdivides, hides itself, and is never triggerLoad'd again (the manager
   * only loads a parent while its children are unready). triggerLoad would
   * refuse it anyway -- it returns on node.loaded before it ever reaches the
   * footprint check. So once BuildingCache's 64-entry LRU drops a source, every
   * tile over that ground is building-less for good, however long you fly
   * around.
   *
   * That is reachable in normal flight rather than at some extreme: forTile
   * only refreshes recency when a mesh is built, so a source still on screen
   * ages out behind sources being built ahead of it, and the loss only shows
   * when one of its tiles is later rebuilt.
   *
   * Asking for the source directly decouples the two. Deduplicated on the
   * source key, and bounded by the cache knowing about empty ground as well as
   * occupied ground, so this asks once per source rather than once per frame.
   */
  public ensureSource(tile: TileId): void {
    if (!this.enabled || tile.z < this.sourceZoom) return;
    const source = BuildingCache.sourceTileFor(tile, this.sourceZoom);
    if (this.cache.has(source)) return;

    const key = tileKey(source);
    if (this.sourcesInFlight.has(key)) return;
    this.sourcesInFlight.add(key);

    // Below active tiles, above prefetch: the ground is already on screen
    // without its buildings, so this should not outrank terrain still arriving.
    this.deps.workerPool
      .requestTile(source, -5e6, this.deps.requestOptions())
      .then((res) => {
        this.sourcesInFlight.delete(key);
        // Only the records are wanted. The terrain and imagery that came with
        // them belong to a tile nothing is drawing, so the bundle is not built
        // and the bitmap is closed rather than left to the GC.
        res.imageBitmap?.close();
        if (res.buildingRecords) {
          this.cache.put(source, res.buildingRecords);
          this.attachPending(source);
        } else if (!res.buildingsFailed) {
          // Empty is an answer worth recording; a failure is not. Left
          // unrecorded, has() stays false and the next mesh built over this
          // ground asks again -- which is what makes the outage recoverable
          // rather than cached as fact. Same rule as recordResult.
          this.cache.put(source, []);
        }
      })
      .catch(() => {
        // Transient: dropped from the in-flight set so the next tile built over
        // this ground tries again, rather than the ground going quiet for good.
        this.sourcesInFlight.delete(key);
      });
  }

  /**
   * Re-attach buildings to tiles that were drawn before their footprints
   * arrived. Without this a tile bundled while the cache was cold stays empty
   * for good, since triggerLoad hands back the cached bundle untouched.
   *
   * Extrudes onto the mesh the node already has, rather than rebuilding it from
   * a Bundle. A mesh outlives its bundle -- eviction only spares PINNED keys, so
   * a loaded node that is currently hidden keeps its mesh while its bundle goes
   * -- and asking BundleCache for one it no longer holds silently did nothing,
   * leaving that tile building-less for good. Everything the extrusion needs
   * (the terrain positions it seats buildings on, the grid size, the material
   * roofs share) is on the mesh already, so the bundle was never required.
   */
  public attachPending(source: TileId): void {
    this.deps.forEachNode((node) => {
      const mesh = node.mesh;
      if (
        !mesh ||
        !node.loaded ||
        node.gridSize === undefined ||
        node.tile.z < this.sourceZoom ||
        mesh.getObjectByName("buildingMesh")
      ) {
        return;
      }
      const owner = BuildingCache.sourceTileFor(node.tile, this.sourceZoom);
      if (owner.x !== source.x || owner.y !== source.y || owner.z !== source.z) return;

      // mats[0] is the terrain material for a terrain mesh; roofs share the
      // instance, exactly as they do when the mesh is first built.
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!material) return;
      const geometry = this.buildGeometry(
        node.tile,
        mesh.geometry.getAttribute("position").array,
        node.gridSize
      );
      if (geometry) this.attachMesh(mesh, geometry, material);
    });
  }

  public buildGeometry(
    tile: TileId,
    positions: ArrayLike<number>,
    gridSize: number
  ): THREE.BufferGeometry | undefined {
    const owned = this.cache.forTile(tile, this.sourceZoom);
    if (!owned) return undefined;

    // Sample the terrain mesh itself for base elevation. Its interior vertices
    // are a row-major (gridSize x gridSize) grid over the tile, and their Z is
    // already mercator-scaled -- so a building seated on it lands on the ground
    // whatever the vertical exaggeration or latitude.
    const g = gridSize;
    const pos = positions;
    const groundAt = (u: number, v: number): number => {
      const col = Math.min(g - 1, Math.max(0, Math.round(u * (g - 1))));
      const row = Math.min(g - 1, Math.max(0, Math.round(v * (g - 1))));
      return pos[(row * g + col) * 3 + 2] ?? 0;
    };

    const bounds = tileBoundsMercator(tile);
    const zScale = mercatorScale(
      mercatorToLonLat((bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2)[1]
    );

    const built = buildTileBuildings(
      owned.wallRecords,
      owned.roofRecords,
      tile,
      groundAt,
      zScale,
      owned.origin,
      this.sourceZoom
    );
    if (!built) return undefined;

    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(built.positions, 3));
    bg.setAttribute("normal", new THREE.BufferAttribute(built.normals, 3));
    bg.setAttribute("uv", new THREE.BufferAttribute(built.uvs, 2));
    bg.setIndex(new THREE.BufferAttribute(built.indices, 1));

    // Two draw groups so walls and roofs can take different materials: walls
    // stay flat-shaded, roofs take the terrain material and so show imagery.
    bg.addGroup(0, built.roofIndexStart, 0);
    bg.addGroup(built.roofIndexStart, built.indices.length - built.roofIndexStart, 1);

    return bg;
  }

  /**
   * Hang extruded buildings on a terrain mesh.
   *
   * Group 1 (roofs) reuses the terrain material INSTANCE, so a roof tones
   * exactly like the ground it sits on and follows SHADING MODE, brightness,
   * contrast, saturation and hillshade with no second uniform set to keep in
   * step -- and nothing extra to dispose, since the mesh does not own it.
   */
  public attachMesh(
    mesh: THREE.Mesh,
    buildingGeometry: THREE.BufferGeometry,
    terrainMaterial: THREE.Material
  ): void {
    const wallMat = new THREE.MeshLambertMaterial({
      color: 0xcbd5e1,
      side: THREE.DoubleSide,
      transparent: this.wallOpacity < 1.0,
      opacity: this.wallOpacity,
    });
    const bMesh = new THREE.Mesh(buildingGeometry, [wallMat, terrainMaterial]);
    bMesh.name = "buildingMesh";
    bMesh.visible = this.enabled;
    // Identity transform, never moved -- it inherits everything from the
    // terrain mesh it hangs on, which carries the position and the vertical
    // exaggeration. Nothing here needs recomposing per frame.
    bMesh.matrixAutoUpdate = false;
    bMesh.updateMatrix();
    mesh.add(bMesh);
    this.bytes += buildingGeometryBytes(buildingGeometry);
    this.budgetDirty = true;
  }

  /**
   * Drop a node's building mesh. The wall material is ours; the roof material
   * is the tile's own terrain ShaderMaterial, disposed by the caller, so
   * disposing it again here would double-free it.
   */
  public disposeMesh(node: TileNode): void {
    const bMesh = node.mesh?.getObjectByName("buildingMesh") as THREE.Mesh | undefined;
    if (!bMesh) return;
    this.bytes -= buildingGeometryBytes(bMesh.geometry);
    this.budgetDirty = true;
    bMesh.geometry.dispose();
    const mats = Array.isArray(bMesh.material) ? bMesh.material : [bMesh.material];
    mats[0]?.dispose(); // walls only; mats[1] is the shared terrain material
    node.mesh?.remove(bMesh);
  }

  /**
   * Whether this node is done waiting on buildings, so terrain may refine over
   * it. True when there is nothing to draw as well as when it is drawn -- a
   * node that never gets buildings must not block refinement forever.
   */
  public isSettled(node: TileNode): boolean {
    if (!this.enabled) return true;
    if (node.tile.z < this.sourceZoom) return true;
    const source = BuildingCache.sourceTileFor(node.tile, this.sourceZoom);
    if (!this.cache.has(source)) return true; // nothing known to draw yet
    // ownsBuildings, not forTile: this runs from isCovered on every qualifying
    // node every frame, and forTile allocates two arrays and reorders the LRU.
    if (!this.cache.ownsBuildings(node.tile, this.sourceZoom)) return true;
    return !!node.mesh?.getObjectByName("buildingMesh");
  }

  public updateVisibility(): void {
    this.deps.forEachNode((node) => {
      const bMesh = node.mesh?.getObjectByName("buildingMesh");
      if (bMesh) bMesh.visible = this.enabled;
    });
  }

  public setWallOpacity(opacity: number): void {
    this.wallOpacity = opacity;
    const transparent = opacity < 1.0;
    this.deps.forEachNode((node) => {
      const bMesh = node.mesh?.getObjectByName("buildingMesh") as THREE.Mesh | undefined;
      if (!bMesh) return;
      // Wall material is at index 0 in the multi-material array; index 1 is the
      // shared terrain material the roofs use, which must not be touched. A
      // real instanceof rather than a cast plus a guard the cast made dead.
      const materials = Array.isArray(bMesh.material) ? bMesh.material : [bMesh.material];
      const wallMat = materials[0];
      if (wallMat instanceof THREE.MeshLambertMaterial) {
        wallMat.opacity = opacity;
        wallMat.transparent = transparent;
        wallMat.needsUpdate = true;
      }
    });
  }
}
