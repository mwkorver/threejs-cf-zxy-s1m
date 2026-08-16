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


# --- BuildingResolver SQL: prune on statistics, then refine ------------------


def _capture_resolve(z: int, x: int, y: int) -> list[tuple[str, list]]:
    """Run resolve() against a recording connection, returning (sql, params)."""
    from tiler.buildings import BuildingResolver

    calls: list[tuple[str, list]] = []

    class Recorder:
        def execute(self, sql, params=None):
            calls.append((sql, params))
            outer = self

            class Result:
                def fetchall(self):
                    # First query: one intersecting partition file.
                    return [("s3://bucket/part-0.parquet",)]

                def fetchone(self):
                    # Second query: an empty MVT, so resolve() returns None.
                    return (b"",)

            del outer
            return Result()

    # __new__ so no DuckDB connection or S3 credentials are needed.
    r = BuildingResolver.__new__(BuildingResolver)
    r.index_path = "s3://bucket/index.parquet"
    r._con = Recorder()
    r.resolve(z, x, y)
    return calls


def test_geometry_query_prunes_on_bbox_before_refining():
    """The bbox comparisons are what make this cheap.

    ST_Intersects is a spatial function over the geometry column, which no
    Parquet statistic describes, so on its own it scans the whole partition --
    and partitions are far larger than a tile, so even an empty tile paid for a
    full read. Comparing the bbox STRUCT fields against constants is something
    DuckDB can answer from row-group statistics instead.
    """
    import morecantile

    calls = _capture_resolve(14, 4818, 6159)
    assert len(calls) == 2, "expected an index query then a geometry query"
    sql, params = calls[1]

    # Cheap prune the statistics can answer...
    assert "bbox.xmin <= ? AND bbox.xmax >= ?" in sql
    assert "bbox.ymin <= ? AND bbox.ymax >= ?" in sql
    # ...then the exact test, which still decides the result.
    assert "ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))" in sql

    # Nothing variable spliced into the SQL: one prepared statement per tile.
    assert "s3://bucket" not in sql

    # Placeholder order, which is the part that breaks silently. The prune
    # compares each bbox edge against the OPPOSITE tile edge -- xmin vs right,
    # xmax vs left -- so swapping a pair still runs and quietly returns wrong
    # buildings rather than failing.
    tms = morecantile.tms.get("WebMercatorQuad")
    b = tms.bounds(morecantile.Tile(4818, 6159, 14))
    assert params == [
        b.left, b.bottom, b.right, b.top,          # ST_AsMVTGeom envelope
        ["s3://bucket/part-0.parquet"],            # read_parquet file list
        b.right, b.left, b.top, b.bottom,          # bbox prune (opposite edges)
        b.left, b.bottom, b.right, b.top,          # ST_Intersects envelope
    ]


def test_prune_bounds_bracket_the_tile():
    """A building overlapping the tile can never be pruned away.

    The prune must be a conservative superset of ST_Intersects: any geometry
    touching the envelope has a bbox overlapping it, so this can only ever
    remove rows the exact test would have removed anyway.
    """
    import morecantile

    _, params = _capture_resolve(14, 4818, 6159)[1]
    tms = morecantile.tms.get("WebMercatorQuad")
    b = tms.bounds(morecantile.Tile(4818, 6159, 14))

    xmin_vs, xmax_vs, ymin_vs, ymax_vs = params[5:9]
    assert xmin_vs == b.right and xmax_vs == b.left
    assert ymin_vs == b.top and ymax_vs == b.bottom
