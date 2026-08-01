"""Mosaic resolver: which COGs intersect tile z/x/y? (plan §2 row 5, §4.1)

Region pruning to shrink the S3 LIST, a cheap bbox-column prune, then an exact
ST_Intersects refine. Lake geometry/bbox columns are EPSG:4326; tile bounds come
from morecantile's geographic bounds, so no CRS juggling.

Not cogeo-mosaic, but not because the asset set is too dynamic for MosaicJSON —
it isn't. NAIP is re-flown per state every year or two and S1M grows in batches,
so a mosaic regenerated on the same cadence as the index would track it fine,
and the newest-vintage-per-region rule could be baked in at build time.

The reason is ownership: the lake is shared infrastructure this repo reads but
does not write (deckgl-s3-cog-s1m's ingest pipeline maintains it), and it
already answers "which COGs intersect this tile." MosaicJSON would mean
deriving and republishing a second index from an upstream this repo doesn't
control, and keeping the two in step. The cost of querying directly is DuckDB
in the Lambda plus the SQL below being ours to maintain. rio-tiler's
mosaic_reader still does the pixel work (see imagery.py); this module only
decides *which* assets. The README has the longer version.
"""

import logging
from dataclasses import dataclass

import duckdb
import morecantile

from . import duck

logger = logging.getLogger(__name__)

TMS = morecantile.tms.get("WebMercatorQuad")

TNM_BUCKET = "prd-tnm"  # public USGS TNM bucket, anonymous reads
DEM_INDEX_EPSG = 6350  # NAD83(2011) Conus Albers

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


def lake_read_paths(lake_root: str, collection: str, states: list[str]) -> list[str]:
    """Narrow read_parquet to the collection partition subtree for specific states.

    Lake layout: collection=<id>/region=<state>/year=<yyyy>/*.parquet.
    """
    return [
        f"{lake_root.rstrip('/')}/collection={collection}/region={state}/year=*/*.parquet"
        for state in states
    ]


def build_tile_query(read_paths: list[str], west: float, south: float, east: float, north: float, requested_year: int) -> tuple[str, list]:
    """The /search intersect query, scoped to one tile envelope and specific states.

    Finds the latest available year up to the requested year for each state/region,
    and layers the more recent year on top.

    Returns the SQL and its bound parameters. Everything variable is bound, so
    the SQL text is identical for every tile and DuckDB can reuse one prepared
    statement instead of re-parsing and re-planning a freshly formatted string
    per request. (This is not an injection defence: `year` arrives as an int
    from FastAPI's path validation and the envelope is floats this module
    computes from morecantile. Binding also keeps float repr — exponent
    notation, precision — out of the query text.)

    The asset href is derived once in a CTE rather than repeating the same
    COALESCE(JSON_EXTRACT_STRING(...)) in the select list, the bucket regex and
    the LIKE filter, which had it evaluated four times per candidate row.

    The bbox predicates are a per-row PREFILTER, not row-group pruning, and the
    distinction is worth stating because the obvious simplification here costs
    3x. This lake declares no GeoParquet `covering`, and its `bbox` is STAC's
    plain DOUBLE[]: Parquet keeps statistics on one leaf that mixes all four
    dimensions together (measured on the nj/2023 partition, min -75.56 is a
    longitude and max 41.37 a latitude), so they skip nothing from metadata.
    What they do instead is cheap and effective -- on the ca/2022 partition
    they cut 11,070 rows to 4-26 before a single geometry is decoded, measured
    3.2x faster end to end than ST_Intersects alone, same results.

    ST_Intersects is the correctness half. NAIP quarter-quads are axis-aligned
    in UTM, so reprojected to CRS84 they come out slightly skewed -- none of
    those 11,070 footprints equals its own bbox -- and a tile can clip the bbox
    corner without touching the quad.

    Note this is the opposite arrangement to DemIndexResolver.resolve below,
    whose bbox columns really are stats-bearing: that index is built here with
    separate bbox_xmin/xmax/ymin/ymax DOUBLEs and carries no native geo_bbox,
    while this lake is the reverse. Near-identical SQL, opposite mechanisms.
    """
    sql = """
        with candidates as (
            select COALESCE(JSON_EXTRACT_STRING(assets, '$.data.href'),
                            JSON_EXTRACT_STRING(assets, '$.visual.href')) as asset_href,
                   CAST(JSON_EXTRACT(properties, '$.gsd') AS DOUBLE) as gsd,
                   region, year, id
            from read_parquet(?, hive_partitioning=true)
            where bbox[1] <= ? and bbox[3] >= ?
              and bbox[2] <= ? and bbox[4] >= ?
              and ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))
        )
        select asset_href,
               regexp_extract(asset_href, 's3://([^/]+)', 1) as source_bucket,
               gsd
        from candidates
        where asset_href LIKE 's3://naip-visualization/%'
          and (region, year) in (
              select region, max(year)
              from read_parquet(?, hive_partitioning=true)
              where year <= ?
              group by region
          )
        order by year desc, gsd asc nulls last, id asc
        limit ?
    """
    # Positional, in the order the ? placeholders appear above.
    return sql, [
        read_paths,
        east, west, north, south,          # bbox-column prune
        west, south, east, north,          # ST_MakeEnvelope refine
        read_paths,
        requested_year,
        MAX_ASSETS_PER_TILE,
    ]


