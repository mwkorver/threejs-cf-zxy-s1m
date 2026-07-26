# pTolemy3D Architectural Adaptations

This document logs the core architectural patterns and algorithms adapted from the **pTolemy3D** viewer project (specifically its `Jp2TileLoader.java` and related rendering subsystems) to achieve high-performance, stutter-free flight simulation in our WebGL client.

Part of the point of building this app was to see whether anything we built into pTolemy3D twenty years ago was still of value. The stack has turned over completely — Java and JOGL to TypeScript and WebGL, JPEG2000 to WebP, a bespoke server to COGs behind a CDN — so the interesting question was which ideas were about the *problem* rather than the technology of the day. The sections below are the answer: what carried across, what changed shape on the way, and what turned out to be wrong. Section 4 is the most useful of the three categories, since it records an idea we had to take back out.

---

## 1. Prioritized Background-Thread loading Pipeline (`Jp2TileLoader.java`)

### The pTolemy3D Concept
To keep the main rendering loop running at a steady frame rate (preventing main-thread "jank" and freeze frames), pTolemy3D offloads heavy operations to a background thread (`Jp2TileLoader implements Runnable`, running at `Thread.setPriority(1)`). This includes downloading JP2 imagery files, parsing JP2 headers, progressively decoding JPEG2000 image data at increasing resolutions, and loading TIN/DEM terrain data into vertex arrays. The GL mesh construction and texture upload still happen on the render thread.

### Our Adaptation
* **Web Workers**: We created [tile.worker.ts](client/src/core/tile.worker.ts). When the client needs to stream a tile, all download fetches, WebP decoding (`createImageBitmap`), and 3D grid mesh triangulation (`buildTerrainMesh`/`buildFlatMesh`) run on separate browser threads.
* **Zero-Copy Transferables**: The resulting vertex, index, UV, and normal buffers are passed back to the main thread via JavaScript's `Transferable` interface (see `transferList` in `tile.worker.ts`). This shifts ownership of the memory buffers directly rather than copying them, eliminating GC (Garbage Collection) pauses during flight.

---

## 2. Dynamic Distance-Based Priority Queue

### The pTolemy3D Concept
Instead of scheduling downloads on a first-come, first-served basis (which causes distant, tiny background tiles to clog network sockets), pTolemy3D's `getClosestTile()` method performs a linear scan of all tiles at each level and selects the one closest to the camera position (via `getDistanceTileCenter`). This nearest-first selection runs every loop iteration, so the nearest tile in view always gets the next download slot. It is not a sorted priority queue data structure — it is a per-iteration nearest-tile scan — but the effect is the same: the closest terrain tiles load first.

### Our Adaptation
* **Priority Scheduler**: We implemented a priority queue in [tileWorkerPool.ts](client/src/core/tileWorkerPool.ts). Each `PendingTask` carries a numeric `priority`; `processQueue()` sorts pending tasks highest-priority-first before dispatching to the least-loaded worker.
* **Priority = negative distance**: `triggerLoad` in `tileManager.ts` passes `-dist` as the priority, so the nearest tile to the camera wins the next free worker slot. Prefetch requests use a priority of `-1e7` so they always yield to visible-tile loads.
* **Live reprioritization**: As the camera flies, a tile queued near an old camera position would otherwise outrank tiles now in front of the camera (stale-priority inversion). `reprioritize()` refreshes the priority of still-queued tiles every frame so the queue reflects the current camera position.

---

## 3. Active Culling & Request Abort (Cancelation)

### The pTolemy3D Concept
When a camera pans away or zooms out rapidly, many tiles that were queued or loading are no longer visible. pTolemy3D's `tileInView()` method uses the camera pitch and a 50-degree view angle cone to determine which tiles are visible; tiles outside this cone are simply not selected for loading on the next `getClosestTile()` iteration. However, pTolemy3D does **not** actively cancel in-flight HTTP requests — the `Communicator` interface has no abort mechanism. Out-of-view tiles are deprioritized (skipped) rather than cancelled, and their textures are recycled via a `texTrash` vector on the next cleanup pass.

Our adaptation goes further by actively aborting in-flight requests, which pTolemy3D's architecture did not support.

