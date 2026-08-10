"""Low-zoom basemap imagery = one 512px render from the USGS NAIP ImageServer.

At low zoom the COG mosaic fan-out is slow and coverage-capped, so imagery
there comes from an ArcGIS image service instead, rendered server-side into one
512px tile that CloudFront then caches path-only.

The upstream is https://imagery.nationalmap.gov (USGS), replacing the USDA
CONUS PRIME service this used to call. That one stopped completing TLS
handshakes -- "SSL: UNEXPECTED_EOF_WHILE_READING", reproduced from both Lambda
and a laptop on an unrelated network, so it was the service and not a block on
this account -- and every uncached basemap tile had been 503ing for days.

The two are not interchangeable, which is why this module changed shape rather
than just its URL. CONUS PRIME published a *pre-rendered tile cache*: this
fetched four 256px z+1 children over XYZ and stitched them 2x2. The USGS
service advertises `Image,Metadata,Catalog,Mensuration` with no tileInfo and no
singleFusedMapCache -- it has no tile endpoint at all (/tile/... 404s), only a
dynamic exportImage. So one request now renders the tile's own bbox at its full
size, which is both simpler and three fewer round trips.

Coverage is reported differently too, and the difference matters because the
result is cached immutably. The cache answered 404 for a tile it did not have;
exportImage always answers 200 and encodes absence as transparency, so "no
coverage" is now an all-zero alpha channel rather than a status code. Anything
partially covered is composited onto white, matching what the stitched version
did with its missing quadrants. A transient failure (timeout / 5xx / network)
is retried, and if it still fails the tile is failed (TransientBasemapError ->
503) rather than cached with a hole.
"""

import time
import warnings

import httpx
import numpy as np
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rio_tiler.utils import render

_USGS_NAIP = (
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery"
    "/ImageServer/exportImage"
)
# Web Mercator half-circumference: the XYZ grid's extent in EPSG:3857 metres.
_R = 20037508.342789244
# No longer an upstream limit -- a dynamic service has no LOD ceiling the way
# the old tile cache did (it topped out at z17, capping 512px assembly at z16).
# Kept as this endpoint's own guard: past here the COG mosaic is the right
# source, and the client routes to it well below this anyway.
BASEMAP_MAX_ZOOM = 16

# One request per tile now instead of four concurrent children, so a longer
# per-attempt timeout still leaves the 60s Lambda budget plenty of room --
# and it needs one, because exportImage renders on demand rather than serving
# something already baked.
_ATTEMPTS = 2
_TIMEOUT_S = 20.0
_client = httpx.Client(
    timeout=httpx.Timeout(_TIMEOUT_S),
    headers={"User-Agent": "flight-sim-tiler"},
    limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
)


class TransientBasemapError(Exception):
    """The tile could not be fetched (timeout/5xx/network) after retries.

    The endpoint turns this into a 503 so the client retries and the failed
    tile is never cached.
    """


def tile_bbox_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """(minx, miny, maxx, maxy) of an XYZ tile in EPSG:3857 metres."""
    span = 2 * _R / (2**z)
    minx = -_R + x * span
    maxy = _R - y * span
    return (minx, maxy - span, minx + span, maxy)


def _fetch_tile(z: int, x: int, y: int, tilesize: int) -> "np.ndarray | None":
    """(3, tilesize, tilesize) RGB on white, or None if wholly out of coverage.

    Raises TransientBasemapError if the upstream never answered usefully.
    """
    minx, miny, maxx, maxy = tile_bbox_3857(z, x, y)
    params = {
        "bbox": f"{minx},{miny},{maxx},{maxy}",
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{tilesize},{tilesize}",
        # png32 specifically, not png: ArcGIS drops to a 24-bit PNG when a
        # render happens to be fully opaque, and then there is no alpha band to
        # read coverage from. Forcing 32-bit keeps the response shape constant.
        "format": "png32",
        "transparent": "true",
        "f": "image",
    }

    last = "unknown"
    for attempt in range(_ATTEMPTS):
        try:
            r = _client.get(_USGS_NAIP, params=params)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", NotGeoreferencedWarning)
                    with MemoryFile(r.content) as mf, mf.open() as ds:
                        arr = ds.read()
                if arr.shape[0] < 4:
                    return arr[:3]  # no alpha band: fully covered
                alpha = arr[3]
                if not alpha.any():
                    return None  # nothing here (open ocean, outside CONUS)
                # Composite onto white, so partial coverage matches what the
                # stitched version left behind for its missing quadrants.
                rgb = arr[:3].astype(np.uint16)
                a16 = alpha.astype(np.uint16)
                out = (rgb * a16 + 255 * (255 - a16)) // 255
                return out.astype(np.uint8)
            last = f"HTTP {r.status_code}"  # 5xx / unexpected -> retry
        except Exception as e:  # timeout / network -> retry
            last = f"{type(e).__name__}: {e}"
        if attempt < _ATTEMPTS - 1:
            time.sleep(0.4 * (attempt + 1))
    raise TransientBasemapError(f"tile {z}/{x}/{y} failed: {last}")


def render_basemap_tile(z: int, x: int, y: int, tilesize: int = 512, quality: int = 75) -> bytes | None:
    """512px WebP rendered from the USGS NAIP image service.

    None if the tile is entirely out of coverage. Raises TransientBasemapError
    if the upstream failed transiently (caller -> 503).
    """
    arr = _fetch_tile(z, x, y, tilesize)
    if arr is None:
        return None
    return render(arr, img_format="WEBP", quality=quality)
