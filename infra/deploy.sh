#!/usr/bin/env bash
# Deploy both stacks (tiler, then edge) and publish the web app.
#
#   echo "my-new-key" > .tile-key    # repo root; gitignored
#   infra/deploy.sh
#
# Replaces the old deploy-edge.sh + SAM flow. The tiler/edge wiring is no
# longer reconstructed here with `aws cloudformation describe-stacks` — the CDK
# app declares it, so this script only does the things that genuinely aren't
# infrastructure: the access key, the first-run data seed, the client build,
# and mirroring both into client/.env.local.
#
# The key is read from $TILE_ACCESS_KEY or the gitignored repo-root .tile-key
# and passed as a NoEcho CloudFormation parameter, so it never lands in the
# template or in describe-stacks output. Rotating = edit .tile-key, rerun this.
# No CloudFront invalidation needed for a rotation: the key isn't part of the
# cache key. With no key present the stack deploys open (no function attached),
# which is also the escape hatch if you ever lock yourself out.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
SEED_BUCKET="${SEED_BUCKET:-mwkorver-foundation-us-west-2}"

KEY="${TILE_ACCESS_KEY:-}"
if [[ -z "$KEY" && -f "$ROOT/.tile-key" ]]; then
  KEY="$(tr -d '[:space:]' < "$ROOT/.tile-key")"
fi

if [[ -z "$KEY" ]]; then
  echo "!! no key found (\$TILE_ACCESS_KEY or $ROOT/.tile-key)"
  echo "!! deploying an OPEN distribution — anyone with the domain can pull tiles"
else
  echo "-- deploying with access key (${#KEY} chars)"
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
USER_BUCKET="threejs-cf-zxy-s1m-${ACCOUNT_ID}-${REGION}"

# Build before deploying: the edge stack serves whatever is in client/dist, and
# a stale bundle behind a fresh distribution is the confusing failure mode.
echo "-- building web viewer application bundle..."
(cd "$ROOT/client" && npm run build)

# Tiler first — the edge stack imports its Function URL and ARN. Named
# explicitly rather than --all: flight-sim-github-oidc is one-time setup that
# creates the role CI logs in with, and has no business in a routine deploy.
echo "-- deploying stacks..."
(cd "$ROOT/infra" && npx cdk deploy flight-sim-tiler flight-sim-edge \
  --require-approval never \
  --parameters "flight-sim-edge:TileAccessKey=${KEY}")

# One-time data seed. The static bucket holds the DEM index and footprints as
# well as the web app; a fresh account starts empty, so pull them from the
# shared seed bucket (public read, requester-pays) the first time only.
if ! aws s3 ls "s3://${USER_BUCKET}/manifest-index/s1m/S1M_Products.parquet" >/dev/null 2>&1; then
  echo "-- seeding s3://${USER_BUCKET}/ from s3://${SEED_BUCKET}/threejs-cf-zxy-s1m/..."
  aws s3 sync "s3://${SEED_BUCKET}/threejs-cf-zxy-s1m/" "s3://${USER_BUCKET}/" --request-payer requester
fi

echo "-- uploading web viewer assets to s3://${USER_BUCKET}/..."
# NOT --delete: this bucket also holds the seeded manifest-index/ and
# footprints/ trees, which client/dist knows nothing about and which a prune
# would wipe out.
aws s3 sync "$ROOT/client/dist/" "s3://${USER_BUCKET}/"

DIST_ID="$(aws cloudformation describe-stack-resources --stack-name flight-sim-edge --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='Distribution'].PhysicalResourceId" --output text)"
DIST_DOMAIN="$(aws cloudformation describe-stacks --stack-name flight-sim-edge --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" --output text)"

# Invalidate ONLY the app entry points. index.html keeps its name across builds
# and is served under CachingOptimized, so without this a deploy silently
# serves the previous app. Deliberately NOT /* — that would also evict every
# cached tile, each of which costs a cold Lambda render to rebuild.
if [[ -n "$DIST_ID" && "$DIST_ID" != "None" ]]; then
  echo "-- invalidating /index.html and /assets/* on ${DIST_ID}..."
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
    --paths "/index.html" "/assets/*" --query "Invalidation.Id" --output text
fi

# Keep the client in lockstep. .env.local is gitignored; Vite inlines these
# into both the main bundle and the tile worker at build time:
#   VITE_TILE_KEY      - dev gate key, must match the edge function
#   VITE_TILE_BASE_URL - this distribution, so a recreated stack doesn't need
#                        a hand-edit in client/src/main.ts
ENV_FILE="$ROOT/client/.env.local"
: > "$ENV_FILE"
if [[ -n "$KEY" ]]; then
  printf 'VITE_TILE_KEY=%s\n' "$KEY" >> "$ENV_FILE"
else
  echo "-- no key: omitting VITE_TILE_KEY"
fi
if [[ -n "$DIST_DOMAIN" && "$DIST_DOMAIN" != "None" ]]; then
  printf 'VITE_TILE_BASE_URL=https://%s\n' "$DIST_DOMAIN" >> "$ENV_FILE"
fi
echo "-- wrote $ENV_FILE (restart the dev server to pick it up)"
