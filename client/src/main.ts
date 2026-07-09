/**
 * Entry point. Real rendering starts once the engine spike (plan §10.2,
 * src/spikes/) picks the render path; until then this just proves the
 * toolchain and the core tile math.
 */

import { lonLatToMercator, mercatorToTile, tileKey } from "./core/mercator";

// Phase 0 corridor: New Jersey, NAIP (plan §10.3).
const [x, y] = lonLatToMercator(-74.44, 40.5); // over central NJ
const tile = mercatorToTile(x, y, 15);

document.querySelector<HTMLDivElement>("#app")!.innerText =
  `flight-sim client scaffold — NJ anchor tile ${tileKey(tile)}`;
