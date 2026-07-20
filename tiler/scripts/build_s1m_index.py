#!/usr/bin/env python3
"""Rebuild S1M_Products.parquet — the DEM lookup the terrain tiler resolves against.

Reads bounds straight from each COG's header (a few-KB range request, not the
whole file), so the index is derived from the rasters themselves rather than
from the .gpkg sidecars shipped alongside them — one source of truth.

S1M COGs carry a COMPOUND CRS ("NAD83(2011) / Conus Albers + NAVD88 height"),
so rasterio's to_epsg() returns None even though every horizontal parameter is
EPSG:6350. Bounds are therefore already in the Albers metres the resolver
expects; the script verifies the horizontal params per file instead of
comparing EPSG codes.

Upstream publishes dated filenames (S1M_n2100w2200_20260430.tif) and reissues
tiles in place, so several dates can exist for one location. Only the newest
per location is indexed — otherwise mosaic_reader stacks duplicates.

Because those dated names are immutable, a path's bounds can never change: by
default the script reuses rows from the current index and only opens COGs for
files it hasn't seen (~950 instead of ~11k). --full re-reads everything.

    python scripts/build_s1m_index.py --dry-run          # report drift, write nothing
    python scripts/build_s1m_index.py --upload           # rebuild + publish
    python scripts/build_s1m_index.py --full --upload    # ignore existing index

After uploading, warm Lambda containers keep a cached DuckDB parquet footer;
bump an env var (or wait for recycling) before expecting new coverage to show.
Then refresh the overlay: build_footprints.py --which s1m --invalidate
"""

import argparse
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from tiler.settings import settings  # noqa: E402

BUCKET = "prd-tnm"
PREFIX = "StagedProducts/Elevation/"
S1M_PREFIX = PREFIX + "S1M/"

# location + issue date, e.g. S1M_n2100w2200_20260430.tif -> ("n2100w2200", "20260430")
TILE_RE = re.compile(r"(n\d+[ew]\d+)_(\d{8})\.tif$")

# Horizontal CRS the resolver assumes (EPSG:6350 Conus Albers). Compared
# parameter-wise because the COGs declare a compound (3D) CRS.
EXPECTED_PROJ = {"proj": "aea", "lat_0": 23, "lat_1": 29.5, "lat_2": 45.5,
                 "lon_0": -96, "x_0": 0, "y_0": 0, "units": "m", "ellps": "GRS80"}


def list_cogs() -> list[str]:
    """All S1M .tif keys, as 'dataset' paths relative to StagedProducts/Elevation/."""
    import boto3

    s3 = boto3.client("s3")
    out = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=S1M_PREFIX):
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(".tif"):
                out.append(obj["Key"][len(PREFIX):])
    return out


def newest_per_location(datasets: list[str]) -> tuple[list[str], int]:
    """Keep one dataset per tile location: the latest issue date."""
    best: dict[str, tuple[str, str]] = {}
    unparsed = 0
    for d in datasets:
        m = TILE_RE.search(d)
        if not m:
            unparsed += 1
            continue
        loc, date = m.group(1), m.group(2)
        if loc not in best or date > best[loc][0]:
            best[loc] = (date, d)
    return sorted(v[1] for v in best.values()), unparsed


def read_bounds(dataset: str) -> tuple[str, tuple[float, float, float, float] | None, str | None]:
    """(dataset, bounds, error) — bounds in Albers metres from the COG header."""
    import rasterio

    url = f"s3://{BUCKET}/{PREFIX}{dataset}"
    for attempt in range(3):
        try:
            with rasterio.Env(AWS_REQUEST_PAYER="requester"), rasterio.open(url) as ds:
                crs = ds.crs.to_dict() if ds.crs else {}
                bad = [k for k, v in EXPECTED_PROJ.items() if crs.get(k) != v]
                if bad:
                    return dataset, None, f"unexpected CRS params {bad}"
                b = ds.bounds
                return dataset, (b.left, b.bottom, b.right, b.top), None
        except Exception as e:  # transient S3/GDAL hiccup
            if attempt == 2:
                return dataset, None, str(e)[:120]
            time.sleep(1 + attempt)
    return dataset, None, "unreachable"


