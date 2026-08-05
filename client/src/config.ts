import { lonLatToMercator } from "./core/mercator";

export interface AppConfig {
  baseUrl: string;
  layer: string;
  year: number;
  maxZoom: number;
  lodFactor: number;
  cullTiles: boolean;
  prefetchLookahead: number;
  prefetchSamples: number;
  /**
   * The one zoom that ever requests /buildings. Finer tiles re-extrude from the
   * cached vectors instead of refetching, so this also sets the zoom at which
   * buildings first appear.
   */
  buildingSourceZoom: number;
  startLon: number;
  startLat: number;
  worldAnchor: [number, number];
  testMode: boolean;
}

const params = new URLSearchParams(window.location.search);
const useLocal = params.get("src") === "local";
const useLocalTiler = params.get("src") === "tiler-local";

const CDN_BASE_URL: string | undefined = import.meta.env.VITE_TILE_BASE_URL;

const BASE_URL = useLocal
  ? "/tiles"
  : (useLocalTiler ? "http://localhost:8000" : CDN_BASE_URL);

if (!BASE_URL) {
  const help = [
    "No tile source configured.",
    "",
    "Pick one:",
    "  • Deploy your own stacks — infra/deploy.sh writes VITE_TILE_BASE_URL",
    "    into client/.env.local for you.",
    "  • Append ?src=local to fly the baked tiles in client/public/tiles.",
    "  • Append ?src=tiler-local to point at a tiler running on :8000.",
  ].join("\n");

  const pre = document.createElement("pre");
  pre.textContent = help;
  pre.style.cssText =
    "position:fixed;inset:0;margin:0;padding:2rem;background:#0b0e13;color:#8ab4f8;" +
    "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap";
  document.body.appendChild(pre);

  throw new Error(help);
}

const startLon = Number(params.get("lon") ?? -109.61683);
const startLat = Number(params.get("lat") ?? 43.50468);
const worldAnchor = lonLatToMercator(startLon, startLat);

export const config: AppConfig = {
  baseUrl: BASE_URL,
  layer: params.get("layer") ?? "naip-visualization",
  year: Number(params.get("year") ?? 2023),
  maxZoom: Number(params.get("maxzoom") ?? 18),
  lodFactor: Number(params.get("lod") ?? 2.2),
  cullTiles: params.get("cull") !== "false",
  prefetchLookahead: Number(params.get("lookahead") ?? 4),
  prefetchSamples: Number(params.get("samples") ?? 4),
  buildingSourceZoom: Number(params.get("buildingzoom") ?? 14),
  startLon,
  startLat,
  worldAnchor,
  testMode: params.get("test") === "1" || import.meta.env.MODE === "test" || window.location.hostname === "localhost",
};
