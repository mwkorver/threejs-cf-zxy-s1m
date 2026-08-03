"""Imagery tile rendering: COG list -> mosaic read -> warp -> WebP.

rio-tiler does the real work (this is why "thin rio-tiler"):
Reader.tile() reads only the overview level and blocks the tile needs and
warps to Web Mercator; mosaic_reader lays assets down first-hit-first until
the tile is fully covered. The resolver sorts finest-gsd first, so the
sharpest source wins where footprints overlap.
"""

from contextlib import nullcontext

import rasterio
from rio_tiler.errors import EmptyMosaicError, TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.models import ImageData
from rio_tiler.mosaic import mosaic_reader

from .registry import Layer
from .resolver import CogAsset


def _tile_from_asset(
    asset: CogAsset, x: int, y: int, z: int, tilesize: int, indexes: tuple[int, ...] | None
) -> ImageData:
    # All reads are signed (Lambda role). Requester-pays is scoped to the assets
    # whose bucket requires it, set here in the worker thread mosaic_reader runs
    # this in — GDAL config from rasterio.Env is thread-local, so a main-thread
    # Env wouldn't reach these pool threads.
    env = rasterio.Env(AWS_REQUEST_PAYER="requester") if asset.requester_pays else nullcontext()
    with env, Reader(asset.href) as src:
        return src.tile(x, y, z, tilesize=tilesize, indexes=indexes)


def render_imagery_tile(
    assets: list[CogAsset],
    layer: Layer,
    z: int,
    x: int,
    y: int,
    tilesize: int,
    quality: int,
) -> bytes | None:
    """Returns WebP bytes, or None when no asset actually covers the tile
    (footprint intersected but pixels didn't — caller 404s)."""
    if not assets:
        return None

    try:
        img, _assets_used = mosaic_reader(
            assets,
            _tile_from_asset,
            x,
            y,
            z,
            tilesize=tilesize,
            indexes=layer.indexes,
            allowed_exceptions=(TileOutsideBounds,),
            threads=min(len(assets), 4),
        )
    except EmptyMosaicError:
        return None

    if layer.rescale is not None:
        img.rescale(in_range=(layer.rescale,) * img.count)

    return img.render(img_format="WEBP", quality=quality)
