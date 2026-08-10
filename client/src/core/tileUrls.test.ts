import { describe, expect, it } from "vitest";
import {
  imageryRequest,
  osmRequest,
  resolveImageryKind,
  terrainRequest,
  type ImageryRouting,
} from "./tileUrls";
import { type TileId } from "./mercator";

const BASE = "https://cdn.example.test";
const routing = (over: Partial<ImageryRouting> = {}): ImageryRouting => ({
  baseUrl: BASE,
  layer: "naip-visualization",
  year: 2023,
  externalImageryMaxZoom: 13,
  ...over,
});
const t = (z: number, x = 1, y = 2): TileId => ({ z, x, y });

describe("resolveImageryKind", () => {
  it("routes at/below externalImageryMaxZoom to the USGS basemap render", () => {
    expect(resolveImageryKind(12, "satellite", 13)).toBe("basemap");
    expect(resolveImageryKind(13, "satellite", 13)).toBe("basemap"); // boundary is inclusive
  });

  it("routes above externalImageryMaxZoom to the NAIP COG mosaic", () => {
    expect(resolveImageryKind(14, "satellite", 13)).toBe("imagery");
  });

  it("lets OSM override the zoom rule at every zoom", () => {
    expect(resolveImageryKind(2, "osm", 13)).toBe("osm");
    expect(resolveImageryKind(18, "osm", 13)).toBe("osm");
  });
});

describe("imageryRequest", () => {
  it("builds the basemap URL below the threshold", () => {
    const { url, label } = imageryRequest(t(13), routing());
    expect(url).toContain(`${BASE}/basemap/13/1/2.webp`);
    expect(label).toBe("basemap 13/1/2");
  });

  it("builds the COG imagery URL with layer and year above the threshold", () => {
    const { url, label } = imageryRequest(t(14), routing());
    expect(url).toContain(`${BASE}/imagery/naip-visualization/2023/14/1/2.webp`);
    expect(label).toBe("imagery 14/1/2");
  });

  it("never attaches the access key to the third-party OSM server", () => {
    // The key is a dev gate for OUR CDN; leaking it to osm.org would put it in
    // their logs. Guarded here because this used to be duplicated per call site.
    const { url } = imageryRequest(t(9), routing({ imagerySource: "osm" }));
    expect(url).toBe("https://tile.openstreetmap.org/9/1/2.png");
    expect(url).not.toContain("k=");
    expect(osmRequest(t(9)).url).not.toContain("k=");
  });
});

describe("terrainRequest", () => {
  it("builds a path-only terrain URL", () => {
    const { url, label } = terrainRequest(BASE, t(15));
    expect(url).toContain(`${BASE}/terrain/15/1/2.webp`);
    expect(label).toBe("terrain 15/1/2");
  });

  it("carries no DEM-band params — the bands are tiler config, not per-request", () => {
    // These once rode on query params, which CloudFront strips (so they were a
    // no-op in production) and which would have varied tile CONTENT without
    // varying the cache key had that policy ever changed. The only query string
    // a tile URL may carry is the ?k= access key.
    const { url } = terrainRequest(BASE, t(15));
    expect(url).not.toContain("usgs_min_zoom");
    expect(url).not.toContain("s1m_min_zoom");
    const query = url.split("?")[1];
    if (query !== undefined) {
      expect(query.split("&").every((p) => p.startsWith("k="))).toBe(true);
    }
  });
});
