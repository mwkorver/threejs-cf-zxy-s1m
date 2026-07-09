# Infrastructure (plan §3, §7)

Deploy shape reused from `deckgl-s3-cog-s1m`: **foundation → tiler → static
assets**, all in **us-west-2** (same region as `naip-analytic`, `prd-tnm`
etc., so requester-pays reads are same-region GET pennies — plan §2 row 10).

| Stack | Contents | Status |
|---|---|---|
| `foundation.yaml` | ECR repo, tile/static S3 bucket, shared IAM | TODO — port foundation pattern from existing repo |
| `tiler.yaml` | Lambda container (Function URL), reserved concurrency | scaffolded |
| `edge.yaml` | One CloudFront distribution, path-routed behaviors (§3): `/imagery/*` + `/terrain/*` → Function URL origin, `/buildings/*` + static pyramid → S3 origin | TODO — Phase 0 step 2 |

Cache policy notes (plan §4.1, §8):
- Path-only cache keys — **no query strings anywhere**.
- Tiles are immutable: `Cache-Control: public, max-age=31536000, immutable`.
- Origin shield + pre-genned z0–z12 pyramid are the cold-latency mitigations,
  in that order (§8); hot-tile write-behind only if Phase 0/1 p99 demands.
