# deckgl-cf-xyz-s1m

CONUS flight-simulator-style streaming viewer: NAIP (and state COG) imagery,
USGS 3DEP S1M terrain, and Overture buildings, normalized server-side onto a
single EPSG:3857 `z/x/y` quadtree and served through CloudFront.

**Read [FLIGHT-SIM-PLAN.md](FLIGHT-SIM-PLAN.md) first** — it holds the
architecture, the locked decisions, and the phased plan. This repo is the
Phase 0 build: fly a camera over one corridor (New Jersey, NAIP) with server
tiles end-to-end.

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
