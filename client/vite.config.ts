import { defineConfig } from "vite";

export default defineConfig({
  // Force a single @luma.gl/core across the pre-bundled deps. Without this,
  // Vite inlines core into several optimized chunks and luma's global adapter
  // registry initializes more than once ("already been initialized"), leaving
  // the bare-luma spike's device and Model on different instances -> no-op draw.
  resolve: {
    dedupe: ["@luma.gl/core", "@luma.gl/constants", "@luma.gl/shadertools"],
  },
  optimizeDeps: {
    include: [
      "@luma.gl/core",
      "@luma.gl/engine",
      "@luma.gl/webgl",
      "@luma.gl/shadertools",
      "@deck.gl/core",
      "@deck.gl/mesh-layers",
    ],
  },
});
