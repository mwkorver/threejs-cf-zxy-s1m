"""Building tile resolver: query GeoParquet building lake via DuckDB ST_AsMVT.

Serves MVT vector tiles (.pbf) containing 3D building footprints, heights,
and Overture/MS building IDs for tile envelope z/x/y.
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
            res = self._con.execute(
                """
                SELECT ST_AsMVT(building_tiles, 'buildings', 4096, 'geom')
                FROM (
                    SELECT id, height, num_floors,
                           ST_AsMVTGeom(geometry, ST_MakeEnvelope(?, ?, ?, ?), 4096, 64, true) AS geom
                    FROM read_parquet(?)
                    WHERE ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))
                ) AS building_tiles
                """,
                [
                    bounds.left,
                    bounds.bottom,
                    bounds.right,
                    bounds.top,
                    self.index_path,
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
            logger.warning(f"Building tile query failed for {self.index_path} {z}/{x}/{y}: {e}")
            return None
