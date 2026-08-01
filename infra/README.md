# Infrastructure (plan [§3](../FLIGHT-SIM-PLAN.md#3-architecture), [§7](../FLIGHT-SIM-PLAN.md#7-reuse-from-deckgl-s3-cog-s1m))

Two CDK stacks — **tiler → edge** — all in **us-west-2**, the region holding
the GeoParquet lake and the source COG buckets (`naip-visualization`,
`prd-tnm`), so requester-pays reads are same-region GET pennies (plan
[§2 row 10](../FLIGHT-SIM-PLAN.md#2-locked-decisions)).

The original plan called for a separate `foundation.yaml` to provision a shared
ECR repo and static bucket up front; that stack was never built and isn't
needed. CDK's bootstrap covers the ECR/staging side per account, and the edge
stack provisions the per-account static bucket itself
(`threejs-cf-zxy-s1m-<account>-<region>`), seeded on first deploy from one
shared public, requester-pays bucket (`mwkorver-foundation-us-west-2`) holding
the master DEM index and footprints.

| Stack | Contents |
|---|---|
| `flight-sim-tiler` (`lib/tiler-stack.ts`) | Lambda container (arm64) + IAM-auth Function URL. CDK builds and pushes the image. |
| `flight-sim-edge` (`lib/edge-stack.ts`) | One CloudFront distribution — tiler Function URL origin via OAC, path-only immutable cache policy — plus the account's static/DEM-index bucket. |

## Deploying

```bash
infra/deploy.sh
```

Builds the client, deploys both stacks, seeds the static bucket on first run,
uploads `client/dist/`, and mirrors the access key and distribution domain into
`client/.env.local`. Reads the dev key from `$TILE_ACCESS_KEY` or the gitignored
repo-root `.tile-key`.

### The distribution is disabled by default

`deploy.sh` deploys the CloudFront distribution **not serving**. Turn it on only
while you need it:

```bash
DEMO_ENABLED=true infra/deploy.sh          # deploy and serve
infra/deploy.sh                            # deploy and stop serving
```

Or without a full deploy:

```bash
cd infra && npx cdk deploy flight-sim-edge -c demoEnabled=true \
  --parameters "flight-sim-edge:TileAccessKey=$(tr -d '[:space:]' < ../.tile-key)"
```

Why off by default: the `?k=` gate stops crawlers, not people. `index.html` and
`/assets/*` are ungated and the key is baked into the bundle they serve, so
anyone holding the distribution domain has a working demo, and every tile miss
is a requester-pays read billed here. Being reachable is a deliberate act.

Disabled costs nothing and keeps the stack, the bucket and the seeded DEM index
intact, so re-enabling is one deploy rather than a rebuild. It is also the
required first step before a distribution can be deleted at all. Either flip
takes **~15 minutes** to propagate — do it before the meeting, not during it.

First time in a new account, bootstrap CDK once:

```bash
npx cdk bootstrap aws://<account-id>/us-west-2
```

On a machine running colima rather than Docker Desktop, point the Docker client
at colima's socket first — CDK builds the tiler image locally:

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
```

`.github/workflows/deploy.yml` does the same from CI (manual dispatch only),
authenticating through GitHub OIDC — no stored AWS access keys.

### CI deploy setup (one time)

`flight-sim-github-oidc` (`lib/github-oidc-stack.ts`) holds the OIDC provider
and the role CI assumes. Deploy it **from a workstation** — it creates the role
CI logs in with, so CI can't be what creates it — and it is deliberately not
part of `deploy.sh` or the workflow's stack choices:

```bash
cd infra && npx cdk deploy flight-sim-github-oidc
```

Then set two repo secrets from its `DeployRoleArn` output and your `.tile-key`:

```bash
gh secret set AWS_DEPLOY_ROLE_ARN --body "arn:aws:iam::<account>:role/flight-sim-github-deploy"
gh secret set TILE_ACCESS_KEY --body "$(tr -d '[:space:]' < .tile-key)"
```

Two things the trust policy depends on, both easy to break:

- The role trusts exactly `repo:<owner>/<repo>:environment:production`, matched
  with `StringEquals`. **Removing `environment: production` from the workflow
  job changes the OIDC subject claim and auth will start failing** with an
  unhelpful STS error. Wildcards are avoided on purpose here — `repo:owner/*`
  would let any repo under the account's owner assume this role.
- The role itself holds no managed policies. It can assume the CDK bootstrap
  roles and do the workflow's own S3/CloudFormation/CloudFront steps, nothing
  more. Its effective ceiling is still what `cdk-hnb659fds-cfn-exec-role` can
  do, which is inherent to how CDK bootstrap works.

## Working on the stacks

```bash
cd infra
npm install
npx cdk diff          # against both live stacks
npx cdk synth         # rendered templates into cdk.out/
```

**`cdk diff` is the gate before any deploy.** These stacks are live: the
distribution serves the demo and the static bucket holds the seeded DEM index.
A `replace` on `Distribution`, `AppStaticBucket`, or `TilerFunctionUrl` means
something is wrong — stop and fix it rather than deploying through it.

Two things make that adoption work, and both are load-bearing:

- **Logical IDs are pinned** with `overrideLogicalId` to what CloudFormation
  already has. CDK's generated IDs would not match, so every resource would be
  created fresh and the originals deleted.
- **`TilerFunctionUrl.TargetFunctionArn` is overridden to `Ref`.** SAM emitted
  `Ref` (a Lambda `Ref` resolves to the function name, which the property
  accepts); CDK's L2 emits `GetAtt .Arn`. Both point at the same function, but
  the resolved strings differ, and that property requires recreation when it
  changes — which would issue a *new* Function URL hostname, the distribution's
  origin. Matching the deployed form keeps the change set empty.

`cdk diff` renders the tiler as replacing `TilerFunction`, because it compares
against the stack's *submitted* template, where the only resource is a single
`AWS::Serverless::Function` that the SAM transform expanded at deploy time.
CloudFormation itself reports `Replacement: False` — confirm with a change set
(`cdk deploy --no-execute`, then `describe-change-set`) rather than trusting
that rendering.

## Runtime gotchas baked into the code

- `Dockerfile` installs `expat` — GDAL/PROJ link `libexpat.so.1`, absent from
  the base image.
- `duck.py` sets DuckDB `home_directory=/tmp` on Lambda (HOME is empty; only
  /tmp is writable).
- `terrain.py` reads far-field `elevation-tiles-prod` (us-east-1) via
  `/vsicurl/` over the global endpoint — the us-west-2 Lambda otherwise gets a
  301 GDAL won't follow. Its four children are read on a thread pool, and each
  worker opens its own `rasterio.Env`: GDAL config is thread-local, so a shared
  one would not reach the workers.
- `ReservedConcurrentExecutions: 100` needs account concurrency above 110; this
  account's limit was raised from the 10 new-account default to 1000
  (`aws lambda get-account-settings`).

The Function URL is `AWS_IAM`-authed (CloudFront OAC signs origin requests), so
it can't be `curl`ed directly. Smoke-test by invoking the Lambda with a
Function-URL v2 event — it needs `requestContext.http.{method,path,sourceIp}`
or Mangum raises `KeyError` before reaching any app code:

```bash
aws lambda invoke --function-name <fn> --cli-binary-format raw-in-base64-out \
  --payload '{"version":"2.0","rawPath":"/terrain/15/6588/12172.webp","rawQueryString":"","headers":{},"requestContext":{"http":{"method":"GET","path":"/terrain/15/6588/12172.webp","protocol":"HTTP/1.1","sourceIp":"127.0.0.1","userAgent":"smoke"}},"isBase64Encoded":false}' out.json
```

## Static footprints (`/footprints/*`)

DEM footprints are scale-free vectors and the whole CONUS set is tiny
(~360 KB gzipped), so they aren't tiled or queried per-viewport. Two static,
immutable files are pre-genned and served straight from S3 (no Lambda) via the
edge's `/footprints/*` behavior:

| File | Features | Gzipped | Rebuild |
|---|---|---|---|
| `footprints/s1m.json` | ~10.3k | ~327 KB | when new S1M COGs are indexed |
| `footprints/usgs13.json` | ~1.4k | ~30 KB | ≈ never (static) |

The client fetches both once and clips client-side. Regenerate + bust the CDN:

```bash
cd tiler
# after new S1M coverage lands (rebuilds just s1m.json and invalidates it):
.venv/bin/python scripts/build_footprints.py --which s1m --invalidate
# first-time / full run:
.venv/bin/python scripts/build_footprints.py --which both --invalidate
```

OAC gotcha (cost an afternoon): CloudFront OAC → an `AWS_IAM` Function URL needs
**both** `lambda:InvokeFunctionUrl` **and** `lambda:InvokeFunction` granted to
`cloudfront.amazonaws.com`. With only the former, every request 403s
`{"Message":"Forbidden"}` at the Function URL — the edge stack grants both.

Cache policy notes (plan [§4.1](../FLIGHT-SIM-PLAN.md#41-imagery), [§8](../FLIGHT-SIM-PLAN.md#8-cost--risk-notes)):
- Path-only cache keys — **no query strings anywhere**.
- Tiles are immutable: `Cache-Control: public, max-age=31536000, immutable`.
- Origin shield + pre-genned z0–z12 pyramid are the cold-latency mitigations,
  in that order; hot-tile write-behind only if Phase 0/1 p99 demands.
