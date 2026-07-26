import { describe, it, expect } from "vitest";
import { spaceFactor, createStarfield } from "./sky";

describe("spaceFactor", () => {
  it("is 0 at the ground and 1 at the space altitude", () => {
    expect(spaceFactor(0, 10000)).toBe(0);
    expect(spaceFactor(10000, 10000)).toBe(1);
  });

  it("clamps above the space altitude instead of overshooting", () => {
    expect(spaceFactor(50000, 10000)).toBe(1);
  });

  it("rises monotonically with altitude", () => {
    const samples = [0, 2000, 4000, 6000, 8000, 10000].map((z) => spaceFactor(z, 10000));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThan(samples[i - 1]!);
    }
  });

  it("holds the sky near its ground colour through low-altitude flight", () => {
    // Squared falloff: half the way to space is only a quarter of the fade,
    // so normal flight altitudes still look like daytime.
    expect(spaceFactor(5000, 10000)).toBeCloseTo(0.25, 5);
    expect(spaceFactor(1500, 10000)).toBeLessThan(0.03);
  });

  it("never divides by a zero space altitude", () => {
    expect(spaceFactor(1000, 0)).toBe(0);
  });
});

describe("createStarfield", () => {
  it("sizes points in pixels, not world units", () => {
    // sizeAttenuation:false makes `size` a pixel count — scaling it by the
    // sphere radius paints screen-filling squares.
    const stars = createStarfield(2_000_000);
    const material = stars.material as unknown as { size: number; sizeAttenuation: boolean };

    expect(material.sizeAttenuation).toBe(false);
    expect(material.size).toBeLessThan(10);
  });

  it("starts invisible and is excluded from culling and depth", () => {
    const stars = createStarfield(1000);
    const material = stars.material as unknown as { opacity: number; depthWrite: boolean };

    expect(material.opacity).toBe(0);
    expect(material.depthWrite).toBe(false);
    expect(stars.frustumCulled).toBe(false);
  });

  it("places every star on the sphere", () => {
    const radius = 1000;
    const stars = createStarfield(radius);
    const positions = stars.geometry.getAttribute("position");

    for (let i = 0; i < positions.count; i++) {
      const r = Math.hypot(positions.getX(i), positions.getY(i), positions.getZ(i));
      expect(r).toBeCloseTo(radius, 3);
    }
  });
});
