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
import { loadTerrain, loadImagery, loadFootprints, type FootprintCollection } from "./tileLoader";
import { buildTerrainMesh } from "./terrainMesh";
import { BundleCache, Bundle } from "./bundleCache";
import { TerrainShader } from "./terrainShader";

export interface TileNode {
  key: string;
  tile: TileId;
  bounds: { west: number; south: number; east: number; north: number };
  centerMercator: [number, number];
  mesh?: THREE.Mesh;
  footprintsMesh?: THREE.LineSegments;
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

  public globalUniforms = {
    hillshadeIntensity: { value: 0.3 },
    sunDirection: { value: new THREE.Vector3(-1, -1, 1.4).normalize() },
    fallbackColor: { value: new THREE.Color(0x556655) },
  };
  
  constructor(
    readonly baseUrl: string,
    readonly layer: string,
    readonly year: number,
    readonly scene: THREE.Scene,
    readonly bundleCache: BundleCache,
    readonly worldAnchor: [number, number],
    readonly baseZoom = 12,
    readonly maxZoom = 16,
    readonly lodFactor = 2.2
  ) {}

  /**
   * Update active tiles and LOD based on camera position (relative to worldAnchor).
   * @param localCameraPos Camera position in local offset space.
   */
  update(localCameraPos: THREE.Vector3): void {
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

    // 5. Run LOD update on each root node recursively
    this.activeKeys.clear();
    const cameraPosGlobal = new THREE.Vector3(cx, cy, localCameraPos.z);

    for (const node of this.rootNodes.values()) {
      this.updateNode(node, cameraPosGlobal);
    }

    // 6. Update scene visibility & sync mesh additions/removals
    for (const node of this.rootNodes.values()) {
      this.syncScene(node);
    }
  }

  /**
   * Get the keys of all tiles that are currently pinned (visible or actively loading).
   */
  getActiveKeys(): Set<string> {
    return this.activeKeys;
  }

