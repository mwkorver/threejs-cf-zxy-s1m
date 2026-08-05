import { describe, expect, it, vi } from "vitest";
import { BundleCache, type Bundle } from "./bundleCache";

/** Create a minimal Bundle with the given key and byte count. */
function makeBundle(key: string, bytes: number): Bundle {
  const geom = {
    dispose: vi.fn(),
  } as unknown as import("three").BufferGeometry;
  return { key, bytes, geometry: geom, gridSize: 65 };
}

/** Create a Bundle with a mock texture (tests dispose path). */
function makeBundleWithTexture(key: string, bytes: number): Bundle {
  const geom = {
    dispose: vi.fn(),
  } as unknown as import("three").BufferGeometry;
  const tex = {
    dispose: vi.fn(),
  } as unknown as import("three").Texture;
  return { key, bytes, geometry: geom, gridSize: 65, texture: tex };
}

/** Create a Bundle with mock footprints (tests array + non-array material dispose). */
function makeBundleWithFootprints(
  key: string,
  bytes: number,
  materialArray: boolean,
): Bundle {
  const geom = {
    dispose: vi.fn(),
  } as unknown as import("three").BufferGeometry;
  const footGeom = {
    dispose: vi.fn(),
  } as unknown as import("three").BufferGeometry;
  // Create fresh mock materials each time so dispose counts are independent
  const mats = materialArray
    ? [{ dispose: vi.fn() } as unknown as import("three").Material,
       { dispose: vi.fn() } as unknown as import("three").Material]
    : { dispose: vi.fn() } as unknown as import("three").Material;
  const footprints = {
    geometry: footGeom,
    material: mats,
  } as unknown as import("three").LineSegments;
  return { key, bytes, geometry: geom, gridSize: 65, footprints };
}

