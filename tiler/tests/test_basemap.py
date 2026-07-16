"""Basemap rendering tests. Network calls are mocked; the 2x2 assembly
and failure routing are exercised for real.

Mirrors test_terrain.py: _fetch_child / render_basemap_tile are tested the
same way _s1m_tile / render_farfield_tile are — mock the I/O, exercise the
real assembly + encode path.
"""

from unittest.mock import MagicMock, patch

import httpx
import numpy as np
import pytest

from tiler import basemap
from tiler.basemap import BASEMAP_MAX_ZOOM, TransientBasemapError, render_basemap_tile


def _decode_webp(body: bytes) -> np.ndarray:
    """Decode a WebP tile to (H, W, 3) uint8 for pixel-level assertions."""
    from rasterio.io import MemoryFile

    with MemoryFile(body) as m, m.open() as ds:
        return np.transpose(ds.read(), (1, 2, 0))


def _solid_tile(rgb: tuple[int, int, int], size: int = 256) -> np.ndarray:
    """A solid-color (3, size, size) uint8 array — stands in for a fetched child."""
    arr = np.zeros((3, size, size), dtype=np.uint8)
    for i, c in enumerate(rgb):
        arr[i] = c
    return arr


def _make_png_bytes(rgb: tuple[int, int, int], size: int = 256) -> bytes:
    """Solid-color PNG as bytes, readable by rasterio MemoryFile.

    Uses the same rio_tiler.render the module itself uses, so the encode/decode
    round-trip is identical to production.
    """
    from rio_tiler.utils import render

    return render(_solid_tile(rgb, size), img_format="PNG")


# --- render_basemap_tile: 2x2 assembly ---------------------------------------


def test_happy_path_assembles_2x2_quadrants():
    """Four distinct-color children land in their correct quadrants."""
    colors = {
        (0, 0): (255, 0, 0),    # top-left = red
        (0, 1): (0, 255, 0),    # top-right = green
        (1, 0): (0, 0, 255),    # bottom-left = blue
        (1, 1): (255, 255, 0),  # bottom-right = yellow
    }

    def fake_fetch(z: int, x: int, y: int):
        # Parent (z=7, x=1, y=1) → children at z=8: (2,2),(3,2),(2,3),(3,3)
        di, dj = x - 2, y - 2
        return _solid_tile(colors[(dj, di)])

    with patch.object(basemap, "_fetch_child", side_effect=fake_fetch):
        body = render_basemap_tile(7, 1, 1, tilesize=512)

    assert body is not None
    img = _decode_webp(body)
    assert img.shape == (512, 512, 3)
    # Check quadrant interiors (skip 4px border where lossy WebP block artifacts
    # appear at color transitions). atol=5 covers quality-75 quantization.
    assert np.allclose(img[4:252, 4:252], [255, 0, 0], atol=5)        # top-left
    assert np.allclose(img[4:252, 260:508], [0, 255, 0], atol=5)     # top-right
    assert np.allclose(img[260:508, 4:252], [0, 0, 255], atol=5)     # bottom-left
    assert np.allclose(img[260:508, 260:508], [255, 255, 0], atol=5) # bottom-right


def test_all_404_returns_none():
    """All four children out of coverage → None (no tile to cache)."""
    with patch.object(basemap, "_fetch_child", return_value=None):
        assert render_basemap_tile(7, 1, 1, tilesize=512) is None


def test_partial_404_fills_white():
    """Missing children (404) leave white quadrants, matching CONUS PRIME nodata."""

    def fake_fetch(z: int, x: int, y: int):
        di, dj = x - 2, y - 2
        if (dj, di) == (0, 0):
            return _solid_tile((100, 150, 200))
        return None

    with patch.object(basemap, "_fetch_child", side_effect=fake_fetch):
        body = render_basemap_tile(7, 1, 1, tilesize=512)

    assert body is not None
    img = _decode_webp(body)
    assert np.allclose(img[4:252, 4:252], [100, 150, 200], atol=5)  # real data
    assert np.allclose(img[4:252, 260:508], 255, atol=5)             # white
    assert np.allclose(img[260:508, 4:252], 255, atol=5)             # white
    assert np.allclose(img[260:508, 260:508], 255, atol=5)           # white


def test_transient_failure_propagates():
    """A transient child failure raises TransientBasemapError (caller → 503)."""
    with patch.object(basemap, "_fetch_child", side_effect=TransientBasemapError("boom")):
        with pytest.raises(TransientBasemapError):
            render_basemap_tile(7, 1, 1, tilesize=512)


def test_maxzoom_is_16():
    """Children at z+1 must stay within the USDA cache (tops out at z17)."""
    assert BASEMAP_MAX_ZOOM == 16


# --- _fetch_child: HTTP routing ----------------------------------------------


def _mock_response(status_code: int, content: bytes = b"", content_type: str = ""):
    r = MagicMock()
    r.status_code = status_code
    r.content = content
    r.headers = {"content-type": content_type} if content_type else {}
    return r


def test_fetch_child_404_returns_none():
    """A 404 means genuinely out of coverage — not a transient failure."""
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(404)
        assert basemap._fetch_child(8, 2, 2) is None
    assert client.get.call_count == 1  # no retry on 404


def test_fetch_child_200_returns_array():
    """A 200 image response decodes to a (3, 256, 256) array."""
    png_bytes = _make_png_bytes((200, 100, 50))
    with patch.object(basemap, "_client") as client:
        client.get.return_value = _mock_response(200, png_bytes, "image/png")
        arr = basemap._fetch_child(8, 2, 2)
    assert arr is not None
    assert arr.shape == (3, 256, 256)
    assert arr.dtype == np.uint8
    assert np.allclose(arr[0], 200)
    assert np.allclose(arr[1], 100)
    assert np.allclose(arr[2], 50)


def test_fetch_child_transient_503_retries_then_raises():
    """A persistent 503 exhausts retries then raises TransientBasemapError."""
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.return_value = _mock_response(503)
        with pytest.raises(TransientBasemapError, match="HTTP 503"):
            basemap._fetch_child(8, 2, 2)
    assert client.get.call_count == basemap._ATTEMPTS


def test_fetch_child_network_error_retries_then_raises():
    """A network exception is retried, then raises TransientBasemapError."""
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.side_effect = httpx.ConnectTimeout("timeout")
        with pytest.raises(TransientBasemapError, match="ConnectTimeout"):
            basemap._fetch_child(8, 2, 2)
    assert client.get.call_count == basemap._ATTEMPTS


def test_fetch_child_non_image_200_retries_then_raises():
    """A 200 with non-image content-type is treated as transient (retry)."""
    with patch.object(basemap, "_client") as client, patch.object(basemap, "time"):
        client.get.return_value = _mock_response(200, b"<html>", "text/html")
        with pytest.raises(TransientBasemapError, match="HTTP 200"):
            basemap._fetch_child(8, 2, 2)
    assert client.get.call_count == basemap._ATTEMPTS
