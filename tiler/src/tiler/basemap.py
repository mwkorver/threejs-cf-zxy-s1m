"""Low-zoom basemap imagery = 512px stitch of 4 cached USDA NAIP tiles.

At low zoom the COG mosaic fan-out is slow and coverage-capped, so imagery
there comes from the USDA CONUS PRIME ImageServer's pre-rendered map cache
(EPSG:3857, XYZ scheme, 256px JPEG, LODs 0-17). We assemble the 2x2 z+1
children into one 512px tile server-side so the client gets a 512px texture
like everywhere else, and CloudFront caches the assembled result path-only.

Mirrors terrain.render_farfield_tile (which stitches 2x2 z+1 Terrarium
children). The upstream is public-domain USDA imagery; no key, no request-payer.
"""

import io
from concurrent.futures import ThreadPoolExecutor

import httpx
from PIL import Image

# ArcGIS cached tile URL: /tile/{level}/{row}/{col} == /tile/{z}/{y}/{x}.
_CONUS_PRIME = (
    "https://gis.apfo.usda.gov/arcgis/rest/services/NAIP/USDA_CONUS_PRIME"
    "/ImageServer/tile/{z}/{y}/{x}"
)
# Cache tops out at z17, so 512px assembly (children at z+1) is valid to z16.
BASEMAP_MAX_ZOOM = 16

_client = httpx.Client(
    timeout=httpx.Timeout(10.0),
    headers={"User-Agent": "flight-sim-tiler"},
    limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
)
_pool = ThreadPoolExecutor(max_workers=4)


def _fetch_child(z: int, x: int, y: int) -> "Image.Image | None":
    """One 256px child JPEG as a PIL image, or None if missing/not an image."""
    try:
        r = _client.get(_CONUS_PRIME.format(z=z, x=x, y=y))
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"):
            return None
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def render_basemap_tile(z: int, x: int, y: int, tilesize: int = 512, quality: int = 75) -> bytes | None:
    """512px WebP built from the 2x2 z+1 USDA cache children, or None if none exist."""
    src = tilesize // 2  # upstream tiles are 256px
    # (row, col) offsets -> child (x, y) at z+1.
    children = [
        (dj, di, 2 * x + di, 2 * y + dj)
        for dj in (0, 1)
        for di in (0, 1)
    ]
    imgs = list(_pool.map(lambda c: _fetch_child(z + 1, c[2], c[3]), children))

    if all(img is None for img in imgs):
        return None

    canvas = Image.new("RGB", (tilesize, tilesize))
    for (dj, di, _cx, _cy), img in zip(children, imgs):
        if img is not None:
            canvas.paste(img, (di * src, dj * src))

    buf = io.BytesIO()
    canvas.save(buf, format="WEBP", quality=quality)
    return buf.getvalue()
