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
import { loadTerrain, loadImagery, loadImageryExternal, loadImageryOSM, loadStaticFootprints, type FootprintCollection, type FootprintFeature } from "./tileLoader";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import { BundleCache, Bundle } from "./bundleCache";
import { TerrainShader } from "./terrainShader";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { TileWorkerPool } from "./tileWorkerPool";


export interface TileNode {
  key: string;
  tile: TileId;
  bounds: { west: number; south: number; east: number; north: number };
  centerMercator: [number, number];
  mesh?: THREE.Mesh;
  labelSprite?: THREE.Sprite;
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
}

export class TileManager {
  private rootNodes = new Map<string, TileNode>();
  private activeKeys = new Set<string>();
  
  // Grid step for terrain mesh density (e.g. vertices every N source pixels)
  public gridStep = 8;
  // Vertical exaggeration factor
  public verticalExaggeration = 2;
  // Toggle for footprints visibility
  public showFootprints = false;
  // Toggle for Z/X/Y tile labels visibility
  public showLabels = false;
  // Dynamic scaling factor for Z/X/Y labels
  public labelScale = 1.0;
  // Imagery zoom threshold: tiles at z <= this load from the USDA NAIP
  // ImageServer instead of the COG tiler (which is slow/coverage-capped at low
  // zoom). Set to maxZoom to route everything external.
  public externalImageryMaxZoom = 13;
  // Terrain zoom floor: tiles at z < this skip the DEM fetch entirely and
  // render as flat sea-level quads (relief is subpixel at those altitudes).
  // Keeps low zoom off the tiler's far-field path; z14 = USGS 1/3, z15+ = S1M.
  public terrainMinZoom = 14;
  // Zoom at/above which USGS 1/3" DEM is used instead of far-field.
  public usgsMinZoom = 11;
  // Zoom at/above which S1M is used instead of USGS 1/3" DEM.
  public s1mMinZoom = 15;
  // Shading mode (0.0 = Satellite, 1.0 = DEM, 2.0 = Hypsometric)
  public shadingMode = 0.0;
  // Blend factor for hypsometric tinting (0.0 to 1.0)
  public hypsometricBlend = 0.5;
  // Selected imagery source layer type
  public imagerySource: "satellite" | "osm" = "satellite";
  // Toggle for showing DEM source colors
  public showDemColors = false;

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
  private workerPool = new TileWorkerPool();

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
    useLocalHypso: { value: 0.0 },
    localMinElev: { value: 0.0 },
    localMaxElev: { value: 4000.0 },
    brightness: { value: 1.15 },
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
  ) {}

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
    if (camera && (camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
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
      for (const [key, node] of this.rootNodes.entries()) {
        this.transitionNodes.set(key, node);
        this.applyPolygonOffset(node, true);
        this.cancelLoadingSubtree(node);
      }
      this.rootNodes.clear();
      this.baseZoom = computedBaseZoom;
    }

    // 1. Convert local offset space to global Mercator meters
    const cx = localCameraPos.x + this.worldAnchor[0];
    const cy = localCameraPos.y + this.worldAnchor[1];

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
      gx += fwd.x * 1.5 * tileW;
      gy += fwd.y * 1.5 * tileW;
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
        // Still loading: keep transition nodes alive and visible
        for (const node of this.transitionNodes.values()) {
          this.updateTransitionNode(node, cameraPosGlobal, frustum);
        }
      }
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
  }

  /**
   * Get the keys of all tiles that are currently pinned (visible or actively loading).
   */
  getActiveKeys(): Set<string> {
    return this.activeKeys;
  }

  /** @returns true if the node was frustum-culled (renders nothing on screen). */
  private updateNode(node: TileNode, cameraPosGlobal: THREE.Vector3, frustum?: THREE.Frustum): boolean {
    // 1. Perform frustum culling check first
    if (this.cullTiles && frustum) {
      const tileMinZ = -1000 * this.verticalExaggeration;
      const tileMaxZ = 9000 * this.verticalExaggeration;
      const box = new THREE.Box3(
        new THREE.Vector3(node.bounds.west - this.worldAnchor[0], node.bounds.south - this.worldAnchor[1], tileMinZ),
        new THREE.Vector3(node.bounds.east - this.worldAnchor[0], node.bounds.north - this.worldAnchor[1], tileMaxZ)
      );

      if (!frustum.intersectsBox(box)) {
        // Node is completely out of view: make it and its subtree invisible
        this.hideSubtree(node);
        return true; // Stop recursion and loading!
      }
    }

    const tileW = node.bounds.east - node.bounds.west;

    const clampX = Math.max(node.bounds.west, Math.min(node.bounds.east, cameraPosGlobal.x));
    const clampY = Math.max(node.bounds.south, Math.min(node.bounds.north, cameraPosGlobal.y));
    const closestPoint = new THREE.Vector3(clampX, clampY, node.centerElevation ?? 0);
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
    const shouldSubdivide = ssePx > this.sseThreshold && node.tile.z < this.maxZoom;

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

    // Check if the bundle exists in the cache
    const cached = this.bundleCache.get(key);
    if (cached) {
      node.centerElevation = cached.centerElevation;
      node.demSource = cached.demSource;
      node.minElevation = cached.minElevation;
      node.maxElevation = cached.maxElevation;
      if (!node.labelSprite) {
        node.labelSprite = this.buildLabelSprite(node.tile, tileBoundsMercator(node.tile), cached.centerElevation ?? 0);
      }
      this.createMeshFromBundle(node, cached.geometry, cached.texture);
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
      usgsMinZoom: this.usgsMinZoom,
      s1mMinZoom: this.s1mMinZoom,
      gridStep: this.gridStep,
      externalImageryMaxZoom: this.externalImageryMaxZoom
    };

    this.workerPool.requestTile(node.tile, priority, options)
      .then((res) => {
        if (!node.loading) {
          // Node was pruned/cancelled during fetch
          if (res.imageBitmap) res.imageBitmap.close();
          return;
        }

        const { demSource, centerElevation, meshData, imageBitmap, minElevation, maxElevation } = res;

        // Build Three.js geometry from worker-returned typed arrays
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(meshData.positions, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(meshData.uvs, 2));
        geom.setAttribute("normal", new THREE.BufferAttribute(meshData.normals, 3));
        geom.setIndex(new THREE.BufferAttribute(meshData.indices, 1));

        // Create texture if imagery loaded successfully
        let texture: THREE.Texture | undefined;
        if (imageBitmap) {
          texture = new THREE.CanvasTexture(imageBitmap as unknown as HTMLCanvasElement);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
        }

        const bytes =
          meshData.positions.byteLength +
          meshData.normals.byteLength +
          meshData.indices.byteLength +
          (texture ? 512 * 512 * 4 : 0);

        node.centerElevation = centerElevation;
        node.demSource = demSource;
        node.minElevation = minElevation;
        node.maxElevation = maxElevation;

        const bounds = tileBoundsMercator(node.tile);
        if (!node.labelSprite) {
          node.labelSprite = this.buildLabelSprite(node.tile, bounds, centerElevation);
        }

        const bundle: Bundle = { key, bytes, geometry: geom, texture, centerElevation, demSource, minElevation, maxElevation };
        this.bundleCache.put(bundle, this.activeKeys);

        this.createMeshFromBundle(node, geom, texture);
        node.loaded = true;
        node.loading = false;
        node.retryAfter = undefined;
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Task aborted, don't set cooldown or error out
          return;
        }
        console.warn(`tile ${key} deferred: ${err.message || err}`);
        node.loading = false;
        node.retryAfter = performance.now() + 2000 + Math.random() * 2000;
      });
  }

  private buildViewportFootprintsMesh(
    footprints: FootprintCollection
  ): LineSegments2 | undefined {
    if (!footprints.features || footprints.features.length === 0) {
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
      // terrain z = elevation * mercatorScale(lat) * verticalExaggeration.
      const zOf = (elev: number, lat: number) =>
        elev * mercatorScale(lat) * this.verticalExaggeration + 5.0;

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
      const isS1M = feat.properties?.type !== "usgs13";
      
      if (geom.type === "Polygon") {
        for (const ring of geom.coordinates) {
          addRingSegments(ring, isS1M);
        }
      } else if (geom.type === "MultiPolygon") {
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
  private getElevationAt(mx: number, my: number): number | null {
    let bestNode: TileNode | undefined;
    const checkNode = (node: TileNode) => {
      if (!node.loaded) return;
      if (mx >= node.bounds.west && mx <= node.bounds.east &&
          my >= node.bounds.south && my <= node.bounds.north) {
        if (!bestNode || node.tile.z > bestNode.tile.z) {
          bestNode = node;
        }
        if (node.children) {
          for (const child of node.children) {
            checkNode(child);
          }
        }
      }
    };

    for (const node of this.rootNodes.values()) {
      checkNode(node);
    }
    for (const node of this.transitionNodes.values()) {
      checkNode(node);
    }

    return bestNode && bestNode.centerElevation !== undefined ? bestNode.centerElevation : null;
  }

  private createMeshFromBundle(
    node: TileNode,
    geom: THREE.BufferGeometry,
    texture?: THREE.Texture
  ): void {
    let demSourceVal = 0.0;
    if (node.demSource === "flat") {
      demSourceVal = 3.0;
    } else if (node.demSource === "s1m") {
      demSourceVal = 2.0;
    } else if (node.demSource === "usgs13") {
      demSourceVal = 1.0;
    }

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
        // Per-tile Mercator vertical scale: vertex Z is elevation * sec(lat),
        // so the shader divides by this to recover true metres for hypsometric
        // tinting (whose bounds are in true metres).
        uZScale: { value: mercatorScale(mercatorToLonLat(
          (node.bounds.west + node.bounds.east) / 2,
          (node.bounds.north + node.bounds.south) / 2
        )[1]) },
        ...THREE.UniformsLib.fog
      },
      vertexShader: TerrainShader.vertexShader,
      fragmentShader: TerrainShader.fragmentShader,
      fog: true
    });

    const mesh = new THREE.Mesh(geom, material);
    // Position NW anchor relative to worldAnchor to maintain float32 coordinate precision
    mesh.position.set(
      node.bounds.west - this.worldAnchor[0],
      node.bounds.north - this.worldAnchor[1],
      0
    );
    // Apply vertical exaggeration
    mesh.scale.z = this.verticalExaggeration;

    node.mesh = mesh;
  }

  /**
   * Sync active tile node meshes with the Three.js scene recursively.
   */
  private syncScene(node: TileNode): void {
    if (node.visible && node.loaded && node.mesh) {
      if (node.mesh.parent !== this.scene) {
        this.scene.add(node.mesh);
      }
      if (node.labelSprite) {
        const inScene = node.labelSprite.parent === this.scene;
        if (this.showLabels && !inScene) {
          this.scene.add(node.labelSprite);
        } else if (!this.showLabels && inScene) {
          this.scene.remove(node.labelSprite);
        }
      }
    } else {
      if (node.mesh && node.mesh.parent === this.scene) {
        this.scene.remove(node.mesh);
      }
      if (node.labelSprite && node.labelSprite.parent === this.scene) {
        this.scene.remove(node.labelSprite);
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
      node.mesh = undefined;
    }
    if (node.labelSprite) {
      if (node.labelSprite.parent === this.scene) {
        this.scene.remove(node.labelSprite);
      }
      if (node.labelSprite.material) {
        node.labelSprite.material.map?.dispose();
        node.labelSprite.material.dispose();
      }
      node.labelSprite = undefined;
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
    if (node.loaded) return true;
    if (node.children && node.children.length > 0) {
      return node.children.every((c) => this.isCovered(c, frustum));
    }
    return false;
  }

  private isNodeVisible(node: TileNode, frustum?: THREE.Frustum): boolean {
    if (this.cullTiles && frustum) {
      const bbox = new THREE.Box3(
        new THREE.Vector3(node.bounds.west - this.worldAnchor[0], node.bounds.south - this.worldAnchor[1], -1000),
        new THREE.Vector3(node.bounds.east - this.worldAnchor[0], node.bounds.north - this.worldAnchor[1], 9000),
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
    if (node.mesh && node.mesh.material) {
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
   * Dynamically update the vertical exaggeration of all existing meshes and future ones.
   */
  setVerticalExaggeration(val: number): void {
    this.verticalExaggeration = val;
    const updateScale = (node: TileNode) => {
      if (node.mesh) {
        node.mesh.scale.z = val;
      }
      if (node.labelSprite && node.centerElevation !== undefined) {
        const [cx, cy] = node.centerMercator;
        const lat = mercatorToLonLat(cx, cy)[1];
        node.labelSprite.position.z = node.centerElevation * mercatorScale(lat) * val + 150;
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

  setUsgsMinZoom(z: number): void {
    if (z === this.usgsMinZoom) return;
    this.usgsMinZoom = z;
    this.bundleCache.clear();
    this.clear(); // reset nodes; next update() rebuilds + refetches
  }

  setS1mMinZoom(z: number): void {
    if (z === this.s1mMinZoom) return;
    this.s1mMinZoom = z;
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

  /**
   * Dynamically toggle Z/X/Y labels on all active and future tiles.
   */
  setShowLabels(show: boolean): void {
    this.showLabels = show;
    // Walk all nodes and update label visibility in the scene
    const updateVisibility = (node: TileNode) => {
      if (node.labelSprite) {
        if (show && node.visible && node.loaded) {
          if (node.labelSprite.parent !== this.scene) {
            this.scene.add(node.labelSprite);
          }
        } else {
          if (node.labelSprite.parent === this.scene) {
            this.scene.remove(node.labelSprite);
          }
        }
      }
      if (node.children) {
        for (const child of node.children) {
          updateVisibility(child);
        }
      }
    };
    for (const node of this.rootNodes.values()) {
      updateVisibility(node);
    }
  }

  /** Dynamically scale the tile labels on all active and future tiles. */
  setLabelScale(scale: number): void {
    this.labelScale = scale;
    // Walk all nodes and update label scales
    const updateNodeScale = (node: TileNode) => {
      if (node.labelSprite) {
        const bounds = tileBoundsMercator(node.tile);
        const tileW = bounds.east - bounds.west;
        const spriteW = tileW * 0.22 * this.labelScale;
        const spriteH = spriteW * (96 / 384);
        node.labelSprite.scale.set(spriteW, spriteH, 1);
      }
      if (node.children) {
        for (const child of node.children) {
          updateNodeScale(child);
        }
      }
    };
    for (const node of this.rootNodes.values()) {
      updateNodeScale(node);
    }
  }

  /** Change dynamic imagery base layer source and force refresh active tiles. */
  setImagerySource(source: "satellite" | "osm"): void {
    this.imagerySource = source;
    // Clear cache to discard current tile textures
    this.bundleCache.clear();

    // Cancel in-flight worker tasks: requestTile de-dupes by tile key alone,
    // so without this a re-request would chain onto a task started with the
    // OLD imagery source and cache its texture under the new source.
    this.workerPool.clear();

    // Force reload all nodes in the tree
    const resetNode = (node: TileNode) => {
      node.loaded = false;
      node.loading = false;
      node.retryAfter = undefined;
      if (node.children) {
        for (const child of node.children) {
          resetNode(child);
        }
      }
    };
    for (const node of this.rootNodes.values()) {
      resetNode(node);
    }
  }

  /**
   * Render coordinate label to a texture canvas and create a floating 3D sprite.
   */
  private buildLabelSprite(
    tile: TileId,
    bounds: { west: number; south: number; east: number; north: number },
    centerElevation: number
  ): THREE.Sprite | undefined {
    if (typeof document === "undefined") {
      return undefined;
    }
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 96;
    const ctx = canvas.getContext("2d")!;

    // Background panel - white with clean black border
    const r = 12;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Centered label text - black and 50% larger
    ctx.fillStyle = "#000000";
    ctx.font = "bold 30px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.fillText(`${tile.z}/${tile.x}/${tile.y}`, w / 2, h / 2);

    const texture = new THREE.CanvasTexture(canvas);
    // depthTest off + high renderOrder so the label draws on top of terrain
    // instead of being occluded by relief between the camera and the tile
    // center (labels are a debug overlay — always readable, like the
    // footprints overlay which does the same).
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999;

    // Calculate dynamic proportional width and height relative to tile size
    const tileW = bounds.east - bounds.west;
    const spriteW = tileW * 0.22 * this.labelScale;
    const spriteH = spriteW * (96 / 384);
    sprite.scale.set(spriteW, spriteH, 1);

    // Position sprite at tile center, offset by buffer above terrain height.
    const centerMx = (bounds.west + bounds.east) / 2;
    const centerMy = (bounds.north + bounds.south) / 2;
    const localX = centerMx - this.worldAnchor[0];
    const localY = centerMy - this.worldAnchor[1];
    // Match terrain world Z (elevation * mercatorScale(lat) * exaggeration).
    const centerLat = mercatorToLonLat(centerMx, centerMy)[1];
    const localZ = centerElevation * mercatorScale(centerLat) * this.verticalExaggeration + 150;
    sprite.position.set(localX, localY, localZ);

    return sprite;
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
          this.allFootprints = fc.features ?? [];
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
