"""Basemap rendering tests. Network calls are mocked; the bbox maths, coverage
routing and failure handling are exercised for real.

Mirrors test_terrain.py: _fetch_tile / render_basemap_tile are tested the same
way _s1m_tile / render_farfield_tile are — mock the I/O, exercise the real
decode + composite + encode path.
"""

from unittest.mock import MagicMock, patch

import httpx
import numpy as np
import pytest
from helpers import decode_webp

from tiler import basemap
from tiler.basemap import (
    BASEMAP_MAX_ZOOM,
    TransientBasemapError,
    render_basemap_tile,
    tile_bbox_3857,
)


def _rgba_png(rgb: tuple[int, int, int], alpha: int, size: int = 512) -> bytes:
    """Solid RGBA PNG, as exportImage returns with format=png32.

    Uses the same rio_tiler.render the module decodes with, so the round-trip
    matches production.
    """
    from rio_tiler.utils import render

    arr = np.zeros((4, size, size), dtype=np.uint8)
    for i, c in enumerate(rgb):
        arr[i] = c
    arr[3] = alpha
    return render(arr, img_format="PNG")


# --- tile_bbox_3857 -----------------------------------------------------------


def test_bbox_of_the_whole_world_at_z0():
    minx, miny, maxx, maxy = tile_bbox_3857(0, 0, 0)
    assert minx == pytest.approx(-basemap._R)
    assert maxx == pytest.approx(basemap._R)
    assert miny == pytest.approx(-basemap._R)
    assert maxy == pytest.approx(basemap._R)


def test_bbox_quadrants_at_z1():
    """y counts down from the north, the XYZ convention -- not up."""
    _, _, _, top_maxy = tile_bbox_3857(1, 0, 0)
    _, bottom_miny, _, _ = tile_bbox_3857(1, 0, 1)
    assert top_maxy == pytest.approx(basemap._R)
    assert bottom_miny == pytest.approx(-basemap._R)
    # Tiles tile: the top row's floor is the bottom row's ceiling.
    assert tile_bbox_3857(1, 0, 0)[1] == pytest.approx(tile_bbox_3857(1, 0, 1)[3])


def test_bbox_is_square_and_shrinks_by_half_each_zoom():
    for z in range(0, 6):
        minx, miny, maxx, maxy = tile_bbox_3857(z, 0, 0)
        assert (maxx - minx) == pytest.approx(maxy - miny)
    assert (tile_bbox_3857(3, 0, 0)[2] - tile_bbox_3857(3, 0, 0)[0]) == pytest.approx(
        (tile_bbox_3857(2, 0, 0)[2] - tile_bbox_3857(2, 0, 0)[0]) / 2
    )


# --- render_basemap_tile ------------------------------------------------------


def test_happy_path_encodes_the_rendered_image():
    with patch.object(basemap, "_fetch_tile", return_value=np.full((3, 512, 512), 120, dtype=np.uint8)):
        body = render_basemap_tile(7, 1, 1, tilesize=512)

    assert body is not None
    img = decode_webp(body)
    assert img.shape == (512, 512, 3)
    assert np.allclose(img, 120, atol=5)  # atol covers quality-75 quantization


def test_no_coverage_returns_none():
    """Nothing to draw → None, so the endpoint 404s instead of caching a blank."""
    with patch.object(basemap, "_fetch_tile", return_value=None):
        assert render_basemap_tile(7, 1, 1, tilesize=512) is None


def test_transient_failure_propagates():
    """A transient fetch failure raises TransientBasemapError (caller → 503)."""
    with patch.object(basemap, "_fetch_tile", side_effect=TransientBasemapError("boom")):
        with pytest.raises(TransientBasemapError):
            render_basemap_tile(7, 1, 1, tilesize=512)


def test_maxzoom_is_16():
    """This endpoint's own guard; past it the COG mosaic is the right source."""
    assert BASEMAP_MAX_ZOOM == 16


# --- _fetch_tile: HTTP + coverage routing -------------------------------------


def _mock_response(status_code: int, content: bytes = b"", content_type: str = ""):
    r = MagicMock()
    r.status_code = status_code
    r.content = content
    r.headers = {"content-type": content_type} if content_type else {}
    return r


def test_fetch_opaque_image_returns_rgb():
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(200, _rgba_png((200, 100, 50), 255), "image/png")
        arr = basemap._fetch_tile(8, 2, 2, 512)
    assert arr is not None
    assert arr.shape == (3, 512, 512)
    assert arr.dtype == np.uint8
    assert np.allclose(arr[0], 200)
    assert np.allclose(arr[1], 100)
    assert np.allclose(arr[2], 50)


def test_fetch_fully_transparent_is_no_coverage():
    """exportImage answers 200 with empty alpha where the cache used to 404."""
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(200, _rgba_png((0, 0, 0), 0), "image/png")
        assert basemap._fetch_tile(8, 2, 2, 512) is None
    assert client.get.call_count == 1  # absence is not a transient failure


def test_fetch_composites_partial_coverage_onto_white():
    """Half-transparent red over white lands halfway to white, not on black."""
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(200, _rgba_png((255, 0, 0), 128), "image/png")
        arr = basemap._fetch_tile(8, 2, 2, 512)
    assert arr is not None
    assert np.allclose(arr[0], 255, atol=1)  # red stays saturated
    assert np.allclose(arr[1], 127, atol=2)  # green lifted toward white
    assert np.allclose(arr[2], 127, atol=2)


def test_fetch_requests_the_tile_bbox_in_web_mercator():
    """The query has to describe the tile, or the render is of somewhere else."""
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(200, _rgba_png((10, 10, 10), 255), "image/png")
        basemap._fetch_tile(7, 1, 1, 512)

    params = client.get.call_args.kwargs["params"]
    assert params["bbox"] == ",".join(str(v) for v in tile_bbox_3857(7, 1, 1))
    assert params["bboxSR"] == "3857"
    assert params["imageSR"] == "3857"
    assert params["size"] == "512,512"
    # png32, not png: ArcGIS drops the alpha band on a fully opaque render, and
    # then coverage cannot be read at all.
    assert params["format"] == "png32"


def test_fetch_transient_503_retries_then_raises():
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.return_value = _mock_response(503)
        with pytest.raises(TransientBasemapError, match="HTTP 503"):
            basemap._fetch_tile(8, 2, 2, 512)
    assert client.get.call_count == basemap._ATTEMPTS


def test_fetch_network_error_retries_then_raises():
    """The shape the USDA outage took: the connection never completes."""
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.side_effect = httpx.ConnectError("SSL: UNEXPECTED_EOF_WHILE_READING")
        with pytest.raises(TransientBasemapError, match="ConnectError"):
            basemap._fetch_tile(8, 2, 2, 512)
    assert client.get.call_count == basemap._ATTEMPTS


def test_fetch_non_image_200_retries_then_raises():
    """ArcGIS reports errors as a 200 carrying JSON, so status alone is not enough."""
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.return_value = _mock_response(200, b'{"error":{"code":400}}', "application/json")
        with pytest.raises(TransientBasemapError, match="HTTP 200"):
            basemap._fetch_tile(8, 2, 2, 512)
    assert client.get.call_count == basemap._ATTEMPTS
