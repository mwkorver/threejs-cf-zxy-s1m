"""Imagery tile rendering: COG list -> mosaic read -> warp -> WebP (plan §4.1).

rio-tiler does the real work (this is why "thin rio-tiler", plan §10.4):
Reader.tile() reads only the overview level and blocks the tile needs and
warps to Web Mercator; mosaic_reader lays assets down first-hit-first until
the tile is fully covered. The resolver sorts finest-gsd first, so the
sharpest source wins where footprints overlap.
"""

import os

from rio_tiler.errors import EmptyMosaicError, TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.models import ImageData
from rio_tiler.mosaic import mosaic_reader

from .registry import Layer
from .resolver import CogAsset


def _tile_from_asset(
    asset: CogAsset, x: int, y: int, z: int, tilesize: int, indexes: tuple[int, ...] | None
) -> ImageData:
    with Reader(asset.href) as src:
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

    if any(a.requester_pays for a in assets):
        # Process-level, not rasterio.Env: mosaic_reader reads assets in its
        # own thread pool and GDAL config from rasterio.Env is thread-local.
        # Harmless on public buckets; the Dockerfile sets it for Lambda too.
        os.environ.setdefault("AWS_REQUEST_PAYER", "requester")

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
        )
    except EmptyMosaicError:
        return None

    if layer.rescale is not None:
        img.rescale(in_range=(layer.rescale,) * img.count)

    return img.render(img_format="WEBP", quality=quality)
