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

## Results (16 baked z14 tiles, gridStep=4, ~13s timed run)

| engine | renders? | fps | frame p95 / max | cpu/frame | friction |
|---|---|---|---|---|---|
| three.js | yes, first try | 60 | 17.4 / 19.3 ms | 0.3 ms p50 | none — direct BufferGeometry, UV texture, free eye/target camera |
| deck.gl | yes | 60 | 18.3 / 21.7 ms | not comparable¹ | SimpleMeshLayer mesh format finicky; OrbitView has no free eye/target (bad fit for free flight) |
| luma.gl | **black²** | 43³ | 25.8 / 71.6 ms | 0.9 ms p50 | most code; duplicate `@luma.gl/core` copies (device≠Model instance); hand-rolled per-tile UBO |

¹ deck's `metrics.cpuTime` isn't per-frame ms; can't compare to the timed
render calls in three/luma. ² geometry didn't appear — dual-luma-core
packaging bug leaves the draw a no-op. ³ therefore not a real luma perf
number; it reflects an incomplete spike, not luma's ceiling.

**Read so far:** 16 tiles is too light to separate the engines on FPS (all
peg near refresh). The real differentiators are developer friction and camera
fit. three.js rendered our exact contract (custom skirted mesh + per-tile
texture on one quadtree + free-fly camera) with the least code and strong
headroom. deck.gl works but its camera model fights free flight. luma.gl needs
its packaging + UBO path sorted before it yields a fair number.

Not yet settled (plan §10.2): a definitive perf ranking needs luma rendering
and a heavier load (denser mesh / replicated tiles) so FPS drops below refresh.

Add the chosen engine's npm dependency only inside its spike until the
decision is made.
