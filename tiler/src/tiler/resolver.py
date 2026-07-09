"""Mosaic resolver: which COGs intersect tile z/x/y? (plan §2 row 5, §4.1)

Ported from deckgl-s3-cog-s1m's /search (app/api/app.py:_build_lake_inner_sql):
Hive-partition path scoping to shrink the S3 LIST, a cheap bbox-column prune,
then an exact ST_Intersects refine. Lake geometry/bbox columns are EPSG:4326;
tile bounds come from morecantile's geographic bounds, so no CRS juggling.

S1M terrain resolution (Albers-indexed, Python-side refine) comes with
Phase 0 step 3.
"""

from dataclasses import dataclass

import duckdb
import morecantile

from . import duck

TMS = morecantile.tms.get("WebMercatorQuad")

# Mirrors descriptors.REQUESTER_PAYS_BUCKETS in the source repo.
REQUESTER_PAYS_BUCKETS = {"naip-analytic", "naip-visualization", "naip-stac-catalog"}

# Plenty for a 512px tile even where NAIP quarter-quads are dense.
MAX_ASSETS_PER_TILE = 64


@dataclass(frozen=True)
class CogAsset:
    href: str
    source_bucket: str
    gsd: float | None

    @property
    def requester_pays(self) -> bool:
        return self.source_bucket in REQUESTER_PAYS_BUCKETS


def lake_read_path(lake_root: str, collection: str, year: int) -> str:
    """Narrow read_parquet to the collection/year partition subtree.

    Lake layout (from the source repo's ingest): collection=<id>/region=<state>/
    year=<yyyy>/*.parquet. Region is unknown at tile time, so it stays a glob.
    """
    return f"{lake_root.rstrip('/')}/collection={collection}/region=*/year={year}/*.parquet"


def build_tile_query(read_path: str, west: float, south: float, east: float, north: float) -> str:
    """The ported /search intersect query, scoped to one tile envelope.

    bbox columns prune cheaply against parquet row-group stats; ST_Intersects
    refines against the exact footprint (irregular NAIP quarter-quads).
    Sort finest-first so the mosaic reader lays sharpest pixels down first.
    Bounds are computed floats (never user strings) — safe to interpolate.
    """
    return f"""
        select asset_href, source_bucket, gsd
        from read_parquet('{read_path}', hive_partitioning=true)
        where bbox_xmin <= {east} and bbox_xmax >= {west}
          and bbox_ymin <= {north} and bbox_ymax >= {south}
          and ST_Intersects(geometry, ST_MakeEnvelope({west}, {south}, {east}, {north}))
        order by gsd asc nulls last, source_key asc
        limit {MAX_ASSETS_PER_TILE}
    """


class MosaicResolver:
    """Lake-backed lookup of source COGs for an imagery tile."""

    def __init__(self, lake_root: str, region: str = "us-west-2"):
        self.lake_root = lake_root
        self._con = duck.connect(region)

    def resolve(self, collection: str, year: int, z: int, x: int, y: int) -> list[CogAsset]:
        bounds = TMS.bounds(morecantile.Tile(x, y, z))  # geographic (4326)
        path = lake_read_path(self.lake_root, collection, year)
        sql = build_tile_query(path, bounds.left, bounds.bottom, bounds.right, bounds.top)
        try:
            rows = self._con.execute(sql).fetchall()
        except duckdb.IOException:
            # No partition for this collection/year -> empty glob -> 404 upstream
            return []
        return [CogAsset(href=r[0], source_bucket=r[1], gsd=r[2]) for r in rows]
