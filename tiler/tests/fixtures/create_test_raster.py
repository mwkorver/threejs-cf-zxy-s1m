"""Regenerates the fixtures for the un-mocked rio-tiler tests.

Two rasters, both covering exactly WebMercatorQuad tile 14/3342/6190 so a tile
read lands on them squarely and a misaligned read decodes as nodata:

  test_raster.tif   1-band float32 elevation ramp -- test_terrain.py
  test_imagery.tif  4-band uint8 RGBIR            -- test_imagery.py

Plain GeoTIFFs, not COGs: at one tile the internal tiling and overviews a COG
adds are never read, so they would only make the checked-in fixtures larger
without covering a different path. Both files are committed so the suite needs
no rasterio write support at runtime -- rerun this only if the tile, the
elevation range, or the band values the tests assert on change.

The imagery fixture is RGBIR rather than RGB on purpose. The naip-visualization
layer carries indexes=(1, 2, 3), and a 3-band source would make that selection a
no-op; with a 4th NIR band holding a distinct value, a test can prove the NIR
band was actually dropped.
"""

from pathlib import Path
import numpy as np
import rasterio
from rasterio.enums import ColorInterp
from rasterio.transform import from_bounds
import morecantile

# The tile both fixtures cover. Wyoming, inside the S1M group the demo flies.
TILE = morecantile.Tile(x=3342, y=6190, z=14)
SIZE = 256

# Per-band constants for the imagery fixture. Distinct so a band-order or
# band-selection bug shows up as a specific wrong colour rather than noise.
RGBIR = {"red": 200, "green": 120, "blue": 60, "nir": 250}


def _transform():
    tms = morecantile.tms.get("WebMercatorQuad")
    b = tms.xy_bounds(TILE)
    return from_bounds(b.left, b.bottom, b.right, b.top, SIZE, SIZE)


def create_terrain_fixture(fixtures_dir: Path) -> Path:
    out_path = fixtures_dir / "test_raster.tif"

    # Elevation in float32: ramp from 1500 m to 2500 m.
    data = np.linspace(1500.0, 2500.0, SIZE * SIZE, dtype=np.float32).reshape(SIZE, SIZE)

    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": np.float32,
        "crs": "EPSG:3857",
        "transform": _transform(),
        "nodata": -9999.0,
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)
    return out_path


def create_imagery_fixture(fixtures_dir: Path) -> Path:
    out_path = fixtures_dir / "test_imagery.tif"

    # Flat per-band constants: the test asserts on exact channel values, and
    # WebP at quality<100 is lossy, so a gradient would force wide tolerances
    # and stop the assertions from meaning much.
    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 4,
        "dtype": np.uint8,
        "crs": "EPSG:3857",
        "transform": _transform(),
    }
    with rasterio.open(out_path, "w", **profile) as dst:
        for i, name in enumerate(("red", "green", "blue", "nir"), start=1):
            dst.write(np.full((SIZE, SIZE), RGBIR[name], dtype=np.uint8), i)
        # Band 4 must be tagged undefined, not alpha. Left to itself GDAL reads
        # a 4th uint8 band as alpha, which makes the NIR constant become the
        # mask -- rio-tiler then reports mask=250 and renders a near-transparent
        # RGBA tile instead of opaque RGB. NAIP RGBIR COGs tag NIR undefined;
        # matching that is what makes this fixture represent the real source.
        dst.colorinterp = (
            ColorInterp.red,
            ColorInterp.green,
            ColorInterp.blue,
            ColorInterp.undefined,
        )
    return out_path


def create_fixture():
    fixtures_dir = Path(__file__).parent
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    for path in (create_terrain_fixture(fixtures_dir), create_imagery_fixture(fixtures_dir)):
        print(f"Created {path}")


if __name__ == "__main__":
    create_fixture()
