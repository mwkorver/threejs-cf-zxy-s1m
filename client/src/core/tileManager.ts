import * as THREE from "three";
import {
  type TileId,
  tileBoundsMercator,
  tileKey,
  mercatorToTile,
  lonLatToMercator,
  mercatorScale,
  mercatorToLonLat,
  EARTH_CIRCUMFERENCE
} from "./mercator";
import { loadStaticFootprints, type FootprintCollection, type FootprintFeature } from "./tileLoader";
import { resolveImageryKind } from "./tileUrls";
import { BundleCache, Bundle } from "./bundleCache";
import type { TexturePool } from "./texturePool";
import { TerrainShader } from "./terrainShader";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { TileWorkerPool } from "./tileWorkerPool";
import { BuildingCache } from "./buildingCache";
import { buildTileBuildings } from "./buildingMesh";
import type { TileLoadResult } from "./workerTypes";


/** Byte size of a building geometry's own buffers, for the live-memory counter. */
function buildingGeometryBytes(g: THREE.BufferGeometry): number {
  let n = g.getIndex()?.array.byteLength ?? 0;
  for (const name of ["position", "normal", "uv"]) {
    // Indexed off .attributes rather than getAttribute(), whose type claims a
    // value is always present; under noUncheckedIndexedAccess this stays honest.
    const a = g.attributes[name];
    if (a) n += a.array.byteLength;
  }
  return n;
}

export interface TileNode {
  /** Terrain grid size of the mesh currently attached, for rebuilding buildings. */
  gridSize?: number;
  key: string;
  tile: TileId;
  bounds: { west: number; south: number; east: number; north: number };
  centerMercator: [number, number];
  mesh?: THREE.Mesh;
  centerElevation?: number;
  demSource?: string;
  minElevation?: number;
  maxElevation?: number;
  children?: TileNode[];
  loading: boolean;
  loaded: boolean;
  visible: boolean;
  /** performance.now() before which triggerLoad is skipped after a failure. */
  retryAfter?: number;
  /** performance.now() when the node was handed to transitionNodes (stale pool). */
  transitionSince?: number;
}

export class TileManager {
  private rootNodes = new Map<string, TileNode>();
  private activeKeys = new Set<string>();
  
  // Grid step for terrain mesh density (e.g. vertices every N source pixels)
  public gridStep = 8;
  // Vertical exaggeration factor
  public verticalExaggeration = 1.5;
  // Reference height (true metres) exaggeration is anchored to: world height is
  // (h - ref)·exag + ref, so ground at the reference holds still and relief
  // amplifies around it (Cesium's terrainExaggerationRelativeHeight idea).
  // 0 = classic sea-level anchoring; setVerticalExaggeration freezes in the
  // ground elevation under the camera so the terrain in view doesn't lift.
  private exagReference = 0;
  // Camera ground position from the last update(), for freezing exagReference.
  private lastCameraMercator?: [number, number];
  // Toggle for footprints visibility
  public showFootprints = false;
  // Toggle for Z/X/Y tile labels visibility
  public showLabels = false;
  // Toggle for baking an imagery-source letter into each tile texture:
  // U = USDA ImageServer basemap stitch, N = NAIP COG mosaic (DuckDB lookup).
  public showSourceLabels = false;
  // Imagery zoom threshold: tiles at z <= this load from the USDA NAIP
  // ImageServer instead of the COG tiler (which is slow/coverage-capped at low
  // zoom). Set to maxZoom to route everything external.
  public externalImageryMaxZoom = 13;
  // Terrain zoom floor: tiles at z < this skip the DEM fetch entirely and
  // render as flat sea-level quads (relief is subpixel at those altitudes).
  // Keeps low zoom off the tiler's far-field path; z14 = USGS 1/3, z15+ = S1M.
  public terrainMinZoom = 14;
  // Recycles tile textures rather than allocating one per tile. Share the same
  // instance with BundleCache, which returns evicted textures to it.
  public texturePool?: TexturePool;
  // Shading mode (0.0 = Satellite, 1.0 = DEM, 2.0 = Hypsometric)
  public shadingMode = 0.0;
  // Blend factor for hypsometric tinting (0.0 to 1.0)
  public hypsometricBlend = 0.5;
  // Selected imagery source layer type
  public imagerySource: "satellite" | "osm" = "satellite";
  // Toggle for showing DEM source colors
  public showDemColors = false;
  // Toggle for 3D vector buildings rendering
  public showBuildings = true;
  // Opacity for 3D building wall faces (0.0 fully transparent, 1.0 opaque)
  public buildingWallOpacity = 0.85;
  /** The one zoom that fetches /buildings; finer tiles reuse the cache. */
  public buildingSourceZoom = 14;
  /** Decoded footprints, keyed by source tile and reused up the LOD. */
  private buildingCache = new BuildingCache();
  /**
   * Live bytes of building geometry.
   *
   * Deliberately its own counter rather than part of BundleCache's 256 MB
   * budget: this geometry is owned by the tile MESH, not the bundle, so a
   * cached bundle with no live node holds none of it and folding it in would
   * make the budget lie in the other direction. It went untracked entirely
   * between cc32005 (which moved ownership) and now -- and b9f98ba then put
   * roof geometry on every overlapping tile, so there is much more of it.
   * Tracked so it is at least visible rather than invisible.
   */
  private buildingBytes = 0;
  /**
   * The whole GPU budget, shared between bundles and building geometry. Set
   * from BundleCache's initial budget, since that is where main.ts declares it.
   */
  private totalGpuBudget = 0;
  /**
   * Set when buildingBytes moves, cleared when the budget is reapplied. Exists
   * because the byte change and the eviction it implies must happen at
   * different times -- see rebalanceGpuBudget.
   */
  private buildingBudgetDirty = false;

  // Footprint overlay. The full S1M+usgs13 set (~360 KB gzipped) is fetched once
  // from the static /footprints/*.json files and held in memory; the mesh is
  // (re)built by clipping that set to the current viewport, so panning/zooming
  // never touches the network.
  private footprintsMesh?: LineSegments2;
  private footprintsMaterial?: LineMaterial;
  private allFootprints?: FootprintFeature[];
  private isFetchingFootprints = false;
  // The overlay is rebuilt only when terrain draping changes; this signature
  // (base zoom + loaded-node count) is compared each update to decide, and a
  // time throttle caps rebuilds while terrain streams in. "" forces a rebuild.
  private footprintsDrapeSig = "";
  private lastFootprintsBuildMs = 0;
  private visibleNodesList: TileNode[] = [];
  // Keep old root nodes rendering smoothly until new base level roots are fully loaded
  private transitionNodes = new Map<string, TileNode>();
  // Max lifetime (ms) of a stale tile after its base-zoom handoff. Coverage-
  // based retirement only works zooming OUT (a stale fine tile hides once its
  // coarser active ancestor renders); zooming IN, a stale coarse tile has no
  // active ancestor and would pin until the global swap — which camera motion
  // keeps resetting while each base-zoom step adds another stale cohort. The
  // TTL bounds that: the global swap prunes everything anyway, so timing a
  // straggler out just reaches the same steady state sooner.
  public transitionTtlMs = 5000;
  private workerPool = new TileWorkerPool();

  // --- Velocity-vector prefetch ---
  private prefetchPrevPos?: THREE.Vector3;
  private prefetchPrevTimeMs = 0;
  private prefetchVelocity = new THREE.Vector3(); // Mercator m/s, local offset space
  private lastPrefetchCount = 0;
  /** Prefetches issued since load. The per-frame count is 0 most frames — the
   *  camera is parked, or the tiles ahead are already cached — so a running
   *  total is what actually shows the feature working. */
  private prefetchTotal = 0;
  /** How far ahead (seconds) to sample along the flight vector. */
  public prefetchLookaheadSec = 4;
  /** Number of sample points along the look-ahead ray. */
  public prefetchSamples = 4;
  /** Minimum horizontal Mercator m/s before prefetch activates (≈ 100 kt ground). */
  public prefetchMinSpeedMs = 50;

  /**
   * Ceiling on pinned tiles, and so on resident VRAM: pinned bundles are exempt
   * from cache eviction, so this is what keeps BundleCache's byte budget real.
   * Roughly one megabyte per tile (mesh + 512² texture), so the default pairs
   * with a 256 MB budget.
   */
  public maxActiveTiles = 256;

  // Screen-space-error projection factor: (viewportH/2) * cot(fovY/2), i.e.
  // pixels per radian of vertical view angle. Recomputed each update() from
  // the camera's projection matrix; fallback for cameraless (test) updates.
  private sseFactor = 900;
  private activeVisibleKeys = new Set<string>();

  /** Refine while a tile's geometric error projects to more than this many px. */
  private get sseThreshold(): number {
    // Derived from lodFactor so the existing constructor knob keeps meaning:
    // higher lodFactor -> lower pixel tolerance -> more subdivision.
    return 16 / this.lodFactor;
  }

