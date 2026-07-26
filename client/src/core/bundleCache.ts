import type * as THREE from "three";
import type { TexturePool } from "./texturePool";

export interface Bundle {
  key: string; // tileKey(z/x/y)
  bytes: number;
  geometry: THREE.BufferGeometry;
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
  constructor(readonly byteBudget: number, private readonly texturePool?: TexturePool) {}

  get(key: string): Bundle | undefined {
    const bundle = this.map.get(key);
    if (bundle) {
      // Refresh key order for LRU
      this.map.delete(key);
      this.map.set(key, bundle);
    }
    return bundle;
  }

  put(bundle: Bundle, pinnedKeys?: Set<string>): void {
    const existing = this.map.get(bundle.key);
    if (existing) {
      this.map.delete(bundle.key);
      this.currentBytes -= existing.bytes;
      this.disposeBundle(existing);
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
    if (bundle.geometry) {
      bundle.geometry.dispose();
    }
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

