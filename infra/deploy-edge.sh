#!/usr/bin/env bash
# Deploy the edge stack, wiring the dev access key in from ONE gitignored file.
#
#   echo "my-new-key" > .tile-key    # repo root; gitignored
#   infra/deploy-edge.sh
#
# Reads the key from $TILE_ACCESS_KEY or the repo-root .tile-key, passes it to
# CloudFormation as a NoEcho parameter (so it never lands in the template or in
# describe-stacks output), and mirrors it into client/.env.local so the browser
# and the edge can't drift apart. Rotating = edit .tile-key, rerun this. No
# CloudFront invalidation needed: the key isn't part of the cache key.
#
# With no key present the stack deploys open (no function attached), which is
# also the escape hatch if you ever lock yourself out.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION=us-west-2

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

DOMAIN=$(aws cloudformation describe-stacks --stack-name flight-sim-tiler --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrlDomain'].OutputValue" --output text)
ARN=$(aws cloudformation describe-stacks --stack-name flight-sim-tiler --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionArn'].OutputValue" --output text)

aws cloudformation deploy \
  --template-file "$ROOT/infra/edge.yaml" \
  --stack-name flight-sim-edge \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "TilerFunctionUrlDomain=$DOMAIN" \
    "TilerFunctionArn=$ARN" \
    "TileAccessKey=$KEY"

# Keep the client in lockstep. .env.local is gitignored; Vite inlines these
# into both the main bundle and the tile worker at build time:
#   VITE_TILE_KEY      - dev gate key, must match the edge function
#   VITE_TILE_BASE_URL - this distribution, so a recreated stack doesn't need
#                        a hand-edit in client/src/main.ts
# Read the domain BEFORE truncating the file: if this call fails, set -e exits
# with .env.local untouched rather than half-written.
DIST_DOMAIN=$(aws cloudformation describe-stacks --stack-name flight-sim-edge --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomain'].OutputValue" --output text)

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