def load_existing(path: str) -> dict[str, tuple[float, float, float, float]]:
    """dataset -> bounds from the current index (bounds are immutable per path)."""
    import duckdb

    from tiler import duck

    try:
        con = duck.connect(settings.aws_region)
        rows = con.execute(
            f"SELECT dataset, bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax "
            f"FROM read_parquet('{path.replace(chr(39), chr(39) * 2)}')"
        ).fetchall()
        return {r[0]: (r[1], r[2], r[3], r[4]) for r in rows}
    except duckdb.Error as e:
        print(f"  (no reusable index: {str(e)[:90]})")
        return {}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=None, help="local parquet path (default: alongside this script)")
    ap.add_argument("--upload", action="store_true", help=f"publish to {settings.s1m_index_path}")
    ap.add_argument("--full", action="store_true", help="re-read every COG instead of reusing the current index")
    ap.add_argument("--dry-run", action="store_true", help="report drift only; write nothing")
    ap.add_argument("--workers", type=int, default=32)
    args = ap.parse_args()

    print(f"listing s3://{BUCKET}/{S1M_PREFIX} ...")
    all_tifs = list_cogs()
    datasets, unparsed = newest_per_location(all_tifs)
    print(f"  {len(all_tifs)} .tif -> {len(datasets)} locations after newest-per-location dedup"
          + (f"  ({unparsed} unparseable names skipped)" if unparsed else ""))

    existing = {} if args.full else load_existing(settings.s1m_index_path)
    if existing:
        print(f"  reusing {len(existing)} bounds from the current index")
    todo = [d for d in datasets if d not in existing]
    stale = [d for d in existing if d not in set(datasets)]
    print(f"  need bounds for {len(todo)} COG(s); {len(stale)} indexed path(s) no longer upstream")

    if args.dry_run:
        print("\n[dry-run] would add:")
        for d in todo[:10]:
            print("   +", d)
        if len(todo) > 10:
            print(f"   ... and {len(todo) - 10} more")
        return

    bounds: dict[str, tuple[float, float, float, float]] = {
        d: existing[d] for d in datasets if d in existing
    }
    errors: list[tuple[str, str]] = []
    if todo:
        print(f"reading {len(todo)} COG headers with {args.workers} workers ...")
        t0 = time.time()
        done = 0
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for dataset, b, err in pool.map(read_bounds, todo):
                done += 1
                if err:
                    errors.append((dataset, err))
                else:
                    bounds[dataset] = b
                if done % 250 == 0 or done == len(todo):
                    print(f"  {done}/{len(todo)}  ({time.time() - t0:.0f}s)")

    if errors:
        print(f"\n!! {len(errors)} COG(s) failed and are EXCLUDED from the index:")
        for d, e in errors[:10]:
            print(f"   {d}: {e}")
        if len(errors) > 10:
            print(f"   ... and {len(errors) - 10} more")

    from shapely.geometry import box

    rows = []
    for fid, dataset in enumerate(sorted(bounds), start=1):
        xmin, ymin, xmax, ymax = bounds[dataset]
        rows.append((fid, dataset, box(xmin, ymin, xmax, ymax).wkb, xmin, xmax, ymin, ymax))
    print(f"\nindex: {len(rows)} rows")

    out = args.out or str(Path(__file__).resolve().parent.parent / "S1M_Products.parquet")
    import duckdb

    con = duckdb.connect()
    con.execute(
        "CREATE TABLE t (fid BIGINT, dataset VARCHAR, geometry_wkb BLOB, "
        "bbox_xmin DOUBLE, bbox_xmax DOUBLE, bbox_ymin DOUBLE, bbox_ymax DOUBLE)"
    )
    con.executemany("INSERT INTO t VALUES (?,?,?,?,?,?,?)", rows)
    con.execute(f"COPY t TO '{out}' (FORMAT PARQUET)")
    print(f"wrote {out} ({Path(out).stat().st_size / 1e3:.0f} KB)")

    if args.upload:
        import boto3

        target = settings.s1m_index_path
        bkt, key = target.replace("s3://", "", 1).split("/", 1)
        boto3.client("s3", region_name=settings.aws_region).upload_file(out, bkt, key)
        print(f"uploaded -> {target}")
        print("NOTE: warm Lambda containers cache the parquet footer; bump a TILER_* env var to force new ones.")
        print("NOTE: refresh the overlay too: python scripts/build_footprints.py --which s1m --invalidate")


if __name__ == "__main__":
    main()
