"""Runtime configuration. All values overridable via TILER_* env vars."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "TILER_"}

    # GeoParquet lake = mosaic index (plan §2 row 5, §7). Hive tree:
    # collection=/region=/year=. This is the canonical NAIP index, shared with
    # deckgl-s3-cog-s1m rather than owned by either repo: this tiler reads
    # collection=naip-visualization (RGB, plan §2 row 5a), while the analytic
    # RGBIR collection alongside it belongs to that project. Requester-pays,
    # which duck.py already sets. Point at a local copy for offline dev.
    lake_path: str = "s3://naip-geoparquet-index/manifest-index"

    # Seed source bucket used to bootstrap new account deployments
    seed_bucket_path: str = "s3://mwkorver-foundation-us-west-2/threejs-cf-zxy-s1m/"

    # S1M DEM tile lookup at runtime (read from deployer's account bucket);
    # geometry/bbox are EPSG:6350 Albers. Overridden dynamically at runtime by TILER_S1M_INDEX_PATH.
    s1m_index_path: str = (
        "s3://threejs-cf-zxy-s1m-us-west-2/manifest-index/s1m/S1M_Products.parquet"
    )

    # Far-field terrain source, Terrarium 256px (plan §2 row 7, §4.2).
    farfield_tiles: str = "s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

    tile_size: int = 512  # both imagery and terrain (plan §2 row 4, §4.2)
    imagery_webp_quality: int = 75  # plan §4.1

    # Zoom at/above which S1M is used instead of USGS 1/3" DEM.
    s1m_min_zoom: int = 15

    # Zoom at/above which USGS 1/3" DEM is used instead of far-field.
    usgs_min_zoom: int = 11

    # Hard cap on /terrain z: above this the CDN would cache upsampled junk
    # over an unbounded key space (mirrors the imagery maxzoom 404). S1M at
    # 1 m fully resolves ~z17 on the 512px basis; 18 matches the client's max
    # subdivision — one upsampled step past native, invisible under 30 cm
    # imagery.
    terrain_max_zoom: int = 18

    aws_region: str = "us-west-2"  # same region as sources (plan §2 row 10)


settings = Settings()
