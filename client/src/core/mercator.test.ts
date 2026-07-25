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

// Plan §5.1 sec(lat) scale audit: every true-metre → world-Z conversion must
// multiply by mercatorScale(lat). This test documents the convention and guards
// against regressions: a 1000 m peak at 49°N renders at world Z = 1524 m, not
// 1000 m — miss the factor and slopes flatten going north, frustum culling
// boxes are too short, and LOD distances mix units.
describe("sec(lat) world-Z convention", () => {
  it("true metres × mercatorScale(lat) = world Z (Mercator metres)", () => {
    // Sea level: world Z is 0 regardless of latitude
    expect(0 * mercatorScale(49)).toBe(0);

    // 1000 m true at the equator → 1000 m world Z (no stretch)
    expect(1000 * mercatorScale(0)).toBeCloseTo(1000, 1);

    // 1000 m true at 49°N → 1524 m world Z (stretched by sec(lat))
    expect(1000 * mercatorScale(49)).toBeCloseTo(1524, 0);

    // The stretch is monotonic in latitude — slopes get steeper going north
    const zAt40 = 1000 * mercatorScale(40);
    const zAt45 = 1000 * mercatorScale(45);
    const zAt49 = 1000 * mercatorScale(49);
    expect(zAt40).toBeLessThan(zAt45);
    expect(zAt45).toBeLessThan(zAt49);
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
