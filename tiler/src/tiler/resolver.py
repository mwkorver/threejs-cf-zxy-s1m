"""Mosaic resolver: which COGs intersect tile z/x/y? (plan §2 row 5, §4.1)

Ported from deckgl-s3-cog-s1m's /search (app/api/app.py:_build_lake_inner_sql):
Hive-partition path scoping to shrink the S3 LIST, a cheap bbox-column prune,
then an exact ST_Intersects refine. Lake geometry/bbox columns are EPSG:4326;
tile bounds come from morecantile's geographic bounds, so no CRS juggling.

S1M terrain resolution (Albers-indexed, Python-side refine) comes with
Phase 0 step 3.
"""

import logging
from dataclasses import dataclass

import duckdb
import morecantile

from . import duck

logger = logging.getLogger(__name__)

TMS = morecantile.tms.get("WebMercatorQuad")

S1M_BUCKET = "prd-tnm"  # public USGS TNM bucket, anonymous reads
S1M_EPSG = 6350  # NAD83(2011) Conus Albers

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


# Bounding boxes for each US state/region in EPSG:4326 (West, South, East, North)
# Used to prune partition checks to only the exact states intersecting the tile viewport.
REGION_BOUNDS = {
    "al": (-88.5, 30.2, -84.9, 35.0),
    "ak": (-179.2, 51.2, -129.0, 71.4),
    "az": (-114.8, 31.3, -109.0, 37.0),
    "ar": (-94.6, 33.0, -89.6, 36.5),
    "ca": (-124.4, 32.5, -114.1, 42.0),
    "co": (-109.1, 37.0, -102.0, 41.0),
    "ct": (-73.7, 41.0, -71.8, 42.1),
    "de": (-75.8, 38.4, -75.0, 39.8),
    "fl": (-87.6, 24.5, -80.0, 31.0),
    "ga": (-85.6, 30.3, -80.8, 35.0),
    "hi": (-160.2, 18.9, -154.8, 22.2),
    "ia": (-96.6, 40.4, -90.1, 43.5),
    "id": (-117.2, 42.0, -111.0, 49.0),
    "il": (-91.5, 37.0, -87.5, 42.5),
    "in": (-88.1, 37.77, -84.78, 41.76),
    "ks": (-102.1, 37.0, -94.6, 40.0),
    "ky": (-89.6, 36.5, -81.9, 39.15),
    "la": (-94.0, 28.9, -89.0, 33.0),
    "ma": (-73.5, 41.2, -69.9, 42.9),
    "md": (-79.5, 37.9, -75.0, 39.7),
    "me": (-71.1, 42.9, -66.9, 47.5),
    "mi": (-90.4, 41.7, -82.4, 48.3),
    "mn": (-97.2, 43.5, -89.5, 49.4),
    "mo": (-95.8, 36.0, -89.1, 40.6),
    "ms": (-91.7, 30.2, -88.1, 35.0),
    "mt": (-116.1, 44.4, -104.0, 49.0),
    "nc": (-84.3, 33.8, -75.4, 36.6),
    "nd": (-104.1, 45.9, -96.5, 49.0),
    "ne": (-104.1, 40.0, -95.3, 43.0),
    "nh": (-72.6, 42.7, -70.7, 45.3),
    "nj": (-75.6, 38.9, -73.9, 41.36),
    "nm": (-109.1, 31.3, -103.0, 37.0),
    "nv": (-120.0, 35.0, -114.0, 42.0),
    "ny": (-79.8, 40.5, -71.8, 45.0),
    "oh": (-84.8, 38.4, -80.5, 42.0),
    "ok": (-103.0, 33.6, -94.4, 37.0),
    "or": (-124.6, 42.0, -116.5, 46.3),
    "pa": (-80.5, 39.7, -74.7, 42.3),
    "ri": (-71.9, 41.1, -71.1, 42.0),
    "sc": (-83.4, 32.0, -78.5, 35.2),
    "sd": (-104.1, 42.5, -96.4, 46.0),
    "tn": (-90.3, 35.0, -81.6, 36.7),
    "tx": (-106.6, 25.8, -93.5, 36.5),
    "ut": (-114.0, 37.0, -109.0, 42.0),
    "va": (-83.7, 36.5, -75.2, 39.5),
    "vt": (-73.4, 42.7, -71.5, 45.0),
    "wa": (-124.8, 45.5, -116.9, 49.0),
    "wi": (-92.9, 42.5, -86.8, 47.1),
    "wv": (-82.7, 37.2, -77.7, 40.7),
    "wy": (-111.1, 41.0, -104.0, 45.0),
    "pr": (-67.3, 17.9, -65.2, 18.5),
    "vi": (-65.1, 17.6, -64.5, 18.4),
}