  public globalUniforms = {
    // matches the midday preset + HUD slider default (main.ts applyPreset)
    hillshadeIntensity: { value: 0.25 },
    sunDirection: { value: new THREE.Vector3(-1, -1, 1.4).normalize() },
    fallbackColor: { value: new THREE.Color(0x556655) },
    showOutlines: { value: false },
    showDemColors: { value: false },
    shadingMode: { value: 0.0 },
    hypsometricBlend: { value: 0.5 },
    useLocalHypso: { value: 1.0 },
    localMinElev: { value: 0.0 },
    localMaxElev: { value: 4000.0 },
    // main.ts sets the real starting value per imagery source right after
    // construction (BRIGHTNESS_BY_SOURCE); this is just the pre-init default.
    brightness: { value: 1.5 },
    contrast: { value: 1.10 },
    saturation: { value: 1.15 }
  };
  
  constructor(
    readonly baseUrl: string,
    readonly layer: string,
    readonly year: number,
    readonly scene: THREE.Scene,
    readonly bundleCache: BundleCache,
    readonly worldAnchor: [number, number],
    public baseZoom = 12,
    readonly maxZoom = 18,
    readonly lodFactor = 2.2,
    readonly cullTiles = true
  ) {
    // The cache's starting budget is the whole GPU budget; from here on it only
    // gets the share buildings are not using.
    this.totalGpuBudget = bundleCache.byteBudget;
  }

  /**
   * Update active tiles and LOD based on camera position (relative to worldAnchor) and frustum.
   * @param localCameraPos Camera position in local offset space.
   * @param camera Optional Three.js Camera to build view frustum for view culling.
   */
  update(localCameraPos: THREE.Vector3, camera?: THREE.Camera): void {
    this.visibleNodesList = [];
    // Projection factor for SSE: projectionMatrix[5] is cot(fovY/2) for a
    // perspective camera, so (viewportH/2) * m[5] converts a (metres/metre)
    // angular error into on-screen pixels.
    if (camera instanceof THREE.PerspectiveCamera) {
      const cotHalfFov = camera.projectionMatrix.elements[5]!;
      const viewportH = typeof window !== "undefined" ? window.innerHeight : 1024;
      this.sseFactor = (viewportH / 2) * cotHalfFov;
    }

    // 0. Compute dynamic base zoom from camera altitude
    // Roots are the 3x3 grid that covers the visible area; they must stay
    // coarse (large tiles) so the grid spans to the horizon. Fine detail is
    // the LOD subdivision system's job — it refines roots down to maxZoom.
    const altitude = localCameraPos.z;
    let computedBaseZoom = 12;
    if (altitude > 1280000) {
      computedBaseZoom = 3;
    } else if (altitude > 640000) {
      computedBaseZoom = 4;
    } else if (altitude > 320000) {
      computedBaseZoom = 5;
    } else if (altitude > 160000) {
      computedBaseZoom = 6;
    } else if (altitude > 80000) {
      computedBaseZoom = 7;
    } else if (altitude > 40000) {
      computedBaseZoom = 8;
    } else if (altitude > 20000) {
      computedBaseZoom = 9;
    } else if (altitude > 10000) {
      computedBaseZoom = 10;
    } else if (altitude > 5000) {
      computedBaseZoom = 11;
    }

    if (computedBaseZoom !== this.baseZoom) {
      // Move current root nodes to transitionNodes to keep them on screen during transition
      const handoff = performance.now();
      for (const [key, node] of this.rootNodes.entries()) {
        this.transitionNodes.set(key, node);
        node.transitionSince = handoff; // starts (or restarts) the stale TTL
        this.applyPolygonOffset(node, true);
        this.cancelLoadingSubtree(node);
      }
      this.rootNodes.clear();
      this.baseZoom = computedBaseZoom;
    }

    // 1. Convert local offset space to global Mercator meters
    const cx = localCameraPos.x + this.worldAnchor[0];
    const cy = localCameraPos.y + this.worldAnchor[1];
    this.lastCameraMercator = [cx, cy];

    // Velocity estimate for prefetch: finite-difference from prev frame.
    // Clamped to 200 ms: tabs that go to background then resume would produce a
    // huge phantom velocity spike from accumulated dt — reset instead.
    const pfNow = performance.now();
    const pfDt = pfNow - this.prefetchPrevTimeMs;
    if (this.prefetchPrevPos && pfDt > 0 && pfDt < 200) {
      this.prefetchVelocity
        .subVectors(localCameraPos, this.prefetchPrevPos)
        .divideScalar(pfDt / 1000);
    } else if (pfDt >= 200) {
      // Stale gap (tab hidden, long GC pause, etc.) — reset so we don't lurch.
      this.prefetchVelocity.set(0, 0, 0);
    }
    this.prefetchPrevPos = localCameraPos.clone();
    this.prefetchPrevTimeMs = pfNow;

    // 2. Determine the root-grid center tile. Bias it forward along the
    // horizontal component of the view direction: flying level, the frustum
    // sees several tiles ahead and none behind, so a position-centered grid
    // wastes half its budget on culled tiles behind the camera and the thin
    // leading edge is outrun at flight speed. The horizontal component
    // vanishes looking straight down, so top-down views keep a centered grid.
    let gx = cx, gy = cy;
    if (camera) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const tileW = EARTH_CIRCUMFERENCE / 2 ** this.baseZoom;
      // Estimate forward ground intersection distance: when looking toward the ground (fwd.z < 0),
      // ground distance is -h/fwd.z. Cap at 1.0 tileW so the grid stays centered around the actual
      // view target and never evicts live tiles upon camera rotation.
      let forwardDist = 1.0 * tileW;
      if (fwd.z < -0.05) {
        const distToGround = Math.max(0, -localCameraPos.z / fwd.z);
        forwardDist = Math.min(1.0 * tileW, distToGround);
      }
      gx += fwd.x * forwardDist;
      gy += fwd.y * forwardDist;
    }
    const centerTile = mercatorToTile(gx, gy, this.baseZoom);

