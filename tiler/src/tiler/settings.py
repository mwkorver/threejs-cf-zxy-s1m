"""Runtime configuration. All values overridable via TILER_* env vars."""

from pydantic_settings import BaseSettings

# Master copy that a new account's deployment seeds its own bucket from: the
# deploy syncs this -> threejs-cf-zxy-s1m-${AccountId}-${Region}, which the
# edge stack provisions. Public-read with requester-pays, so any account can
# bootstrap from it, not just this one. Hoisted to a constant so seed_bucket_path
# and the s1m_index_path default below can't drift apart the way they did when
# they were two independent literals -- settings.py said "-us-west-2" while the
# infra template said "-${AWS::AccountId}-${AWS::Region}".
_SEED_BUCKET_ROOT = "s3://mwkorver-foundation-us-west-2/threejs-cf-zxy-s1m/"


class Settings(BaseSettings):
    model_config = {"env_prefix": "TILER_"}

    # The mosaic index: published stac-geoparquet (STAC Items -- id/geometry/
    # bbox/datetime/properties/assets), Hive tree collection=/region=/year=.
    # NOT the GeoParquet lake, which is the separate upstream artifact with a
    # 15-column ingest schema that this is the 9-column projection OF. This
    # field and its env var were called `lake_path`/TILER_LAKE_PATH until the
    # name was doing real damage: "lake" here means "the thing the ingest
    # pipeline maintains", so calling the index one licensed the conclusion --
    # which reached the README -- that the pipeline maintains this too. The
    # compatibility aliases for the old env vars are gone: the tiler stack was
    # redeployed 2026-09-03 and no stack sets them any more.
    #
    # This tiler reads collection=naip-visualization (RGB); the analytic RGBIR
    # collection alongside it belongs to deckgl-s3-cog-s1m. Ownership splits by
    # step rather than by repo: that project's ingest pipeline builds the lakes
    # behind BOTH collections, but the projection into this index was run once,
    # ad hoc, and lives in no repository -- so new NAIP vintages reaching a lake
    # do not reach this index on their own. See the README's cogeo-mosaic
    # section.
    #
    # Requester-pays, which duck.py already sets. Point at a local copy for
    # offline dev.
    index_path: str = "s3://naip-geoparquet-index/manifest-index"

    # Seed source bucket used to bootstrap new account deployments.
    seed_bucket_path: str = _SEED_BUCKET_ROOT

    # S1M DEM tile lookup; geometry/bbox are EPSG:6350 Albers. In production
    # this is always overridden by TILER_S1M_INDEX_PATH -- the tiler stack sets
    # it to the deployer's own account bucket, threejs-cf-zxy-s1m-<account
    # id>-<region>, which this class can't compute (it doesn't know the account
    # it will run in). The default below is only what local dev / tests /
    # scripts get without that env var, so it points at the seed bucket
    # directly rather than guessing an account-specific name that would just be
    # wrong.
    s1m_index_path: str = _SEED_BUCKET_ROOT + "manifest-index/s1m/S1M_Products.parquet"

    # Far-field terrain source, Terrarium 256px.
    farfield_tiles: str = "s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

    tile_size: int = 512  # both imagery and terrain
    imagery_webp_quality: int = 75  # lossy is fine for imagery; terrain is not

    # Zoom at/above which /imagery resolves the COG mosaic. Below it the client
    # asks /basemap instead (the USGS ImageServer render), because down there a tile
    # envelope covers whole states: the index query fans out across many region
    # partitions and the mosaic read pulls dozens of COGs to fill one tile.
    #
    # Enforced server-side for the same reason the DEM bands are: the client
    # routing rule (resolveImageryKind in client/src/core/tileUrls.ts) is the
    # only thing that currently keeps low-z requests off this endpoint, and a
    # hand-built URL would otherwise trigger a CONUS-scale query. Must stay one
    # above that module's externalImageryMaxZoom (13) -- they are two constants
    # describing one boundary, so moving either alone opens a gap or a dead band.
    imagery_min_zoom: int = 14

    # Zoom at/above which S1M is used instead of USGS 1/3" DEM.
    s1m_min_zoom: int = 15

    # Zoom at/above which USGS 1/3" DEM is used instead of far-field.
    usgs_min_zoom: int = 11

    # Overture Maps / MS Building footprints index & min zoom floor. One
    # GeoParquet FILE, not a partitioned tree -- the old name
    # (building_lake_path) called a single object a lake.
    building_index_path: str = _SEED_BUCKET_ROOT + "manifest-index/buildings/buildings.parquet"
    building_min_zoom: int = 14

    # Hard cap on /terrain z: above this the CDN would cache upsampled junk
    # over an unbounded key space (mirrors the imagery maxzoom 404). S1M at
    # 1 m fully resolves ~z17 on the 512px basis; 18 matches the client's max
    # subdivision — one upsampled step past native, invisible under 30 cm
    # imagery.
    terrain_max_zoom: int = 18

    aws_region: str = "us-west-2"  # same region as sources


settings = Settings()
