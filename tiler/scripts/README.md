# Tiler scripts

The tiler resolves tiles against indexes rather than scanning buckets. The
builders below rebuild them: occasional, run by hand, safe to re-run.

| Script | What | When |
|---|---|---|
| [`build_s1m_index.py`](build_s1m_index.py) | rebuilds `S1M_Products.parquet` — the DEM lookup `/terrain` resolves against | USGS publishes new or reissued S1M tiles |
| [`build_footprints.py`](build_footprints.py) | rebuilds the static DEM-coverage GeoJSON the SHOW DEM FOOTPRINTS overlay draws | after an S1M index rebuild |
| [`bake.py`](bake.py) | rebuilds `client/public/tiles/`, the offline tile set for local dev | rarely; only if the baked set drifts |
| [`preview.py`](preview.py) | renders adjacent tiles into an HTML swipe page, for eyeballing seams | debugging a tile boundary |
| [`deps_to_requirements.py`](deps_to_requirements.py) | writes pyproject deps to requirements.txt for the Dockerfile's cached layer | build tooling; not run by hand |

## The buildings index is NOT here

`/buildings` resolves against an index of Overture GeoParquet row groups, and
its builder lives in the sibling repo — because that is where the Overture lake
is maintained, and duplicating it here would mean two things to keep in step:

    ../deckgl-s3-cog-s1m/app/api/build_overture_buildings_index.py

You will need it. The index is a pointer into **one** Overture release, and
Overture deletes old releases as new ones land — at which point every building
tile answers `404 "no building coverage"` and buildings disappear everywhere,
with nothing wrong in this repo. That is not hypothetical: it happened in
August 2026 when release `2026-06-17.0` was retired.

The full procedure — including the two publish paths that must **both** be
written, and the figure to validate a rebuild against before publishing — is
under **"External dependencies, and how they fail"** in the
[root README](../../README.md).
