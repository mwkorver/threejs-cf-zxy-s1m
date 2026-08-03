"""Imagery rendering against a real GeoTIFF, with rio-tiler un-mocked.

The counterpart to test_unmocked_rio_tiler_terrain_rendering in test_terrain.py.
Everywhere else the imagery path is exercised, mosaic_reader is patched, which
pins how render_imagery_tile reacts to a mosaic result but never that a real
Reader.tile -> warp -> band-select -> WebP round trip produces the right pixels.

The fixture is 4-band RGBIR covering exactly tile 14/3342/6190, which lets these
pin two things the mocked tests structurally cannot: that the layer's
indexes=(1, 2, 3) really drops NIR, and that a tile off the footprint comes back
None rather than a black square.
"""

from pathlib import Path

import numpy as np

from helpers import decode_webp
from tiler import imagery
from tiler.registry import LAYERS
from tiler.resolver import CogAsset

# Written by fixtures/create_test_raster.py -- keep in step with RGBIR there.
FIXTURE = Path(__file__).parent / "fixtures" / "test_imagery.tif"
TILE_Z, TILE_X, TILE_Y = 14, 3342, 6190
RED, GREEN, BLUE, NIR = 200, 120, 60, 250

LAYER = LAYERS["naip-visualization"]


def _asset() -> CogAsset:
    # source_bucket deliberately not one of REQUESTER_PAYS_BUCKETS: a local file
    # read must not go anywhere near an AWS_REQUEST_PAYER env.
    return CogAsset(href=str(FIXTURE), source_bucket="local-fixture", gsd=0.3)


def test_unmocked_rio_tiler_imagery_rendering():
    assert FIXTURE.exists(), "test_imagery.tif fixture missing"

    body = imagery.render_imagery_tile(
        [_asset()], LAYER, TILE_Z, TILE_X, TILE_Y, tilesize=256, quality=75
    )
    assert body is not None, "Real rio-tiler read returned None"

    decoded = decode_webp(body)

    # Three bands out of a four-band source: indexes=(1, 2, 3) dropped NIR.
    # A 3-band fixture could not tell this apart from no selection at all.
    assert decoded.shape == (256, 256, 3)

    # WebP at quality 75 is lossy, hence the tolerance; the point is that each
    # channel landed on its own constant and the band ORDER survived the warp.
    # NIR (250) is far enough from blue (60) that a stray 4th band would fail.
    for band, expected in enumerate((RED, GREEN, BLUE)):
        assert np.abs(decoded[:, :, band].astype(int) - expected).mean() < 8, (
            f"band {band} decoded to ~{decoded[:, :, band].mean():.0f}, expected ~{expected}"
        )


def test_unmocked_tile_outside_fixture_returns_none():
    # Same zoom, far-away tile: rio-tiler raises TileOutsideBounds per asset,
    # which render_imagery_tile allows, leaving an empty mosaic -> None so the
    # endpoint 404s instead of caching a black tile for a year.
    body = imagery.render_imagery_tile(
        [_asset()], LAYER, TILE_Z, TILE_X + 200, TILE_Y + 200, tilesize=256, quality=75
    )
    assert body is None


def test_unmocked_no_assets_returns_none():
    assert imagery.render_imagery_tile([], LAYER, TILE_Z, TILE_X, TILE_Y, 256, 75) is None
