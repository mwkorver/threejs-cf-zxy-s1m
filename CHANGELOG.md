# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No releases are tagged yet — the project is pre-1.0 and everything below is
unreleased.

## [Unreleased]

### Added

- GitHub Actions CI (`.github/workflows/ci.yml`): `tsc` typecheck and Vitest for
  the TypeScript client; Ruff and pytest for the Python tiler. Both suites are
  hermetic — all S3/HTTP reads are mocked, so CI needs no AWS credentials.
- Ruff linting (`E9` + `F`), scoped so a lint failure always means something is
  actually broken rather than merely unfashionable.
- `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, and this changelog.
- Foundation seed bucket pattern: a new account's deployment provisions its own
  `threejs-cf-zxy-s1m-<account>-<region>` static bucket and seeds the DEM index
  and footprints from a shared public, requester-pays bucket, so the demo can be
  stood up in an account that has none of this data.
- The compiled web app is served from CloudFront rather than only run locally —
  the same distribution now fronts both the app and the tile API.
- GeoParquet v2 (native `GEOMETRY` column) for the S1M DEM index.
- Follow-DEM camera mode (AGL hold) and FlyTo trajectories.
- Velocity-vector prefetch: tiles are requested ahead along the flight vector
  rather than only under the camera.
- `core/tileUrls.ts` — one module owning every tile URL and the imagery-source
  routing rule, shared by the worker, the main-thread fallback, and the baked
  debug letter.
- `VITE_TILE_BASE_URL`, written into `client/.env.local` by
  `infra/deploy.sh` from the edge stack's `DistributionDomain` output, so a
  recreated distribution no longer needs a source edit.
- Hard maxzoom cap on `/terrain` (`TILER_TERRAIN_MAX_ZOOM`, default 18),
  mirroring the imagery endpoint.

### Changed

- Hypsometric tinting defaults to local-to-viewport bounds; imagery brightness
  defaults to 1.75.
- Stale transition tiles are bounded by a per-node TTL, fixing coarse terrain
  "bleeding" through fine terrain on fast zoom-in.
- README restructured, and the architecture diagram redrawn as a request
  sequence so the cache boundary — warm tiles never reach the Lambda — is
  visible rather than implied.
- Far-field terrain stitches its four upstream children concurrently instead of
  in sequence. They are cross-region reads (us-east-1 source, us-west-2
  Lambda), so this removes three serial round trips from the cold path. Each
  worker opens its own `rasterio.Env` — GDAL config is thread-local, so a
  shared one would not reach the pool.
- The mosaic resolver's tile query binds its envelope, year and row cap instead
  of formatting them into the SQL, so DuckDB sees one reusable prepared
  statement rather than a new string per tile, and derives the asset href once
  in a CTE instead of recomputing the same JSON extraction four times per row.
- Dependency extraction in the tiler `Dockerfile` moved out of an inline
  `python -c` one-liner into `scripts/deps_to_requirements.py`.
- `requires-python` relaxed to `>=3.12` (was `>=3.12,<3.13`). CI still pins
  3.12, which is what the Lambda base image ships.

### Fixed

- Transient upstream failures no longer poison immutable tiles. A far-field
  child read that fails transiently (network/5xx) is retried and then fails the
  whole tile with `503 Retry-After`, instead of baking a sea-level hole into a
  tile cached for a year. Unknown failure modes fail toward 503.
- Real mosaic read errors (throttling, expired credentials) propagate as 5xx
  instead of masquerading as "no coverage" and silently falling through to a
  coarser DEM or a cacheable 404.
- `sec(lat)` scale audit: the LOD frustum box and distance test were computed in
  true metres while the world is in Mercator metres.
- `deploy-edge.sh` silently pinned an existing stack to whatever static bucket
  it was first deployed with. `aws cloudformation deploy` carries forward the
  previous value of any parameter left out of `--parameter-overrides`, so the
  per-account bucket could never take over on an already-deployed stack.
- S1M index builder: a CRS check that had been loosened to a name/proj4
  substring match (which would also accept a different-datum Albers) is back to
  comparing exact projection parameters, and the index is written with a
  row-group size that lets statistics-based pruning work.
- Over-broad IAM: the tiler's S3 policy matched a `threejs-cf-zxy-s1m-*` prefix.
  S3 bucket names are globally unique across all AWS accounts, so that also
  matched buckets belonging to anyone else; it is now the exact bucket ARN.
- A blanket `AWS_REQUEST_PAYER` environment variable on the tiler Lambda made
  the per-asset requester-pays scoping in `imagery.py`/`terrain.py` dead code.

### Removed

- The `?usgs_min_zoom` / `?s1m_min_zoom` DEM-band query parameters and the HUD
  sliders driving them. CloudFront's path-only cache policy stripped them, so
  they only ever worked against a local tiler — and they varied tile *content*
  independently of the cache key, which would have become a cache-poisoning
  vector had that policy changed. The bands remain configurable through
  `TILER_USGS_MIN_ZOOM` / `TILER_S1M_MIN_ZOOM`.
- Dead `tileLoader` imports in `tileManager`, two unused `rasterio` imports, and
  an unused mock binding (replaced with a real assertion that path parameters
  reach the renderer in `z/x/y` order).
- `map-viewer/index.html` — an unrelated Japan GSI imagery viewer that shared
  nothing with this project and was referenced from nowhere in the repo.
- `CODE_OF_CONDUCT.md`. A Contributor Covenant governs a contributor community
  this repo explicitly says it does not have (`CONTRIBUTING.md`: "PRs and
  support requests are not reviewed"). `SECURITY.md` lost its response-time
  promise for the same reason.

[Unreleased]: https://github.com/mwkorver/threejs-cf-zxy-s1m/commits/master
