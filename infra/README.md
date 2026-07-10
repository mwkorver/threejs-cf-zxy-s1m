# Infrastructure (plan §3, §7)

Deploy shape reused from `deckgl-s3-cog-s1m`: **foundation → tiler → static
assets**, all in **us-west-2** (same region as `naip-analytic`, `prd-tnm`
etc., so requester-pays reads are same-region GET pennies — plan §2 row 10).

| Stack | Contents | Status |
|---|---|---|
| `foundation.yaml` | ECR repo, tile/static S3 bucket, shared IAM | TODO — port foundation pattern from existing repo |
| `tiler.yaml` | Lambda container (arm64) + IAM-auth Function URL | **deployed** (`flight-sim-tiler`, us-west-2); SAM builds + pushes the image to a managed ECR repo |
| `edge.yaml` | One CloudFront distribution, path-routed behaviors (§3): `/imagery/*` + `/terrain/*` → Function URL origin, `/buildings/*` + static pyramid → S3 origin | TODO — Phase 0 step 2 |

## Deploying the tiler

```sh
export DOCKER_HOST=unix:///Users/mwkorver/.colima/default/docker.sock  # this machine runs colima, not Docker Desktop
sam build -t infra/tiler.yaml
sam deploy --stack-name flight-sim-tiler --region us-west-2 \
  --resolve-s3 --resolve-image-repos --capabilities CAPABILITY_IAM \
  --no-confirm-changeset --no-fail-on-empty-changeset
```

The Function URL is `AWS_IAM`-authed (CloudFront OAC will sign origin requests),
so it can't be `curl`ed directly. Smoke-test by invoking the Lambda with a
Function-URL event: `aws lambda invoke --function-name <fn> --payload
'{"version":"2.0","rawPath":"/terrain/14/4794/6174.webp","requestContext":{"http":{"method":"GET"}}}' out.json`.

Runtime gotchas baked into the code (all Lambda-specific, worked locally):
- `Dockerfile` installs `expat` — GDAL/PROJ link `libexpat.so.1`, absent from the base image.
- `duck.py` sets DuckDB `home_directory=/tmp` on Lambda (HOME is empty; only /tmp is writable).
- `terrain.py` reads far-field `elevation-tiles-prod` (us-east-1) via `/vsicurl/` over the global
  endpoint — the us-west-2 Lambda otherwise gets a 301 GDAL won't follow.
- No `ReservedConcurrentExecutions`: this account's total concurrency limit is 10.

Cache policy notes (plan §4.1, §8):
- Path-only cache keys — **no query strings anywhere**.
- Tiles are immutable: `Cache-Control: public, max-age=31536000, immutable`.
- Origin shield + pre-genned z0–z12 pyramid are the cold-latency mitigations,
  in that order (§8); hot-tile write-behind only if Phase 0/1 p99 demands.
