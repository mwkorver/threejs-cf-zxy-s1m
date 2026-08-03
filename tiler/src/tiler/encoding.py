"""Terrarium Terrain-RGB packing (settled: Terrarium, not Mapbox Terrain-RGB).

    elevation = (R * 256 + G + B / 256) - 32768

Matches s3://elevation-tiles-prod exactly, so far-field passthrough is pure
pixel copying and the client runs one decoder everywhere. Tiles carrying this
encoding MUST be losslessly compressed.
"""

import numpy as np

TERRARIUM_OFFSET = 32768.0

# S1M nodata. Encoded as 0 m for now; revisit void-fill vs
# transparency in Phase 0 when real coverage gaps are on screen.
S1M_NODATA = -999999.0


def encode_terrarium(elevation: np.ndarray) -> np.ndarray:
    """Float32 elevation (meters) -> (H, W, 3) uint8 Terrarium RGB.

    Quantizes to 1/256 m. Input NaNs and S1M nodata become 0 m.
    """
    e = np.asarray(elevation, dtype=np.float64)
    e = np.where(np.isnan(e) | (e == S1M_NODATA), 0.0, e)
    v = np.clip((e + TERRARIUM_OFFSET) * 256.0, 0, 2**24 - 1)
    v = np.round(v).astype(np.uint32)
    rgb = np.empty((*e.shape, 3), dtype=np.uint8)
    rgb[..., 0] = (v >> 16) & 0xFF
    rgb[..., 1] = (v >> 8) & 0xFF
    rgb[..., 2] = v & 0xFF
    return rgb


def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    """(H, W, 3) uint8 Terrarium RGB -> float32 elevation (meters)."""
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)
    return r * 256.0 + g + b / 256.0 - TERRARIUM_OFFSET
