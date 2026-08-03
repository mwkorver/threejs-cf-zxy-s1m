"""Layer registry: per-layer maxzoom from gsd, read options.

Slimmed from deckgl-s3-cog-s1m's registry.yaml — the tiler only needs what
affects tile rendering. Lake partition ids match the source registry's
collection ids exactly.
"""

import math
from dataclasses import dataclass

import morecantile

# The tile grid itself is the authority on zoom<->resolution; don't restate its
# constants here: its table is on the 256-px basis, and ground m/px needs a
# further ÷ sec(lat).
TMS = morecantile.tms.get("WebMercatorQuad")


def maxzoom_for_gsd(gsd: float, tile_size: int = 512) -> int:
    """Smallest zoom that fully resolves a source of the given gsd (meters).

    Requests beyond this 404 so the CDN never caches upsampled junk. The TMS is
    on the 256-px basis and a 512-px tile carries 256-px resolution at z+1,
    hence the tile-size shift.

    `zoom_level_strategy="upper"` takes the finer zoom when a gsd falls between
    two levels, so a source is never under-resolved.
    """
    z256 = TMS.zoom_for_res(gsd, zoom_level_strategy="upper")
    return z256 - int(math.log2(tile_size // 256))


@dataclass(frozen=True)
class Layer:
    id: str
    collection: str  # lake partition id
    min_gsd: float  # finest gsd in the collection -> maxzoom
    indexes: tuple[int, ...] | None = None  # band selection (NAIP is RGBIR)
    rescale: tuple[float, float] | None = None  # source domain -> uint8

    @property
    def maxzoom(self) -> int:
        return maxzoom_for_gsd(self.min_gsd)


# NAIP only. State imagery collections (nj-imagery, in-imagery, kyfromabove)
# live in deckgl-s3-cog-s1m's lake and were dropped here so this tiler reads a
# single canonical index; see settings.lake_path.
LAYERS: dict[str, Layer] = {
    # NAIP RGB visualization COGs (3-band uint8, JPEG, requester-pays), keyed to
    # the manifest-index collection=naip-visualization. NAIP is usually quoted
    # at 60 cm-1 m, but the lake shows 2022+ vintages at 30 cm (verified:
    # nj/2023 gsd=0.3), so maxzoom keys off that; older years resolve less
    # detail. indexes=(1,2,3) = the RGB bands of an RGBIR source.
    "naip-visualization": Layer("naip-visualization", "naip-visualization", min_gsd=0.3, indexes=(1, 2, 3)),
}
