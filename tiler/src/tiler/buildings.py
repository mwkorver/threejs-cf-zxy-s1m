"""Building tile resolver: query GeoParquet building lake via DuckDB ST_AsMVT.

Serves MVT vector tiles (.pbf) containing 3D building footprints, heights,
and Overture/MS building IDs for tile envelope z/x/y.

The index this resolves against (settings.building_lake_path) is a pointer into
ONE Overture release, and Overture deletes old releases as new ones land. When
that happens read_parquet cannot open the files the index names, resolve()
returns None, and every building tile answers 404 -- buildings vanish
everywhere while the code is entirely correct.

The rebuild is not in this repo. It lives in the sibling project, because that
is where the lake is maintained:

    ../deckgl-s3-cog-s1m/app/api/build_overture_buildings_index.py

See "External dependencies, and how they fail" in the README for the full
procedure -- notably that the output must be published to BOTH the live path
the Lambda reads and the seed deploy.sh copies from.
"""

import logging

import morecantile

from . import duck

logger = logging.getLogger(__name__)

TMS = morecantile.tms.get("WebMercatorQuad")


class BuildingResolver:
    """Lake-backed lookup of 3D building vector features for tile z/x/y."""

    def __init__(self, index_path: str, region: str = "us-west-2"):
        self.index_path = index_path
        self.region = region
        self._con = duck.connect(region)

    def resolve(self, z: int, x: int, y: int) -> bytes | None:
        """Query building features and encode into 512px MVT protobuf byte payload."""
        bounds = TMS.bounds(morecantile.Tile(x, y, z))
        try:
            # 1. Query index manifest to find intersecting Overture partition files
            files_res = self._con.execute(
                """
                SELECT DISTINCT 's3://' || file
                FROM read_parquet(?)
                WHERE NOT (bbox_xmax < ? OR bbox_xmin > ? OR bbox_ymax < ? OR bbox_ymin > ?)
                """,
                [
                    self.index_path,
                    bounds.left,
                    bounds.right,
                    bounds.bottom,
                    bounds.top,
                ],
            ).fetchall()

            if not files_res:
                return None

            file_list = [f[0] for f in files_res]

            # 2. Query target partition files for building geometry and encode MVT.
            #
            # The bbox comparisons carry the weight; ST_Intersects only refines
            # what they let through. Overture's GeoParquet has a bbox STRUCT
            # column, and comparing its fields against constants is something
            # DuckDB can answer from Parquet row-group statistics -- so whole
            # row groups are skipped without being read. ST_Intersects alone is
            # a spatial function over the geometry column, which no statistic
            # describes, so it forced a scan of the entire partition however
            # little of it the tile covered. Partitions are far larger than any
            # tile, so even a tile with no buildings paid for a full read.
            #
            # Measured against S3 (cold metadata, so the upper end): rural z16
            # 21.6s -> 0.6s, Newark z14 22.2s -> 0.5s, Manhattan z14 20.7s ->
            # 0.5s. Warm, the same Manhattan z18 tile goes 0.96s -> 0.12s, so
            # expect 8x rather than 40x once containers are hot.
            #
            # Row counts are unchanged, and cannot change: a geometry that
            # intersects the envelope must have a bbox that overlaps it, so this
            # is a conservative superset and ST_Intersects still decides. Checked
            # at 0, 8, 192 and 2700 rows -- identical each time.
            res = self._con.execute(
                """
                SELECT ST_AsMVT(building_tiles, 'buildings', 4096, 'geom')
                FROM (
                    SELECT id, height, num_floors,
                           ST_AsMVTGeom(geometry, ST_Extent(ST_MakeEnvelope(?, ?, ?, ?)), 4096, 64, true) AS geom
                    FROM read_parquet(?)
                    WHERE bbox.xmin <= ? AND bbox.xmax >= ?
                      AND bbox.ymin <= ? AND bbox.ymax >= ?
                      AND ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))
                ) AS building_tiles
                """,
                [
                    bounds.left,
                    bounds.bottom,
                    bounds.right,
                    bounds.top,
                    file_list,
                    bounds.right,
                    bounds.left,
                    bounds.top,
                    bounds.bottom,
                    bounds.left,
                    bounds.bottom,
                    bounds.right,
                    bounds.top,
                ],
            ).fetchone()

            if res and res[0]:
                data = bytes(res[0])
                return data if len(data) > 0 else None
            return None
        except Exception as e:
            # Named, not just reported: a missing-object error here is almost
            # always the index outliving its Overture release, and that is not
            # deducible from a stack trace. Whoever reads this line is the
            # person who needs the pointer.
            logger.warning(
                f"Building tile query failed for {self.index_path} {z}/{x}/{y}: {e} "
                "(if this names missing S3 objects, Overture has retired the release "
                "this index points at -- rebuild it: see README "
                "'External dependencies, and how they fail')"
            )
            return None