### Our Adaptation
* **Abort Controllers**: We integrated `AbortController` handles into the worker request pipeline (`tile.worker.ts`).
* **Eviction Triggers**: In [tileManager.ts](client/src/core/tileManager.ts), when a node is culled out of view (`pruneNode()`) or when the scene cache resets (`clear()`), the manager calls `cancelTile()`. This immediately sends an `ABORT` signal to the background worker, which aborts the in-flight `fetch()` request.

---

## 4. Screen-Space-Error LOD (replaced an earlier pitch/FOV heuristic)

### The pTolemy3D Concept
pTolemy3D uses camera pitch in its `tileInView()` method to determine whether a tile is within a 50-degree view cone — this is **frustum culling**, not LOD subdivision. Subdivision itself is level-and-resolution-based: `Jp2Tile.NUM_RESOLUTION` progressive resolution levels are loaded per tile, and the highest resolution is skipped when the next-finer level is also visible. There is no pitch-scaled subdivision threshold in pTolemy3D's source.

An earlier version of our code attempted a pitch/cosine-scaled LOD threshold inspired by the general idea of view-angle-aware terrain rendering. We removed it (see below) and replaced it with screen-space error.

### Our Adaptation
* **Earlier attempt — pitch/cosine heuristic (removed)**: An earlier version of this code attempted a pitch/cosine-scaled LOD threshold — scaling the subdivision distance by `(0.4 + 0.6 × tilt) × cos(angle-to-tile)` — inspired by the general idea of view-angle-aware terrain rendering (not directly from pTolemy3D, whose pitch usage is for culling, not subdivision). This was removed because it caused **LOD inversions**: when looking toward the horizon, the heuristic collapsed the threshold for the tile directly below the camera, leaving a coarse tile near the camera while finer tiles rendered farther away.
* **Current approach — screen-space error (Cesium-style)**: Subdivision is now driven by projected geometric error, in `updateNode()` in [tileManager.ts](client/src/core/tileManager.ts):

  $$\text{ssePx} = \frac{\text{geometricError}}{\text{dist}} \times \frac{\text{viewportH}}{2} \cot\left(\frac{\text{fovY}}{2}\right)$$

  where `geometricError = tileW / 64` (the mesh cell size, 512 px / gridStep 8). A tile subdivides while `ssePx > sseThreshold` (default 16 / `lodFactor` pixels) and `z < maxZoom`.

  This is **monotonic in distance**, so LOD rings can never invert: the highest zoom is always nearest the camera, decreasing with distance. View direction deliberately plays no part in the subdivision decision — direction is frustum culling's job (behind-camera tiles are culled, never loaded).

---

## 5. Altitude-Based Translation Speed

### The pTolemy3D Concept
Moving the camera at a constant speed makes high-altitude navigation feel static and slow, while low-altitude flight becomes impossibly fast and uncontrollable. pTolemy3D scales keyboard translation speed as a function of current altitude.

### Our Adaptation
* **Dynamic Knots Multiplier**: In [main.ts](client/src/main.ts) (inside `frameLoop()`), speed scales relative to altitude:
  $$\text{Altitude Factor} = \max\left(1.0, \frac{\text{camera.position.z}}{1500.0}\right)$$
  This guarantees that climbing to $30{,}000\text{ m}$ speeds up translation proportionally, keeping flight fluid across all zoom scales.

---

## 6. Double-Click to Zoom

### The pTolemy3D Concept
pTolemy3D's `zoomToSelected()` method raycasts against the terrain to find the clicked point, converts it to lat/lon, quarters the camera altitude (`ty /= 4`), and calls `flyTo()` to initiate a smooth autopilot trajectory to that position with tilt set to 0 (looking straight down). This is a full camera relocation with an animated flight path, not an instant snap.

### Our Adaptation
* **Raycast zoom-in**: In [main.ts](client/src/main.ts), a `dblclick` listener raycasts against the terrain mesh to find the clicked point, then halves the camera's distance to that point via `camera.position.lerp(point, 0.5)`. **Orientation is unchanged** — the point stays under the cursor at 2× magnification rather than recentering the look target. This makes it a pure zoom-in gesture that preserves the user's current view direction.
