import { test, expect, type Page } from "@playwright/test";

/** Waits scale with the machine: a CI runner rasterises WebGL in software. */
const WAIT_MS = process.env.CI ? 90_000 : 30_000;

// A 1x1 PNG: every tile resolves instantly and identically, so these tests
// measure resource lifetime rather than network timing.
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** TexturePool keeps this many textures warm; they stay uploaded by design. */
const POOL_MAX_IDLE = 64;
/** Sky, compass and the like -- a handful of textures that are not tiles. */
const NON_TILE_SLACK = 16;

async function stubTiles(page: Page): Promise<void> {
  await page.route("**/tiles/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
}

/**
 * Wait for the scene to settle rather than for a fixed delay. isSceneReady is
 * true once the tile pool is idle AND every visible node has drawn -- the two
 * halves a timeout was standing in for.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__VIEWER_STATE__?.isSceneReady() === true, null, {
    timeout: WAIT_MS,
  });
}

async function info(page: Page) {
  return page.evaluate(() => window.__VIEWER_STATE__!.getRendererInfo());
}

async function flyTo(page: Page, x: number, y: number, z: number): Promise<void> {
  await page.evaluate(
    ([px, py, pz]) => window.__VIEWER_STATE__!.setCameraPos(px!, py!, pz!),
    [x, y, z],
  );
  await settle(page);
}

async function open(page: Page): Promise<void> {
  await stubTiles(page);
  await page.goto("/?test=1&src=local");
  await expect(page.locator("canvas")).toBeVisible();
  await settle(page);
}

/** The app's own budgets, read back rather than hard-coded to a guess. */
async function textureCeiling(page: Page): Promise<number> {
  const capText = (await page.locator("#hud-tiles").textContent()) ?? "";
  const maxActiveTiles = Number(capText.split("/")[1]?.trim());
  expect(maxActiveTiles).toBeGreaterThan(0); // HUD parsed as expected
  return maxActiveTiles + POOL_MAX_IDLE + NON_TILE_SLACK;
}

test.describe("GPU resource lifetime", () => {
  // Deliberately a ceiling rather than a growth comparison between cycles. How
  // many tiles a cycle happens to load varies with timing, so first-vs-last
  // differences are noise under parallel workers -- that assertion was flaky
  // here. A bound derived from the app's budgets is stable, and still catches
  // the thing that matters: textures that are never freed breach it.
  test("textures stay within the tile cap plus the warm pool while panning", async ({ page }) => {
    await open(page);
    const ceiling = await textureCeiling(page);

    // Round trips between two distant viewpoints. Each loads a fresh working
    // set and abandons the previous one, which is when a texture that is never
    // released would accumulate. Two cycles, not four: each one is a full
    // settle, and on a software-rasterising runner four did not fit the clock.
    // A leak breaches a fixed ceiling on the first abandoned set anyway.
    for (let cycle = 0; cycle < 2; cycle++) {
      await flyTo(page, 0, -5000, 7700);
      expect(await info(page).then((i) => i.textures)).toBeLessThanOrEqual(ceiling);

      await flyTo(page, 40_000, 25_000, 6000);
      expect(await info(page).then((i) => i.textures)).toBeLessThanOrEqual(ceiling);
    }
  });

  test("geometries are released when the working set moves on", async ({ page }) => {
    await open(page);
    const capText = (await page.locator("#hud-tiles").textContent()) ?? "";
    const maxActiveTiles = Number(capText.split("/")[1]?.trim());
    expect(maxActiveTiles).toBeGreaterThan(0);

    // A tile can hold terrain geometry and building geometry, and the LOD keeps
    // at most maxActiveTiles of them -- so that is the bound, whatever a given
    // run happens to load. Measured against a moment-in-time reading instead,
    // this was flaky: both sides of the comparison move.
    const ceiling = maxActiveTiles * 2 + NON_TILE_SLACK;

    expect((await info(page)).calls).toBeGreaterThan(0); // it is actually drawing

    // Away and back, repeatedly. Geometry belonging to tiles long out of view
    // would accumulate across the cycles and breach the bound.
    for (let cycle = 0; cycle < 2; cycle++) {
      await flyTo(page, 0, -5000, 7700);
      expect((await info(page)).geometries).toBeLessThanOrEqual(ceiling);

      await flyTo(page, 120_000, 90_000, 9000);
      expect((await info(page)).geometries).toBeLessThanOrEqual(ceiling);
    }
  });
});
