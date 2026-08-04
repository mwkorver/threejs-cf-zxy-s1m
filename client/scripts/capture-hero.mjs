/**
 * Captures docs/hero.png, the README's screenshot.
 *
 * Scripted rather than a manual screenshot so the image can be regenerated when
 * the rendering changes, and so the framing (position, altitude, viewport) is
 * recorded rather than remembered.
 *
 *   cd client && npm run dev            # tiles come from the real CDN
 *   node scripts/capture-hero.mjs       # writes ../docs/hero.png
 *
 * Deliberately NOT a Playwright test: it needs real network tiles, while
 * e2e/viewer.spec.ts routes **\/tiles\/** to a 1x1 stub for speed. Pointing this
 * at a stubbed server would produce a flat grey rectangle.
 */

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// JPEG, not PNG: the frame is draped aerial photography, so PNG's lossless
// encoding costs ~1.2 MB in the repo to preserve detail no reader can see.
const OUT = resolve(HERE, "../../docs/hero.jpg");
const URL = process.env.HERO_URL ?? "http://localhost:5180/?test=1";

// Low enough that 1 m relief reads at a glance; high enough to show the basin
// running to the horizon rather than a single hillside.
const ALTITUDE_M = 3400;
const VIEWPORT = { width: 1600, height: 900 };

const browser = await chromium.launch({
  args: ["--enable-webgl", "--use-gl=angle", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

page.on("console", (m) => m.type() === "error" && console.error("page error:", m.text()));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__VIEWER_STATE__ !== "undefined", null, {
  timeout: 30_000,
});

await page.evaluate((alt) => window.__VIEWER_STATE__.setCameraPos(0, 0, alt), ALTITUDE_M);

// Wait for the tile count to stop climbing: streaming is async and a fixed
// sleep either wastes time or catches the scene half-populated.
await page.waitForFunction(
  () => {
    const n = window.__VIEWER_STATE__.getTileCount();
    const prev = window.__heroPrev ?? -1;
    window.__heroPrev = n;
    return n > 40 && n === prev;
  },
  null,
  { timeout: 90_000, polling: 1500 },
);

// Hide the control panel: the hero should show the terrain, not the UI chrome.
await page.evaluate(() => {
  const hud = document.getElementById("hud");
  if (hud) hud.style.display = "none";
});
await page.waitForTimeout(1500); // let the last textures upload after the reflow

await page.screenshot({ path: OUT, type: "jpeg", quality: 82 });
console.log(`wrote ${OUT} (${VIEWPORT.width}x${VIEWPORT.height})`);

await browser.close();
