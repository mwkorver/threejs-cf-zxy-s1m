/**
 * Dev access key for the tile CDN.
 *
 * CloudFront runs a viewer-request function that 403s any request without
 * `?k=<key>` (infra/lib/edge-stack.ts). The key is NOT a real secret — it ships in the
 * client bundle and is visible in devtools — it just keeps crawlers and shared
 * URLs from burning requester-pays reads on the dev distribution.
 *
 * The value comes from VITE_TILE_KEY in `client/.env.local`, which is
 * gitignored and written by infra/deploy.sh from the repo-root `.tile-key`
 * file, so the edge and the client can never drift apart. Empty = no key is
 * appended, which is also how the stack behaves when TileAccessKey is unset.
 *
 * Vite inlines import.meta.env at build time, so this works identically on the
 * main thread and inside the tile worker (which has no access to window).
 */
const TILE_KEY: string = import.meta.env.VITE_TILE_KEY ?? "";

/**
 * Append the access key to a tile-CDN URL. Only for OUR endpoints — never send
 * it to third-party tile servers (OSM), which would leak it into their logs.
 */
export function withKey(url: string): string {
  if (!TILE_KEY) return url;
  return `${url}${url.includes("?") ? "&" : "?"}k=${encodeURIComponent(TILE_KEY)}`;
}
