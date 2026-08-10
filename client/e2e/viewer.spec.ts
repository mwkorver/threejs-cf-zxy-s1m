import { test, expect, type Page } from "@playwright/test";

/**
 * Wait for `n` frames to actually render, rather than for a wall-clock delay.
 *
 * A delay measures the renderer, not the thing under test: a CI runner has no
 * GPU and rasterises in software, where 300 ms can cover barely a frame and an
 * assertion about camera motion fails for having had no motion to make.
 */
async function advanceFrames(page: Page, n: number): Promise<void> {
  const start = await page.evaluate(() => window.__VIEWER_STATE__?.getFrameCount() ?? 0);
  await page.waitForFunction(
    ([from, want]) => (window.__VIEWER_STATE__?.getFrameCount() ?? 0) >= from! + want!,
    [start, n] as const,
    { timeout: 30_000 },
  );
}

test.describe("WebGL Flight Simulator Viewer UI & Controls", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept network tile calls and fulfill with fast synthetic empty byte responses
    await page.route("**/tiles/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64"
        ),
      })
    );

    // Open viewer with ?test=1 and ?src=local params
    await page.goto("/?test=1&src=local");
    await page.waitForLoadState("domcontentloaded");
  });

  test("Viewer initializes canvas element and HUD telemetry", async ({ page }) => {
    // Verify WebGL Canvas exists
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    // Verify HUD elements exist in DOM
    const hud = page.locator("#hud");
    await expect(hud).toBeVisible();

    const hudPos = page.locator("#hud-pos");
    await expect(hudPos).toBeVisible();

    // Verify window telemetry state is exposed
    const isTelemetryAvailable = await page.evaluate(() => typeof window.__VIEWER_STATE__ !== "undefined");
    expect(isTelemetryAvailable).toBe(true);

    const initialPos = await page.evaluate(() => window.__VIEWER_STATE__?.getCameraPos());
    expect(initialPos).toBeDefined();
    expect(typeof initialPos?.z).toBe("number");
  });

  test("Keyboard flight navigation (W key) moves camera position", async ({ page }) => {
    const initialPos = await page.evaluate(() => window.__VIEWER_STATE__?.getCameraPos());
    expect(initialPos).toBeDefined();

    // Hold 'W' across a number of rendered frames. Flight integrates per frame,
    // so frames are the unit that actually produces movement -- a fixed delay
    // produces none at all where each frame is slow.
    await page.keyboard.down("KeyW");
    await advanceFrames(page, 20);
    await page.keyboard.up("KeyW");

    const updatedPos = await page.evaluate(() => window.__VIEWER_STATE__?.getCameraPos());
    expect(updatedPos).toBeDefined();

    // Camera should have moved in world space (distance > 0)
    const dx = (updatedPos?.x ?? 0) - (initialPos?.x ?? 0);
    const dy = (updatedPos?.y ?? 0) - (initialPos?.y ?? 0);
    const dz = (updatedPos?.z ?? 0) - (initialPos?.z ?? 0);
    const distanceMoved = Math.sqrt(dx * dx + dy * dy + dz * dz);

    expect(distanceMoved).toBeGreaterThan(0);
  });

  test("Fast tile route mocking operates without network tile dependencies", async ({ page }) => {
    // Assert tile count metric is tracked in telemetry
    const tileCount = await page.evaluate(() => window.__VIEWER_STATE__?.getTileCount());
    expect(typeof tileCount).toBe("number");

    const altitude = await page.evaluate(() => window.__VIEWER_STATE__?.getAltitudeFt());
    expect(altitude).toBeGreaterThan(0);
  });

  test("HUD elements can be queried and verified", async ({ page }) => {
    const hudTiles = page.locator("#hud-tiles");
    await expect(hudTiles).toBeVisible();

    const tilesText = await hudTiles.textContent();
    expect(tilesText).toContain("/");
  });

  test("Visual snapshot of WebGL canvas matches reference", async ({ page }) => {
    // Local only. The baseline is a picture of one machine's GPU output --
    // Playwright even names it ...-darwin -- and a CI runner rasterises in
    // software, so there is nothing for it to match. Every other test here
    // reads telemetry, HUD text or resource counts and travels fine.
    test.skip(!!process.env.CI, "GPU-specific baseline; run locally");

    // Position camera deterministically for visual regression snapshot
    await page.evaluate(() => {
      window.__VIEWER_STATE__?.setCameraPos(0, -5000, 7700);
    });

    // Wait for the tiles, rather than hoping one frame was enough. Stepping a
    // single frame and screenshotting captured whatever had happened to arrive,
    // so the baseline encoded one particular race. isSceneReady is true only
    // once the tile pool is idle and every visible node has drawn.
    await page.waitForFunction(() => window.__VIEWER_STATE__?.isSceneReady() === true, null, {
      timeout: 30_000,
    });
    await page.evaluate(() => window.__STEP_FRAME__?.(16.6));

    // Capture visual snapshot of the canvas locator with tight pixel tolerance
    await expect(page.locator("canvas")).toHaveScreenshot("webgl-canvas-preset.png", {
      maxDiffPixelRatio: 0.05,
    });
  });
});
