# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's built-in tool:
**Security → Report a vulnerability**
(https://github.com/mwkorver/threejs-cf-zxy-s1m/security/advisories/new).
This keeps the report confidential until a fix is available.

Please include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- affected component (client, tiler, infra) and version/commit.

This is a personal prototype, not a maintained product — see
[CONTRIBUTING.md](CONTRIBUTING.md). Reports are read, but no response time is
promised. If something here is genuinely exploitable, please report it anyway;
the scope notes below say what would actually be interesting.

## Scope notes

This project runs a public read-only tile API in front of public and
requester-pays data on Amazon S3. Findings that are especially in scope:

- **Cache-key correctness.** Tiles are served
  `Cache-Control: public, max-age=31536000, immutable` behind a CloudFront
  policy with `QueryStringBehavior: none`. Any path by which request-controlled
  input changes what a tile *contains* without changing its cache key is a
  cache-poisoning bug — see `tiler/tests/test_app.py::test_terrain_ignores_dem_band_query_params`.
- **Unbounded cache-key space.** Endpoints 404 above their source's native
  resolution so an attacker can't mint unlimited distinct keys, each triggering
  an expensive cold render (`tiler/src/tiler/app.py`).
- **Credential handling and IAM scope** in the tiler Lambda — the S3 read policy
  and the requester-pays scoping in `infra/lib/tiler-stack.ts` and
  `tiler/src/tiler/imagery.py`.
- **CloudFront origin access.** The OAC configuration, the Lambda Function URL
  invoke permissions, and the static bucket policy — which grants the
  distribution read over the whole bucket, since one origin serves both the
  compiled web app and `footprints/*`.
- **SQL construction** against the DuckDB GeoParquet indexes
  (`tiler/src/tiler/resolver.py`).

Explicitly **out of scope**:

- **The dev tile access key** (`?k=`, `infra/lib/edge-stack.ts`). It is not a secret by
  design: it ships in the client bundle and is visible in devtools. It exists
  only to keep crawlers and shared links from burning requester-pays reads on a
  dev distribution. Reporting that it is discoverable is expected behavior, not
  a vulnerability.
- **Costs incurred by running this against requester-pays buckets.** NAIP reads
  are billed to the caller; that is how the architecture works.
