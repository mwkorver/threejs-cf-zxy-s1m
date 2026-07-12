"""Endpoint contract tests: resolver/renderer mocked, no S3."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from tiler import app as app_module
from tiler.resolver import CogAsset

client = TestClient(app_module.app)

NJ_TILE = "/imagery/naip-visualization/2021/15/9648/12312.webp"


@pytest.fixture(autouse=True)
def no_real_resolver():
    """Resolvers are lru_cached and open DuckDB/S3 — never in unit tests."""
    app_module.get_resolver.cache_clear()
    app_module.get_s1m_resolver.cache_clear()
    yield
    app_module.get_resolver.cache_clear()
    app_module.get_s1m_resolver.cache_clear()


def test_unknown_layer_404():
    assert client.get("/imagery/nope/2021/10/0/0.webp").status_code == 404


def test_beyond_maxzoom_404_without_touching_lake():
    # NAIP maxzoom is 18 (30 cm, 512px basis); z19 must 404 before any
    # resolve — the CDN never caches upsampled junk (plan §4.1).
    with patch.object(app_module, "get_resolver") as resolver:
        assert client.get("/imagery/naip-visualization/2021/19/0/0.webp").status_code == 404
        resolver.assert_not_called()


def test_tile_out_of_range_404():
    assert client.get("/imagery/naip-visualization/2021/3/8/0.webp").status_code == 404  # x >= 2^3


def test_no_coverage_404():
    with patch.object(app_module, "get_resolver") as resolver:
        resolver.return_value.resolve.return_value = []
        assert client.get(NJ_TILE).status_code == 404


def test_happy_path_headers():
    asset = CogAsset("s3://naip-visualization/nj/x.tif", "naip-visualization", 0.6)
    with (
        patch.object(app_module, "get_resolver") as resolver,
        patch.object(app_module, "render_imagery_tile", return_value=b"RIFFwebp") as render,
    ):
        resolver.return_value.resolve.return_value = [asset]
        r = client.get(NJ_TILE)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert r.content == b"RIFFwebp"
    # layer config flows through: RGB visualization COGs, indexes select the 3 bands
    assert render.call_args.args[1].indexes == (1, 2, 3)


# --- terrain endpoint (plan §4.2) ---

def test_terrain_nearfield_uses_s1m():
    # z >= s1m_min_zoom routes to the S1M resolver + renderer, not far-field.
    with (
        patch.object(app_module, "get_s1m_resolver") as s1m,
        patch.object(app_module, "render_terrain_tile", return_value=b"WEBP") as render,
        patch.object(app_module, "render_farfield_tile") as farfield,
    ):
        s1m.return_value.resolve.return_value = ["s3://prd-tnm/x.tif"]
        r = client.get("/terrain/14/4804/6172.webp")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    render.assert_called_once()
    farfield.assert_not_called()


def test_terrain_farfield_below_threshold():
    # z < s1m_min_zoom (default 11) is far-field passthrough, never S1M.
    with (
        patch.object(app_module, "get_s1m_resolver") as s1m,
        patch.object(app_module, "render_farfield_tile", return_value=b"WEBP") as farfield,
    ):
        r = client.get("/terrain/8/75/96.webp")
    assert r.status_code == 200
    farfield.assert_called_once()
    s1m.assert_not_called()


def test_terrain_no_coverage_404():
    with (
        patch.object(app_module, "get_s1m_resolver") as s1m,
        patch.object(app_module, "get_usgs13_resolver") as usgs13,
        patch.object(app_module, "render_terrain_tile", return_value=None),
        patch.object(app_module, "render_farfield_tile", return_value=None),
    ):
        s1m.return_value.resolve.return_value = []
        usgs13.return_value.resolve.return_value = []
        assert client.get("/terrain/14/4804/6172.webp").status_code == 404


def test_terrain_out_of_range_404():
    assert client.get("/terrain/3/8/0.webp").status_code == 404


# --- footprints endpoint ---

def test_footprints_nearfield():
    with patch.object(app_module, "get_s1m_resolver") as s1m, patch.object(app_module, "get_usgs13_resolver") as usgs13:
        mock_geojson = {"type": "FeatureCollection", "features": []}
        s1m.return_value.resolve_footprints.return_value = mock_geojson
        usgs13.return_value.resolve_footprints.return_value = mock_geojson
        r = client.get("/terrain-footprints/14/4804/6172.json")
    assert r.status_code == 200
    assert r.json() == mock_geojson
    s1m.return_value.resolve_footprints.assert_called_once_with(14, 4804, 6172, dataset_type="s1m")
    usgs13.return_value.resolve_footprints.assert_called_once_with(14, 4804, 6172, dataset_type="usgs13")


def test_footprints_farfield():
    # z < min_zoom (11) returns empty FeatureCollection immediately without querying S1M
    with patch.object(app_module, "get_s1m_resolver") as s1m, patch.object(app_module, "get_usgs13_resolver") as usgs13:
        r = client.get("/terrain-footprints/8/75/96.json")
    assert r.status_code == 200
    assert r.json() == {"type": "FeatureCollection", "features": []}
    s1m.assert_not_called()
    usgs13.assert_not_called()


def test_footprints_out_of_range_404():
    assert client.get("/terrain-footprints/3/8/0.json").status_code == 404


def test_footprints_viewport():
    with patch.object(app_module, "get_s1m_resolver") as s1m, patch.object(app_module, "get_usgs13_resolver") as usgs13:
        mock_geojson = {"type": "FeatureCollection", "features": []}
        s1m.return_value.resolve_viewport_footprints.return_value = mock_geojson
        usgs13.return_value.resolve_viewport_footprints.return_value = mock_geojson
        r = client.get("/terrain-footprints/viewport?west=-74.5&south=40.0&east=-74.0&north=41.0")
    assert r.status_code == 200
    assert r.json() == mock_geojson
    s1m.return_value.resolve_viewport_footprints.assert_called_once_with(-74.5, 40.0, -74.0, 41.0, dataset_type="s1m")
    usgs13.return_value.resolve_viewport_footprints.assert_called_once_with(-74.5, 40.0, -74.0, 41.0, dataset_type="usgs13")

