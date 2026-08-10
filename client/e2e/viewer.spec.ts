import { test, expect } from "@playwright/test";

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

    // Hold 'W' key for forward flight thrust
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(300); // Simulate 300ms forward motion
    await page.keyboard.up("KeyW");

    // Force frame step
    await page.evaluate(() => window.__STEP_FRAME__?.(16.6));

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
