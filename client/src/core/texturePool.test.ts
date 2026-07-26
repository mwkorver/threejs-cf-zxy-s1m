import { describe, it, expect } from "vitest";
import { TexturePool } from "./texturePool";

/** Stand-in for the baked tile bitmap; the pool never reads its contents. */
function fakeImage(): TexImageSource {
  return { width: 512, height: 512 } as unknown as TexImageSource;
}

describe("TexturePool", () => {
  it("creates a texture when nothing is idle", () => {
    const pool = new TexturePool();
    const texture = pool.acquire(fakeImage());

    expect(texture.image).toBeTruthy();
    expect(pool.stats()).toMatchObject({ created: 1, reused: 0, idle: 0 });
  });

  it("recycles a released texture instead of creating another", () => {
    const pool = new TexturePool();
    const first = pool.acquire(fakeImage());
    pool.release(first);
    expect(pool.stats().idle).toBe(1);

    const second = pool.acquire(fakeImage());

    expect(second).toBe(first); // same GPU texture, refilled
    expect(pool.stats()).toMatchObject({ created: 1, reused: 1, idle: 0 });
  });

  it("re-uploads on reuse so the recycled texture shows the new tile", () => {
    const pool = new TexturePool();
    const texture = pool.acquire(fakeImage());
    const versionBefore = texture.version;
    pool.release(texture);

    const image = fakeImage();
    const reused = pool.acquire(image);

    expect(reused.image).toBe(image);
    // `needsUpdate` is a write-only setter in three.js; it bumps `version`,
    // which is what actually triggers the re-upload.
    expect(reused.version).toBeGreaterThan(versionBefore);
  });

  it("drops the image reference while idle so bitmaps aren't pinned", () => {
    const pool = new TexturePool();
    const texture = pool.acquire(fakeImage());
    pool.release(texture);

    expect(texture.image).toBeNull();
  });

  it("disposes rather than pools beyond maxIdle", () => {
    const pool = new TexturePool(1);
    const a = pool.acquire(fakeImage());
    const b = pool.acquire(fakeImage());

    pool.release(a);
    pool.release(b); // over the cap

    expect(pool.stats().idle).toBe(1);
  });
});
