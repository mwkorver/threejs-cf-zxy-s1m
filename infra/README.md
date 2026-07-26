# Infrastructure (plan [§3](../FLIGHT-SIM-PLAN.md#3-architecture), [§7](../FLIGHT-SIM-PLAN.md#7-reuse-from-deckgl-s3-cog-s1m))

Deploy shape reused from `deckgl-s3-cog-s1m`: **foundation → tiler → static
assets**, all in **us-west-2** (same region as `naip-analytic`, `prd-tnm`
etc., so requester-pays reads are same-region GET pennies — plan [§2 row 10](../FLIGHT-SIM-PLAN.md#2-locked-decisions)).

| Stack | Contents | Status |
|---|---|---|
| `foundation.yaml` | ECR repo, tile/static S3 bucket, shared IAM | TODO — port foundation pattern from existing repo |
| `tiler.yaml` | Lambda container (arm64) + IAM-auth Function URL | **deployed** (`flight-sim-tiler`, us-west-2); SAM builds + pushes the image to a managed ECR repo |
| `edge.yaml` | One CloudFront distribution: tiler Function URL origin via OAC, path-only immutable cache policy. `/buildings/*` + static pyramid → S3 origin come in Phase 1/2 | **deployed** (`flight-sim-edge`); tiles served unsigned over HTTPS, warm CDN hits ~0.1s |

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

## Deploying the edge (CloudFront)

```sh
# params come from the tiler stack outputs (FunctionUrlDomain, FunctionArn)
DOMAIN=$(aws cloudformation describe-stacks --stack-name flight-sim-tiler --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrlDomain'].OutputValue" --output text)
ARN=$(aws cloudformation describe-stacks --stack-name flight-sim-tiler --region us-west-2 \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionArn'].OutputValue" --output text)
aws cloudformation deploy --template-file infra/edge.yaml --stack-name flight-sim-edge \
  --region us-west-2 --capabilities CAPABILITY_IAM \
  --parameter-overrides "TilerFunctionUrlDomain=$DOMAIN" "TilerFunctionArn=$ARN"
```

Then tiles are public over unsigned HTTPS at
`https://<DistributionDomain>/terrain/{z}/{x}/{y}.webp` etc.

## Static footprints (`/footprints/*`)

DEM footprints are scale-free vectors and the whole CONUS set is tiny
(~360 KB gzipped), so they aren't tiled or queried per-viewport. Two static,
immutable files are pre-genned and served straight from S3 (no Lambda) via the
edge's `/footprints/*` behavior (S3 origin + OAC, `edge.yaml`):

| File | Features | Gzipped | Rebuild |
|---|---|---|---|
| `footprints/s1m.json` | ~10.3k | ~327 KB | when new S1M COGs are indexed |
| `footprints/usgs13.json` | ~1.4k | ~30 KB | ≈ never (static) |

The client fetches both once and clips client-side. Regenerate + bust the CDN:

```sh
cd tiler
# after new S1M coverage lands (rebuilds just s1m.json and invalidates it):
.venv/bin/python scripts/build_footprints.py --which s1m --invalidate
# first-time / full run:
.venv/bin/python scripts/build_footprints.py --which both --invalidate
```

OAC gotcha (cost an afternoon): CloudFront OAC → an `AWS_IAM` Function URL needs
the role granted **both** `lambda:InvokeFunctionUrl` **and** `lambda:InvokeFunction`
for `cloudfront.amazonaws.com`. With only the former, every request 403s
`{"Message":"Forbidden"}` at the Function URL — edge.yaml grants both.

Cache policy notes (plan [§4.1](../FLIGHT-SIM-PLAN.md#41-imagery), [§8](../FLIGHT-SIM-PLAN.md#8-cost--risk-notes)):
- Path-only cache keys — **no query strings anywhere**.
- Tiles are immutable: `Cache-Control: public, max-age=31536000, immutable`.
- Origin shield + pre-genned z0–z12 pyramid are the cold-latency mitigations,
  in that order ([§8](../FLIGHT-SIM-PLAN.md#8-cost--risk-notes)); hot-tile write-behind only if Phase 0/1 p99 demands.
