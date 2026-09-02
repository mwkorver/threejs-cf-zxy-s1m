#!/usr/bin/env python3
"""Build static footprint GeoJSON files and upload them to S3.

Footprints are scale-free vectors and the whole dataset is tiny (~360 KB
gzipped total), so instead of tiling them or running a per-viewport DuckDB
query on every camera move, we ship two static, immutable files the client
fetches once and clips client-side:

    footprints/s1m.json     (~10k features, GROWS as S1M coverage expands)
    footprints/usgs13.json  (~1.4k features, effectively static)

They're kept separate on purpose: usgs13 never changes, S1M grows, so only
s1m.json needs regenerating when new COGs are indexed. Each file is compact
GeoJSON with coords rounded to ~1 m (5 dp), gzipped, uploaded with
Content-Encoding: gzip and immutable Cache-Control. Served via CloudFront's
/footprints/* S3-origin behavior (infra/lib/edge-stack.ts).

    # rebuild + upload just S1M after new coverage lands, then bust the CDN copy
    python scripts/build_footprints.py --which s1m --invalidate

    # first-time / full run (both files)
    python scripts/build_footprints.py --which both

Needs AWS creds (reuses the tiler's DuckDB S3 setup).
"""

import argparse
import gzip
import json
import os
import time
from pathlib import Path

from tiler import duck
from tiler.resolver import TNM_BUCKET, DEM_INDEX_EPSG
from tiler.settings import settings

# usgs13 index ships in the repo (same file get_usgs13_resolver loads at runtime).
USGS13_INDEX = Path(__file__).resolve().parent.parent / "src" / "tiler" / "data" / "USGS_13_DEM_Index.parquet"

COORD_DP = 5  # ~1 m at these latitudes; footprint edges don't need more.

# The app is CONUS-only (NAIP imagery doesn't cover Alaska, and the DEM indexes
# carry AK/HI/Pacific-territory tiles with no matching imagery). Drop footprints
# whose centroid falls outside this box so the overlay isn't cluttered with
# unreachable coverage. West, South, East, North.
CONUS_BBOX = (-125.0, 24.0, -66.5, 49.5)


def _bucket_from_s3_uri(uri: str) -> str:
    # "s3://<bucket>/some/key" -> "<bucket>"
    return uri.split("//", 1)[1].split("/", 1)[0]


def _round_coords(coords):
    if coords and isinstance(coords[0], (int, float)):
        return [round(coords[0], COORD_DP), round(coords[1], COORD_DP)]
    return [_round_coords(c) for c in coords]


def build_geojson(index_path: str, dataset_type: str, region: str, conus_only: bool = True) -> dict:
    """Read a DEM index (Albers EPSG:6350), reproject to WGS84, return a GeoJSON
    FeatureCollection with the {dataset, href, type} properties the client
    overlay colors/filters by."""
    from pyproj import Transformer
    from shapely import from_wkb
    from shapely.geometry import mapping
    from shapely.ops import transform as shp_transform

    to_latlon = Transformer.from_crs(DEM_INDEX_EPSG, 4326, always_xy=True).transform
    w, s, e, n = CONUS_BBOX

    con = duck.connect(region)
    # ST_AsWKB, not a raw column read: the indexes carry a native GEOMETRY
    # column now, and shapely still wants bytes.
    rows = con.execute(
        "SELECT dataset, ST_AsWKB(geometry) FROM read_parquet(?)", [index_path]
    ).fetchall()

    features = []
    dropped = 0
    for dataset, wkb in rows:
        geom = shp_transform(to_latlon, from_wkb(bytes(wkb)))
        if conus_only:
            c = geom.centroid
            if not (w <= c.x <= e and s <= c.y <= n):
                dropped += 1
                continue
        gj = mapping(geom)
        gj["coordinates"] = _round_coords(gj["coordinates"])
        features.append({
            "type": "Feature",
            "properties": {
                "dataset": dataset,
                "href": f"s3://{TNM_BUCKET}/StagedProducts/Elevation/{dataset}",
                "type": dataset_type,
            },
            "geometry": gj,
        })
    if conus_only and dropped:
        print(f"  dropped {dropped} non-CONUS footprints (no NAIP imagery)")
    return {"type": "FeatureCollection", "features": features}


