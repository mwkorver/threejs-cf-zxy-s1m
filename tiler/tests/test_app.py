"""Endpoint contract tests: resolver/renderer mocked, no S3."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from tiler import app as app_module
from tiler.resolver import CogAsset

client = TestClient(app_module.app)

NJ_TILE = "/imagery/naip/2021/15/9648/12312.webp"


@pytest.fixture(autouse=True)
def no_real_resolver():
    """get_resolver is lru_cached and opens DuckDB/S3 — never in unit tests."""
    app_module.get_resolver.cache_clear()
    yield
    app_module.get_resolver.cache_clear()


def test_unknown_layer_404():
    assert client.get("/imagery/nope/2021/10/0/0.webp").status_code == 404


def test_beyond_maxzoom_404_without_touching_lake():
    # NAIP maxzoom is 18 (30 cm, 512px basis); z19 must 404 before any
    # resolve — the CDN never caches upsampled junk (plan §4.1).
    with patch.object(app_module, "get_resolver") as resolver:
        assert client.get("/imagery/naip/2021/19/0/0.webp").status_code == 404
        resolver.assert_not_called()


def test_tile_out_of_range_404():
    assert client.get("/imagery/naip/2021/3/8/0.webp").status_code == 404  # x >= 2^3


def test_no_coverage_404():
    with patch.object(app_module, "get_resolver") as resolver:
        resolver.return_value.resolve.return_value = []
        assert client.get(NJ_TILE).status_code == 404


def test_happy_path_headers():
    asset = CogAsset("s3://naip-analytic/nj/x.tif", "naip-analytic", 0.6)
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
    # layer config flows through: NAIP drops the IR band
    assert render.call_args.args[1].indexes == (1, 2, 3)
