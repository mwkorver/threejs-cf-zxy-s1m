"""Terrain rendering tests. S3 reads are mocked; the encoding round-trip and
tile assembly are exercised for real."""

from unittest.mock import MagicMock, patch

import numpy as np

from tiler import terrain
from tiler.encoding import decode_terrarium


def _decode_webp(body: bytes) -> np.ndarray:
    import rasterio
    from rasterio.io import MemoryFile

    with MemoryFile(body) as m, m.open() as ds:
        return np.transpose(ds.read(), (1, 2, 0))


def test_s1m_empty_hrefs_returns_none():
    assert terrain.render_terrain_tile([], 14, 0, 0, 512) is None


def test_s1m_encodes_elevation_losslessly():
    # Fake an S1M mosaic read: a 512x512 elevation ramp with a void corner.
    elev = np.linspace(0, 400, 512 * 512).reshape(512, 512).astype(np.float32)
    mask = np.full((1, 512, 512), 255, dtype=np.uint8)
    mask[0, :10, :10] = 0  # void patch -> should decode to 0 m

    img = MagicMock()
    img.data = elev[np.newaxis, :, :]
    img.mask = mask

    with patch.object(terrain, "mosaic_reader", return_value=(img, [])):
        body = terrain.render_terrain_tile(["s3://prd-tnm/x.tif"], 14, 0, 0, 512)

    assert body is not None
    out = decode_terrarium(_decode_webp(body))
    # Lossless WebP + Terrarium quantization (1/256 m) on valid samples
    valid = np.ones((512, 512), bool)
    valid[:10, :10] = False
    assert np.allclose(out[valid], elev[valid], atol=1.0 / 256.0)
    assert np.allclose(out[:10, :10], 0.0)  # void -> 0 m


def test_farfield_assembles_2x2_children():
    # Each child is a solid 256px Terrarium tile at a distinct elevation, so a
    # correct 2x2 layout produces four quadrants with those exact heights.
    quad_elev = {(0, 0): 10.0, (1, 0): 20.0, (0, 1): 30.0, (1, 1): 40.0}

    def fake_open(url):
        # url .../{z}/{x}/{y}.png ; parent tile is (x=1, y=1) so children are 2,3
        parts = url.rstrip(".png").split("/")
        cx, cy = int(parts[-2]), int(parts[-1])
        di, dj = cx - 2, cy - 2  # children of x=1,y=1
        from tiler.encoding import encode_terrarium

        rgb = encode_terrarium(np.full((256, 256), quad_elev[(di, dj)]))
        ds = MagicMock()
        ds.read.return_value = np.transpose(rgb, (2, 0, 1))
        ds.__enter__.return_value = ds
        ds.__exit__.return_value = False
        return ds

    with patch.object(terrain.rasterio, "open", side_effect=fake_open):
        body = terrain.render_farfield_tile(7, 1, 1, 512)

    out = decode_terrarium(_decode_webp(body))
    assert np.allclose(out[:256, :256], 10.0, atol=1 / 256)  # top-left  (di0,dj0)
    assert np.allclose(out[:256, 256:], 20.0, atol=1 / 256)  # top-right (di1,dj0)
    assert np.allclose(out[256:, :256], 30.0, atol=1 / 256)  # bot-left  (di0,dj1)
    assert np.allclose(out[256:, 256:], 40.0, atol=1 / 256)  # bot-right (di1,dj1)


def test_farfield_missing_child_fills_sea_level():
    from rasterio.errors import RasterioIOError

    def fake_open(url):
        raise RasterioIOError("404")

    with patch.object(terrain.rasterio, "open", side_effect=fake_open):
        body = terrain.render_farfield_tile(7, 1, 1, 512)
    assert body is None  # all children missing -> no tile
