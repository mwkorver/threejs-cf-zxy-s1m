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

- `deckgl/` — custom Layer/SimpleMeshLayer-style path (closest to existing repo)
- `luma/` — bare luma.gl v9 (most control, WebGPU headroom)
- `three/` — three.js (biggest ecosystem, mature controls)

Add the chosen engine's npm dependency only inside its spike until the
decision is made.
