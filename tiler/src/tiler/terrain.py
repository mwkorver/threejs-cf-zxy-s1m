"""Terrain tile rendering (plan §4.2, §10.5).

Two regimes behind one endpoint so the client speaks one terrain contract:

- z >= s1m_min_zoom (near field): read the S1M DEM (Albers EPSG:6350) via
  rio-tiler, warp to Web Mercator, encode Terrarium, lossless WebP. Vanilla
  512px registration, no overlap ring — seams are the client's job (skirts).
- z < s1m_min_zoom (far field): passthrough of elevation-tiles-prod, which is
  already 256px Terrarium. A 512px tile at z is exactly the four z+1 children
  at 256px, so this is a pure 2x2 pixel copy — same encoding by design, no
  elevation decode/re-encode, no conversion bugs at the boundary (plan §10.5).
"""

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rio_tiler.errors import TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.mosaic import mosaic_reader
from rio_tiler.utils import render

from .encoding import encode_terrarium

# elevation-tiles-prod is public and in us-east-1. Read it signed (Lambda role),
# like every other bucket. A signed request still needs the endpoint AND signing
# region pinned to us-east-1: the us-west-2 Lambda otherwise gets a virtual-
# hosted 301 that GDAL won't auto-recover (that recovery only fires for the
# path-style AuthorizationHeaderMalformed 400). No request-payer — public bucket.
FARFIELD_TEMPLATE = "s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
_FARFIELD_ENV = {"AWS_S3_ENDPOINT": "s3.us-east-1.amazonaws.com", "AWS_REGION": "us-east-1"}


def _s1m_tile(href: str, x: int, y: int, z: int, tilesize: int) -> "object":
    with Reader(href) as src:
        # Band 1 only; keep native float elevation (no rescale/expression).
        return src.tile(x, y, z, tilesize=tilesize, indexes=(1,))


def render_terrain_tile(
    s1m_hrefs: list[str], z: int, x: int, y: int, tilesize: int
) -> bytes | None:
    """Near-field S1M terrain tile as lossless-WebP Terrarium, or None."""
    if not s1m_hrefs:
        return None
    try:
        img, _used = mosaic_reader(
            s1m_hrefs, _s1m_tile, x, y, z,
            tilesize=tilesize,
            allowed_exceptions=(TileOutsideBounds,),
        )
    except Exception:
        return None

    # Masked (void) samples -> NaN so encode_terrarium writes them as 0 m
    # (plan §4.2 defers void-fill vs transparent; 0 m is the placeholder).
    elev = img.data[0].astype(np.float64)
    if img.mask is not None:
        elev = np.where(img.mask[0] == 0, np.nan, elev)

    rgb = encode_terrarium(elev)  # (H, W, 3) uint8
    # rio_tiler.render wants (bands, H, W); lossless WebP for exact elevations.
    return render(np.transpose(rgb, (2, 0, 1)), img_format="WEBP", lossless=True)


def render_farfield_tile(z: int, x: int, y: int, tilesize: int) -> bytes | None:
    """512px far-field tile = 2x2 of z+1 elevation-tiles-prod 256px Terrarium.

    Pure pixel copy (same encoding), re-emitted as lossless WebP. Any missing
    child (edge of coverage) is filled with sea-level Terrarium (128,0,0)."""
    src = tilesize // 2  # upstream tiles are 256px
    canvas = np.zeros((tilesize, tilesize, 3), dtype=np.uint8)
    canvas[..., 0] = 128  # sea-level default so gaps decode to 0 m
    got_any = False
    with rasterio.Env(**_FARFIELD_ENV):
        for dj, cy in enumerate((2 * y, 2 * y + 1)):
            for di, cx in enumerate((2 * x, 2 * x + 1)):
                url = FARFIELD_TEMPLATE.format(z=z + 1, x=cx, y=cy)
                try:
                    with rasterio.open(url) as ds:
                        arr = ds.read(indexes=[1, 2, 3])  # (3, 256, 256) RGB
                except RasterioIOError:
                    continue  # missing child (edge of coverage) -> sea-level fill
                got_any = True
                r0, c0 = dj * src, di * src
                canvas[r0:r0 + src, c0:c0 + src, :] = np.transpose(arr, (1, 2, 0))
    if not got_any:
        return None
    return render(np.transpose(canvas, (2, 0, 1)), img_format="WEBP", lossless=True)
