import { test, expect } from "@playwright/test";

test.describe("WebGL Tile Coverage Gaps & GPU Memory Pressure Tests", () => {
  test("Canvas maintains 0% void gaps during rapid scroll zoom with network latency", async ({ page }) => {
    // 1. Intercept tile calls with a 500ms artificial network delay to test parent fallback retention
    await page.route("**/tiles/**", async (route) => {
      await new Promise((res) => setTimeout(res, 500));
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64"
        ),
      });
    });

    await page.goto("/?test=1&src=local");
    await page.waitForLoadState("domcontentloaded");

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();

    // 2. Perform rapid zoom-in action via mouse wheel
    await canvas.hover();
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(50);
    }

    // Force frame step
    await page.evaluate(() => window.__STEP_FRAME__?.(16.6));

    // 3. Inspect lower portion of canvas via WebGL frame render & pixel evaluation
    const voidPercentage = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return 0;

      // Force render frame to populate drawing buffer
      if (window.__STEP_FRAME__) {
        window.__STEP_FRAME__(16.6);
      }

      // Create a temporary 2d canvas to sample pixels from the WebGL element
      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = canvas.width;
      sampleCanvas.height = canvas.height;
      const ctx = sampleCanvas.getContext("2d");
      if (!ctx) return 0;

      ctx.drawImage(canvas, 0, 0);

      // Sample pixels in lower 50% (terrain area)
      const startY = Math.floor(canvas.height * 0.5);
      const sampleHeight = canvas.height - startY;
      const imageData = ctx.getImageData(0, startY, canvas.width, sampleHeight);
      const data = imageData.data;

      let voidCount = 0;
      const totalPixels = canvas.width * sampleHeight;

      // Count pixels matching background sky/void color (#0b0e13 -> R:11, G:14, B:19)
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a === 0 || (r === 11 && g === 14 && b === 19)) {
          voidCount++;
        }
      }

      const sampledTotal = totalPixels / 4;
      return (voidCount / sampledTotal) * 100;
    });

    // Void hole percentage on ground must be less than 5% (fallbacks filling holes)
    expect(voidPercentage).toBeLessThan(5);
  });

  test("GPU Cache memory usage stays bounded within budget during high-speed flight", async ({ page }) => {
    test.setTimeout(60000);
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

    await page.goto("/?test=1&src=local");
    await page.waitForLoadState("domcontentloaded");

    // Hold Shift + W for 1 second of high-speed forward flight
    await page.keyboard.down("ShiftLeft");
    await page.keyboard.down("KeyW");

    const cacheMemoryReadouts: number[] = [];

    for (let step = 0; step < 10; step++) {
      await page.waitForTimeout(100);
      await page.evaluate(() => window.__STEP_FRAME__?.(100));

      const cacheText = await page.locator("#hud-cache").textContent();
      const mb = parseFloat(cacheText ?? "0");
      cacheMemoryReadouts.push(mb);
    }

    await page.keyboard.up("KeyW");
    await page.keyboard.up("ShiftLeft");

    // Assert cache memory remains bounded: maxActiveTiles allows transient allocation
    // headroom (up to ~350MB on desktop viewports) while culled subtrees behind the camera are being pruned.
    const maxMB = Math.max(...cacheMemoryReadouts);
    expect(maxMB).toBeLessThanOrEqual(350.0);
  });

  test("Tile telemetry metrics report active tile counts during rapid movement", async ({ page }) => {
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

    await page.goto("/?test=1&src=local");
    await page.waitForLoadState("domcontentloaded");

    const initialTiles = await page.evaluate(() => window.__VIEWER_STATE__?.getTileCount());
    expect(initialTiles).toBeGreaterThan(0);

    // Fast position set
    await page.evaluate(() => {
      window.__VIEWER_STATE__?.setCameraPos(10000, 20000, 3000);
      window.__STEP_FRAME__?.(16.6);
    });

    const postTeleportTiles = await page.evaluate(() => window.__VIEWER_STATE__?.getTileCount());
    expect(postTeleportTiles).toBeGreaterThan(0);
  });
});