class MosaicResolver:
    """Lake-backed lookup of source COGs for an imagery tile."""

    def __init__(self, lake_root: str, region: str = "us-west-2"):
        self.lake_root = lake_root
        self._con = duck.connect(region)
        # collection -> {region: (xmin, ymin, xmax, ymax)}, filled on first use.
        self._extents: dict[str, dict[str, tuple[float, float, float, float]]] = {}

    def region_extents(self, collection: str) -> dict[str, tuple[float, float, float, float]]:
        """Per-region footprint extents, read from the index itself.

        Region pruning exists to narrow the S3 LIST before the real query, but
        the bounds driving it belong to the data, not to a hand-maintained
        table: a hardcoded box is approximate, goes stale as coverage grows,
        and cannot express a region crossing the antimeridian. min/max over the
        bbox columns is answered from Parquet row-group statistics, and the
        result is cached for the life of the container (warm invocations pay
        nothing), so one metadata query buys exact pruning.

        A region whose footprints straddle the antimeridian yields a full-width
        extent, which over-selects. That is the safe direction — it costs an
        extra partition read, where under-selecting would silently lose tiles.
        """
        cached = self._extents.get(collection)
        if cached is not None:
            return cached

        glob = f"{self.lake_root.rstrip('/')}/collection={collection}/region=*/year=*/*.parquet"
        sql = """
            select region,
                   min(bbox[1]), min(bbox[2]),
                   max(bbox[3]), max(bbox[4])
            from read_parquet(?, hive_partitioning=true)
            group by region
        """
        try:
            rows = self._con.execute(sql, [glob]).fetchall()
        except duckdb.IOException as e:
            # No partitions for this collection -> empty glob -> 404 upstream.
            logger.warning(f"Lake extent scan failed for {collection}: {e}")
            rows = []
        extents = {r[0]: (r[1], r[2], r[3], r[4]) for r in rows}
        self._extents[collection] = extents
        return extents

    def resolve(self, collection: str, year: int, z: int, x: int, y: int) -> list[CogAsset]:
        bounds = TMS.bounds(morecantile.Tile(x, y, z))  # geographic (4326)

        # Narrow to the regions whose footprints actually reach this tile.
        regions = [
            name
            for name, (xmin, ymin, xmax, ymax) in self.region_extents(collection).items()
            if not (bounds.left > xmax or bounds.right < xmin or bounds.bottom > ymax or bounds.top < ymin)
        ]
        if not regions:
            return []

        paths = lake_read_paths(self.lake_root, collection, sorted(regions))
        sql, params = build_tile_query(paths, bounds.left, bounds.bottom, bounds.right, bounds.top, year)
        try:
            rows = self._con.execute(sql, params).fetchall()
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


class DemIndexResolver:
    """DEM tile lookup for terrain tiles (plan §4.2).

    Serves any Albers-indexed 3DEP DEM index — S1M (1 m) and USGS 1/3" both
    use this shape — so the dataset is chosen by which parquet index is passed
    to the constructor, not by the class.

    Ported from deckgl-s3-cog-s1m's s1m.py. Unlike the imagery lake, these
    indexes store geometry/bbox in EPSG:6350 Albers, so we transform the tile's
    geographic bounds to an Albers envelope, do the cheap bbox-range prune from
    row-group statistics, then refine against the footprint exactly.

    Both prune and refine run in DuckDB. That is only possible because the
    indexes now carry a real GEOMETRY column: they used to store footprints as
    an opaque geometry_wkb BLOB, which forced every candidate row to be shipped
    back and re-parsed with shapely just to answer "does it actually overlap".
    COGs live in the public prd-tnm bucket (anonymous reads).
    """

    def __init__(self, index_path: str, region: str = "us-west-2"):
        self.index_path = index_path
        self._con = duck.connect(region)
        from pyproj import Transformer

        self._to_albers = Transformer.from_crs(4326, DEM_INDEX_EPSG, always_xy=True)

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

        # The bbox columns stay even though ST_Intersects alone would be
        # correct: they carry Parquet min/max statistics, so DuckDB skips whole
        # row groups from metadata without decoding any geometry. ST_Intersects
        # then refines only the survivors, since a bbox hit is not a footprint
        # hit. Dropping the bbox predicate would force a full geometry scan.
        rows = self._con.execute(
            """
            SELECT dataset
            FROM read_parquet(?)
            WHERE bbox_xmin <= ? AND bbox_xmax >= ?
              AND bbox_ymin <= ? AND bbox_ymax >= ?
              AND ST_Intersects(geometry, ST_MakeEnvelope(?, ?, ?, ?))
            """,
            [self.index_path, axmax, axmin, aymax, aymin, axmin, aymin, axmax, aymax],
        ).fetchall()

        return [f"s3://{TNM_BUCKET}/StagedProducts/Elevation/{dataset}" for (dataset,) in rows]
