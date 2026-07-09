#!/usr/bin/env python3
"""Tile inspector: render a grid of adjacent imagery + terrain tiles for a
location and write a self-contained HTML swipe-comparison page.

    python scripts/preview.py 40.48 -74.66 15
    python scripts/preview.py 40.48 -74.66 15 --layer naip --year 2023 --grid 3

Both layers ride the same z/x/y quadtree, so the output shows them registering
pixel-for-pixel and adjacent tiles meeting with no seam. The terrain side is
hillshaded from the tile's *decoded* Terrarium elevation, so it also verifies
the S1M encode/decode round-trip. Needs AWS creds (lake + NAIP reads).
"""

import argparse
import base64
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.io import MemoryFile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from tiler.encoding import decode_terrarium  # noqa: E402
from tiler.imagery import render_imagery_tile  # noqa: E402
from tiler.registry import LAYERS  # noqa: E402
from tiler.resolver import TMS, MosaicResolver, S1MResolver  # noqa: E402
from tiler.settings import settings  # noqa: E402
from tiler.terrain import render_terrain_tile  # noqa: E402

TEMPLATE = Path(__file__).parent / "preview_template.html"


def _decode_webp(body: bytes) -> np.ndarray:
    with MemoryFile(body) as m, m.open() as ds:
        return np.transpose(ds.read(), (1, 2, 0))


def _hillshade(elev: np.ndarray, az_deg=315.0, alt_deg=45.0) -> np.ndarray:
    dy, dx = np.gradient(elev)
    slope = np.pi / 2 - np.arctan(np.hypot(dx, dy))
    aspect = np.arctan2(-dx, dy)
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    hs = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    return (np.clip(hs, 0, 1) * 255).astype(np.uint8)


def _data_uri(arr: np.ndarray, fmt: str, count: int, quality: int | None = None) -> str:
    profile = dict(driver=fmt, height=arr.shape[-2], width=arr.shape[-1], count=count, dtype="uint8")
    if quality is not None:
        profile["quality"] = quality
    payload = arr if arr.ndim == 3 else arr[np.newaxis]
    with MemoryFile() as m:
        with m.open(**profile) as ds:
            ds.write(payload)
        body = m.read()
    mime = "jpeg" if fmt == "JPEG" else "png"
    return f"data:image/{mime};base64," + base64.b64encode(body).decode()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("zoom", type=int)
    ap.add_argument("--layer", default="naip", choices=sorted(LAYERS))
    ap.add_argument("--year", type=int, default=2023)
    ap.add_argument("--grid", type=int, default=3, help="odd N for an NxN block centered on the point")
    ap.add_argument("--out", type=Path, default=Path("tile_preview.html"))
    args = ap.parse_args()

    z = args.zoom
    center = TMS.tile(args.lon, args.lat, z)
    half = args.grid // 2
    rng = range(-half, half + 1)
    coords = [(center.x + dx, center.y + dy) for dy in rng for dx in rng]
    px = args.grid * 512

    mr = MosaicResolver(settings.lake_path, settings.aws_region)
    sr = S1MResolver(settings.s1m_index_path, settings.aws_region)
    layer = LAYERS[args.layer]

    # DuckDB connections are not thread-safe: resolve sequentially, then render
    # in parallel (rio-tiler S3 reads are the slow, thread-safe part).
    t0 = time.time()
    img_hrefs = {xy: mr.resolve(layer.collection, args.year, z, xy[0], xy[1]) for xy in coords}
    ter_hrefs = {xy: sr.resolve(z, xy[0], xy[1]) for xy in coords}
    print(f"resolved {2 * len(coords)} tiles in {time.time() - t0:.1f}s")

    def r_img(xy):
        b = render_imagery_tile(img_hrefs[xy], layer, z, xy[0], xy[1], 512, 75)
        return xy, (_decode_webp(b) if b else None)

    def r_ter(xy):
        b = render_terrain_tile(ter_hrefs[xy], z, xy[0], xy[1], 512)
        return xy, (decode_terrarium(_decode_webp(b)) if b else None)

    t1 = time.time()
    with ThreadPoolExecutor(16) as ex:
        imgs = dict(ex.map(r_img, coords))
        ters = dict(ex.map(r_ter, coords))
    print(f"rendered {2 * len(coords)} tiles in {time.time() - t1:.1f}s")

    img_cov = sum(v is not None for v in imgs.values())
    ter_cov = sum(v is not None for v in ters.values())
    print(f"coverage: imagery {img_cov}/{len(coords)}, terrain {ter_cov}/{len(coords)}")

    mosaic_img = np.zeros((px, px, 3), np.uint8)
    mosaic_elev = np.zeros((px, px))
    for i, xy in enumerate(coords):
        r, c = (i // args.grid) * 512, (i % args.grid) * 512
        if imgs[xy] is not None:
            mosaic_img[r:r + 512, c:c + 512] = imgs[xy]
        if ters[xy] is not None:
            mosaic_elev[r:r + 512, c:c + 512] = ters[xy]

    valid = mosaic_elev > 0
    emin, emax = (mosaic_elev[valid].min(), mosaic_elev[valid].max()) if valid.any() else (0.0, 0.0)
    hs = _hillshade(mosaic_elev)

    # Downscale for a lighter page (block-average when evenly divisible).
    def maybe_half(a):
        if a.shape[-2] % 2 == 0 and a.shape[-1] % 2 == 0:
            if a.ndim == 3:
                return a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2, 3).mean((1, 3)).astype(np.uint8)
            return a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2).mean((1, 3)).astype(np.uint8)
        return a

    img_uri = _data_uri(np.transpose(maybe_half(mosaic_img), (2, 0, 1)), "JPEG", 3, quality=82)
    hs_uri = _data_uri(maybe_half(hs), "PNG", 1)

    xs = sorted({c[0] for c in coords})
    ys = sorted({c[1] for c in coords})
    subs = {
        "__IMG__": img_uri,
        "__HS__": hs_uri,
        "__LAT__": f"{args.lat:.2f}",
        "__LON__": f"{args.lon:.2f}",
        "__Z__": str(z),
        "__NTILE__": str(len(coords)),
        "__GRID__": str(args.grid),
        "__XR__": f"{xs[0]}–{xs[-1]}",
        "__YR__": f"{ys[0]}–{ys[-1]}",
        "__LAYER__": args.layer,
        "__YEAR__": str(args.year),
        "__ELEV__": f"{emin:.1f}–{emax:.1f} m",
    }
    html = TEMPLATE.read_text()
    for k, v in subs.items():
        html = html.replace(k, v)
    args.out.write_text(html)
    print(f"wrote {args.out} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
