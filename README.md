# threejs-cf-zxy-s1m

CONUS flight-simulator-style streaming viewer: NAIP (and state COG) imagery,
USGS 3DEP S1M terrain, and Overture buildings, normalized server-side onto a
single EPSG:3857 `z/x/y` quadtree and served through CloudFront.

**Read [FLIGHT-SIM-PLAN.md](FLIGHT-SIM-PLAN.md) first** — it holds the
architecture, the locked decisions, and the phased plan. This repo is the
Phase 0 build: fly a camera over one corridor (New Jersey, NAIP) with server
tiles end-to-end.

## How it works

The viewer requests 512 px imagery and elevation tiles over one XYZ
Web-Mercator quadtree from CloudFront; a rio-tiler Lambda renders cache
misses. At higher zooms the Lambda builds tiles from source COGs in S3 —
NAIP imagery and USGS DEMs (1 m S1M, falling back to 10 m 1/3″) — locating
the intersecting COGs via a DuckDB parquet index, then mosaicking and
warping them onto the tile grid. At lower zooms it skips the COGs and
proxies pre-rendered pyramids instead: USDA's NAIP ImageServer cache for
imagery, the public Terrarium tile set for elevation. Imagery arrives as
lossy WebP, elevation as lossless Terrarium-RGB WebP; the client decodes
elevations into heightfield meshes and textures them with the imagery, with
a screen-space-error quadtree deciding which tiles to request.

Per zoom band, the source data is:

| Tiles | Zoom | Source | How |
|---|---|---|---|
| Imagery | ≥ 14 | NAIP COGs (requester-pays USDA S3) | DuckDB index → rio-tiler mosaic |
| Imagery | ≤ 13 | USDA NAIP ImageServer tile cache | `/basemap` 2×2 stitch of 256 px children |
| Terrain | ≥ 15 | S1M 1 m DEM COGs (`prd-tnm` S3, Albers) | index → mosaic → warp; voids filled from 1/3″ |
| Terrain | 11–14 | USGS 1/3″ (10 m) DEM COGs (`prd-tnm` S3) | same path, no fill |
| Terrain | < 11 | `elevation-tiles-prod` Terrarium pyramid | 2×2 stitch passthrough (no COGs) |

The design idea: every source — 1 m or 10 m DEM, COG mosaic or proxied
pyramid — is normalized server-side onto the same 512 px `z/x/y` grid and
encoding, so the client speaks exactly one tile contract and never knows
which source produced a tile (beyond the `X-DEM-Source` debug header). The
browser only ever talks to CloudFront: warm tiles are edge-cache hits
(path-only keys, immutable), and only misses invoke the Lambda. The client
requests no terrain below z14 (relief is subpixel there; those tiles render
as flat quads) and fetches DEM footprint overlays as two static GeoJSON
files from S3, not from the Lambda.

## Layout

| Directory | What | Plan ref |
|---|---|---|
| `tiler/` | Thin rio-tiler FastAPI service (Lambda container): imagery + terrain tiles | §4.1, §4.2, §10.4 |
| `client/` | TypeScript client: flat Mercator world, terrain meshes with skirts, engine spikes | §5, §6, §10.2 |
| `infra/` | SAM/CloudFormation: foundation → tiler → static assets | §3, §7 |

## Tile contracts (v0)

- `GET /imagery/{layer}/{year}/{z}/{x}/{y}.webp` — 512 px WebP q≈75, path-only
  cache keys, per-layer maxzoom from registry `gsd`.
- `GET /terrain/{z}/{x}/{y}.webp` — 512 px **Terrarium**-encoded Terrain-RGB,
  lossless WebP, vanilla registration (no overlap); the client builds skirts.
- `GET /basemap/{z}/{x}/{y}.webp` — low-zoom 512 px imagery stitched from the
  USDA NAIP ImageServer cache (the browser never hits ArcGIS directly).
- `GET /footprints/{s1m,usgs13}.json` — static gzipped GeoJSON of DEM COG
  footprints, served straight from S3 (no Lambda); rebuilt by
  `tiler/scripts/build_footprints.py` when the S1M index grows.

## Development

```sh
# tiler
cd tiler && pip install -e ".[dev]" && pytest
uvicorn tiler.app:app --reload   # local dev server

# inspect real tiles for any CONUS location (needs AWS creds):
# writes a self-contained swipe-comparison page (imagery vs S1M hillshade)
python scripts/preview.py 40.48 -74.66 15 --layer naip --year 2023

# client
cd client && npm install && npm test
npm run dev
```
