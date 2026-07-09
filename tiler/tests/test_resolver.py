from tiler.resolver import REQUESTER_PAYS_BUCKETS, CogAsset, build_tile_query, lake_read_path


def test_read_path_narrows_to_partition_subtree():
    # Path scoping shrinks the S3 LIST (ported from _lake_read_path)
    p = lake_read_path("s3://bucket/lake/", "naip", 2021)
    assert p == "s3://bucket/lake/collection=naip/region=*/year=2021/*.parquet"


def test_query_has_prune_and_refine():
    sql = build_tile_query("s3://b/lake/collection=naip/region=*/year=2021/*.parquet",
                           west=-74.5, south=40.4, east=-74.4, north=40.5)
    # cheap bbox-column prune against row-group stats...
    assert "bbox_xmin <= -74.4" in sql and "bbox_xmax >= -74.5" in sql
    assert "bbox_ymin <= 40.5" in sql and "bbox_ymax >= 40.4" in sql
    # ...then exact footprint refine
    assert "ST_Intersects(geometry, ST_MakeEnvelope(-74.5, 40.4, -74.4, 40.5))" in sql
    # finest source first so the mosaic lays sharpest pixels down first
    assert "order by gsd asc" in sql
    assert "hive_partitioning=true" in sql


def test_requester_pays_flag():
    assert CogAsset("s3://naip-analytic/x.tif", "naip-analytic", 0.6).requester_pays
    assert not CogAsset("s3://njogis-imagery/x.tif", "njogis-imagery", 0.15).requester_pays
    assert "naip-analytic" in REQUESTER_PAYS_BUCKETS