    // 3. Generate a 5x5 grid of root tiles around the camera center tile.
    // 5x5 (not 3x3) so the horizon extends ~2 tiles in every direction;
    // distant roots stay coarse (cheap), only near-camera tiles subdivide.
    const newRootKeys = new Set<string>();
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const tx = centerTile.x + dx;
        const ty = centerTile.y + dy;
        // Simple range check for Web Mercator tile index boundaries
        const maxTiles = 2 ** this.baseZoom;
        if (tx >= 0 && tx < maxTiles && ty >= 0 && ty < maxTiles) {
          const t: TileId = { z: this.baseZoom, x: tx, y: ty };
          const key = tileKey(t);
          newRootKeys.add(key);

          if (!this.rootNodes.has(key)) {
            if (this.transitionNodes.has(key)) {
              // Reclaim the existing node from transitionNodes instead of instantiating a duplicate
              const node = this.transitionNodes.get(key)!;
              this.rootNodes.set(key, node);
              this.transitionNodes.delete(key);
              node.transitionSince = undefined; // active again, no longer stale
              this.applyPolygonOffset(node, false);
            } else {
              const bounds = tileBoundsMercator(t);
              const center: [number, number] = [
                (bounds.west + bounds.east) / 2,
                (bounds.north + bounds.south) / 2,
              ];
              this.rootNodes.set(key, {
                key,
                tile: t,
                bounds,
                centerMercator: center,
                loading: false,
                loaded: false,
                visible: false,
              });
            }
          }
        }
      }
    }

    // 4. Evict root nodes that are too far from the camera (Chebyshev distance > 3)
    for (const [key, node] of this.rootNodes.entries()) {
      const dx = Math.abs(node.tile.x - centerTile.x);
      const dy = Math.abs(node.tile.y - centerTile.y);
      if (dx > 3 || dy > 3) {
        this.pruneNode(node);
        this.rootNodes.delete(key);
      }
    }

    // 5. Build view frustum if camera is provided
    let frustum: THREE.Frustum | undefined;
    if (this.cullTiles && camera) {
      camera.updateMatrixWorld(true);
      frustum = new THREE.Frustum();
      const projScreenMatrix = new THREE.Matrix4();
      projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projScreenMatrix);
    }

    // 6. Run LOD update on each root node recursively
    this.activeKeys.clear();
    this.activeVisibleKeys.clear();
    const cameraPosGlobal = new THREE.Vector3(cx, cy, localCameraPos.z);

    for (const node of this.rootNodes.values()) {
      this.updateNode(node, cameraPosGlobal, frustum);
    }

    // Re-check and update transition nodes if they exist
    if (this.transitionNodes.size > 0) {
      // The new base level is ready once every in-view root is COVERED, not
      // necessarily loaded itself: a root that immediately subdivides is hidden
      // by its children and never gets triggerLoad'd (so node.loaded stays
      // false forever), yet its footprint is fully drawn by those children.
      // Checking node.loaded here would pin the old coarse roots permanently.
      let allNewRootsLoaded = true;
      for (const node of this.rootNodes.values()) {
        if (!this.isCovered(node, frustum)) {
          allNewRootsLoaded = false;
        }
      }

      if (allNewRootsLoaded) {
        // Swap complete! Prune and discard all old transition nodes
        for (const node of this.transitionNodes.values()) {
          this.pruneNode(node);
        }
        this.transitionNodes.clear();
      } else {
        // Still loading: keep transition nodes alive and visible — but only
        // for transitionTtlMs each. Without the TTL, a fast zoom-IN leaves
        // stale coarse cohorts no coverage check can ever retire, and their
        // coarsely-sampled DEM surfaces poke through the fine terrain
        // ("bleeding"). Prune expired nodes individually; survivors keep
        // rendering as the usual hole-free fallback.
        const now = performance.now();
        for (const [key, node] of this.transitionNodes.entries()) {
          if (now - (node.transitionSince ?? now) > this.transitionTtlMs) {
            this.pruneNode(node);
            this.transitionNodes.delete(key);
          }
        }
        for (const node of this.transitionNodes.values()) {
          this.updateTransitionNode(node, cameraPosGlobal, frustum);
        }
      }
    }

    // 6b. Settle the GPU budget now the walk is done and activeKeys is whole
    // again. Every live mesh is pinned at this point, so eviction can only take
    // bundles nothing renders -- the precondition TexturePool recycling relies
    // on. Doing this inside the walk is what put another tile's imagery on
    // screen and blacked out the tile it was taken from.
    if (this.buildingBudgetDirty) {
      this.rebalanceGpuBudget();
    }

    // 7. Update scene visibility & sync mesh additions/removals
    for (const node of this.rootNodes.values()) {
      this.syncScene(node);
    }
    for (const node of this.transitionNodes.values()) {
      this.syncScene(node);
    }

    // 8. Update viewport-wide footprints
    this.updateViewportFootprints();

    // 9. Calculate local viewport min/max elevations if using local hypsometric tinting
    let viewMin = Infinity;
    let viewMax = -Infinity;
    let hasElevations = false;
    for (const node of this.visibleNodesList) {
      if (node.loaded && node.minElevation !== undefined && node.maxElevation !== undefined && node.demSource !== "flat") {
        if (node.minElevation < viewMin) viewMin = node.minElevation;
        if (node.maxElevation > viewMax) viewMax = node.maxElevation;
        hasElevations = true;
      }
    }

    if (hasElevations && viewMin < viewMax) {
      this.globalUniforms.localMinElev.value = viewMin;
      this.globalUniforms.localMaxElev.value = viewMax;
    } else {
      this.globalUniforms.localMinElev.value = 0.0;
      this.globalUniforms.localMaxElev.value = 4000.0;
    }

    // 10. Prefetch tiles along the flight vector
    this.prefetchAhead();
  }

  /**
   * Get the keys of all tiles that are currently pinned (visible or actively loading).
   */
  getActiveKeys(): Set<string> {
    return this.activeKeys;
  }

  /** Number of prefetch tile requests enqueued in the last update(). */
  getLastPrefetchCount(): number {
    return this.lastPrefetchCount;
  }

  /** Prefetch requests enqueued since load. */
  getPrefetchTotal(): number {
    return this.prefetchTotal;
  }

  /** @returns true if the node was frustum-culled (renders nothing on screen). */
  private updateNode(node: TileNode, cameraPosGlobal: THREE.Vector3, frustum?: THREE.Frustum): boolean {
    // Per-tile ground→world Z scale at the tile's center latitude.
    // Every true-metre value (elevation, exagZ) must be multiplied by this
    // before entering world Z, where the camera and frustum live. Mesh
    // vertices bake h·zScale; the same factor applies here for consistency.
    const zScale = mercatorScale(mercatorToLonLat(node.centerMercator[0], node.centerMercator[1])[1]);

    // 1. Perform frustum culling check first
    if (this.cullTiles && frustum) {
      // Box Z in world (Mercator) metres: exagZ returns true metres, ×zScale
      // converts to the world Z the frustum is projected in.
      const tileMinZ = this.exagZ(-1000) * zScale;
      const tileMaxZ = this.exagZ(9000) * zScale;
      const box = new THREE.Box3(
        new THREE.Vector3(node.bounds.west - this.worldAnchor[0], node.bounds.south - this.worldAnchor[1], tileMinZ),
        new THREE.Vector3(node.bounds.east - this.worldAnchor[0], node.bounds.north - this.worldAnchor[1], tileMaxZ)
      );

      if (!frustum.intersectsBox(box)) {
        // Node is completely out of view. Normally retained (still pinned) so
        // rotating back is gap-free — but in forward flight that trail is the
        // main source of pinned-tile growth, and pinned bundles are exempt
        // from eviction, so it is what actually voids the cache budget. Once
        // the active set is at its cap, drop the subtree instead and accept a
        // reload if the camera turns back: a brief gap under memory pressure
        // beats an unbounded resident set.
        if (this.activeKeys.size >= this.maxActiveTiles) {
          this.pruneNode(node);
        } else {
          this.hideSubtree(node);
        }
        return true; // Stop recursion and loading!
      }
    }

    const tileW = node.bounds.east - node.bounds.west;

    const clampX = Math.max(node.bounds.west, Math.min(node.bounds.east, cameraPosGlobal.x));
    const clampY = Math.max(node.bounds.south, Math.min(node.bounds.north, cameraPosGlobal.y));
    // closestPoint.z must be in world Z (Mercator metres) to match
    // cameraPosGlobal.z — both the frustum and the camera live in world space.
    const closestPoint = new THREE.Vector3(clampX, clampY, this.exagZ(node.centerElevation ?? 0) * zScale);
    const dist = Math.max(1, cameraPosGlobal.distanceTo(closestPoint));

    // Pin this key as active
    this.activeKeys.add(node.key);

    // Screen-space-error subdivision (Cesium-style): refine while the tile's
    // geometric error projects to more than sseThreshold pixels on screen.
    //   ssePx = (geometricError / dist) * (viewportH/2) * cot(fovY/2)
    // Monotonic in distance, so LOD rings can NEVER invert: highest z is
    // always nearest the camera, decreasing with distance. View direction
    // deliberately plays no part here — an earlier angle-based heuristic
    // collapsed the threshold for the tile directly below a horizon-facing
    // camera, leaving coarse tiles near and fine tiles far. Direction is
    // frustum culling's job (behind-camera tiles are culled, never loaded).
    const geometricError = tileW / 64; // mesh cell size (512px / gridStep 8)
    const ssePx = (geometricError / dist) * this.sseFactor;
    // Refinement also has to fit in memory. Every pinned key holds its bundle
    // against eviction, so an unbounded active set silently voids the cache
    // budget: at speed this hit 658 tiles / 677 MB against a 256 MB budget,
    // with nothing evictable. Stopping subdivision at the cap costs detail at
    // the far edge of the view instead, and keeps the budget meaningful.
    // Already-subdivided nodes keep refining, so hitting the cap degrades the
    // frontier rather than collapsing LOD under the camera.
    const withinTileBudget =
      this.activeKeys.size < this.maxActiveTiles || node.children !== undefined;
    const shouldSubdivide =
      ssePx > this.sseThreshold && node.tile.z < this.maxZoom && withinTileBudget;

    if (shouldSubdivide) {
      if (!node.children) {
        node.children = this.createChildren(node.tile);
      }

      // Recursively update children. A child must not block the parent->child
      // swap when it is frustum-culled (renders nothing) OR recursively
      // covered (loaded, or subdivided with every descendant culled/loaded).
      // Checking child.loaded alone deadlocks at the frustum edge: an in-view
      // child that subdivides and has ALL its children culled hides itself
      // without ever loading, so the parent would wait forever and a coarse
      // tile would sit next to the camera permanently.
      let allChildrenLoaded = true;
      for (const child of node.children) {
        const culled = this.updateNode(child, cameraPosGlobal, frustum);
        if (!culled && !this.isCovered(child, frustum)) {
          allChildrenLoaded = false;
        }
      }

      if (allChildrenLoaded) {
        // Children take over: hide parent mesh
        node.visible = false;
      } else {
        // Not all four children are ready. Render ONLY the parent as a
        // coarse fallback and hide the partially-loaded child subtree, so a
        // parent and its finer children never render in the same footprint at
        // once. Overlapping them z-fights, and when they come from different
        // DEM sources (far-field parent vs S1M children across the z15
        // boundary) that z-fight shows as a cyan/gray "camo" within one tile.
        // Children swap in atomically once all four have loaded.
        node.visible = true;
        this.triggerLoad(node, -dist);
        for (const child of node.children) {
          this.hideSubtree(child);
        }
      }
    } else {
      // Do not subdivide: show parent
      node.visible = true;
      this.triggerLoad(node, -dist);

      // Collapse and dispose children if they exist to conserve memory
      if (node.children) {
        for (const child of node.children) {
          this.pruneNode(child);
        }
        delete node.children;
      }
    }

    if (node.visible) {
      this.activeVisibleKeys.add(node.key);
      this.visibleNodesList.push(node);
    }

    return false; // in view
  }

  /**
   * Mark a node and its whole descendant subtree invisible but retained. The
   * keys are still pinned as active so BundleCache won't evict + dispose their
   * geometry: a frustum-culled subtree is kept so rotating back is gap-free,
   * but if its bundle were disposed the retained mesh would render blank and
   * never reload (triggerLoad early-returns on loaded). Pinning is bounded by
   * the root grid — once a root is evicted the whole subtree drops out.
   */
  private hideSubtree(node: TileNode): void {
    node.visible = false;
    this.activeKeys.add(node.key);
    if (node.children) {
      for (const child of node.children) {
        this.hideSubtree(child);
      }
    }
  }

  private createChildren(tile: TileId): TileNode[] {
    const children: TileNode[] = [];
    const cz = tile.z + 1;
    const offsets = [
      { dx: 0, dy: 0 }, // Top-Left
      { dx: 1, dy: 0 }, // Top-Right
      { dx: 0, dy: 1 }, // Bottom-Left
      { dx: 1, dy: 1 }, // Bottom-Right
    ];

    for (const offset of offsets) {
      const cx = tile.x * 2 + offset.dx;
      const cy = tile.y * 2 + offset.dy;
      const childTile: TileId = { z: cz, x: cx, y: cy };
      const key = tileKey(childTile);
      const bounds = tileBoundsMercator(childTile);
      const center: [number, number] = [
        (bounds.west + bounds.east) / 2,
        (bounds.north + bounds.south) / 2,
      ];
      children.push({
        key,
        tile: childTile,
        bounds,
        centerMercator: center,
        loading: false,
        loaded: false,
        visible: false,
      });
    }

    return children;
  }

  private triggerLoad(node: TileNode, priority: number): void {
    if (node.loaded) {
      return;
    }
    if (node.loading) {
      // Already queued/running: refresh its priority with the current camera
      // distance so tiles queued near an old camera position can't outrank
      // the tiles now in front of a moving camera.
      this.workerPool.reprioritize(node.tile, priority);
      return;
    }
    // Cooldown after a failure so a persistently-failing tile isn't re-fetched
    // every frame (the loader already backed off + retried internally).
    if (node.retryAfter !== undefined && performance.now() < node.retryAfter) {
      return;
    }

    node.loading = true;
    const key = node.key;

    // 1. Check if an exact loaded match exists in transitionNodes
    const transNode = this.transitionNodes.get(key);
    if (transNode && transNode.loaded && transNode.mesh) {
      const mat = transNode.mesh.material as THREE.ShaderMaterial;
      const tex = mat.uniforms.map?.value as THREE.Texture | null;
      if (tex) {
        node.centerElevation = transNode.centerElevation;
        node.demSource = transNode.demSource;
        node.minElevation = transNode.minElevation;
        node.maxElevation = transNode.maxElevation;
        this.createMeshFromBundle(node, {
          key: node.key,
          bytes: 0,
          geometry: transNode.mesh.geometry,
          // Reusing the transition node's terrain grid, so its gridSize too.
          gridSize: transNode.gridSize ?? 65,
          texture: tex,
        });
        node.loaded = true;
        node.loading = false;
        return;
      }
    }

    // 2. Check if the bundle exists in cache
    const cached = this.bundleCache.get(key);
    // A source-zoom tile whose footprints have aged out of BuildingCache has to
    // go back to the worker. The bundle short-circuit below skips the fetch
    // entirely -- terrain is complete without buildings, so nothing notices --
    // and the /buildings request is made nowhere else. BuildingCache holds 64
    // source tiles against a BundleCache measured in hundreds of megabytes, so
    // records age out first, and every finer tile over that ground then reads a
    // cold cache and draws no buildings for as long as the terrain bundle lives.
    const needsFootprints =
      this.showBuildings &&
      node.tile.z === this.buildingSourceZoom &&
      !this.buildingCache.has(node.tile);
    if (cached && !needsFootprints) {
      node.centerElevation = cached.centerElevation;
      node.demSource = cached.demSource;
      node.minElevation = cached.minElevation;
      node.maxElevation = cached.maxElevation;
      this.createMeshFromBundle(node, cached);
      node.loaded = true;
      node.loading = false;
      return;
    }

    const options = {
      baseUrl: this.baseUrl,
      layer: this.layer,
      year: this.year,
      imagerySource: this.imagerySource,
      terrainMinZoom: this.terrainMinZoom,
      gridStep: this.gridStep,
      externalImageryMaxZoom: this.externalImageryMaxZoom,
      showBuildings: this.showBuildings,
      buildingSourceZoom: this.buildingSourceZoom,
    };

    this.workerPool.requestTile(node.tile, priority, options)
        .then((res) => {
          if (!node.loading) {
            if (res.imageBitmap) res.imageBitmap.close();
            return;
          }

          const { demSource, centerElevation, minElevation, maxElevation } = res;
          node.centerElevation = centerElevation;
          node.demSource = demSource;
          node.minElevation = minElevation;
          node.maxElevation = maxElevation;

          const bundle = this.buildBundleFromResult(key, node.tile, res);
          this.bundleCache.put(bundle, this.activeKeys);
          this.createMeshFromBundle(node, bundle);
          node.loaded = true;
          node.loading = false;
          node.retryAfter = undefined;
        })
        .catch((err) => {
          node.loading = false;
          if (err instanceof DOMException && err.name === "AbortError") {
            return; // Normal cancellation
          }
          console.warn(`Failed tile load ${node.key}:`, err);
        });
  }

  /**
   * Extrude this tile's share of the cached buildings, or undefined if it has
   * none. Runs for every terrain tile at or above the source zoom, which is what
   * lets one fetch serve z14 through z18.
   */
  /**
   * Release a tile's building mesh. Necessary because the geometry is owned by
   * the mesh rather than the Bundle -- BundleCache.disposeBundle no longer
   * frees it, so without this every subdivide leaks a building geometry.
   *
   * The wall material is per-mesh and disposed here too. The roof material is
   * the tile's own terrain ShaderMaterial, disposed by the caller; disposing it
   * again here would double-free it.
   */
  private disposeBuildingMesh(node: TileNode): void {
    const bMesh = node.mesh?.getObjectByName("buildingMesh") as THREE.Mesh | undefined;
    if (!bMesh) return;
    this.buildingBytes -= buildingGeometryBytes(bMesh.geometry);
    // Deferred, not applied here: pruneNode reaches this from inside update()'s
    // tree walk, when activeKeys is only half rebuilt -- see rebalanceGpuBudget.
    this.buildingBudgetDirty = true;
    bMesh.geometry.dispose();
    const mats = Array.isArray(bMesh.material) ? bMesh.material : [bMesh.material];
    mats[0]?.dispose(); // walls only; mats[1] is the shared terrain material
    node.mesh?.remove(bMesh);
  }

  /**
   * Hang extruded buildings on a terrain mesh.
   *
   * Group 1 (roofs) reuses the terrain material INSTANCE, so a roof tones
   * exactly like the ground it sits on and follows SHADING MODE, brightness,
   * contrast, saturation and hillshade with no second uniform set to keep in
   * step -- and nothing extra to dispose, since the mesh does not own it.
   */
  private attachBuildingMesh(
    mesh: THREE.Mesh,
    buildingGeometry: THREE.BufferGeometry,
    terrainMaterial: THREE.Material
  ): void {
    const wallMat = new THREE.MeshLambertMaterial({
      color: 0xcbd5e1,
      side: THREE.DoubleSide,
      transparent: this.buildingWallOpacity < 1.0,
      opacity: this.buildingWallOpacity,
    });
    const bMesh = new THREE.Mesh(buildingGeometry, [wallMat, terrainMaterial]);
    bMesh.name = "buildingMesh";
    bMesh.visible = this.showBuildings;
    mesh.add(bMesh);
    this.buildingBytes += buildingGeometryBytes(buildingGeometry);
    // Deferred for the same reason as the disposal side: settled once per
    // frame in update(), where the pin set is known to be complete.
    this.buildingBudgetDirty = true;
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
   *
   * transitionNodes are walked too: a base-zoom change parks whole subtrees
   * there, and those tiles are on screen exactly like any other.
   */
  private attachPendingBuildings(source: TileId): void {
    const visit = (node: TileNode): void => {
      const mesh = node.mesh;
      if (
        mesh &&
        node.loaded &&
        node.gridSize !== undefined &&
        node.tile.z >= this.buildingSourceZoom &&
        !mesh.getObjectByName("buildingMesh")
      ) {
        const owner = BuildingCache.sourceTileFor(node.tile, this.buildingSourceZoom);
        if (owner.x === source.x && owner.y === source.y && owner.z === source.z) {
          // mats[0] is the terrain material for a terrain mesh; roofs share the
          // instance, exactly as they do when the mesh is first built.
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          const buildingGeometry = material
            ? this.buildBuildingGeometry(
                node.tile,
                mesh.geometry.getAttribute("position").array,
                node.gridSize
              )
            : undefined;
          if (buildingGeometry && material) {
            this.attachBuildingMesh(mesh, buildingGeometry, material);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) visit(child);
      }
    };
    for (const root of this.rootNodes.values()) visit(root);
    for (const node of this.transitionNodes.values()) visit(node);
  }

  private buildBuildingGeometry(
    tile: TileId,
    positions: ArrayLike<number>,
    gridSize: number
  ): THREE.BufferGeometry | undefined {
    const owned = this.buildingCache.forTile(tile, this.buildingSourceZoom);
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

    const zScale = mercatorScale(
      mercatorToLonLat(
        (tileBoundsMercator(tile).west + tileBoundsMercator(tile).east) / 2,
        (tileBoundsMercator(tile).north + tileBoundsMercator(tile).south) / 2
      )[1]
    );

    const built = buildTileBuildings(
      owned.wallRecords,
      owned.roofRecords,
      tile,
      groundAt,
      zScale,
      owned.origin,
      this.buildingSourceZoom
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
   * Shared resolution step for triggerLoad and prefetchAhead: convert a worker
   * result into a Bundle (geometry + texture) without touching any TileNode.
   * Callers are responsible for putting the bundle into the cache.
   */
  private buildBundleFromResult(
    key: string,
    tile: TileId,
    res: TileLoadResult
  ): Bundle {
    const { demSource, centerElevation, meshData, buildingRecords, imageBitmap, minElevation, maxElevation } = res;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(meshData.positions, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(meshData.uvs, 2));
    geom.setAttribute("normal", new THREE.BufferAttribute(meshData.normals, 3));
    geom.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

    // Source-zoom tiles carry the footprints; cache them so every finer tile
    // over this ground can re-extrude without another fetch.
    if (buildingRecords) {
      const source = BuildingCache.sourceTileFor(tile, this.buildingSourceZoom);
      this.buildingCache.put(source, buildingRecords);
      // Tiles over this ground that already drew without buildings can have
      // them now.
      this.attachPendingBuildings(source);
    }

    // NOT built here. Building geometry is assembled at mesh-creation time
    // instead, so it reflects the BuildingCache as it is when the tile is drawn
    // rather than when it was first fetched. Frozen here, a tile bundled before
    // its source tile's records arrived stayed empty forever: triggerLoad's
    // bundleCache.get() short-circuit means the bundle is never rebuilt.
    // Reproduced on 16/12812/23939 -- owns 7 buildings, bundled cold, still
    // empty long after the cache went warm.

    let texture: THREE.Texture | undefined;
    if (imageBitmap) {
      const branded = this.bakeTileLabel(imageBitmap, tile);
      texture = this.texturePool
        ? this.texturePool.acquire(branded as unknown as TexImageSource)
        : new THREE.CanvasTexture(branded as unknown as HTMLCanvasElement);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
    }

    const bytes =
      meshData.positions.byteLength +
      meshData.normals.byteLength +
      meshData.indices.byteLength +
      (texture ? 512 * 512 * 4 : 0);

    return { key, bytes, geometry: geom, gridSize: meshData.gridSize, texture, centerElevation, demSource, minElevation, maxElevation };
  }



  /**
   * Velocity-vector prefetch: sample look-ahead points along the
   * horizontal flight vector and pre-warm the bundle cache for tiles the camera
   * will encounter in prefetchLookaheadSec seconds. Called at the end of update().
   *
   * Tiles already in the bundle cache or actively loading are skipped (no-ops).
   * Prefetch requests use a priority well below visible tiles so the worker pool
   * never starves the current frame's tile loads.
   */
  private prefetchAhead(): void {
    this.lastPrefetchCount = 0;
    if (!this.prefetchPrevPos) return;

    const horizSpeedSq =
      this.prefetchVelocity.x ** 2 + this.prefetchVelocity.y ** 2;
    if (horizSpeedSq < this.prefetchMinSpeedMs ** 2) return;

    const options = {
      baseUrl: this.baseUrl,
      layer: this.layer,
      year: this.year,
      imagerySource: this.imagerySource,
      terrainMinZoom: this.terrainMinZoom,
      gridStep: this.gridStep,
      externalImageryMaxZoom: this.externalImageryMaxZoom,
      showBuildings: this.showBuildings,
      buildingSourceZoom: this.buildingSourceZoom,
    };

    // Prefetch zoom: match camera's active LOD zoom tier (baseZoom + 2 capped at maxZoom),
    // so a high-altitude camera at z=7 prefetches z=9, NOT z=18!
    const zoom = Math.min(this.baseZoom + 2, this.maxZoom);
    const anchorX = this.worldAnchor[0];
    const anchorY = this.worldAnchor[1];

    for (let s = 1; s <= this.prefetchSamples; s++) {
      const t = (s / this.prefetchSamples) * this.prefetchLookaheadSec;
      const fx = (this.prefetchPrevPos.x + anchorX) + this.prefetchVelocity.x * t;
      const fy = (this.prefetchPrevPos.y + anchorY) + this.prefetchVelocity.y * t;

      const tile = mercatorToTile(fx, fy, zoom);
      const key = tileKey(tile);

      // Skip if already cached or in the active LOD tree (loads via triggerLoad).
      if (this.bundleCache.get(key)) continue;
      if (this.activeKeys.has(key)) continue;

      this.lastPrefetchCount++;
      this.prefetchTotal++;
      // Prefetch priority is well below active tiles. triggerLoad uses negative
      // camera distances (roughly -1e3 to -1e6); -1e7 ensures prefetch yields.
      const priority = -1e7 - s;
      const capturedKey = key;
      const capturedTile = { ...tile };
      this.workerPool.requestTile(capturedTile, priority, options)
        .then((res) => {
          const bundle = this.buildBundleFromResult(capturedKey, capturedTile, res);
          this.bundleCache.put(bundle, this.activeKeys);
        })
        .catch(() => {
          // Non-fatal: the LOD tree retries if/when the camera arrives.
        });
    }
  }

  /**
   * High-priority FlyTo prefetch: calculate all destination tiles needed at the arrival
   * ground point and dispatch them to the top of the worker queue before the flight starts.
   */
  prefetchTargetGround(targetGround: THREE.Vector3, arrivalAltAgl: number = 1500): void {
    const cx = targetGround.x + this.worldAnchor[0];
    const cy = targetGround.y + this.worldAnchor[1];
    const arrivalAltitude = targetGround.z + arrivalAltAgl;

    let targetBaseZoom = 11;
    if (arrivalAltitude > 40000) targetBaseZoom = 8;
    else if (arrivalAltitude > 20000) targetBaseZoom = 9;
    else if (arrivalAltitude > 10000) targetBaseZoom = 10;
    else if (arrivalAltitude > 5000) targetBaseZoom = 11;
    else targetBaseZoom = 12;

    const centerTile = mercatorToTile(cx, cy, targetBaseZoom);
    const maxTiles = 2 ** targetBaseZoom;

    const targetTiles: TileId[] = [];

    // Collect 3x3 root grid at destination baseZoom
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = centerTile.x + dx;
        const ty = centerTile.y + dy;
        if (tx >= 0 && tx < maxTiles && ty >= 0 && ty < maxTiles) {
          targetTiles.push({ z: targetBaseZoom, x: tx, y: ty });
        }
      }
    }

    // Collect immediate LOD child tiles around center tile capped at targetBaseZoom + 1
    const maxZ = Math.min(this.maxZoom, targetBaseZoom + 1);
    const collectChildren = (t: TileId) => {
      if (t.z >= maxZ) return;
      const cX = t.x * 2;
      const cY = t.y * 2;
      for (let dx = 0; dx <= 1; dx++) {
        for (let dy = 0; dy <= 1; dy++) {
          const child: TileId = { z: t.z + 1, x: cX + dx, y: cY + dy };
          targetTiles.push(child);
          collectChildren(child);
        }
      }
    };
    collectChildren(centerTile);

    const options = {
      baseUrl: this.baseUrl,
      layer: this.layer,
      year: this.year,
      imagerySource: this.imagerySource,
      terrainMinZoom: this.terrainMinZoom,
      gridStep: this.gridStep,
      externalImageryMaxZoom: this.externalImageryMaxZoom,
      showBuildings: this.showBuildings,
      buildingSourceZoom: this.buildingSourceZoom,
    };

    // Priority = 1e8 (super high priority so it jumps to top of pending task queue)
    for (const tile of targetTiles) {
      const key = tileKey(tile);
      if (this.bundleCache.get(key)) continue;

      const capturedKey = key;
      const capturedTile = { ...tile };
      this.workerPool.requestTile(capturedTile, 1e8, options)
        .then((res) => {
          const bundle = this.buildBundleFromResult(capturedKey, capturedTile, res);
          this.bundleCache.put(bundle, this.activeKeys);
        })
        .catch(() => {
          // Non-fatal: LOD tree will retry if missing when camera arrives
        });
    }
  }

  private buildViewportFootprintsMesh(
    footprints: FootprintCollection
  ): LineSegments2 | undefined {
    if (footprints.features.length === 0) {
      return undefined;
    }

    const vertices: number[] = [];
    const colors: number[] = [];

    const addRingSegments = (ring: [number, number][], isS1M: boolean) => {
      if (ring.length < 2) return;

      // S1M (1m) = Cyan (0, 1, 1), USGS 1/3 Arc-Second (10m) = Magenta (1, 0, 1)
      const colorRGB = isS1M ? [0.0, 1.0, 1.0] : [1.0, 0.0, 1.0];

      // Per-vertex anchor-relative XY, latitude, and terrain elevation (null
      // where no terrain is loaded under the point — e.g. anywhere at a CONUS
      // overview, where nothing below terrainMinZoom is fetched).
      const pts = ring.map(([lon, lat]) => {
        const [mx, my] = lonLatToMercator(lon, lat);
        return {
          x: mx - this.worldAnchor[0],
          y: my - this.worldAnchor[1],
          lat,
          elev: this.getElevationAt(mx, my) as number | null,
        };
      });

      // Match the terrain's world Z exactly to kill perspective parallax:
      // terrain z = exagZ(elevation) * mercatorScale(lat) (reference-anchored
      // exaggeration, same affine map the meshes realise via scale+offset).
      const zOf = (elev: number, lat: number) =>
        this.exagZ(elev) * mercatorScale(lat) + 5.0;

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!, b = pts[i + 1]!;
        // Resolve missing elevations so every footprint draws: a fully-unloaded
        // segment (overview) sits flat at sea level; a mixed segment lifts the
        // null end to its neighbour so the line never plunges to 0 at a loaded-
        // terrain boundary — the "curtain" that skipping used to avoid (307f109).
        let ea = a.elev, eb = b.elev;
        if (ea === null && eb === null) { ea = 0; eb = 0; }
        else if (ea === null) ea = eb;
        else if (eb === null) eb = ea;
        vertices.push(a.x, a.y, zOf(ea!, a.lat), b.x, b.y, zOf(eb!, b.lat));
        colors.push(...colorRGB, ...colorRGB);
      }
    };

    for (const feat of footprints.features) {
      const geom = feat.geometry;
      const isS1M = feat.properties.type !== "usgs13";
      
      if (geom.type === "Polygon") {
        for (const ring of geom.coordinates) {
          addRingSegments(ring, isS1M);
        }
      } else {
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            addRingSegments(ring, isS1M);
          }
        }
      }
    }

    if (vertices.length === 0) return undefined;

    const geom = new LineSegmentsGeometry();
    geom.setPositions(vertices);
    geom.setColors(colors);

    const mat = new LineMaterial({
      linewidth: 3, // 3px wide lines
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.8
    });
    mat.resolution.set(window.innerWidth, window.innerHeight);
    this.footprintsMaterial = mat;

    const lines = new LineSegments2(geom, mat);
    lines.frustumCulled = false;
    return lines;
  }

  /**
   * Elevation (true metres) at a global Mercator coordinate, from the finest
   * loaded tile covering it, or null if no loaded tile covers it (so callers
   * can skip drawing over absent terrain instead of floating at z=0).
   */
  public getElevationAt(mx: number, my: number): number | null {
    let bestNode: TileNode | undefined;
    const checkNode = (node: TileNode) => {
      // Outside this node: nothing in the subtree can cover the point.
      if (mx < node.bounds.west || mx > node.bounds.east ||
          my < node.bounds.south || my > node.bounds.north) {
        return;
      }
      // Recurse regardless of THIS node's load state. Bailing on !loaded
      // stopped the walk at an unloaded ancestor, hiding loaded descendants.
      // Usually harmless — updateNode triggerLoads a parent whenever its
      // children aren't all ready, so the chain is normally contiguous — but a
      // parent whose four children all load synchronously from a warm
      // BundleCache never loads itself, and the walk then died on it, yielding
      // null (Follow-DEM disengages, draped footprints drop to sea level)
      // despite fine terrain being loaded right there.
      // Only a loaded node that actually has a sample may win: selecting one
      // without centerElevation would mask a coarser node that has it.
      if (node.loaded && node.centerElevation !== undefined &&
          (bestNode === undefined || node.tile.z > bestNode.tile.z)) {
        bestNode = node;
      }
      if (node.children) {
        for (const child of node.children) {
          checkNode(child);
        }
      }
    };

    for (const node of this.rootNodes.values()) {
      checkNode(node);
    }
    for (const node of this.transitionNodes.values()) {
      checkNode(node);
    }

    return bestNode ? bestNode.centerElevation! : null;
  }

  private createMeshFromBundle(
    node: TileNode,
    bundle: Bundle
  ): void {
    const geom = bundle.geometry;
    const texture = bundle.texture;
    let demSourceVal = 0.0;
    if (node.demSource === "flat") {
      demSourceVal = 3.0;
    } else if (node.demSource === "s1m") {
      demSourceVal = 2.0;
    } else if (node.demSource === "usgs13") {
      demSourceVal = 1.0;
    }

    const zScale = mercatorScale(mercatorToLonLat(
      (node.bounds.west + node.bounds.east) / 2,
      (node.bounds.north + node.bounds.south) / 2
    )[1]);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture || null },
        useTexture: { value: !!texture },
        fallbackColor: this.globalUniforms.fallbackColor,
        hillshadeIntensity: this.globalUniforms.hillshadeIntensity,
        sunDirection: this.globalUniforms.sunDirection,
        showOutlines: this.globalUniforms.showOutlines,
        showDemColors: this.globalUniforms.showDemColors,
        shadingMode: this.globalUniforms.shadingMode,
        hypsometricBlend: this.globalUniforms.hypsometricBlend,
        useLocalHypso: this.globalUniforms.useLocalHypso,
        localMinElev: this.globalUniforms.localMinElev,
        localMaxElev: this.globalUniforms.localMaxElev,
        brightness: this.globalUniforms.brightness,
        contrast: this.globalUniforms.contrast,
        saturation: this.globalUniforms.saturation,
        demSourceType: { value: demSourceVal },
        uZScale: { value: zScale },
        ...THREE.UniformsLib.fog
      },
      vertexShader: TerrainShader.vertexShader,
      fragmentShader: TerrainShader.fragmentShader,
      fog: true
    });

    const mesh = new THREE.Mesh(geom, material);

    // Assembled here, not read off the bundle: the bundle may have been cached
    // long before this ground's footprints arrived, and it is handed back
    // unchanged by triggerLoad's cache hit. Building from the live cache at
    // draw time is what lets a tile pick up buildings it did not have when it
    // was first fetched.
    const buildingGeometry = this.buildBuildingGeometry(
      node.tile,
      geom.getAttribute("position").array,
      bundle.gridSize
    );

    if (buildingGeometry) {
      this.attachBuildingMesh(mesh, buildingGeometry, material);
    }

    mesh.position.set(
      node.bounds.west - this.worldAnchor[0],
      node.bounds.north - this.worldAnchor[1],
      this.exagZ(0) * zScale
    );
    mesh.scale.z = this.verticalExaggeration;

    node.mesh = mesh;
    node.gridSize = bundle.gridSize;
  }

  /**
   * Hand BundleCache whatever the buildings are not using.
   *
   * One ceiling, two consumers. Bundles cannot see building geometry, so
   * without this the cache evicts against a number that ignores a third of
   * actual GPU use -- measured at 254.9 MB of bundles beside 135.6 MB of
   * buildings, i.e. 390 MB against a budget reading 99.6% of 256.
   *
   * MUST NOT be called mid-traversal. Eviction's one safety rule is that a
   * pinned key is never evicted, and update() clears activeKeys before walking
   * the tree, so during the walk the pin set is only partially rebuilt. Evicting
   * against it releases textures out from under meshes that are still on screen
   * -- and because TexturePool recycles the THREE.Texture object, the next
   * acquire() hands that same object to a different tile: the released tile goes
   * black (release() closes the ImageBitmap and nulls .image) and the tile that
   * got it renders another tile's imagery. Callers that fire during the walk
   * (pruneNode -> disposeBuildingMesh) set buildingBudgetDirty instead, and
   * update() settles it below once the pin set is whole again.
   */
  private rebalanceGpuBudget(): void {
    if (this.totalGpuBudget <= 0) return;
    this.buildingBudgetDirty = false;
    this.bundleCache.setByteBudget(this.totalGpuBudget - this.buildingBytes, this.activeKeys);
  }

  /** Live building geometry in bytes. Shares the GPU budget with BundleCache. */
  public getBuildingBytes(): number {
    return this.buildingBytes;
  }

  public updateBuildingVisibility(): void {
    const updateNode = (node: TileNode) => {
      if (node.mesh) {
        const bMesh = node.mesh.getObjectByName("buildingMesh");
        if (bMesh) {
          bMesh.visible = this.showBuildings;
        }
      }
      if (node.children) {
        for (const child of node.children) {
          updateNode(child);
        }
      }
    };
    for (const root of this.rootNodes.values()) {
      updateNode(root);
    }
    for (const trans of this.transitionNodes.values()) {
      updateNode(trans);
    }
  }

  public setBuildingWallOpacity(opacity: number): void {
    this.buildingWallOpacity = opacity;
    const transparent = opacity < 1.0;
    const updateNode = (node: TileNode) => {
      if (node.mesh) {
        const bMesh = node.mesh.getObjectByName("buildingMesh") as THREE.Mesh | undefined;
        if (bMesh) {
          // Wall material is at index 0 in the multi-material array; index 1 is
          // the shared terrain material the roofs use, which must not be touched.
          // A real instanceof rather than a cast plus a guard the cast made
          // dead -- that dead guard is what has CI failing on 28d72b6.
          const materials = Array.isArray(bMesh.material) ? bMesh.material : [bMesh.material];
          const wallMat = materials[0];
          if (wallMat instanceof THREE.MeshLambertMaterial) {
            wallMat.opacity = opacity;
            wallMat.transparent = transparent;
            wallMat.needsUpdate = true;
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          updateNode(child);
        }
      }
    };
    for (const root of this.rootNodes.values()) {
      updateNode(root);
    }
    for (const trans of this.transitionNodes.values()) {
      updateNode(trans);
    }
  }

  /**
   * Sync active tile node meshes with the Three.js scene recursively.
   */
  private syncScene(node: TileNode): void {
    if (node.visible && node.loaded && node.mesh) {
      if (node.mesh.parent !== this.scene) {
        this.scene.add(node.mesh);
      }
    } else {
      if (node.mesh && node.mesh.parent === this.scene) {
        this.scene.remove(node.mesh);
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.syncScene(child);
      }
    }
  }

  /**
   * Recursively remove meshes from the scene, prune children, and reset node loading flags.
   */
  private pruneNode(node: TileNode): void {
    if (node.loading) {
      this.workerPool.cancelTile(node.tile);
    }
    node.loading = false;
    node.visible = false;

    if (node.mesh) {
      if (node.mesh.parent === this.scene) {
        this.scene.remove(node.mesh);
      }
      // Dispose the per-mesh ShaderMaterial
      (node.mesh.material as THREE.Material).dispose();
      this.disposeBuildingMesh(node);
      node.mesh = undefined;
    }

    node.loaded = false;

    if (node.children) {
      for (const child of node.children) {
        this.pruneNode(child);
      }
      delete node.children;
    }
  }

  /**
   * Recursively cancel any active worker load requests in a transition node's subtree.
   */
  private cancelLoadingSubtree(node: TileNode): void {
    if (node.loading) {
      this.workerPool.cancelTile(node.tile);
      node.loading = false;
    }
    if (node.children) {
      for (const child of node.children) {
        this.cancelLoadingSubtree(child);
      }
    }
  }

  /**
   * A node's footprint is "covered" for transition purposes if it is out of
   * view (nothing to draw), already loaded, or fully covered by covered
   * children. Mirrors what actually renders, so a root hidden behind its
   * loaded children still counts as ready.
   */
  private isCovered(node: TileNode, frustum?: THREE.Frustum): boolean {
    if (!this.isNodeVisible(node, frustum)) return true;
    if (node.loaded) return this.buildingsSettled(node);
    if (node.children && node.children.length > 0) {
      return node.children.every((c) => this.isCovered(c, frustum));
    }
    return false;
  }

  /**
   * Whether a loaded node is showing the buildings it is supposed to. Used to
   * stop a parent handing over to children that have terrain but not yet the
   * building the parent was drawing -- which is what made a building blink out
   * as you approached it.
   *
   * Deliberately narrow. It returns true unless we KNOW there is something to
   * draw: buildings on, at or above the source zoom, and the source tile
   * already cached. Anywhere with no building data, or before the footprints
   * have arrived, this is inert -- otherwise the LOD would stall waiting on
   * data that is never coming, and terrain would stay coarse under the camera.
   */
  private buildingsSettled(node: TileNode): boolean {
    if (!this.showBuildings) return true;
    if (node.tile.z < this.buildingSourceZoom) return true;
    const source = BuildingCache.sourceTileFor(node.tile, this.buildingSourceZoom);
    if (!this.buildingCache.has(source)) return true; // nothing known to draw yet
    // ownsBuildings, not forTile: this runs from isCovered on every qualifying
    // node every frame, and forTile allocates two arrays and reorders the LRU.
    if (!this.buildingCache.ownsBuildings(node.tile, this.buildingSourceZoom)) return true;
    return !!node.mesh?.getObjectByName("buildingMesh");
  }

  private isNodeVisible(node: TileNode, frustum?: THREE.Frustum): boolean {
    if (this.cullTiles && frustum) {
      const zScale = mercatorScale(mercatorToLonLat(node.centerMercator[0], node.centerMercator[1])[1]);
      const tileMinZ = this.exagZ(-1000) * zScale;
      const tileMaxZ = this.exagZ(9000) * zScale;
      const bbox = new THREE.Box3(
        new THREE.Vector3(node.bounds.west - this.worldAnchor[0], node.bounds.south - this.worldAnchor[1], tileMinZ),
        new THREE.Vector3(node.bounds.east - this.worldAnchor[0], node.bounds.north - this.worldAnchor[1], tileMaxZ),
      );
      return frustum.intersectsBox(bbox);
    }
    return true;
  }

  private isActiveTileCovered(tile: TileId): boolean {
    // Covered means FULLY covered: this exact tile, or an ancestor (a coarser
    // active tile spans this one entirely). Finer active descendants only
    // cover part of the footprint — one visible z12 inside a z7 transition
    // tile must NOT hide the whole z7 tile, or the uncovered remainder shows
    // as a hole. Partial overlap is fine: transition meshes carry a polygon
    // offset, so the active tiles win the depth test where they coexist.
    const selfKey = tileKey(tile);
    if (this.activeVisibleKeys.has(selfKey)) return true;

    // Check ancestors
    let parentZ = tile.z - 1;
    let parentX = Math.floor(tile.x / 2);
    let parentY = Math.floor(tile.y / 2);
    while (parentZ >= 0) {
      const parentKey = `${parentZ}/${parentX}/${parentY}`;
      if (this.activeVisibleKeys.has(parentKey)) return true;
      parentZ--;
      parentX = Math.floor(parentX / 2);
      parentY = Math.floor(parentY / 2);
    }

    return false;
  }

  private updateTransitionNode(node: TileNode, cameraPosGlobal: THREE.Vector3, frustum?: THREE.Frustum): void {
    this.activeKeys.add(node.key);

    if (this.isActiveTileCovered(node.tile)) {
      node.visible = false;
      if (node.children) {
        for (const child of node.children) {
          this.hideTransitionSubtree(child);
        }
      }
      return;
    }

    const isVisible = this.isNodeVisible(node, frustum);
    if (!isVisible) {
      node.visible = false;
      if (node.children) {
        for (const child of node.children) {
          this.hideTransitionSubtree(child);
        }
      }
      return;
    }

    let useChildren = false;
    if (node.children && node.children.length > 0) {
      let allChildrenReady = true;
      for (const child of node.children) {
        if (!this.isCovered(child, frustum)) {
          allChildrenReady = false;
        }
      }
      if (allChildrenReady) {
        useChildren = true;
      }
    }

    if (useChildren && node.children) {
      node.visible = false;
      for (const child of node.children) {
        this.updateTransitionNode(child, cameraPosGlobal, frustum);
      }
    } else {
      node.visible = node.loaded;
      if (node.children) {
        for (const child of node.children) {
          this.hideTransitionSubtree(child);
        }
      }
    }
  }

  private hideTransitionSubtree(node: TileNode): void {
    node.visible = false;
    this.activeKeys.add(node.key);
    if (node.children) {
      for (const child of node.children) {
        this.hideTransitionSubtree(child);
      }
    }
  }

  private applyPolygonOffset(node: TileNode, enable: boolean): void {
    if (node.mesh) {
      const mat = node.mesh.material as THREE.ShaderMaterial;
      mat.polygonOffset = enable;
      mat.polygonOffsetFactor = enable ? 4.0 : 0.0;
      mat.polygonOffsetUnits = enable ? 4.0 : 0.0;
      mat.needsUpdate = true;
    }
    if (node.children) {
      for (const child of node.children) {
        this.applyPolygonOffset(child, enable);
      }
    }
  }

  /**
   * Exaggerated world height (true metres) of ground elevation h:
   * z' = (h - ref)·exag + ref. Multiply by mercatorScale(lat) for world Z.
   * Mesh vertices bake h·mercatorScale, so meshes realise the same affine map
   * via scale.z = exag and position.z = exagZ(0)·mercatorScale.
   */
  private exagZ(h: number): number {
    return (h - this.exagReference) * this.verticalExaggeration + this.exagReference;
  }

  /**
   * World Z of the terrain surface under a Mercator point *as rendered* —
   * exaggeration and the sec(lat) scale included — or null where no loaded
   * tile covers it. Use this, not raw getElevationAt, for anything that has to
   * agree with what the camera can see (e.g. a ground-clearance floor).
   */
  public groundZAt(mx: number, my: number): number | null {
    const elevation = this.getElevationAt(mx, my);
    if (elevation === null) return null;
    return this.exagZ(elevation) * mercatorScale(mercatorToLonLat(mx, my)[1]);
  }

  /**
   * Dynamically update the vertical exaggeration of all existing meshes and future ones.
   */
  setVerticalExaggeration(val: number): void {
    // Freeze the reference to the ground under the camera BEFORE applying the
    // new factor: the terrain being looked at holds still, relief amplifies.
    if (this.lastCameraMercator) {
      const h0 = this.getElevationAt(this.lastCameraMercator[0], this.lastCameraMercator[1]);
      if (h0 !== null) this.exagReference = h0;
    }
    this.verticalExaggeration = val;
    const updateScale = (node: TileNode) => {
      if (node.mesh) {
        const [ncx, ncy] = node.centerMercator;
        const lat = mercatorToLonLat(ncx, ncy)[1];
        node.mesh.scale.z = val;
        node.mesh.position.z = this.exagZ(0) * mercatorScale(lat);
      }
      if (node.children) {
        for (const child of node.children) {
          updateScale(child);
        }
      }
    };
    for (const node of this.rootNodes.values()) {
      updateScale(node);
    }
    for (const node of this.transitionNodes.values()) {
      updateScale(node);
    }
    // Force footprints to rebuild at the new Z scale on next update.
    this.footprintsDrapeSig = "";
  }

  /**
   * Dynamically toggle footprints visibility in the scene.
   */
  setShowFootprints(show: boolean): void {
    this.showFootprints = show;
    if (!show && this.footprintsMesh) {
      if (this.footprintsMesh.parent === this.scene) {
        this.scene.remove(this.footprintsMesh);
      }
      this.footprintsMesh.geometry.dispose();
      (this.footprintsMesh.material as THREE.Material).dispose();
      this.footprintsMesh = undefined;
      this.footprintsMaterial = undefined;
      this.footprintsDrapeSig = "";
    }
  }

  setViewportSize(width: number, height: number): void {
    if (this.footprintsMaterial) {
      this.footprintsMaterial.resolution.set(width, height);
    }
  }

  /**
   * Dynamically toggle TMS tile outlines.
   */
  setShowOutlines(show: boolean): void {
    this.globalUniforms.showOutlines.value = show;
  }

  /**
   * Change the imagery zoom threshold (z <= this uses the USDA ImageServer).
   * Drops cached/loaded tiles so they refetch from the correct source.
   */
  setExternalImageryMaxZoom(z: number): void {
    if (z === this.externalImageryMaxZoom) return;
    this.externalImageryMaxZoom = z;
    this.bundleCache.clear();
    this.clear(); // reset nodes; next update() rebuilds + refetches
  }

  /**
   * Change the terrain zoom floor (z < this renders as a flat quad, no DEM
   * fetch). Drops cached/loaded tiles so geometry rebuilds in the right mode.
   */
  setTerrainMinZoom(z: number): void {
    if (z === this.terrainMinZoom) return;
    this.terrainMinZoom = z;
    this.bundleCache.clear();
    this.clear(); // reset nodes; next update() rebuilds + refetches
  }

  /**
   * Which source letter a tile's imagery gets: the worker routes z <=
   * externalImageryMaxZoom to the USDA basemap stitch (U, yellow) and deeper
   * zooms to the NAIP COG mosaic resolved via DuckDB (N, cyan). OSM gets none.
   */
  private imagerySourceLetter(z: number): { ch: string; color: string } | null {
    // Shares the fetch path's routing rule, so the baked letter can never
    // claim a source the request didn't actually use.
    switch (resolveImageryKind(z, this.imagerySource, this.externalImageryMaxZoom)) {
      case "osm":
        return null;
      case "basemap":
        return { ch: "U", color: "#ffd400" };
      default:
        return { ch: "N", color: "#00e5ff" };
    }
  }

  /**
   * Bake the debug label into the tile texture's SE corner (canvas row 0 is
   * the tile's north edge, so canvas bottom-right = SE on screen):
   * "z/x/y" (showLabels, white) and/or the source letter (showSourceLabels,
   * colored), combined as "z/x/y - N". Auto-shrinks from 100px to fit the
   * tile width. Baking replaces the old per-tile label sprites: no extra
   * draw calls, no occlusion handling, and the text drapes with its tile.
   *
   * Returns an ImageBitmap either way — WebGL ignores flipY for ImageBitmap
   * uploads but honors it for canvas uploads, so returning the canvas itself
   * would render the branded tile vertically flipped relative to plain ones.
   */
  private bakeTileLabel(imageBitmap: ImageBitmap, tile: TileId): ImageBitmap {
    const brand = this.showSourceLabels ? this.imagerySourceLetter(tile.z) : null;
    const coords = this.showLabels ? `${tile.z}/${tile.x}/${tile.y}` : "";
    if (!brand && !coords) return imageBitmap;

    const c = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(imageBitmap, 0, 0);
    imageBitmap.close();

    const head = coords + (coords && brand ? " - " : "");
    const tail = brand ? brand.ch : "";
    const margin = 14;
    let font = 100;
    ctx.font = `bold ${font}px monospace`;
    const fullW = () => ctx.measureText(head + tail).width;
    const avail = c.width - 2 * margin;
    if (fullW() > avail) {
      font = Math.max(32, Math.floor((font * avail) / fullW()));
      ctx.font = `bold ${font}px monospace`;
    }
    ctx.lineWidth = Math.max(4, Math.round(font * 0.08));
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.textAlign = "left";
    let x = c.width - margin - fullW();
    const y = c.height - margin;
    for (const [text, color] of [[head, "#ffffff"], [tail, brand?.color ?? "#ffffff"]] as const) {
      if (!text) continue;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width;
    }
    return c.transferToImageBitmap();
  }

  /**
   * Toggle both baked-in tile annotations at once — "z/x/y - N". They share
   * one compositing pass into the tile texture, so they're set together and
   * cost a single cache clear + refetch (tiles are CDN-warm, so it's cheap).
   * Setting them separately would run that refetch twice.
   */
  setShowTileLabels(show: boolean): void {
    if (show === this.showLabels && show === this.showSourceLabels) return;
    this.showLabels = show;
    this.showSourceLabels = show;
    this.bundleCache.clear();
    this.clear(); // reset nodes; next update() rebuilds + refetches
  }

  /**
   * Dynamically toggle showing DEM source colors.
   */
  setShowDemColors(show: boolean): void {
    this.showDemColors = show;
    this.globalUniforms.showDemColors.value = show;
    this.setShadingMode(show ? 1.0 : 0.0);
  }

  setShadingMode(mode: number): void {
    if (mode === this.shadingMode) return;
    this.shadingMode = mode;
    this.globalUniforms.shadingMode.value = mode;
    this.globalUniforms.showDemColors.value = (mode === 1.0);
  }

  setHypsometricBlend(blend: number): void {
    if (blend === this.hypsometricBlend) return;
    this.hypsometricBlend = blend;
    this.globalUniforms.hypsometricBlend.value = blend;
  }

  setUseLocalHypso(useLocal: boolean): void {
    this.globalUniforms.useLocalHypso.value = useLocal ? 1.0 : 0.0;
  }

  /** Change dynamic imagery base layer source and force refresh active tiles. */
  setImagerySource(source: "satellite" | "osm"): void {
    if (this.imagerySource === source) return;
    this.imagerySource = source;

    // 1. Cancel in-flight worker tasks: requestTile de-dupes by tile key alone,
    // so without this a re-request would chain onto a task started with the
    // OLD imagery source and cache its texture under the new source.
    this.workerPool.clear();

    // 2. Clear transitionNodes and remove their meshes from the scene so old
    // imagery tiles don't remain rendered alongside new ones during transition.
    for (const node of this.transitionNodes.values()) {
      this.pruneNode(node);
    }
    this.transitionNodes.clear();

    // 3. Clear bundle cache and dispose idle textures in pool to prevent reusing
    // textures containing previous imagery source data.
    this.bundleCache.clear();
    this.texturePool?.dispose();

    // 4. Fully prune and reset all root nodes
    for (const node of this.rootNodes.values()) {
      this.pruneNode(node);
    }
    this.activeKeys.clear();
  }

  private countLoadedNodes(): number {
    let n = 0;
    const walk = (node: TileNode) => {
      if (node.loaded) n++;
      if (node.children) for (const c of node.children) walk(c);
    };
    for (const node of this.rootNodes.values()) walk(node);
    for (const node of this.transitionNodes.values()) walk(node);
    return n;
  }

  private updateViewportFootprints(): void {
    if (!this.showFootprints) {
      return;
    }

    // 1. Fetch the full S1M+usgs13 set once (~360 KB gzipped, ~12k features).
    if (!this.allFootprints) {
      if (this.isFetchingFootprints) return;
      this.isFetchingFootprints = true;
      loadStaticFootprints(this.baseUrl)
        .then((fc) => {
          this.allFootprints = fc.features;
          this.isFetchingFootprints = false;
          this.footprintsDrapeSig = ""; // force a build now that data exists
        })
        .catch((err) => {
          console.warn(`Failed to load footprints: ${err.message}`);
          this.isFetchingFootprints = false;
        });
      return;
    }

    // 2. Render the WHOLE set (one draw call, ~28 ms to build) rather than clip
    //    to loaded terrain — that clip is what hid footprints outside the small
    //    loaded area, e.g. all of CONUS at overview. The mesh only needs
    //    rebuilding when terrain draping changes, so gate on a cheap signature
    //    (base zoom + loaded-node count) plus a time throttle so streaming
    //    terrain doesn't rebuild every frame.
    const sig = `${this.baseZoom}:${this.countLoadedNodes()}`;
    if (this.footprintsMesh && sig === this.footprintsDrapeSig) return;
    const now = performance.now();
    if (this.footprintsMesh && now - this.lastFootprintsBuildMs < 300) return;

    const lines = this.buildViewportFootprintsMesh({
      type: "FeatureCollection",
      features: this.allFootprints,
    });

    if (this.footprintsMesh) {
      if (this.footprintsMesh.parent === this.scene) {
        this.scene.remove(this.footprintsMesh);
      }
      this.footprintsMesh.geometry.dispose();
      (this.footprintsMesh.material as THREE.Material).dispose();
    }

    this.footprintsMesh = lines ?? undefined;
    if (lines) this.scene.add(lines);

    this.footprintsDrapeSig = sig;
    this.lastFootprintsBuildMs = now;
  }

  /**
   * Completely clean up all roots and scene meshes.
   */
  clear(): void {
    this.workerPool.clear();
    for (const node of this.rootNodes.values()) {
      this.pruneNode(node);
    }
    this.rootNodes.clear();
    for (const node of this.transitionNodes.values()) {
      this.pruneNode(node);
    }
    this.transitionNodes.clear();
    this.activeKeys.clear();

    if (this.footprintsMesh) {
      if (this.footprintsMesh.parent === this.scene) {
        this.scene.remove(this.footprintsMesh);
      }
      this.footprintsMesh.geometry.dispose();
      (this.footprintsMesh.material as THREE.Material).dispose();
      this.footprintsMesh = undefined;
    }
    this.footprintsDrapeSig = "";
  }
}
