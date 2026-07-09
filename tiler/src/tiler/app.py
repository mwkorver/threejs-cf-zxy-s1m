"""FastAPI app: the two tile endpoints (plan §4).

Deliberately tiny and rigid — path parameters only, no query strings, so
CloudFront cache keys stay path-only and every tile is immutable (plan §4.1).
"""

from fastapi import FastAPI, HTTPException, Response

from .settings import settings

app = FastAPI(title="flight-sim tiler", version="0.0.1")

IMMUTABLE = "public, max-age=31536000, immutable"


@app.get("/imagery/{layer}/{year}/{z}/{x}/{y}.webp")
def imagery_tile(layer: str, year: int, z: int, x: int, y: int) -> Response:
    """512px WebP q~75 imagery tile (plan §4.1).

    TODO(Phase 0):
      1. Registry lookup: layer exists? z <= layer maxzoom (from gsd)? else 404
         — the CDN must never cache upsampled junk.
      2. MosaicResolver.resolve(layer, year, z, x, y) -> COG list (404 if empty).
      3. rio_tiler mosaic read (requester-pays env for NAIP), warp to 3857,
         encode WebP q=settings.imagery_webp_quality.
    """
    raise HTTPException(501, "imagery tiler not implemented — Phase 0 step 2")


@app.get("/terrain/{z}/{x}/{y}.webp")
def terrain_tile(z: int, x: int, y: int) -> Response:
    """512px Terrarium Terrain-RGB tile, lossless WebP (plan §4.2).

    TODO(Phase 0):
      - z >= settings.s1m_min_zoom: S1MResolver -> rio_tiler read -> warp ->
        encoding.encode_terrarium -> lossless WebP. Vanilla registration,
        no overlap ring — seams are the client's job (skirts).
      - z < s1m_min_zoom: far-field passthrough — mosaic four 256px
        elevation-tiles-prod Terrarium PNGs into one 512 (pure pixel copy,
        same encoding by design, plan §10.5) and recompress lossless WebP.
    """
    raise HTTPException(501, "terrain tiler not implemented — Phase 0 step 3")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "region": settings.aws_region}
