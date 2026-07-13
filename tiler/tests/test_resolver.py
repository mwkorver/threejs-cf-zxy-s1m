import os
import re

from tiler.resolver import REQUESTER_PAYS_BUCKETS, S1M_EPSG, CogAsset, build_tile_query, lake_read_paths

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

    to_wgs84 = Transformer.from_crs(S1M_EPSG, 4326, always_xy=True)
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
