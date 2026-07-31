"""Terrain tile rendering (plan §4.2, §10.5).

Two regimes behind one endpoint so the client speaks one terrain contract:

- z >= s1m_min_zoom (near field): read the S1M DEM (Albers EPSG:6350) via
  rio-tiler, warp to Web Mercator, encode Terrarium, lossless WebP. Vanilla
  512px registration, no overlap ring — seams are the client's job (skirts).
- z < s1m_min_zoom (far field): passthrough of elevation-tiles-prod, which is
  already 256px Terrarium. A 512px tile at z is exactly the four z+1 children
  at 256px, so this is a pure 2x2 pixel copy — same encoding by design, no
  elevation decode/re-encode, no conversion bugs at the boundary (plan §10.5).
"""

import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError
from rio_tiler.errors import EmptyMosaicError, TileOutsideBounds
from rio_tiler.io import Reader
from rio_tiler.mosaic import mosaic_reader
from rio_tiler.utils import render

from .encoding import encode_terrarium, S1M_NODATA

# elevation-tiles-prod is public and in us-east-1. Read it signed (Lambda role),
# like every other bucket. A signed request still needs the endpoint AND signing
# region pinned to us-east-1: the us-west-2 Lambda otherwise gets a virtual-
# hosted 301 that GDAL won't auto-recover (that recovery only fires for the
# path-style AuthorizationHeaderMalformed 400). No request-payer — public bucket.
FARFIELD_TEMPLATE = "s3://elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
_FARFIELD_ENV = {"AWS_S3_ENDPOINT": "s3.us-east-1.amazonaws.com", "AWS_REGION": "us-east-1"}

# Mirrors basemap._ATTEMPTS: transient child failures get one retry before the
# whole tile is failed rather than cached with a sea-level hole.
_FARFIELD_ATTEMPTS = 2

# GDAL wraps everything in RasterioIOError, so "genuinely absent" (edge of the
# pyramid's coverage -> sea-level fill is correct) is told apart from transient
# (network/5xx -> must NOT be baked into an immutable tile) by message. Only
# these markers mean absent; anything unrecognized is treated as transient, so
# an unknown failure mode 503s (visible, retryable) instead of silently
# poisoning the CDN cache.
_NOT_FOUND_MARKERS = ("404", "does not exist", "no such file")


class TransientTerrainError(Exception):
    """A far-field child fetch failed transiently (network/5xx) after retries.

    The endpoint turns this into a 503 so the client retries and the failed
    (partial) tile is never cached immutably with a sea-level hole.
    """


def _s1m_tile(href: str, x: int, y: int, z: int, tilesize: int) -> "object":
    with rasterio.Env(AWS_REQUEST_PAYER="requester"), Reader(href) as src:
        # Band 1 only; keep native float elevation (no rescale/expression).
        img = src.tile(x, y, z, tilesize=tilesize, indexes=(1,))
        # Some S1M COGs store nodata as a pixel value (e.g. -9999) without it
        # being reflected in the mask. Fold declared nodata + the S1M sentinel
        # into the mask HERE, per asset — mosaic_reader's pixel selection then
        # prefers the next asset's real data over a nodata pixel, and the merged
        # mask reaches _mosaic_elev (a custom attribute would not survive the
        # mosaic, which builds a new ImageData).
        data = img.array.data[0]
        invalid = data == S1M_NODATA
        if src.dataset.nodata is not None:
            invalid |= data == src.dataset.nodata
        if invalid.any():
            img.array.mask = np.logical_or(img.array.mask, invalid[np.newaxis, :, :])
        return img


def _mosaic_elev(hrefs: list[str], z: int, x: int, y: int, tilesize: int) -> "np.ndarray | None":
    """Mosaic DEM COGs into a float elevation array (NaN for void/uncovered), or None."""
    if not hrefs:
        return None
    try:
        img, _used = mosaic_reader(
            hrefs, _s1m_tile, x, y, z,
            tilesize=tilesize,
            allowed_exceptions=(TileOutsideBounds,),
            threads=min(len(hrefs), 4),
        )
    except EmptyMosaicError:
        # Footprints intersected but no pixels covered the tile: genuine
        # no-coverage, the caller falls through to the next DEM / 404s. Real
        # read failures (throttle, auth) propagate instead — a transient blip
        # must never become a cacheable 404 or a silent fall-through to a
        # coarser DEM.
        return None
    elev = img.data[0].astype(np.float64)
    # Void detection: mask convention is 0=masked, 255=valid. Per-COG declared
    # nodata and the S1M sentinel are already folded into this mask by
    # _s1m_tile, so the mask is the single source of truth post-mosaic.
    if img.mask is not None:
        elev = np.where(img.mask[0] == 0, np.nan, elev)
    # Belt-and-suspenders: the sentinel is always invalid even if unmasked.
    elev = np.where(elev == S1M_NODATA, np.nan, elev)
    return elev


