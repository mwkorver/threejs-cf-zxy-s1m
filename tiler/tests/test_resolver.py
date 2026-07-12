from tiler.resolver import REQUESTER_PAYS_BUCKETS, CogAsset, build_tile_query, lake_read_path


def test_read_path_narrows_to_partition_subtree():
    # Path scoping shrinks the S3 LIST (ported from _lake_read_path)
    p = lake_read_path("s3://bucket/lake/", "naip-visualization")
    assert p == "s3://bucket/lake/collection=naip-visualization/region=*/year=*/*.parquet"


def test_query_has_prune_and_refine():
    sql = build_tile_query("s3://b/lake/collection=naip/region=*/year=*/*.parquet",
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
