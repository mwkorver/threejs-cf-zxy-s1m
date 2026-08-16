/**
 * Measurement harness for the building tile pyramid. NOT a test.
 *
 * Buildings are fetched at one zoom (buildingSourceZoom = 14) and reused by
 * every tile to z18. Two things argue against that: a dense z14 tile is large
 * however little of it is on screen, and MVT vertex quantization is tied to the
 * source zoom, so at z14 outlines snap to a ~0.6 m grid however close you fly.
 *
 * Before changing the scheme, measure it. This prints one table: payload, the
 * record count the client actually holds, extrusion cost, footprint-area
 * distribution, and how much of a source tile a single z18 descendant uses.
 *
 * Network-bound, so it is gated OFF by default -- the rest of the suite is
 * hermetic and CI must stay that way. It lives under src/ only because vitest's
 * include glob is `src/**\/*.test.ts`.
 *
 *   MEASURE=1 npx vitest run src/core/measureBuildings.test.ts
 *
 * Side effect worth knowing: it requests zooms the client never asks for (z15,
 * z17), warming CloudFront and costing a few Lambda invocations. Buildings are
 * cached immutable, so only the first run reflects true origin cost.
 */

import { describe, expect, it } from "vitest";

import { BuildingCache } from "./buildingCache";
import { decodeBuildings, type BuildingRecord } from "./buildingMesh";
import type { TileId } from "./mercator";

// vitest loads client/.env.local through Vite, and infra/deploy.sh writes both
// of these there -- so the harness reads exactly what the app is built with,
// rather than reaching for the repo-root .tile-key itself. `process` is not in
// this project's types (it targets the browser, and @types/node is not a
// dependency); vitest provides it at runtime, so declare just what is used
// rather than adding a dependency for one gated file.
declare const process: { env: Record<string, string | undefined> };

const BASE =
  import.meta.env.VITE_TILE_BASE_URL ?? "https://d2ua3aiihdkajg.cloudfront.net";

function accessKey(): string {
  return (import.meta.env.VITE_TILE_KEY ?? process.env.TILE_ACCESS_KEY ?? "").trim();
}

/** Web Mercator tile containing a lon/lat at zoom z. */
function tileFor(lat: number, lon: number, z: number): TileId {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  };
}

const AREAS: { name: string; lat: number; lon: number }[] = [
  // Calibration row. b9f98ba counted 192 buildings in 14/4818/6159 by hand, so
  // this tile is the check that the decode is measuring what that commit did --
  // an earlier byte-scan proxy overcounted the neighbouring tile by 2.6x, which
  // is exactly the sort of error this row catches.
  { name: "Newark GT", lat: 40.7223, lon: -74.1248 },
  { name: "Manhattan", lat: 40.758, lon: -73.9855 },
  { name: "Newark port", lat: 40.69, lon: -74.15 },
  { name: "Oakland", lat: 37.8044, lon: -122.2712 },
  { name: "suburban NJ", lat: 40.85, lon: -74.45 },
  { name: "rural KS", lat: 38.5, lon: -98.5 },
];

const ZOOMS = [14, 15, 16, 17, 18];

interface Cell {
  area: string;
  tile: TileId;
  bytes: number;
  ms: number;
  status: number;
  records: number;
  vertices: number;
  areaP50: number;
  areaP90: number;
  underM2: Record<number, number>;
  cache: string;
}

async function fetchTile(tile: TileId, key: string) {
  const url = `${BASE}/buildings/${tile.z}/${tile.x}/${tile.y}.pbf${key ? `?k=${encodeURIComponent(key)}` : ""}`;
  const t0 = performance.now();
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  // Timing means nothing without knowing who answered: an edge hit measures
  // CloudFront, a miss measures the tiler. Reported per row so the table is
  // readable without knowing what was invalidated beforehand.
  const cache = (res.headers.get("x-cache") ?? "?").split(" ")[0] ?? "?";
  return { status: res.status, buf, ms: performance.now() - t0, cache };
}

/** Footprint area in m^2 from the record's bbox, which decodeBuildings already
 *  expressed in metres. A bbox overstates a non-rectangular footprint, but it
 *  is the same quantity an area threshold in the tiler would filter on. */
