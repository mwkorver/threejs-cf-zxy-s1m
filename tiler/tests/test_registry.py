from tiler.registry import LAYERS, maxzoom_for_gsd


def test_maxzoom_matches_plan_table():
    # Plan §5.2 (256-px basis): NAIP 17-18, NJ 19-20, S1M(1m) 16-17.
    # Our 512 tiles shift each down by 1.
    assert maxzoom_for_gsd(0.6, tile_size=256) == 18  # NAIP
    assert maxzoom_for_gsd(0.15, tile_size=256) == 20  # NJ ~15cm
    assert maxzoom_for_gsd(1.0, tile_size=256) == 18
    assert maxzoom_for_gsd(0.08, tile_size=256) == 21  # Indiana 3-inch


def test_512_tiles_shift_maxzoom_down_one():
    for gsd in (0.08, 0.15, 0.6, 1.0):
        assert maxzoom_for_gsd(gsd, tile_size=512) == maxzoom_for_gsd(gsd, tile_size=256) - 1


def test_phase0_layers_present():
    assert LAYERS["naip-visualization"].maxzoom == 18  # 30 cm vintages (512-px basis)
    assert LAYERS["naip-visualization"].indexes == (1, 2, 3)  # RGB bands
    # NAIP is the only layer: the state imagery collections live in the source
    # repo's lake, not the canonical NAIP index this tiler reads.
    assert set(LAYERS) == {"naip-visualization"}
