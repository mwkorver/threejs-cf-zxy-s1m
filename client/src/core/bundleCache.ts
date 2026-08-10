import type * as THREE from "three";
import type { TexturePool } from "./texturePool";

export interface Bundle {
  key: string; // tileKey(z/x/y)
  bytes: number;
  geometry: THREE.BufferGeometry;
  /**
   * Interior vertices per side of the terrain grid. Kept so building geometry
   * can be assembled later from this bundle's positions -- it is no longer
   * baked in here, because a bundle outlives the BuildingCache state it was
   * created under.
   */
  gridSize: number;
  texture?: THREE.Texture;
  footprints?: THREE.LineSegments;
  centerElevation?: number;
  demSource?: string;
  minElevation?: number;
  maxElevation?: number;
}

export class BundleCache {
  private map = new Map<string, Bundle>();
  private currentBytes = 0;

  /**
   * @param texturePool when given, evicted tile textures are recycled through
   *   it instead of disposed. Eviction skips pinned keys, so a released
   *   texture is never one a live mesh still renders.
   */
  constructor(private byteBudgetValue: number, private readonly texturePool?: TexturePool) {}

  get byteBudget(): number {
    return this.byteBudgetValue;
  }

  /**
   * Narrow or widen the share of the GPU budget bundles may hold.
   *
   * Bundles are not the only thing on the GPU: building geometry belongs to the
   * tile mesh, so this cache cannot see it. TileManager keeps this at the total
   * budget minus live building bytes, which is what makes the two together
   * respect one ceiling. Without it the cache read 254.9 MB of 256 while real
   * usage was 390 MB, and so never evicted hard enough.
   *
   * Evicts immediately on shrink, so lowering it takes effect now rather than
   * at the next put().
   */
  setByteBudget(bytes: number, pinnedKeys?: Set<string>): void {
    this.byteBudgetValue = Math.max(0, bytes);
    this.evict(pinnedKeys);
  }

  get(key: string): Bundle | undefined {
    const bundle = this.map.get(key);
    if (bundle) {
      // Refresh key order for LRU
      this.map.delete(key);
      this.map.set(key, bundle);
    }
    return bundle;
  }

  /**
   * @param pinnedKeys keys whose bundles something may still be rendering.
   *   Honoured when REPLACING an entry as well as when evicting: see below.
   */
  put(bundle: Bundle, pinnedKeys?: Set<string>): void {
    const existing = this.map.get(bundle.key);
    if (existing) {
      this.map.delete(bundle.key);
      this.currentBytes -= existing.bytes;
      // Replacing is not a licence to free. Eviction has always spared pinned
      // keys; this path did not, and it is reached routinely -- a prefetch
      // in flight when the camera arrives lands here just after triggerLoad
      // built a mesh from the entry being replaced. disposeBundle would hand
      // that mesh's texture back to TexturePool, which nulls its image and
      // gives the same object to the next tile that asks: the live tile goes
      // black and another draws its imagery.
      //
      // The dropped bundle is not recycled, only released to GC -- one texture
      // that misses the pool rather than one that corrupts two tiles. The mesh
      // still holds it, and picks up the new bundle when it is next rebuilt.
      if (!pinnedKeys?.has(bundle.key)) {
        this.disposeBundle(existing);
      }
    }

    this.map.set(bundle.key, bundle);
    this.currentBytes += bundle.bytes;

    this.evict(pinnedKeys);
  }

  private evict(pinnedKeys?: Set<string>): void {
    const keysToEvict: string[] = [];
    for (const key of this.map.keys()) {
      if (this.currentBytes <= this.byteBudget) {
        break;
      }
      if (pinnedKeys && pinnedKeys.has(key)) {
        continue; // Do not evict active/visible tiles
      }
      keysToEvict.push(key);
    }

    for (const key of keysToEvict) {
      const bundle = this.map.get(key)!;
      this.map.delete(key);
      this.currentBytes -= bundle.bytes;
      this.disposeBundle(bundle);
    }
  }

  private disposeBundle(bundle: Bundle): void {
    // Dispose of GPU resources to prevent memory leaks
    bundle.geometry.dispose();
    // Building geometry is owned by the tile mesh, not the bundle -- it is
    // rebuilt per mesh from the current cache. TileManager disposes it when the
    // mesh is torn down.
    if (bundle.texture) {
      if (this.texturePool) {
        this.texturePool.release(bundle.texture);
      } else {
        bundle.texture.dispose();
      }
    }
    if (bundle.footprints) {
      bundle.footprints.geometry.dispose();
      if (Array.isArray(bundle.footprints.material)) {
        bundle.footprints.material.forEach((m) => m.dispose());
      } else {
        bundle.footprints.material.dispose();
      }
    }
  }

  clear(): void {
    for (const bundle of this.map.values()) {
      this.disposeBundle(bundle);
    }
    this.map.clear();
    this.currentBytes = 0;
  }

  size(): number {
    return this.map.size;
  }

  bytesUsed(): number {
    return this.currentBytes;
  }
}