function bboxArea(r: BuildingRecord): number {
  const [minX, minY, maxX, maxY] = r.bbox;
  return Math.abs((maxX - minX) * (maxY - minY));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

function measure(
  area: string,
  tile: TileId,
  status: number,
  buf: ArrayBuffer,
  ms: number,
  cache: string,
): Cell {
  const records = status === 200 ? decodeBuildings(buf, tile) ?? [] : [];
  let vertices = 0;
  for (const r of records) {
    for (const poly of r.polygons) {
      for (const ring of poly) vertices += ring.length / 2;
    }
  }
  const areas = records.map(bboxArea).sort((a, b) => a - b);
  const underM2: Record<number, number> = {};
  for (const t of [50, 100, 200]) {
    underM2[t] = areas.filter((a) => a < t).length;
  }
  return {
    area,
    tile,
    bytes: buf.byteLength,
    ms,
    status,
    records: records.length,
    vertices,
    areaP50: quantile(areas, 0.5),
    areaP90: quantile(areas, 0.9),
    underM2,
    cache,
  };
}

describe.runIf(process.env.MEASURE === "1")("building tile cost matrix", () => {
  it(
    "measures payload, records and reuse across areas and zooms",
    async () => {
      const key = accessKey();
      expect(key, "no VITE_TILE_KEY in client/.env.local -- requests would 403").not.toBe("");

      const cells: Cell[] = [];
      for (const a of AREAS) {
        for (const z of ZOOMS) {
          const tile = tileFor(a.lat, a.lon, z);
          const { status, buf, ms, cache } = await fetchTile(tile, key);
          cells.push(measure(a.name, tile, status, buf, ms, cache));
        }
      }

      const pad = (s: string | number, n: number) => String(s).padStart(n);
      console.log(
        `\n${"area".padEnd(13)} ${"tile".padEnd(17)} ${pad("bytes", 8)} ${pad("ms", 6)} ` +
          `${pad("recs", 6)} ${pad("verts", 7)} ${pad("B/rec", 6)} ${pad("p50 m2", 8)} ${pad("p90 m2", 8)} ${pad("<100m2", 7)} ${pad("cache", 6)}`,
      );
      for (const c of cells) {
        const t = `${c.tile.z}/${c.tile.x}/${c.tile.y}`;
        const perRec = c.records ? Math.round(c.bytes / c.records) : 0;
        const pctSmall = c.records ? Math.round((100 * (c.underM2[100] ?? 0)) / c.records) : 0;
        console.log(
          `${c.area.padEnd(13)} ${t.padEnd(17)} ${pad(c.bytes, 8)} ${pad(Math.round(c.ms), 6)} ` +
            `${pad(c.records, 6)} ${pad(c.vertices, 7)} ${pad(perRec, 6)} ${pad(Math.round(c.areaP50), 8)} ${pad(Math.round(c.areaP90), 8)} ${pad(`${pctSmall}%`, 7)} ${pad(c.cache, 6)}`,
        );
      }

      // How much of a z14 source does one z18 descendant actually use? This is
      // the waste the ladder would remove. BuildingCache.forTile is the same
      // split the renderer uses: roofs overlap, walls own the centroid.
      console.log(`\n${"area".padEnd(13)} z14 recs -> one z18 child: roofs / walls (share of parent)`);
      for (const a of AREAS) {
        const src = tileFor(a.lat, a.lon, 14);
        const { status, buf } = await fetchTile(src, key);
        if (status !== 200) continue;
        const recs = decodeBuildings(buf, src);
        if (!recs) continue;
        const cache = new BuildingCache();
        cache.put(src, recs);
        const child = tileFor(a.lat, a.lon, 18);
        const got = cache.forTile(child, 14);
        const roofs = got?.roofRecords.length ?? 0;
        const walls = got?.wallRecords.length ?? 0;
        const share = recs.length ? ((100 * roofs) / recs.length).toFixed(1) : "0";
        console.log(
          `${a.name.padEnd(13)} ${String(recs.length).padStart(6)} -> ${String(roofs).padStart(5)} / ${String(walls).padStart(5)}  (${share}% of parent)`,
        );
      }

      // Quantization is a property of the source zoom, not of any tile.
      console.log("\nvertex quantization (extent 4096):");
      for (const z of [14, 15, 16, 17, 18]) {
        const w = 40075016.685578488 / 2 ** z;
        console.log(`  z${z}: tile ${w.toFixed(0).padStart(5)} m -> ${(w / 4096).toFixed(3)} m per unit`);
      }

      expect(cells.length).toBe(AREAS.length * ZOOMS.length);
    },
    600_000,
  );
});
