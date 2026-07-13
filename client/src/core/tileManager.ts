import * as THREE from "three";
import {
  type TileId,
  tileBoundsMercator,
  tileKey,
  mercatorToTile,
  lonLatToMercator,
  mercatorScale,
  mercatorToLonLat
} from "./mercator";
import { loadTerrain, loadImagery, loadImageryExternal, loadImageryOSM, loadViewportFootprints, type FootprintCollection } from "./tileLoader";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import { BundleCache, Bundle } from "./bundleCache";
import { TerrainShader } from "./terrainShader";

export interface TileNode {
  key: string;
  tile: TileId;
  bounds: { west: number; south: number; east: number; north: number };
  centerMercator: [number, number];
  mesh?: THREE.Mesh;
  labelSprite?: THREE.Sprite;
  centerElevation?: number;
  demSource?: string;
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
  public verticalExaggeration = 4;
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
  // Selected imagery source layer type
  public imagerySource: "satellite" | "osm" = "satellite";
  // Toggle for showing DEM source colors
  public showDemColors = false;

  // Viewport footprint global mesh & cache box
  private footprintsMesh?: THREE.LineSegments;
  private loadedFootprintsBBox?: { west: number; south: number; east: number; north: number };
  private isFetchingFootprints = false;
  // Keep old root nodes rendering smoothly until new base level roots are fully loaded
  private transitionNodes = new Map<string, TileNode>();

