"""Runtime configuration. All values overridable via TILER_* env vars."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "TILER_"}

    # GeoParquet lake = mosaic index (plan §2 row 5, §7). Consolidated lake in
    # this project's own bucket (Hive tree: collection=/region=/year=); NAIP is
    # collection=naip-visualization pointing at the RGB visualization COGs.
    # Point at a local copy for offline dev.
    lake_path: str = "s3://deckgl-cf-xyz-s1m-us-west-2/manifest-index"

    # S1M DEM tile lookup (plan §4.2); built by the source repo's
    # publish-s1m-index.sh. Geometry/bbox are EPSG:6350 Albers.
    s1m_index_path: str = "s3://deckgl-cf-xyz-s1m-us-west-2/manifest-index/s1m/S1M_Products.parquet"

    # Far-field terrain source, Terrarium 256px (plan §2 row 7, §4.2).
    farfield_tiles: str = "s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

    tile_size: int = 512  # both imagery and terrain (plan §2 row 4, §4.2)
    imagery_webp_quality: int = 75  # plan §4.1

    # Zoom at/above which S1M is used instead of far-field passthrough.
    # Provisional; tune against S1M coverage + SSE threshold in Phase 0.
    s1m_min_zoom: int = 11

    aws_region: str = "us-west-2"  # same region as sources (plan §2 row 10)


settings = Settings()