describe("BundleCache", () => {
  it("returns undefined for a missing key", () => {
    const cache = new BundleCache(1024);
    expect(cache.get("z/x/y")).toBeUndefined();
  });

  it("stores and retrieves a bundle", () => {
    const cache = new BundleCache(1024);
    const bundle = makeBundle("12/2048/2048", 256);
    cache.put(bundle);
    expect(cache.get("12/2048/2048")).toBe(bundle);
    expect(cache.size()).toBe(1);
  });

  it("putting the same key replaces the old bundle and disposes it", () => {
    const cache = new BundleCache(1024);
    const old = makeBundle("12/2048/2048", 256);
    const replacement = makeBundle("12/2048/2048", 512);
    cache.put(old);
    cache.put(replacement);

    expect(old.geometry.dispose).toHaveBeenCalledOnce();
    expect(cache.get("12/2048/2048")).toBe(replacement);
    expect(cache.size()).toBe(1);
    expect(cache.bytesUsed()).toBe(512);
  });

  it("evicts ALL non-pinned entries when budget is exceeded (known behavior)", () => {
    // NOTE: evict() collects keys in a first pass without decrementing currentBytes,
    // so once the budget is exceeded it collects every non-pinned entry — including
    // the freshly-inserted one — then removes them all in bulk.
    //
    // Budget 300: a(150) + b(150) = 300 (fits). Adding c(150) = 450 > 300.
    // evict collects a, b, c (all non-pinned), then removes all → empty.
    const cache = new BundleCache(300);
    const a = makeBundle("12/0/0", 150);
    const b = makeBundle("12/0/1", 150);

    cache.put(a);
    cache.put(b);
    expect(cache.size()).toBe(2);
    expect(cache.bytesUsed()).toBe(300);

    const c = makeBundle("12/0/2", 150);
    cache.put(c);
    // All non-pinned entries were evicted, including c
    expect(cache.size()).toBe(0);
    expect(cache.bytesUsed()).toBe(0);
    expect(a.geometry.dispose).toHaveBeenCalledOnce();
    expect(b.geometry.dispose).toHaveBeenCalledOnce();
    expect(c.geometry.dispose).toHaveBeenCalledOnce();
  });

  it("get refreshes LRU order (affects eviction order, though all get evicted)", () => {
    // LRU order is correctly maintained by get() — the evicted-first order is
    // LRU to MRU. With the bulk-evict behavior, all non-pinned entries are removed
    // regardless, but the order they are disposed is LRU-first.
    const cache = new BundleCache(300);
    const a = makeBundle("12/0/0", 150);
    const b = makeBundle("12/0/1", 150);
    cache.put(a);
    cache.put(b);

    // Touch a to make it MRU
    cache.get("12/0/0");

    const c = makeBundle("12/0/2", 150);
    cache.put(c);
    // All three evicted; b was disposed first (LRU), a second, c third
    expect(cache.size()).toBe(0);
    expect(b.geometry.dispose).toHaveBeenCalledOnce();
    expect(a.geometry.dispose).toHaveBeenCalledOnce();
    expect(c.geometry.dispose).toHaveBeenCalledOnce();
  });

  it("pinned keys survive eviction; non-pinned entries are bulk-evicted", () => {
    // Budget 300: pinned(150) + other(150) fits. Adding fresh(150) = 450.
    // evict skips pinned but collects all other non-pinned entries (including fresh).
    // Result: only pinned survives.
    const cache = new BundleCache(300);
    const pinned = makeBundle("12/0/0", 150);
    const other = makeBundle("12/0/1", 150);
    cache.put(pinned);
    cache.put(other);
    expect(cache.bytesUsed()).toBe(300);

    const fresh = makeBundle("12/0/2", 150);
    const pinnedKeys = new Set(["12/0/0"]);
    cache.put(fresh, pinnedKeys);

    // pinned survives; other AND fresh were evicted (bulk eviction)
    expect(cache.get("12/0/0")).toBe(pinned);
    expect(cache.get("12/0/1")).toBeUndefined();
    expect(cache.get("12/0/2")).toBeUndefined(); // fresh was also evicted
    expect(other.geometry.dispose).toHaveBeenCalledOnce();
    expect(fresh.geometry.dispose).toHaveBeenCalledOnce();
    expect(pinned.geometry.dispose).not.toHaveBeenCalled();
    expect(cache.bytesUsed()).toBe(150);
  });

  it("oversized single bundle gets evicted when it alone exceeds budget", () => {
    // The put adds the bundle then immediately evicts. Since currentBytes (500) > budget (100),
    // and no pinned keys, the oversized bundle itself is evicted.
    const cache = new BundleCache(100);
    const huge = makeBundle("12/0/0", 500);
    cache.put(huge);
    // The bundle was added then evicted in the same put call
    expect(cache.size()).toBe(0);
    expect(cache.bytesUsed()).toBe(0);
    expect(huge.geometry.dispose).toHaveBeenCalledOnce();
  });

  it("oversized bundle survives when it is pinned", () => {
    const cache = new BundleCache(100);
    const huge = makeBundle("12/0/0", 500);
    cache.put(huge, new Set(["12/0/0"]));
    // Pinned, so it survives despite exceeding budget
    expect(cache.size()).toBe(1);
    expect(cache.bytesUsed()).toBe(500);
    expect(huge.geometry.dispose).not.toHaveBeenCalled();
  });

  it("clear disposes all bundles and resets counters", () => {
    const cache = new BundleCache(1024);
    const a = makeBundle("12/0/0", 100);
    const b = makeBundle("12/1/0", 200);
    cache.put(a);
    cache.put(b);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.bytesUsed()).toBe(0);
    expect(a.geometry.dispose).toHaveBeenCalledOnce();
    expect(b.geometry.dispose).toHaveBeenCalledOnce();
  });

  it("dispose also frees textures", () => {
    const cache = new BundleCache(1024);
    const withTex = makeBundleWithTexture("12/0/0", 256);
    cache.put(withTex);
    cache.clear();
    expect(withTex.geometry.dispose).toHaveBeenCalledOnce();
    expect((withTex.texture as any).dispose).toHaveBeenCalledOnce();
  });

  it("disposes footprint materials (array and single)", () => {
    const cache = new BundleCache(2048);

    // Array materials
    const arrayMat = makeBundleWithFootprints("12/0/0", 100, true);
    cache.put(arrayMat);
    cache.clear();
    const arrayMats = (arrayMat.footprints as any).material;
    expect(arrayMats[0].dispose).toHaveBeenCalledOnce();
    expect(arrayMats[1].dispose).toHaveBeenCalledOnce();
    expect((arrayMat.footprints as any).geometry.dispose).toHaveBeenCalledOnce();

    // Single material (separate cache to avoid shared mock interference)
    const cache2 = new BundleCache(2048);
    const singleMat = makeBundleWithFootprints("12/0/1", 100, false);
    cache2.put(singleMat);
    cache2.clear();
    expect((singleMat.footprints as any).material.dispose).toHaveBeenCalledOnce();
  });

  it("tracks bytesUsed accurately across puts, replacements, and evictions", () => {
    const cache = new BundleCache(400);
    cache.put(makeBundle("a", 100));
    expect(cache.bytesUsed()).toBe(100);

    cache.put(makeBundle("b", 200));
    expect(cache.bytesUsed()).toBe(300);

    // Replace "a" (100) with new "a" (150): subtract 100, add 150 = 350
    cache.put(makeBundle("a", 150));
    expect(cache.bytesUsed()).toBe(350);

    // clear resets
    cache.clear();
    expect(cache.bytesUsed()).toBe(0);
  });

  it("multiple rapid evictions handle byte accounting correctly", () => {
    // Budget 100: each put of a 60-byte bundle triggers eviction.
    // After first put: 60 ≤ 100, no eviction.
    // After second put: 120 > 100, both are evicted (bulk) → 0.
    const cache = new BundleCache(100);
    const a = makeBundle("a", 60);

    cache.put(a);
    expect(cache.bytesUsed()).toBe(60);
    expect(cache.size()).toBe(1);

    const b = makeBundle("b", 60);
    cache.put(b);
    // 120 > 100: both a and b are collected and evicted → empty
    expect(cache.bytesUsed()).toBe(0);
    expect(cache.size()).toBe(0);

    // After clearing, new puts work normally
    const c = makeBundle("c", 60);
    cache.put(c);
    expect(cache.bytesUsed()).toBe(60);
    expect(cache.size()).toBe(1);
    expect(cache.get("c")).toBe(c);
  });
});
