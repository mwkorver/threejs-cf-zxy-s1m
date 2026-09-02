"""Shared test helpers.

tests/ has no __init__.py, so pytest puts this directory on sys.path and the
test modules import from here directly.
"""

import warnings

import numpy as np
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile


def decode_webp(body: bytes) -> np.ndarray:
    """WebP bytes -> HWC array, the shape both render paths' assertions want.

    The suppression is deliberate and narrow. What is being opened here is a
    rendered tile -- an image, with no geotransform to have -- so rasterio is
    right to warn and the warning means nothing. Silenced at this call rather
    than through a filterwarnings entry in pyproject, which would also hide it
    if it ever fired somewhere it matters: terrain.py opens real COGs, and one
    of those arriving ungeoreferenced is a bug worth hearing about. Same
    treatment basemap.py gives its own decode.
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with MemoryFile(body) as m, m.open() as ds:
            return np.transpose(ds.read(), (1, 2, 0))