def render_terrain_tile(
    s1m_hrefs: list[str],
    z: int,
    x: int,
    y: int,
    tilesize: int,
    fill_hrefs: "Callable[[], list[str]] | None" = None,
) -> bytes | None:
    """Near-field S1M terrain tile as lossless-WebP Terrarium, or None.

    S1M coverage is not seamless, so a tile straddling its edge has void pixels.
    Left as 0 m they form a huge cliff in relief. `fill_hrefs`, if given, is a
    lazy resolver (called only when voids exist) whose DEM — usgs13 — fills those
    pixels with real elevation, so the S1M edge blends instead of cliffing.
    """
    elev = _mosaic_elev(s1m_hrefs, z, x, y, tilesize)
    if elev is None:
        return None

    if fill_hrefs is not None:
        voids = np.isnan(elev)
        if voids.any():
            fill = _mosaic_elev(fill_hrefs(), z, x, y, tilesize)
            if fill is not None:
                elev = np.where(voids, fill, elev)

    rgb = encode_terrarium(elev)  # (H, W, 3) uint8
    # rio_tiler.render wants (bands, H, W); lossless WebP for exact elevations.
    return render(np.transpose(rgb, (2, 0, 1)), img_format="WEBP", lossless=True)


def _read_farfield_child(url: str) -> "np.ndarray | None":
    """(3, 256, 256) RGB, or None if the child genuinely doesn't exist (edge of
    coverage). Raises TransientTerrainError after retries on anything else.

    Enters its own rasterio.Env rather than inheriting one from the caller:
    GDAL config is thread-local, and render_farfield_tile fans these reads out
    across a thread pool, so an Env opened on the calling thread would not
    apply inside the workers — the us-east-1 endpoint/region pin in
    _FARFIELD_ENV would silently be lost and every read would 301.
    """
    last = "unknown"
    for attempt in range(_FARFIELD_ATTEMPTS):
        try:
            with rasterio.Env(**_FARFIELD_ENV), rasterio.open(url) as ds:
                return ds.read(indexes=[1, 2, 3])
        except RasterioIOError as e:
            msg = str(e)
            if any(m in msg.lower() for m in _NOT_FOUND_MARKERS):
                return None  # genuinely absent -> sea-level fill is correct
            last = msg  # transient (network/5xx) -> retry
        if attempt < _FARFIELD_ATTEMPTS - 1:
            time.sleep(0.4)
    raise TransientTerrainError(f"far-field child {url} failed: {last}")


def render_farfield_tile(z: int, x: int, y: int, tilesize: int) -> bytes | None:
    """512px far-field tile = 2x2 of z+1 elevation-tiles-prod 256px Terrarium.

    Pure pixel copy (same encoding), re-emitted as lossless WebP. Any missing
    child (edge of coverage) is filled with sea-level Terrarium (128,0,0); a
    transiently-failing child fails the WHOLE tile (TransientTerrainError ->
    503) so a hiccup never poisons an immutable tile with a sea-level hole."""
    src = tilesize // 2  # upstream tiles are 256px
    canvas = np.zeros((tilesize, tilesize, 3), dtype=np.uint8)
    canvas[..., 0] = 128  # sea-level default so gaps decode to 0 m

    # The four children are independent cross-region range reads (this runs in
    # us-west-2, elevation-tiles-prod is in us-east-1), so they go out together
    # instead of paying four serial round trips on the cold path. Threads, not
    # asyncio: rasterio exposes no async API and GDAL releases the GIL while
    # blocked on I/O. Each worker opens its own rasterio.Env — see
    # _read_farfield_child on why a shared one wouldn't reach them.
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {
            pool.submit(_read_farfield_child, FARFIELD_TEMPLATE.format(z=z + 1, x=cx, y=cy)): (dj, di)
            for dj, cy in enumerate((2 * y, 2 * y + 1))
            for di, cx in enumerate((2 * x, 2 * x + 1))
        }
        # Key every result off the quadrant it was SUBMITTED for. Completion
        # order is nondeterministic, so consuming these in finish order would
        # scatter children into the wrong quadrants.
        children: dict[tuple[int, int], "np.ndarray | None"] = {}
        transient: TransientTerrainError | None = None
        for fut, pos in pending.items():
            try:
                children[pos] = fut.result()
            except TransientTerrainError as e:
                # Keep draining: every worker must be joined before we bail, and
                # one transient child still fails the WHOLE tile (-> 503) rather
                # than baking a sea-level hole into a tile cached for a year.
                transient = transient or e
    if transient is not None:
        raise transient

    got_any = False
    for (dj, di), arr in children.items():
        if arr is None:
            continue  # missing child (edge of coverage) -> sea-level fill
        got_any = True
        r0, c0 = dj * src, di * src
        canvas[r0:r0 + src, c0:c0 + src, :] = np.transpose(arr, (1, 2, 0))
    if not got_any:
        return None
    return render(np.transpose(canvas, (2, 0, 1)), img_format="WEBP", lossless=True)