  private updateNode(node: TileNode, cameraPosGlobal: THREE.Vector3): void {
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

      // Recursively update children
      let allChildrenLoaded = true;
      for (const child of node.children) {
        this.updateNode(child, cameraPosGlobal);
        if (!child.loaded) {
          allChildrenLoaded = false;
        }
      }

      if (allChildrenLoaded) {
        // Children take over: hide parent mesh
        node.visible = false;
      } else {
        // Keep parent visible as fallback while children load
        node.visible = true;
        this.triggerLoad(node);
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
      this.createMeshFromBundle(node, cached.geometry, cached.texture, cached.footprints);
      node.loaded = true;
      node.loading = false;
      return;
    }

    // Load S1M footprints only if near field (z >= 12)
    const fetchFootprints = node.tile.z >= 12
      ? loadFootprints(this.baseUrl, node.tile).catch(() => null)
      : Promise.resolve(null);

    // Load from backend tiler
    Promise.all([
      loadTerrain(this.baseUrl, node.tile),
      loadImagery(this.baseUrl, this.layer, this.year, node.tile).catch(() => null),
      fetchFootprints
    ])
      .then(([heights, imageBitmap, footprintsData]) => {
        if (!node.loading) {
          // Node was pruned/cancelled during fetch
          if (imageBitmap) imageBitmap.close();
          return;
        }

        // Build grid mesh
        const meshData = buildTerrainMesh(heights, node.tile, this.gridStep);
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

        // Build S1M footprints lines if data is present
        const bounds = tileBoundsMercator(node.tile);
        const [, centerLat] = mercatorToLonLat((bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2);
        const zScale = mercatorScale(centerLat);

        let footprintsMesh: THREE.LineSegments | undefined;
        if (footprintsData) {
          footprintsMesh = this.buildFootprintsMesh(footprintsData, bounds, heights, zScale);
        }

        // Calculate rough bytes: positions (float32=4 bytes) + normals (float32=4) + indices (uint32=4) + texture (512x512 RGBA=1MB) + footprints geometry
        let footprintsBytes = 0;
        if (footprintsMesh) {
          const posAttr = footprintsMesh.geometry.getAttribute("position");
          footprintsBytes = posAttr ? posAttr.count * 3 * 4 : 0;
        }

        const bytes =
          meshData.positions.byteLength +
          meshData.normals.byteLength +
          meshData.indices.byteLength +
          (texture ? 512 * 512 * 4 : 0) +
          footprintsBytes;

        const bundle: Bundle = { key, bytes, geometry: geom, texture, footprints: footprintsMesh };
        this.bundleCache.put(bundle, this.activeKeys);

        this.createMeshFromBundle(node, geom, texture, footprintsMesh);
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

  private buildFootprintsMesh(
    footprints: FootprintCollection,
    bounds: { west: number; south: number; east: number; north: number },
    heights: Float32Array,
    zScale: number
  ): THREE.LineSegments | undefined {
    if (!footprints.features || footprints.features.length === 0) {
      return undefined;
    }

    const tileW = bounds.east - bounds.west;
    const tileH = bounds.north - bounds.south;
    const vertices: number[] = [];

    const addRingSegments = (ring: [number, number][]) => {
      if (ring.length < 2) return;

      const localCoords: [number, number, number][] = [];
      for (const [lon, lat] of ring) {
        const [mx, my] = lonLatToMercator(lon, lat);
        const localX = mx - bounds.west;
        const localY = my - bounds.north;

        // Sample height
        const u = (mx - bounds.west) / tileW;
        const v = (bounds.north - my) / tileH;
        const col = Math.max(0, Math.min(511, Math.round(u * 511)));
        const row = Math.max(0, Math.min(511, Math.round(v * 511)));
        const h = heights[row * 512 + col] ?? 0;

        // Unexaggerated Z coordinate, with a tiny offset (3.0 meters) to avoid Z-fighting
        const localZ = h * zScale + 3.0;

        localCoords.push([localX, localY, localZ]);
      }

      for (let i = 0; i < localCoords.length - 1; i++) {
        const p0 = localCoords[i]!;
        const p1 = localCoords[i + 1]!;
        vertices.push(...p0, ...p1);
      }
    };

    for (const feat of footprints.features) {
      const geom = feat.geometry;
      if (geom.type === "Polygon") {
        for (const ring of geom.coordinates) {
          addRingSegments(ring);
        }
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            addRingSegments(ring);
          }
        }
      }
    }

    if (vertices.length === 0) return undefined;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));

    // A nice bright, glowing cyan material for footprint outlines
    const mat = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.8
    });

    const lines = new THREE.LineSegments(geom, mat);
    return lines;
  }

  private createMeshFromBundle(
    node: TileNode,
    geom: THREE.BufferGeometry,
    texture?: THREE.Texture,
    footprintsMesh?: THREE.LineSegments
  ): void {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture || null },
        useTexture: { value: !!texture },
        fallbackColor: this.globalUniforms.fallbackColor,
        hillshadeIntensity: this.globalUniforms.hillshadeIntensity,
        sunDirection: this.globalUniforms.sunDirection,
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

    if (footprintsMesh) {
      footprintsMesh.position.set(
        node.bounds.west - this.worldAnchor[0],
        node.bounds.north - this.worldAnchor[1],
        0
      );
      footprintsMesh.scale.z = this.verticalExaggeration;
      node.footprintsMesh = footprintsMesh;
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
      if (this.showFootprints && node.footprintsMesh && node.footprintsMesh.parent !== this.scene) {
        this.scene.add(node.footprintsMesh);
      }
    } else {
      if (node.mesh && node.mesh.parent === this.scene) {
        this.scene.remove(node.mesh);
      }
      if (node.footprintsMesh && node.footprintsMesh.parent === this.scene) {
        this.scene.remove(node.footprintsMesh);
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
      node.mesh = undefined;
    }
    if (node.footprintsMesh) {
      if (node.footprintsMesh.parent === this.scene) {
        this.scene.remove(node.footprintsMesh);
      }
      node.footprintsMesh = undefined;
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
   * Dynamically update the vertical exaggeration of all existing meshes and future ones.
   */
  setVerticalExaggeration(val: number): void {
    this.verticalExaggeration = val;
    const updateScale = (node: TileNode) => {
      if (node.mesh) {
        node.mesh.scale.z = val;
      }
      if (node.footprintsMesh) {
        node.footprintsMesh.scale.z = val;
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
    const updateVisibility = (node: TileNode) => {
      if (node.footprintsMesh) {
        if (show && node.visible && node.loaded) {
          if (node.footprintsMesh.parent !== this.scene) {
            this.scene.add(node.footprintsMesh);
          }
        } else {
          if (node.footprintsMesh.parent === this.scene) {
            this.scene.remove(node.footprintsMesh);
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

  /**
   * Completely clean up all roots and scene meshes.
   */
  clear(): void {
    for (const node of this.rootNodes.values()) {
      this.pruneNode(node);
    }
    this.rootNodes.clear();
    this.activeKeys.clear();
  }
}
