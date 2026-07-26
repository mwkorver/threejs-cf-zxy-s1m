# Engine spike (plan [§10.2](../../../FLIGHT-SIM-PLAN.md#10-open-questions-settle-in-phase-0) — **settled: three.js**, 2026-07-09)

deck.gl, luma.gl, and three.js were each spiked against the same baked NJ
tiles and a shared benchmark. **three.js won**; the deck.gl and luma.gl spikes
have been removed. This directory keeps the winner (`three/`) as the reference
for the real renderer, plus the shared harness and the results below.

The task each spike ran:

1. Load the baked block, build a gridded mesh with skirts (`core/terrainMesh`).
2. Drape the matching imagery tile as a texture (same key = same tile, zero
   runtime projection).
3. Free-fly camera over the block; measure frame time and how much the engine
   fights custom mesh generation and camera control.

Everything in `src/core/` stays engine-agnostic — spikes import from core,
never the reverse. `three/` runs at `/spike-three.html`. It shares `shared/`:
`loadBlock` builds the CPU meshes once, `flightPath` is a deterministic camera
path, `perf` times frames (all reusable for on-going three.js dev).

## Results (recorded for the decision)

Tunable load via URL: `?step=N` (mesh density, quads/tile = (512/N)²),
`?rep=R` (tile the baked block into an R×R supergrid).

**Light load — 16 tiles, step 4 (~13s timed run). All three render correctly:**

| engine | fps | frame p95 / max | cpu/frame p50 | friction to get here |
|---|---|---|---|---|
| three.js | 60 | 17.4 / 19.3 ms | 0.3 ms | none — direct BufferGeometry, UV texture, free eye/target camera |
| luma.gl | 60 | 17.6 / 28.3 ms | 0.6 ms | most fixes: Vite dedupe of `@luma.gl/core`, batched UBO, and a canvas-size footgun (auto-resized to 16384² → black + fill-bound) |
| deck.gl | 60 | 18.3 / 21.7 ms | n/a¹ | SimpleMeshLayer mesh format (`{value,size}`); OrbitView has **no free eye/target** — a real mismatch for free flight |

¹ deck's `metrics.cpuTime` isn't per-frame ms, so it's not comparable to the
timed render calls in three/luma.

**Heavy load (step 2, rep 3–4 = 144–256 tiles): not a clean ranking.** Every
engine falls off a cliff to ~1 fps once VRAM is exhausted, because the stress
harness gives each replicated tile its own texture (144–256 unshared textures
from 16 bitmaps) and GPU memory isn't reclaimed between spike navigations. This
measures naive resource management, not the engines' draw paths. The real
lesson: **at scale the bottleneck is GPU resource sharing (texture atlasing /
instancing), which the LOD manager owns — not the engine.**

## Verdict (plan [§10.2](../../../FLIGHT-SIM-PLAN.md#10-open-questions-settle-in-phase-0))

All three render our exact contract (skirted mesh + per-tile texture on one
quadtree) at 60 fps with low CPU. The clean differentiators are **friction and
camera fit**, both favoring three.js:

- **three.js** — least code, native free-fly eye/target camera, ample headroom,
  tolerated the heaviest clean load best. Pragmatic winner.
- **luma.gl** — perf-equal to three once its footguns are fixed, and the best
  WebGPU path, but highest friction and needs disciplined resource management.
- **deck.gl** — strong at data/layers, but OrbitView actively fights free
  flight and its CPU cost isn't cleanly measurable; poorest fit for a sim.

Next: promote `three/main.ts` into a real renderer module (LOD manager, the
GPU resource sharing the heavy-load test showed we'll need, velocity prefetch).