def lake_read_paths(lake_root: str, collection: str, states: list[str]) -> list[str]:
    """Narrow read_parquet to the collection partition subtree for specific states.

    Lake layout: collection=<id>/region=<state>/year=<yyyy>/*.parquet.
    """
    return [
        f"{lake_root.rstrip('/')}/collection={collection}/region={state}/year=*/*.parquet"
        for state in states
    ]


def build_tile_query(read_paths: list[str], west: float, south: float, east: float, north: float, requested_year: int) -> str:
    """The /search intersect query, scoped to one tile envelope and specific states.

    Finds the latest available year up to the requested year for each state/region,
    and layers the more recent year on top.
    """
    paths_str = ", ".join(f"'{p}'" for p in read_paths)
    return f"""
        select asset_href, source_bucket, gsd
        from read_parquet([{paths_str}], hive_partitioning=true)
        where bbox_xmin <= {east} and bbox_xmax >= {west}
          and bbox_ymin <= {north} and bbox_ymax >= {south}
          and ST_Intersects(geometry, ST_MakeEnvelope({west}, {south}, {east}, {north}))
          and (region, year) in (
              select region, max(year)
              from read_parquet([{paths_str}], hive_partitioning=true)
              where year <= {requested_year}
              group by region
          )
        order by year desc, gsd asc nulls last, source_key asc
        limit {MAX_ASSETS_PER_TILE}
    """


class MosaicResolver:
    """Lake-backed lookup of source COGs for an imagery tile."""

    def __init__(self, lake_root: str, region: str = "us-west-2"):
        self.lake_root = lake_root
        self._con = duck.connect(region)

    def resolve(self, collection: str, year: int, z: int, x: int, y: int) -> list[CogAsset]:
        bounds = TMS.bounds(morecantile.Tile(x, y, z))  # geographic (4326)

        # Find which states intersect the tile bounds
        intersecting_states = []
        for state, s_bbox in REGION_BOUNDS.items():
            if not (bounds.left > s_bbox[2] or bounds.right < s_bbox[0] or bounds.bottom > s_bbox[3] or bounds.top < s_bbox[1]):
                intersecting_states.append(state)

        if not intersecting_states:
            return []

        paths = lake_read_paths(self.lake_root, collection, intersecting_states)
        sql = build_tile_query(paths, bounds.left, bounds.bottom, bounds.right, bounds.top, year)
        try:
            rows = self._con.execute(sql).fetchall()
        except duckdb.IOException as e:
            # No partition for this collection -> empty glob -> 404 upstream.
            logger.warning(f"Lake read failed for {collection} {year} {z}/{x}/{y}: {e}")
            return []
        except Exception:
            # Anything else (auth/expired creds, malformed query) is a real
            # failure: surface a 500 rather than a cacheable "no coverage" 404.
            logger.exception(f"DuckDB query failed for {collection} {year} {z}/{x}/{y}")
            raise
        return [CogAsset(href=r[0], source_bucket=r[1], gsd=r[2]) for r in rows]


