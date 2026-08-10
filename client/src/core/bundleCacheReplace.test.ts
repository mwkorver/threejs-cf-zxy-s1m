import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BundleCache, type Bundle } from "./bundleCache";
import { TexturePool } from "./texturePool";

function fakeImage(): TexImageSource {
  return { width: 512, height: 512 } as unknown as TexImageSource;
}

function bundle(key: string, texture: THREE.Texture): Bundle {
  return {
    key, bytes: 1024, geometry: new THREE.BufferGeometry(), gridSize: 8, texture,
  };
}

// Replacing an entry used to free the old one unconditionally. Eviction has
// always spared pinned keys; this path did not, and it is reached routinely --
// a prefetch still in flight when the camera arrives lands here just after
// triggerLoad built a mesh from the entry being replaced.
describe("replacing an entry whose key is pinned", () => {
  it("leaves the texture a live mesh is rendering intact", () => {
    const pool = new TexturePool();
    const cache = new BundleCache(512 * 1024 * 1024, pool);
    const pinned = new Set(["14/1/1"]);

    const first = pool.acquire(fakeImage());
    cache.put(bundle("14/1/1", first), pinned);

    // What createMeshFromBundle does: the material holds the texture.
    const material = new THREE.MeshBasicMaterial({ map: first });

    cache.put(bundle("14/1/1", pool.acquire(fakeImage())), pinned);

    // A released texture has its image closed and nulled, and goes back on the
    // free list for the next acquire() -- black here, wrong imagery there.
    expect(material.map!.image).not.toBeNull();
    expect(pool.stats().idle).toBe(0);
  });

  it("still recycles when the key is not pinned", () => {
    const pool = new TexturePool();
    const cache = new BundleCache(512 * 1024 * 1024, pool);

    const first = pool.acquire(fakeImage());
    cache.put(bundle("14/1/1", first), new Set());
    cache.put(bundle("14/1/1", pool.acquire(fakeImage())), new Set());

    // Nothing renders it, so recycling is exactly right: the fix must not
    // buy safety by turning the pool off.
    expect(pool.stats().idle).toBe(1);
  });

  it("keeps byte accounting straight either way", () => {
    const pool = new TexturePool();
    const cache = new BundleCache(512 * 1024 * 1024, pool);
    const pinned = new Set(["14/1/1"]);

    cache.put(bundle("14/1/1", pool.acquire(fakeImage())), pinned);
    cache.put(bundle("14/1/1", pool.acquire(fakeImage())), pinned);
    cache.put(bundle("14/1/1", pool.acquire(fakeImage())), pinned);

    // One entry, counted once -- a replace must not double-count or go negative.
    expect(cache.size()).toBe(1);
    expect(cache.bytesUsed()).toBe(1024);
  });
});
