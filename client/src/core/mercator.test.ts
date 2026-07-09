import { describe, expect, it } from "vitest";
import {
  lonLatToMercator,
  mercatorScale,
  mercatorToLonLat,
  mercatorToTile,
  tileBoundsMercator,
} from "./mercator";

describe("mercatorScale", () => {
  // Plan §5.1 anchor values
  it("matches the plan's reference latitudes", () => {
    expect(mercatorScale(25.76)).toBeCloseTo(1.11, 2); // Miami
    expect(mercatorScale(39.74)).toBeCloseTo(1.30, 2); // Denver
    expect(mercatorScale(49)).toBeCloseTo(1.524, 3); // northern CONUS border
  });

  it("is 1 at the equator", () => {
    expect(mercatorScale(0)).toBe(1);
  });
});

describe("lonLat <-> mercator", () => {
  it("roundtrips over NJ", () => {
    const [x, y] = lonLatToMercator(-74.44, 40.5);
    const [lon, lat] = mercatorToLonLat(x, y);
    expect(lon).toBeCloseTo(-74.44, 9);
    expect(lat).toBeCloseTo(40.5, 9);
  });

  it("maps the origin to 0,0", () => {
    const [x, y] = lonLatToMercator(0, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });
});

describe("tiles", () => {
  it("point-in-tile is consistent with tile bounds", () => {
    const [x, y] = lonLatToMercator(-74.44, 40.5);
    const t = mercatorToTile(x, y, 15);
    const b = tileBoundsMercator(t);
    expect(x).toBeGreaterThanOrEqual(b.west);
    expect(x).toBeLessThan(b.east);
    expect(y).toBeGreaterThan(b.south);
    expect(y).toBeLessThanOrEqual(b.north);
  });

  it("z0 tile spans the world", () => {
    const b = tileBoundsMercator({ z: 0, x: 0, y: 0 });
    expect(b.east - b.west).toBeCloseTo(2 * 20037508.342789244, 3);
    expect(b.north).toBeCloseTo(20037508.342789244, 3);
  });
});
