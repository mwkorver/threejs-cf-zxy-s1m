# Engine spikes (plan §10.2 — the last open question)

Throwaway prototypes to settle deck.gl custom layers vs bare luma.gl vs
three.js. Same task for each candidate, against the same live tile endpoints
(they're engine-agnostic by design):

1. Fetch a real `/terrain/z/x/y.webp`, decode Terrarium, build a gridded mesh
   with skirts (`core/terrainMesh.ts`).
2. Drape the matching `/imagery/naip/{year}/z/x/y.webp` as a texture
   (same key = same tile, zero runtime projection).
3. Free-fly camera over a few dozen tiles; watch frame time and how much the
   engine fights custom mesh generation and LOD traversal control.

Everything in `src/core/` stays engine-agnostic — spikes import from core,
never the reverse. Losers get deleted; the winner's knowledge moves into a
real renderer module.

- `three/` — three.js (biggest ecosystem, mature controls)
- `deck/` — deck.gl SimpleMeshLayer + OrbitView (closest to existing repo)
- `luma/` — bare luma.gl v9 (most control, WebGPU headroom)

All three share `shared/`: `loadBlock` builds the CPU meshes once (identical
geometry), `flightPath` is a deterministic camera path, `perf` times frames.
Run each at `/spike-three.html`, `/spike-deck.html`, `/spike-luma.html`.

## Results

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

## Verdict (plan §10.2)

All three render our exact contract (skirted mesh + per-tile texture on one
quadtree) at 60 fps with low CPU. The clean differentiators are **friction and
camera fit**, both favoring three.js:

- **three.js** — least code, native free-fly eye/target camera, ample headroom,
  tolerated the heaviest clean load best. Pragmatic winner.
- **luma.gl** — perf-equal to three once its footguns are fixed, and the best
  WebGPU path, but highest friction and needs disciplined resource management.
- **deck.gl** — strong at data/layers, but OrbitView actively fights free
  flight and its CPU cost isn't cleanly measurable; poorest fit for a sim.

Add the chosen engine's npm dependency only inside its spike until settled.