def upload(bucket: str, key: str, fc: dict, dry_run: bool) -> None:
    raw = json.dumps(fc, separators=(",", ":")).encode()
    body = gzip.compress(raw, 9)
    label = f"s3://{bucket}/{key}"
    print(
        f"  {key}: {len(fc['features'])} features, "
        f"{len(raw)/1e6:.2f} MB raw / {len(body)/1e3:.0f} KB gzipped"
    )
    if dry_run:
        out = Path(__file__).resolve().parent.parent / "dist_footprints" / Path(key).name
        out.parent.mkdir(exist_ok=True)
        out.write_bytes(raw)
        print(f"  [dry-run] wrote uncompressed copy to {out}")
        return
    import boto3

    boto3.client("s3", region_name=settings.aws_region).put_object(
        Bucket=bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        ContentEncoding="gzip",
        CacheControl="public, max-age=31536000, immutable",
        RequestPayer="requester",
    )
    print(f"  uploaded {label}")


def invalidate(distribution_id: str, paths: list[str]) -> None:
    import boto3

    cf = boto3.client("cloudfront")
    resp = cf.create_invalidation(
        DistributionId=distribution_id,
        InvalidationBatch={
            "Paths": {"Quantity": len(paths), "Items": paths},
            "CallerReference": f"footprints-{int(time.time())}",
        },
    )
    print(f"  invalidation {resp['Invalidation']['Id']} for {paths}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--which", choices=["s1m", "usgs13", "both"], default="both")
    ap.add_argument("--bucket", default=None, help="target bucket (default: derived from index_path)")
    ap.add_argument("--prefix", default="footprints", help="S3 key prefix (default: footprints)")
    ap.add_argument("--invalidate", action="store_true", help="create a CloudFront invalidation for the uploaded paths")
    ap.add_argument("--distribution-id", default=os.environ.get("EDGE_DISTRIBUTION_ID", None), help="CloudFront Distribution ID to invalidate")
    ap.add_argument("--dry-run", action="store_true", help="build + report sizes without uploading")
    ap.add_argument("--no-conus", dest="conus_only", action="store_false",
                    help="keep footprints outside CONUS (default: drop them — no NAIP there)")
    args = ap.parse_args()

    # Derived from the DEM index, not the imagery index. Footprints are served
    # by this deployment's own static bucket (the one CloudFront's /footprints/*
    # behavior points at), which is where the DEM index lives too. The lake is
    # a shared, requester-pays bucket this repo reads and does not own, so
    # defaulting there aimed uploads at someone else's storage.
    bucket = args.bucket or _bucket_from_s3_uri(settings.s1m_index_path)
    targets = ["s1m", "usgs13"] if args.which == "both" else [args.which]
    s1m_path = settings.s1m_index_path
    local_s1m = Path(__file__).resolve().parent.parent / "S1M_Products.parquet"
    if local_s1m.exists() and (not s1m_path.startswith("s3://") or args.dry_run):
        s1m_path = str(local_s1m)

    sources = {
        "s1m": (s1m_path, "s1m"),
        "usgs13": (str(USGS13_INDEX), "usgs13"),
    }

    print(f"building footprints -> s3://{bucket}/{args.prefix}/")
    invalidation_paths = []
    for name in targets:
        index_path, dtype = sources[name]
        print(f"[{name}] reading {index_path}")
        fc = build_geojson(index_path, dtype, settings.aws_region, conus_only=args.conus_only)
        key = f"{args.prefix}/{name}.json"
        upload(bucket, key, fc, args.dry_run)
        invalidation_paths.append(f"/{key}")

    if args.invalidate and not args.dry_run:
        invalidate(args.distribution_id, invalidation_paths)


if __name__ == "__main__":
    main()