  public globalUniforms = {
    // matches the midday preset + HUD slider default (main.ts applyPreset)
    hillshadeIntensity: { value: 0.25 },
    sunDirection: { value: new THREE.Vector3(-1, -1, 1.4).normalize() },
    fallbackColor: { value: new THREE.Color(0x556655) },
    showOutlines: { value: false },
    showDemColors: { value: false },
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
    // 0. Compute dynamic base zoom from camera altitude
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
      }
      this.rootNodes.clear();
      this.baseZoom = computedBaseZoom;
    }

    // 1. Convert local offset space to global Mercator meters
    const cx = localCameraPos.x + this.worldAnchor[0];
    const cy = localCameraPos.y + this.worldAnchor[1];

    // 2. Determine center tile at base zoom level
    const centerTile = mercatorToTile(cx, cy, this.baseZoom);

    // 3. Generate a 3x3 grid of root tiles around the camera center tile
    const newRootKeys = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tx = centerTile.x + dx;
        const ty = centerTile.y + dy;
        // Simple range check for Web Mercator tile index boundaries
        const maxTiles = 2 ** this.baseZoom;
        if (tx >= 0 && tx < maxTiles && ty >= 0 && ty < maxTiles) {
          const t: TileId = { z: this.baseZoom, x: tx, y: ty };
          const key = tileKey(t);
          newRootKeys.add(key);

          if (!this.rootNodes.has(key)) {
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

    // 4. Evict root nodes that are too far from the camera (Chebyshev distance > 2)
    for (const [key, node] of this.rootNodes.entries()) {
      const dx = Math.abs(node.tile.x - centerTile.x);
      const dy = Math.abs(node.tile.y - centerTile.y);
      if (dx > 2 || dy > 2) {
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
        // Node is completely out of view: prune its children and make it invisible
        node.visible = false;
        if (node.children) {
          for (const child of node.children) {
            this.pruneNode(child);
          }
          delete node.children;
        }
        return true; // Stop recursion and loading!
      }
    }

    const tileW = node.bounds.east - node.bounds.west;
    const tileCenter = new THREE.Vector3(node.centerMercator[0], node.centerMercator[1], 0);
    const dist = cameraPosGlobal.distanceTo(tileCenter);

    // Pin this key as active
    this.activeKeys.add(node.key);

    const shouldSubdivide = dist < tileW * this.lodFactor && node.tile.z < this.maxZoom;

    if (shouldSubdivide) {
      if (!node.children) {
        node.children = this.createChildren(node.tile);
      }

      // Recursively update children. A frustum-culled child renders nothing
      // on screen, so it must not block the parent->children swap — otherwise
      // any partially-off-screen parent keeps its coarse mesh forever.
      let allChildrenLoaded = true;
      for (const child of node.children) {
        const culled = this.updateNode(child, cameraPosGlobal, frustum);
        if (!culled && !child.loaded) {
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
        this.triggerLoad(node);
        for (const child of node.children) {
          this.hideSubtree(child);
        }
      }
    } else {
      // Do not subdivide: show parent
      node.visible = true;
      this.triggerLoad(node);

      // Collapse and dispose children if they exist to conserve memory
      if (node.children) {
        for (const child of node.children) {
          this.pruneNode(child);
        }
        delete node.children;
      }
    }

    return false; // in view
  }

  /** Mark a node and its whole descendant subtree invisible (kept loaded/cached). */
  private hideSubtree(node: TileNode): void {
    node.visible = false;
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

  private triggerLoad(node: TileNode): void {
    if (node.loaded || node.loading) {
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
      if (!node.labelSprite) {
        node.labelSprite = this.buildLabelSprite(node.tile, tileBoundsMercator(node.tile), cached.centerElevation ?? 0);
      }
      this.createMeshFromBundle(node, cached.geometry, cached.texture);
      node.loaded = true;
      node.loading = false;
      return;
    }

    // Imagery source selection
    const loadImageryForTile =
      this.imagerySource === "osm"
        ? loadImageryOSM(node.tile)
        : (node.tile.z <= this.externalImageryMaxZoom
            ? loadImageryExternal(node.tile)
            : loadImagery(this.baseUrl, this.layer, this.year, node.tile));

    // Below the terrain floor: no DEM fetch, flat quad (relief is subpixel).
    const terrainPromise =
      node.tile.z < this.terrainMinZoom
        ? Promise.resolve(null)
        : loadTerrain(this.baseUrl, node.tile);

    // Load from backend tiler
    Promise.all([
      terrainPromise,
      loadImageryForTile.catch(() => null)
    ])
      .then(([terrain, imageBitmap]) => {
        if (!node.loading) {
          // Node was pruned/cancelled during fetch
          if (imageBitmap) imageBitmap.close();
          return;
        }

        const heights = terrain?.heights;
        const demSource = terrain ? terrain.demSource : "flat";

        // Build grid mesh (or a 4-vertex flat quad below the terrain floor)
        const meshData = heights
          ? buildTerrainMesh(heights, node.tile, this.gridStep)
          : buildFlatMesh(node.tile);
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

        const centerCol = 256;
        const centerRow = 256;
        const centerH = heights ? (heights[centerRow * 512 + centerCol] ?? 0) : 0;
        node.centerElevation = centerH;
        node.demSource = demSource;

        const bounds = tileBoundsMercator(node.tile);
        if (!node.labelSprite) {
          node.labelSprite = this.buildLabelSprite(node.tile, bounds, centerH);
        }

        const bundle: Bundle = { key, bytes, geometry: geom, texture, centerElevation: centerH, demSource };
        this.bundleCache.put(bundle, this.activeKeys);

        this.createMeshFromBundle(node, geom, texture);
        node.loaded = true;
        node.loading = false;
        node.retryAfter = undefined;
      })
      .catch((err) => {
        // Loader already retried transient throttling; hold off a few seconds
        // before the manager tries this tile again.
        console.warn(`tile ${key} deferred: ${err.message}`);
        node.loading = false;
        node.retryAfter = performance.now() + 2000 + Math.random() * 2000;
      });
  }

  private buildViewportFootprintsMesh(
    footprints: FootprintCollection
  ): THREE.LineSegments | undefined {
    if (!footprints.features || footprints.features.length === 0) {
      return undefined;
    }

    const vertices: number[] = [];
    const colors: number[] = [];

    const addRingSegments = (ring: [number, number][], isS1M: boolean) => {
      if (ring.length < 2) return;

      // S1M (1m) = Cyan (0, 1, 1), USGS 1/3 Arc-Second (10m) = Magenta (1, 0, 1)
      const colorRGB = isS1M ? [0.0, 1.0, 1.0] : [1.0, 0.0, 1.0];

      const localCoords: [number, number, number][] = [];
      for (const [lon, lat] of ring) {
        const [mx, my] = lonLatToMercator(lon, lat);
        const localX = mx - this.worldAnchor[0];
        const localY = my - this.worldAnchor[1];

        // Draw at flat sea level (Z = 20.0) to avoid terrain sampling complexity.
        // We will disable depth testing on the material so the lines draw directly
        // on top of the terrain like a clean wireframe overlay.
        const localZ = 20.0; 

        localCoords.push([localX, localY, localZ]);
      }

      for (let i = 0; i < localCoords.length - 1; i++) {
        const p0 = localCoords[i]!;
        const p1 = localCoords[i + 1]!;
        vertices.push(...p0, ...p1);
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

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    geom.computeBoundingSphere();
    geom.computeBoundingBox();

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      linewidth: 2, // Double thickness (note: WebGL may clamp to 1.0 depending on GPU/driver support)
      depthTest: false // Render on top of everything!
    });

    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    return lines;
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
        brightness: this.globalUniforms.brightness,
        contrast: this.globalUniforms.contrast,
        saturation: this.globalUniforms.saturation,
        demSourceType: { value: demSourceVal },
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

  private updateTransitionNode(node: TileNode, cameraPosGlobal: THREE.Vector3, frustum?: THREE.Frustum): void {
    const isVisible = this.isNodeVisible(node, frustum);
    this.activeKeys.add(node.key);
    
    // Node is only visible on screen during transition if it's within the frustum and loaded
    node.visible = isVisible && node.loaded;
    
    if (node.children) {
      for (const child of node.children) {
        this.updateTransitionNode(child, cameraPosGlobal, frustum);
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
        node.labelSprite.position.z = node.centerElevation * val + 150;
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
      this.loadedFootprintsBBox = undefined;
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
   * Dynamically toggle showing DEM source colors.
   */
  setShowDemColors(show: boolean): void {
    this.showDemColors = show;
    this.globalUniforms.showDemColors.value = show;
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
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);

    // Calculate dynamic proportional width and height relative to tile size
    const tileW = bounds.east - bounds.west;
    const spriteW = tileW * 0.22 * this.labelScale;
    const spriteH = spriteW * (96 / 384);
    sprite.scale.set(spriteW, spriteH, 1);

    // Position sprite at tile center, offset by buffer above terrain height
    const localX = (bounds.west + bounds.east) / 2 - this.worldAnchor[0];
    const localY = (bounds.north + bounds.south) / 2 - this.worldAnchor[1];
    const localZ = centerElevation * this.verticalExaggeration + 150;
    sprite.position.set(localX, localY, localZ);

    return sprite;
  }

  private updateViewportFootprints(): void {
    if (!this.showFootprints) {
      return;
    }

    // 1. Compute current visible bounding box by unioning bounds of active visible nodes
    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    let hasVisible = false;

    const collectBounds = (node: TileNode) => {
      if (node.visible && node.loaded) {
        west = Math.min(west, node.bounds.west);
        east = Math.max(east, node.bounds.east);
        south = Math.min(south, node.bounds.south);
        north = Math.max(north, node.bounds.north);
        hasVisible = true;
      }
      if (node.children) {
        for (const child of node.children) {
          collectBounds(child);
        }
      }
    };

    for (const node of this.rootNodes.values()) {
      collectBounds(node);
    }

    if (!hasVisible) {
      return;
    }

    // Convert bounds to lon/lat geographic coordinates
    const [westLon, southLat] = mercatorToLonLat(west, south);
    const [eastLon, northLat] = mercatorToLonLat(east, north);

    // 2. Check if the current visible bbox is fully contained in loadedFootprintsBBox
    const isContained =
      this.loadedFootprintsBBox &&
      westLon >= this.loadedFootprintsBBox.west &&
      eastLon <= this.loadedFootprintsBBox.east &&
      southLat >= this.loadedFootprintsBBox.south &&
      northLat <= this.loadedFootprintsBBox.north;

    if (isContained || this.isFetchingFootprints) {
      return;
    }

    // 3. Query viewport-based footprints with a 50% buffer padding
    this.isFetchingFootprints = true;
    const dw = eastLon - westLon;
    const dh = northLat - southLat;

    const qWest = westLon - 0.5 * dw;
    const qEast = eastLon + 0.5 * dw;
    const qSouth = southLat - 0.5 * dh;
    const qNorth = northLat + 0.5 * dh;

    loadViewportFootprints(this.baseUrl, qWest, qSouth, qEast, qNorth)
      .then((footprints) => {
        if (!this.showFootprints) {
          this.isFetchingFootprints = false;
          return;
        }

        const lines = this.buildViewportFootprintsMesh(footprints);

        // Replace the old mesh in the scene
        if (this.footprintsMesh) {
          if (this.footprintsMesh.parent === this.scene) {
            this.scene.remove(this.footprintsMesh);
          }
          this.footprintsMesh.geometry.dispose();
          (this.footprintsMesh.material as THREE.Material).dispose();
        }

        if (lines) {
          this.footprintsMesh = lines;
          this.scene.add(this.footprintsMesh);
        } else {
          this.footprintsMesh = undefined;
        }

        this.loadedFootprintsBBox = { west: qWest, south: qSouth, east: qEast, north: qNorth };
        this.isFetchingFootprints = false;
      })
      .catch((err) => {
        console.warn(`Failed to load viewport footprints: ${err.message}`);
        this.isFetchingFootprints = false;
      });
  }

  /**
   * Completely clean up all roots and scene meshes.
   */
  clear(): void {
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
    this.loadedFootprintsBBox = undefined;
  }
}
