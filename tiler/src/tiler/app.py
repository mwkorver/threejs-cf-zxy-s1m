"""FastAPI app: the two tile endpoints (plan §4).

Deliberately tiny and rigid — path parameters only, no query strings, so
CloudFront cache keys stay path-only and every tile is immutable (plan §4.1).
"""

from functools import lru_cache

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse

from .imagery import render_imagery_tile
from .registry import LAYERS
from .resolver import MosaicResolver, S1MResolver
from .settings import settings
from .terrain import render_farfield_tile, render_terrain_tile

app = FastAPI(title="flight-sim tiler", version="0.0.1")

IMMUTABLE = "public, max-age=31536000, immutable"


@lru_cache(maxsize=1)
def get_resolver() -> MosaicResolver:
    """One resolver (one DuckDB connection) per Lambda container."""
    return MosaicResolver(settings.lake_path, settings.aws_region)


@lru_cache(maxsize=1)
def get_s1m_resolver() -> S1MResolver:
    """One S1M resolver (DuckDB + Albers transformer) per container."""
    return S1MResolver(settings.s1m_index_path, settings.aws_region)


@app.get("/imagery/{layer}/{year}/{z}/{x}/{y}.webp")
def imagery_tile(layer: str, year: int, z: int, x: int, y: int) -> Response:
    """512px WebP q~75 imagery tile (plan §4.1)."""
    lyr = LAYERS.get(layer)
    if lyr is None:
        raise HTTPException(404, f"unknown layer {layer!r}")
    if not 0 <= z <= lyr.maxzoom:
        # Beyond the source's resolution: 404 so the CDN never caches
        # upsampled junk; the client clamps (plan §4.1, §5.2).
        raise HTTPException(404, f"z {z} beyond layer maxzoom {lyr.maxzoom}")
    n = 2**z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(404, "tile out of range")

    assets = get_resolver().resolve(lyr.collection, year, z, x, y)
    body = render_imagery_tile(
        assets, lyr, z, x, y,
        tilesize=settings.tile_size,
        quality=settings.imagery_webp_quality,
    )
    if body is None:
        raise HTTPException(404, "no coverage")
    return Response(body, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@app.get("/terrain/{z}/{x}/{y}.webp")
def terrain_tile(z: int, x: int, y: int) -> Response:
    """512px Terrarium Terrain-RGB tile, lossless WebP (plan §4.2)."""
    n = 2**z
    if not (0 <= z and 0 <= x < n and 0 <= y < n):
        raise HTTPException(404, "tile out of range")

    if z >= settings.s1m_min_zoom:
        hrefs = get_s1m_resolver().resolve(z, x, y)
        body = render_terrain_tile(hrefs, z, x, y, tilesize=settings.tile_size)
    else:
        # Far-field: elevation-tiles-prod passthrough, one endpoint for the
        # whole planet (plan §4.2, §10.5).
        body = render_farfield_tile(z, x, y, tilesize=settings.tile_size)

    if body is None:
        raise HTTPException(404, "no terrain coverage")
    return Response(body, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@app.get("/terrain-footprints/{z}/{x}/{y}.json")
def terrain_footprints(z: int, x: int, y: int) -> JSONResponse:
    """S1M COG footprints intersecting tile z/x/y as GeoJSON. Immutable like the
    tiles — the S1M index is static, so CloudFront caches it path-only."""
    n = 2**z
    if not (0 <= z and 0 <= x < n and 0 <= y < n):
        raise HTTPException(404, "tile out of range")

    if z >= settings.s1m_min_zoom:
        fc = get_s1m_resolver().resolve_footprints(z, x, y)
    else:
        fc = {"type": "FeatureCollection", "features": []}
    return JSONResponse(fc, headers={"Cache-Control": IMMUTABLE})


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "region": settings.aws_region}
