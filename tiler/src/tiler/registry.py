"""Layer registry (plan §4.1, §5.2): per-layer maxzoom from gsd, read options.

Slimmed from deckgl-s3-cog-s1m's registry.yaml — the tiler only needs what
affects tile rendering. Lake partition ids match the source registry's
collection ids exactly.
"""

import math
from dataclasses import dataclass

# Web-Mercator ground resolution at z0 on the 256-px basis, meters/pixel at
# the equator (plan §5.2: table is 256-px basis; ÷ sec(lat) for ground m/px).
WEB_MERCATOR_BASE_RES = 156543.03392804097


def maxzoom_for_gsd(gsd: float, tile_size: int = 512) -> int:
    """Smallest zoom that fully resolves a source of the given gsd (meters).

    Requests beyond this 404 so the CDN never caches upsampled junk
    (plan §4.1). 512-px tiles carry 256-px resolution at z+1, hence the
    tile-size shift.
    """
    z256 = math.ceil(math.log2(WEB_MERCATOR_BASE_RES / gsd))
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


LAYERS: dict[str, Layer] = {
    # NAIP RGB visualization COGs (3-band uint8, JPEG, requester-pays), keyed to
    # the manifest-index collection=naip-visualization. Plan §5.2 says 60 cm-1 m,
    # but the lake shows 2022+ vintages at 30 cm (verified: nj/2023 gsd=0.3), so
    # maxzoom keys off that; older years resolve less detail. indexes=(1,2,3) =
    # the RGB bands.
    "naip-visualization": Layer("naip-visualization", "naip-visualization", min_gsd=0.3, indexes=(1, 2, 3)),
    # NJ statewide, public, ~15 cm, 16-bit samples (registry display.domain).
    "nj-imagery": Layer("nj-imagery", "nj-imagery", min_gsd=0.15, rescale=(0, 65535)),
}
