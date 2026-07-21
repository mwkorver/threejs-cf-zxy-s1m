"""FastAPI app: the two tile endpoints (plan §4).

Deliberately tiny and rigid — path parameters only, no query strings, so
CloudFront cache keys stay path-only and every tile is immutable (plan §4.1).
"""

from functools import lru_cache

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware

from .basemap import BASEMAP_MAX_ZOOM, TransientBasemapError, render_basemap_tile
from .imagery import render_imagery_tile
from .registry import LAYERS
from .resolver import MosaicResolver, S1MResolver
from .settings import settings
from .terrain import TransientTerrainError, render_farfield_tile, render_terrain_tile

app = FastAPI(title="flight-sim tiler", version="0.0.1")

# CORS for local dev only: browsers reach the deployed tiler through CloudFront
# (which adds CORS via its ResponseHeadersPolicy and never exposes the Function
# URL directly), but a `?src=tiler-local` client on :5180 hits uvicorn straight,
# and without Access-Control-Allow-Origin the browser blocks every tile read.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    expose_headers=["X-DEM-Source"],
)

IMMUTABLE = "public, max-age=31536000, immutable"


@lru_cache(maxsize=1)
def get_resolver() -> MosaicResolver:
    """One resolver (one DuckDB connection) per Lambda container."""
    return MosaicResolver(settings.lake_path, settings.aws_region)


@lru_cache(maxsize=1)
def get_s1m_resolver() -> S1MResolver:
    """One S1M resolver (DuckDB + Albers transformer) per container."""
    return S1MResolver(settings.s1m_index_path, settings.aws_region)


@lru_cache(maxsize=1)
def get_usgs13_resolver() -> S1MResolver:
    """One USGS 1/3 Arc-Second resolver (using local data/USGS_13_DEM_Index.parquet) per container."""
    import os
    current_dir = os.path.dirname(os.path.abspath(__file__))
    local_path = os.path.join(current_dir, "data", "USGS_13_DEM_Index.parquet")
    return S1MResolver(local_path, settings.aws_region)


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


@app.get("/basemap/{z}/{x}/{y}.webp")
def basemap_tile(z: int, x: int, y: int) -> Response:
    """512px WebP low-zoom basemap = 2x2 stitch of USDA NAIP cache children.

    Path-only so CloudFront caches it; the browser never hits ArcGIS directly.
    """
    if not 0 <= z <= BASEMAP_MAX_ZOOM:
        raise HTTPException(404, f"z {z} beyond basemap maxzoom {BASEMAP_MAX_ZOOM}")
    n = 2**z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(404, "tile out of range")

    try:
        body = render_basemap_tile(z, x, y, tilesize=settings.tile_size)
    except TransientBasemapError:
        # Upstream fetch failed transiently — 503 so the client retries and this
        # immutable tile isn't cached with a hole. (CloudFront error-caches 5xx
        # ~10s by default; the client's fetchTile backs off and retries 503.)
        raise HTTPException(503, "basemap upstream unavailable, retry", headers={"Retry-After": "2"})
    if body is None:
        raise HTTPException(404, "no coverage")
    return Response(body, media_type="image/webp", headers={"Cache-Control": IMMUTABLE})


@app.get("/terrain/{z}/{x}/{y}.webp")
def terrain_tile(
    z: int,
    x: int,
    y: int,
    usgs_min_zoom: int = None,
    s1m_min_zoom: int = None
) -> Response:
    """512px Terrarium Terrain-RGB tile, lossless WebP (plan §4.2)."""
    if not 0 <= z <= settings.terrain_max_zoom:
        # Beyond native DEM resolution: 404 so the CDN never caches upsampled
        # junk over an unbounded key space (mirrors the imagery maxzoom).
        raise HTTPException(404, f"z {z} beyond terrain maxzoom {settings.terrain_max_zoom}")
    n = 2**z
    if not (0 <= x < n and 0 <= y < n):
        raise HTTPException(404, "tile out of range")

    resolved_usgs_min_zoom = usgs_min_zoom if usgs_min_zoom is not None else settings.usgs_min_zoom
    resolved_s1m_min_zoom = s1m_min_zoom if s1m_min_zoom is not None else settings.s1m_min_zoom

    body = None
    dem_source = "farfield"
    
    # 1. Try high-resolution S1M terrain first if zoom is high enough. S1M
    #    coverage isn't seamless, so fill any void pixels at its edge with the
    #    usgs13 DEM (real 10m elevation) instead of a 0m cliff. The fill resolver
    #    is lazy -- only tiles that actually have voids pay the extra query/read.
    if z >= resolved_s1m_min_zoom:
        s1m_hrefs = get_s1m_resolver().resolve(z, x, y)
        if s1m_hrefs:
            fill = (
                (lambda: get_usgs13_resolver().resolve(z, x, y))
                if z >= resolved_usgs_min_zoom
                else None
            )
            body = render_terrain_tile(s1m_hrefs, z, x, y, tilesize=settings.tile_size, fill_hrefs=fill)
            if body is not None:
                dem_source = "s1m"

    # 2. If no S1M tile is available, check 10m USGS 1/3 arc-second DEM fallback index if zoom is high enough
    if body is None and z >= resolved_usgs_min_zoom:
        usgs13_hrefs = get_usgs13_resolver().resolve(z, x, y)
        if usgs13_hrefs:
            body = render_terrain_tile(usgs13_hrefs, z, x, y, tilesize=settings.tile_size)
            if body is not None:
                dem_source = "usgs13"

    # 3. Fall back to far-field planet-wide tiles if still no coverage
    if body is None:
        try:
            body = render_farfield_tile(z, x, y, tilesize=settings.tile_size)
        except TransientTerrainError:
            # A child fetch failed transiently — 503 so the client retries and
            # this immutable tile isn't cached with a sea-level hole (same
            # contract as the basemap endpoint).
            raise HTTPException(503, "terrain upstream unavailable, retry", headers={"Retry-After": "2"})
        dem_source = "farfield"

    if body is None:
        raise HTTPException(404, "no terrain coverage")
    return Response(
        body,
        media_type="image/webp",
        headers={
            "Cache-Control": IMMUTABLE,
            "X-DEM-Source": dem_source,
            "Access-Control-Expose-Headers": "X-DEM-Source"
        }
    )


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "region": settings.aws_region}
