"""Terrain rendering tests. S3 reads are mocked; the encoding round-trip and
tile assembly are exercised for real."""

from collections import Counter
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from tiler import terrain
from tiler.encoding import decode_terrarium


def _decode_webp(body: bytes) -> np.ndarray:
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


def test_s1m_tile_folds_pixel_nodata_into_mask():
    # COGs that store nodata as a pixel value (declared in metadata, absent
    # from the mask) must have those pixels masked per-asset BEFORE mosaicking:
    # the mosaic then prefers other assets there, and a custom attribute would
    # not survive mosaic_reader (it builds a new ImageData).
    from rio_tiler.models import ImageData

    data = np.full((1, 8, 8), 300.0, dtype=np.float32)
    data[0, :2, :2] = -9999.0  # pixel-value nodata, NOT masked
    img = ImageData(np.ma.MaskedArray(data, mask=np.zeros(data.shape, bool)))

    src = MagicMock()
    src.tile.return_value = img
    src.dataset.nodata = -9999.0
    src.__enter__.return_value = src
    src.__exit__.return_value = False

    with patch.object(terrain, "Reader", return_value=src), patch.object(terrain.rasterio, "Env"):
        out = terrain._s1m_tile("s3://prd-tnm/x.tif", 0, 0, 15, 8)

    assert out.array.mask[0, :2, :2].all()       # nodata pixels folded into mask
    assert not out.array.mask[0, 2:, 2:].any()   # valid pixels untouched


def test_s1m_voids_filled_from_usgs13():
    # S1M with a void corner; the usgs13 fill provides real elevation there so
    # the coverage edge blends instead of dropping to a 0 m cliff.
    s1m = np.full((512, 512), 400.0)
    s1m[:20, :20] = np.nan  # void patch (uncovered by S1M)
    usgs = np.full((512, 512), 250.0)  # seamless usgs13 fill

    seen = []

    def fake_mosaic(hrefs, z, x, y, tilesize):
        seen.append(hrefs)
        return (s1m.copy() if len(seen) == 1 else usgs.copy())

    with patch.object(terrain, "_mosaic_elev", side_effect=fake_mosaic):
        body = terrain.render_terrain_tile(
            ["s3://prd-tnm/s1m.tif"], 15, 0, 0, 512,
            fill_hrefs=lambda: ["s3://prd-tnm/usgs13.tif"],
        )

    out = decode_terrarium(_decode_webp(body))
    assert np.allclose(out[:20, :20], 250.0, atol=1 / 256)     # void filled from usgs13, not 0 m
    assert np.allclose(out[100:, 100:], 400.0, atol=1 / 256)   # S1M kept where it has data
    assert len(seen) == 2                                       # fill resolver invoked (voids present)


def test_s1m_no_voids_skips_fill_resolver():
    # A fully-covered S1M tile must not pay the usgs13 query/read.
    s1m = np.full((512, 512), 400.0)  # no NaN
    fill_called = []

    with patch.object(terrain, "_mosaic_elev", side_effect=lambda *a: s1m.copy()):
        terrain.render_terrain_tile(
            ["s3://prd-tnm/s1m.tif"], 15, 0, 0, 512,
            fill_hrefs=lambda: (fill_called.append(1), ["x"])[1],
        )

    assert fill_called == []  # lazy: no voids -> fill resolver never called


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


def test_farfield_mixed_missing_child_renders_sea_level_quadrant():
    # One child genuinely absent (GDAL's not-found message) + three present:
    # the absent quadrant fills sea level, the rest carry their data.
    from rasterio.errors import RasterioIOError
    from tiler.encoding import encode_terrarium

    def fake_open(url):
        parts = url.rstrip(".png").split("/")
        cx, cy = int(parts[-2]), int(parts[-1])
        if (cx, cy) == (2, 2):  # NW child of parent (1, 1)
            raise RasterioIOError(
                f"'{url}' does not exist in the file system, and is not "
                "recognized as a supported dataset name."
            )
        rgb = encode_terrarium(np.full((256, 256), 40.0))
        ds = MagicMock()
        ds.read.return_value = np.transpose(rgb, (2, 0, 1))
        ds.__enter__.return_value = ds
        ds.__exit__.return_value = False
        return ds

    with patch.object(terrain.rasterio, "open", side_effect=fake_open):
        body = terrain.render_farfield_tile(7, 1, 1, 512)

    out = decode_terrarium(_decode_webp(body))
    assert np.allclose(out[:256, :256], 0.0)                 # absent -> sea level
    assert np.allclose(out[256:, 256:], 40.0, atol=1 / 256)  # present children kept


def test_farfield_transient_child_fails_tile_after_retry():
    # A transient failure (network/5xx) must fail the WHOLE tile (-> 503
    # upstream) rather than bake a sea-level quadrant into an immutable tile —
    # and must be retried once before giving up.
    from rasterio.errors import RasterioIOError

    calls = []

    def fake_open(url):
        calls.append(url)
        raise RasterioIOError("CURL error: Connection timed out")

    with (
        patch.object(terrain.rasterio, "open", side_effect=fake_open),
        patch.object(terrain.time, "sleep"),  # keep the retry backoff instant
    ):
        with pytest.raises(terrain.TransientTerrainError):
            terrain.render_farfield_tile(7, 1, 1, 512)
    # The four children are read concurrently, so all four are in flight before
    # any failure is known — unlike the old sequential loop, which gave up after
    # the first child and left the other three untouched. Assert every child was
    # attempted AND each one retried, which pins the retry behaviour per child
    # rather than only for whichever child happened to run first.
    assert len(calls) == 4 * terrain._FARFIELD_ATTEMPTS
    assert set(Counter(calls).values()) == {terrain._FARFIELD_ATTEMPTS}
    assert len(set(calls)) == 4  # one distinct URL per quadrant


def test_mosaic_read_errors_propagate():
    # Real read failures (throttle, expired creds) must surface (-> 5xx), not
    # become "no coverage": a transient blip must never turn into a cacheable
    # 404 or a silent fall-through to a coarser DEM.
    from rasterio.errors import RasterioIOError

    with patch.object(terrain, "mosaic_reader", side_effect=RasterioIOError("503 Slow Down")):
        with pytest.raises(RasterioIOError):
            terrain.render_terrain_tile(["s3://prd-tnm/x.tif"], 15, 0, 0, 512)


def test_mosaic_empty_returns_none():
    # Footprint intersected but no pixels covered the tile: genuine
    # no-coverage -> None (caller falls through to the next DEM / 404s).
    from rio_tiler.errors import EmptyMosaicError

    with patch.object(terrain, "mosaic_reader", side_effect=EmptyMosaicError()):
        assert terrain.render_terrain_tile(["s3://prd-tnm/x.tif"], 15, 0, 0, 512) is None
