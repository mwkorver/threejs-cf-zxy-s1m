"""Shared test helpers.

tests/ has no __init__.py, so pytest puts this directory on sys.path and the
test modules import from here directly.
"""

import numpy as np


def decode_webp(body: bytes) -> np.ndarray:
    """WebP bytes -> HWC array, the shape both render paths' assertions want."""
    from rasterio.io import MemoryFile

    with MemoryFile(body) as m, m.open() as ds:
        return np.transpose(ds.read(), (1, 2, 0))
