"""Building vector tile endpoint tests."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from tiler.app import app

client = TestClient(app)


def test_buildings_below_min_zoom_returns_404():
    response = client.get("/buildings/13/0/0.pbf")
    assert response.status_code == 404
    assert "below building minzoom" in response.text


def test_buildings_tile_out_of_range_returns_404():
    response = client.get("/buildings/15/999999/999999.pbf")
    assert response.status_code == 404


def test_buildings_no_coverage_returns_404():
    with patch("tiler.app.get_building_resolver") as mock_get_resolver:
        mock_resolver = mock_get_resolver.return_value
        mock_resolver.resolve.return_value = None

        response = client.get("/buildings/15/9633/12332.pbf")
        assert response.status_code == 404
        assert response.text == '{"detail":"no building coverage"}'


def test_buildings_success_returns_protobuf():
    fake_pbf = b"\x08\x01\x12\x05test"
    with patch("tiler.app.get_building_resolver") as mock_get_resolver:
        mock_resolver = mock_get_resolver.return_value
        mock_resolver.resolve.return_value = fake_pbf

        response = client.get("/buildings/15/9633/12332.pbf")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/x-protobuf"
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert response.content == fake_pbf
