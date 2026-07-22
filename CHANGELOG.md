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
- `LICENSE` (MIT), `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, and
  this changelog.
- Follow-DEM camera mode (AGL hold) and FlyTo trajectories.
- Velocity-vector prefetch: tiles are requested ahead along the flight vector
  rather than only under the camera.
- `core/tileUrls.ts` — one module owning every tile URL and the imagery-source
  routing rule, shared by the worker, the main-thread fallback, and the baked
  debug letter.
- `VITE_TILE_BASE_URL`, written into `client/.env.local` by
  `infra/deploy-edge.sh` from the edge stack's `DistributionDomain` output, so a
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

[Unreleased]: https://github.com/mwkorver/threejs-cf-zxy-s1m/commits/master