class S1MResolver:
    """S1M DEM tile lookup for terrain tiles (plan §4.2).

    Ported from deckgl-s3-cog-s1m's s1m.py. Unlike the imagery lake, the S1M
    index stores geometry/bbox in EPSG:6350 Albers, so we transform the tile's
    geographic bounds to an Albers envelope, do the cheap bbox-range prune in
    DuckDB, then refine with shapely (the index has no ST_Intersects). COGs
    live in the public prd-tnm bucket (anonymous reads).
    """

    def __init__(self, index_path: str, region: str = "us-west-2"):
        self.index_path = index_path
        self._con = duck.connect(region)
        from pyproj import Transformer

        self._to_albers = Transformer.from_crs(4326, S1M_EPSG, always_xy=True)
        self._to_latlon = Transformer.from_crs(S1M_EPSG, 4326, always_xy=True)

    def resolve(self, z: int, x: int, y: int) -> list[str]:
        """s3:// hrefs of S1M COGs intersecting tile z/x/y (empty if none)."""
        b = TMS.bounds(morecantile.Tile(x, y, z))
        # Transform all 4 corners; Albers isn't axis-aligned to lon/lat so the
        # envelope over the corners slightly overestimates (admits edge tiles).
        xs, ys = [], []
        for lon, lat in [(b.left, b.bottom), (b.right, b.bottom), (b.right, b.top), (b.left, b.top)]:
            ax, ay = self._to_albers.transform(lon, lat)
            xs.append(ax)
            ys.append(ay)
        axmin, axmax, aymin, aymax = min(xs), max(xs), min(ys), max(ys)

        escaped = self.index_path.replace("'", "''")
        rows = self._con.execute(
            f"""
            SELECT dataset, geometry_wkb
            FROM read_parquet('{escaped}')
            WHERE bbox_xmin <= ? AND bbox_xmax >= ?
              AND bbox_ymin <= ? AND bbox_ymax >= ?
            """,
            [axmax, axmin, aymax, aymin],
        ).fetchall()

        from shapely import from_wkb
        from shapely.geometry import box

        envelope = box(axmin, aymin, axmax, aymax)
        hrefs = []
        for dataset, wkb in rows:
            if from_wkb(wkb).intersects(envelope):
                hrefs.append(f"s3://{S1M_BUCKET}/StagedProducts/Elevation/{dataset}")
        return hrefs

    def resolve_footprints(self, z: int, x: int, y: int, dataset_type: str = "s1m") -> dict:
        """GeoJSON FeatureCollection of footprints intersecting tile z/x/y."""
        b = TMS.bounds(morecantile.Tile(x, y, z))
        xs, ys = [], []
        for lon, lat in [(b.left, b.bottom), (b.right, b.bottom), (b.right, b.top), (b.left, b.top)]:
            ax, ay = self._to_albers.transform(lon, lat)
            xs.append(ax)
            ys.append(ay)
        axmin, axmax, aymin, aymax = min(xs), max(xs), min(ys), max(ys)

        escaped = self.index_path.replace("'", "''")
        rows = self._con.execute(
            f"""
            SELECT dataset, geometry_wkb
            FROM read_parquet('{escaped}')
            WHERE bbox_xmin <= ? AND bbox_xmax >= ?
              AND bbox_ymin <= ? AND bbox_ymax >= ?
            """,
            [axmax, axmin, aymax, aymin],
        ).fetchall()

        import shapely.ops
        from shapely import from_wkb
        from shapely.geometry import box, mapping

        envelope = box(axmin, aymin, axmax, aymax)

        features = []
        for dataset, wkb in rows:
            geom = from_wkb(wkb)
            if geom.intersects(envelope):
                # Reproject geometry to WGS84 for GeoJSON
                geom_wgs = shapely.ops.transform(self._to_latlon.transform, geom)
                features.append({
                    "type": "Feature",
                    "properties": {
                        "dataset": dataset,
                        "href": f"s3://{S1M_BUCKET}/StagedProducts/Elevation/{dataset}",
                        "type": dataset_type
                    },
                    "geometry": mapping(geom_wgs)
                })

        return {
            "type": "FeatureCollection",
            "features": features
        }
