import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // A CI runner has no GPU and rasterises WebGL in software on two cores. The
  // same suite is ~15 s here and 5.6 min there, so the default per-test budget
  // is not a statement about correctness on that hardware -- it just runs out.
  // Both failures on the first CI run were timeouts, not assertions.
  timeout: process.env.CI ? 120_000 : 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    headless: true,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    launchOptions: {
      args: [
        "--enable-webgl",
        "--use-gl=angle",
        "--ignore-gpu-blocklist",
        "--disable-lcd-text",
        "--no-sandbox",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
