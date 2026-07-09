import numpy as np

from tiler.encoding import S1M_NODATA, decode_terrarium, encode_terrarium


def test_roundtrip_within_quantization():
    # Realistic CONUS elevations incl. below-sea-level (Death Valley) and NJ flats
    e = np.array([[-86.0, 0.0, 1.5], [123.456, 4418.0, 14.505]], dtype=np.float32)
    out = decode_terrarium(encode_terrarium(e))
    # Terrarium quantizes to 1/256 m
    assert np.allclose(out, e, atol=1.0 / 256.0 / 2.0 + 1e-6)


def test_known_value():
    # elevation 0 m -> (R*256 + G + B/256) == 32768 -> R=128, G=0, B=0
    rgb = encode_terrarium(np.array([[0.0]]))
    assert rgb[0, 0].tolist() == [128, 0, 0]


def test_nodata_and_nan_become_zero():
    e = np.array([[S1M_NODATA, np.nan]])
    out = decode_terrarium(encode_terrarium(e))
    assert np.allclose(out, 0.0)


def test_matches_terrarium_reference():
    # Cross-check against the published formula on random data:
    # far-field passthrough (plan §10.5) only works if we match it exactly.
    rng = np.random.default_rng(42)
    rgb = rng.integers(0, 256, size=(8, 8, 3), dtype=np.uint8)
    expected = (
        rgb[..., 0].astype(np.float64) * 256
        + rgb[..., 1]
        + rgb[..., 2] / 256.0
        - 32768.0
    )
    assert np.allclose(decode_terrarium(rgb), expected)
