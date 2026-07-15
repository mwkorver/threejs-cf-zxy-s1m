"""Low-zoom basemap imagery = 512px stitch of 4 cached USDA NAIP tiles.

At low zoom the COG mosaic fan-out is slow and coverage-capped, so imagery
there comes from the USDA CONUS PRIME ImageServer's pre-rendered map cache
(EPSG:3857, XYZ scheme, 256px JPEG, LODs 0-17). We assemble the 2x2 z+1
children into one 512px tile server-side so the client gets a 512px texture
like everywhere else, and CloudFront caches the assembled result path-only.

Mirrors terrain.render_farfield_tile (which stitches 2x2 z+1 Terrarium
children) and reuses the same rasterio/numpy/rio_tiler stack -- no new native
deps. The upstream is public-domain USDA imagery; no key, no request-payer.

Failure handling matters because the result is cached immutably: a child that
FETCHES but is out of coverage returns 404 (or a white nodata tile) -> that
quadrant is left white, matching the source. A child that fails transiently
(timeout / 5xx / network) is retried, and if it still fails the WHOLE tile is
failed (TransientBasemapError -> 503) rather than cached with a hole -- a
momentary upstream hiccup must not poison an immutable tile with black/blank.
"""

import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import httpx
import numpy as np
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rio_tiler.utils import render

# ArcGIS cached tile URL: /tile/{level}/{row}/{col} == /tile/{z}/{y}/{x}.
_CONUS_PRIME = (
    "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME"
    "/ImageServer/tile/{z}/{y}/{x}"
)
# Cache tops out at z17, so 512px assembly (children at z+1) is valid to z16.
BASEMAP_MAX_ZOOM = 16

# Per-attempt timeout kept low, x2 attempts x 4 concurrent children, so worst
# case stays well under the Lambda timeout.
_ATTEMPTS = 2
_client = httpx.Client(
    timeout=httpx.Timeout(8.0),
    headers={"User-Agent": "flight-sim-tiler"},
    limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
)
_pool = ThreadPoolExecutor(max_workers=4)


class TransientBasemapError(Exception):
    """A child could not be fetched (timeout/5xx/network) after retries.

    The endpoint turns this into a 503 so the client retries and the failed
    (partial) tile is never cached.
    """


def _fetch_child(z: int, x: int, y: int) -> "np.ndarray | None":
    """(3, 256, 256) RGB, or None if genuinely absent (404); raises on transient failure."""
    last = "unknown"
    for attempt in range(_ATTEMPTS):
        try:
            r = _client.get(_CONUS_PRIME.format(z=z, x=x, y=y))
            if r.status_code == 404:
                return None  # genuinely out of coverage (e.g. open ocean)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", NotGeoreferencedWarning)
                    with MemoryFile(r.content) as mf, mf.open() as ds:
                        return ds.read(indexes=[1, 2, 3])
            last = f"HTTP {r.status_code}"  # 5xx / unexpected -> retry
        except Exception as e:  # timeout / network -> retry
            last = f"{type(e).__name__}: {e}"
        if attempt < _ATTEMPTS - 1:
            time.sleep(0.4 * (attempt + 1))
    raise TransientBasemapError(f"child {z}/{x}/{y} failed: {last}")


def render_basemap_tile(z: int, x: int, y: int, tilesize: int = 512, quality: int = 75) -> bytes | None:
    """512px WebP from the 2x2 z+1 USDA cache children.

    None if the tile is entirely out of coverage (all children 404). Raises
    TransientBasemapError if any child failed transiently (caller -> 503).
    """
    src = tilesize // 2  # upstream tiles are 256px
    # (row, col) offsets -> child (x, y) at z+1.
    children = [
        (dj, di, 2 * x + di, 2 * y + dj)
        for dj in (0, 1)
        for di in (0, 1)
    ]
    # map() re-raises the first child exception (TransientBasemapError) here,
    # so a transient failure fails the whole tile instead of yielding a hole.
    arrs = list(_pool.map(lambda c: _fetch_child(z + 1, c[2], c[3]), children))

    if all(a is None for a in arrs):
        return None  # entirely out of coverage

    # White fill for absent (404) quadrants, matching CONUS PRIME's own nodata.
    canvas = np.full((3, tilesize, tilesize), 255, dtype=np.uint8)
    for (dj, di, _cx, _cy), arr in zip(children, arrs):
        if arr is not None:
            canvas[:, dj * src:dj * src + src, di * src:di * src + src] = arr

    return render(canvas, img_format="WEBP", quality=quality)
