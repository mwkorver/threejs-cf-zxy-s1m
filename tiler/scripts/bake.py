#!/usr/bin/env python3
"""Bake a small block of imagery + terrain tiles to disk for the client spike.

    python scripts/bake.py 40.48 -74.66 14 --grid 4 --out ../client/public/tiles

Writes real tiles under {out}/imagery/{layer}/{year}/{z}/{x}/{y}.webp and
{out}/terrain/{z}/{x}/{y}.webp so the client (and the engine spike, plan
§10.2) can fetch them instantly over Vite's static server instead of paying
cold tiler latency on every frame. Needs AWS creds.
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from tiler.imagery import render_imagery_tile  # noqa: E402
from tiler.registry import LAYERS  # noqa: E402
from tiler.resolver import TMS, MosaicResolver, DemIndexResolver  # noqa: E402
from tiler.settings import settings  # noqa: E402
from tiler.terrain import render_terrain_tile  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("zoom", type=int)
    ap.add_argument("--layer", default="naip-visualization", choices=sorted(LAYERS))
    ap.add_argument("--year", type=int, default=2023)
    ap.add_argument("--grid", type=int, default=4, help="NxN block centered on the point")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "client/public/tiles")
    args = ap.parse_args()

    z = args.zoom
    center = TMS.tile(args.lon, args.lat, z)
    half = args.grid // 2
    coords = [
        (center.x + dx, center.y + dy)
        for dy in range(-half, args.grid - half)
        for dx in range(-half, args.grid - half)
    ]
    layer = LAYERS[args.layer]
    mr = MosaicResolver(settings.lake_path, settings.aws_region)
    sr = DemIndexResolver(settings.s1m_index_path, settings.aws_region)

    # DuckDB connections aren't thread-safe: resolve sequentially, render in
    # parallel (rio-tiler S3 reads are the slow, thread-safe part).
    t0 = time.time()
    img_hrefs = {xy: mr.resolve(layer.collection, args.year, z, *xy) for xy in coords}
    ter_hrefs = {xy: sr.resolve(z, *xy) for xy in coords}
    print(f"resolved {2 * len(coords)} tiles in {time.time() - t0:.1f}s")

    img_dir = args.out / "imagery" / args.layer / str(args.year) / str(z)
    ter_dir = args.out / "terrain" / str(z)
    img_dir.mkdir(parents=True, exist_ok=True)
    ter_dir.mkdir(parents=True, exist_ok=True)

    def bake_img(xy):
        b = render_imagery_tile(img_hrefs[xy], layer, z, xy[0], xy[1], 512, 75)
        if b:
            (img_dir / f"{xy[0]}").mkdir(exist_ok=True)
            (img_dir / f"{xy[0]}" / f"{xy[1]}.webp").write_bytes(b)
        return b is not None

    def bake_ter(xy):
        b = render_terrain_tile(ter_hrefs[xy], z, xy[0], xy[1], 512)
        if b:
            (ter_dir / f"{xy[0]}").mkdir(exist_ok=True)
            (ter_dir / f"{xy[0]}" / f"{xy[1]}.webp").write_bytes(b)
        return b is not None

    t1 = time.time()
    with ThreadPoolExecutor(16) as ex:
        img_ok = sum(ex.map(bake_img, coords))
        ter_ok = sum(ex.map(bake_ter, coords))
    print(f"baked in {time.time() - t1:.1f}s -> imagery {img_ok}/{len(coords)}, terrain {ter_ok}/{len(coords)}")

    # Manifest the client reads to know what's available without probing.
    xs = sorted({c[0] for c in coords})
    ys = sorted({c[1] for c in coords})
    manifest = (
        f'{{"layer":"{args.layer}","year":{args.year},"z":{z},'
        f'"x":[{xs[0]},{xs[-1]}],"y":[{ys[0]},{ys[-1]}],'
        f'"center":{{"lat":{args.lat},"lon":{args.lon}}}}}\n'
    )
    (args.out / "manifest.json").write_text(manifest)
    print(f"wrote {args.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
