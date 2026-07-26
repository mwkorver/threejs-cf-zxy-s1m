import os
import re
from unittest.mock import patch

from tiler.resolver import (
    REQUESTER_PAYS_BUCKETS,
    DEM_INDEX_EPSG,
    CogAsset,
    MosaicResolver,
    build_tile_query,
    lake_read_paths,
)

USGS_INDEX = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "src", "tiler", "data", "USGS_13_DEM_Index.parquet"
)


def test_read_path_narrows_to_partition_subtree():
    # Path scoping shrinks the S3 LIST (ported from _lake_read_path)
    p = lake_read_paths("s3://bucket/lake/", "naip-visualization", ["nj"])
    assert p == ["s3://bucket/lake/collection=naip-visualization/region=nj/year=*/*.parquet"]


def test_query_has_prune_and_refine():
    sql = build_tile_query(["s3://b/lake/collection=naip/region=nj/year=*/*.parquet"],
                           west=-74.5, south=40.4, east=-74.4, north=40.5, requested_year=2021)
    # cheap bbox-column prune against row-group stats...
    assert "bbox_xmin <= -74.4" in sql and "bbox_xmax >= -74.5" in sql
    assert "bbox_ymin <= 40.5" in sql and "bbox_ymax >= 40.4" in sql
    # ...then exact footprint refine
    assert "ST_Intersects(geometry, ST_MakeEnvelope(-74.5, 40.4, -74.4, 40.5))" in sql
    # latest year first, then finest source
    assert "order by year desc, gsd asc" in sql
    # year filter and group-by-region cross-year fallback subquery
    assert "year <= 2021" in sql
    assert "group by region" in sql
    assert "hive_partitioning=true" in sql


# --- region pruning comes from the index, not a hardcoded table ---
#
# Pruning narrows the S3 LIST before the real query. The bounds driving it are
# read from the lake's own bbox columns (min/max per region, answered from
# Parquet row-group stats) and cached per container, so they can't go stale as
# coverage grows and can't be wrong at a region's edge.

def _resolver_with_extents(extents_rows):
    """MosaicResolver whose DuckDB connection returns canned rows."""
    with patch("tiler.resolver.duck.connect") as connect:
        r = MosaicResolver("s3://bucket/lake", "us-west-2")
    r._con = type("Con", (), {"execute": lambda self, sql: type("R", (), {"fetchall": lambda s: extents_rows})()})()
    assert connect.called
    return r


NJ_AND_CA = [
    ("nj", -75.6, 38.9, -73.9, 41.4),
    ("ca", -124.4, 32.5, -114.1, 42.0),
]


def test_region_extents_read_from_index_and_cached():
    r = _resolver_with_extents(NJ_AND_CA)
    calls = []
    real_execute = r._con.execute
    r._con.execute = lambda sql: (calls.append(sql), real_execute(sql))[1]

    first = r.region_extents("naip-visualization")
    second = r.region_extents("naip-visualization")

    assert first == {"nj": (-75.6, 38.9, -73.9, 41.4), "ca": (-124.4, 32.5, -114.1, 42.0)}
    assert second is first          # cached for the life of the container
    assert len(calls) == 1          # warm invocations pay nothing
    # min/max over the bbox columns, grouped by the hive partition
    assert "min(bbox_xmin)" in calls[0] and "max(bbox_ymax)" in calls[0]
    assert "group by region" in calls[0] and "hive_partitioning=true" in calls[0]


def test_resolve_reads_only_the_regions_reaching_the_tile():
    r = _resolver_with_extents(NJ_AND_CA)
    seen = {}

    def fake_query(paths, west, south, east, north, requested_year):
        seen["paths"] = paths
        return "select 1"

    r._con.execute = lambda sql: type("R", (), {"fetchall": lambda s: NJ_AND_CA if "min(" in sql else []})()
    with patch("tiler.resolver.build_tile_query", side_effect=fake_query):
        r.resolve("naip-visualization", 2023, 12, 1204, 1541)  # a New Jersey tile

    assert seen["paths"] == ["s3://bucket/lake/collection=naip-visualization/region=nj/year=*/*.parquet"]


def test_resolve_returns_empty_when_no_region_reaches_the_tile():
    # Mid-Pacific: outside every region's extent, so nothing is even listed.
    r = _resolver_with_extents(NJ_AND_CA)
    with patch("tiler.resolver.build_tile_query") as q:
        assert r.resolve("naip-visualization", 2023, 4, 1, 7) == []
        q.assert_not_called()


def test_requester_pays_flag():
    assert CogAsset("s3://naip-analytic/x.tif", "naip-analytic", 0.6).requester_pays
    assert not CogAsset("s3://njogis-imagery/x.tif", "njogis-imagery", 0.15).requester_pays
    assert "naip-analytic" in REQUESTER_PAYS_BUCKETS


# --- USGS 1/3 index geometry (guards the index-build latitude fix) ---
#
# USGS 1-degree tiles are named by their NW corner: n41w074 spans 40-41 N,
# 74-73 W. A prior index built every footprint 1 deg too far north and the
# resolver compensated with a query-time +/-1 deg shift. The bundled index now
# stores the true position (shift removed). This reads the parquet directly
# with a plain DuckDB connection (no S3 / AWS creds) so it always runs.

def test_bundled_usgs_index_footprints_match_tile_names():
    import duckdb
    from pyproj import Transformer
    from shapely import from_wkb
    from shapely.ops import transform as shp_transform

    to_wgs84 = Transformer.from_crs(DEM_INDEX_EPSG, 4326, always_xy=True)
    con = duckdb.connect()
    rows = con.execute(
        f"SELECT dataset, geometry_wkb FROM read_parquet('{USGS_INDEX}') "
        "WHERE dataset LIKE '%n41w074%' OR dataset LIKE '%n42w074%'"
    ).fetchall()
    assert len(rows) == 2  # both NJ-corridor cells are present

    for dataset, wkb in rows:
        m = re.search(r"n(\d{2})w(\d{3})", dataset)
        nw_lat, nw_lon = int(m.group(1)), -int(m.group(2))
        w, s, e, n = shp_transform(to_wgs84.transform, from_wkb(bytes(wkb))).bounds
        # NW-corner naming: cell spans [nw_lat-1, nw_lat] N, [nw_lon, nw_lon+1] E.
        assert abs(s - (nw_lat - 1)) < 1e-6 and abs(n - nw_lat) < 1e-6
        assert abs(w - nw_lon) < 1e-6 and abs(e - (nw_lon + 1)) < 1e-6
