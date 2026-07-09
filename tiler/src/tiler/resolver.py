"""Mosaic resolver: which COGs intersect tile z/x/y? (plan §2 row 5, §4.1)

This is the custom heart of the tiler and the reason we run thin rio-tiler
instead of TiTiler proper (plan §10.4): the answer comes from a DuckDB query
over the existing GeoParquet lake, i.e. the /search pattern proven in
deckgl-s3-cog-s1m.
"""

from dataclasses import dataclass

import duckdb
import morecantile

TMS = morecantile.tms.get("WebMercatorQuad")


@dataclass(frozen=True)
class CogAsset:
    href: str
    requester_pays: bool


class MosaicResolver:
    """Lake-backed lookup of source COGs for an imagery tile.

    One connection per Lambda container; DuckDB is in-process so a warm
    container answers from cached parquet footers.
    """

    def __init__(self, lake_path: str):
        self.lake_path = lake_path
        self._con = duckdb.connect()
        self._con.execute("INSTALL spatial; LOAD spatial;")
        self._con.execute("INSTALL httpfs; LOAD httpfs;")

    def resolve(self, layer: str, year: int, z: int, x: int, y: int) -> list[CogAsset]:
        """Tile -> geographic bbox -> lake query -> COG list.

        TODO(Phase 0): port the /search query from deckgl-s3-cog-s1m —
        SELECT href, ... FROM lake WHERE collection = $layer AND year = $year
        AND ST_Intersects(geometry, ST_MakeEnvelope($w, $s, $e, $n)).
        Single-vintage per path keeps mosaics seam-free (plan §4.1).
        """
        bounds = TMS.bounds(morecantile.Tile(x, y, z))
        raise NotImplementedError(
            f"lake query for {layer}/{year} over {bounds} — port from deckgl-s3-cog-s1m"
        )


class S1MResolver:
    """S1M_Products.parquet lookup for terrain tiles (plan §4.2)."""

    def __init__(self, index_path: str):
        self.index_path = index_path
        self._con = duckdb.connect()
        self._con.execute("INSTALL spatial; LOAD spatial;")
        self._con.execute("INSTALL httpfs; LOAD httpfs;")

    def resolve(self, z: int, x: int, y: int) -> list[CogAsset]:
        """TODO(Phase 0): bbox-intersect against S1M_Products.parquet."""
        bounds = TMS.bounds(morecantile.Tile(x, y, z))
        raise NotImplementedError(
            f"S1M index query over {bounds} — reuse build script output from deckgl-s3-cog-s1m"
        )
