"""Script to generate a small 256x256 GeoTIFF fixture for un-mocked rio-tiler tests."""

from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_bounds
import morecantile

def create_fixture():
    fixtures_dir = Path(__file__).parent
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    out_path = fixtures_dir / "test_raster.tif"

    # Use WebMercatorQuad tile (14, 3342, 6190) in Wyoming
    tms = morecantile.tms.get("WebMercatorQuad")
    tile = morecantile.Tile(x=3342, y=6190, z=14)
    bounds = tms.xy_bounds(tile)

    width, height = 256, 256
    transform = from_bounds(bounds.left, bounds.bottom, bounds.right, bounds.top, width, height)

    # Elevation data in float32: ramp from 1500m to 2500m
    data = np.linspace(1500.0, 2500.0, width * height, dtype=np.float32).reshape(height, width)

    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": np.float32,
        "crs": "EPSG:3857",
        "transform": transform,
        "nodata": -9999.0,
    }

    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)

    print(f"Created test raster at {out_path}")

if __name__ == "__main__":
    create_fixture()
