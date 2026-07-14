# pTolemy3D Architectural Adaptations

This document logs the core architectural patterns and algorithms adapted from the **pTolemy3D** viewer project (specifically its `Jp2TileLoader.java` and related rendering subsystems) to achieve high-performance, stutter-free flight simulation in our WebGL client.

---

## 1. Prioritized Background-Thread loading Pipeline (`Jp2TileLoader.java`)

### The pTolemy3D Concept
To keep the main rendering loop running at a steady frame rate (preventing main-thread "jank" and freeze frames), pTolemy3D offloads heavy operations—such as downloading files, decompressing JPEG2000 images, and converting terrain height arrays to 3D geometry vertices—to background threads. 

### Our Adaptation
* **Web Workers**: We created [tile.worker.ts](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/core/tile.worker.ts). When the client needs to stream a tile, all download fetches, WebP decoding (`createImageBitmap`), and 3D grid mesh triangulation (`buildTerrainMesh`/`buildFlatMesh`) run on separate browser threads.
* **Zero-Copy Transferables**: The resulting vertex, index, UV, and normal buffers are passed back to the main thread via JavaScript's `Transferable` interface. This shifts ownership of the memory buffers directly rather than copying them, eliminating GC (Garbage Collection) pauses during flight.

---

## 2. Dynamic Distance-Based Priority Queue

### The pTolemy3D Concept
Instead of scheduling downloads on a first-come, first-served basis (which causes distant, tiny background tiles to clog network sockets), pTolemy3D runs a priority queue. Request threads are dynamically sorted by their distance from the camera, ensuring the nearest terrain tiles directly in front of the camera load first.

### Our Adaptation
* **Priority Scheduler**: We implemented a priority queue in [tileWorkerPool.ts](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/core/tileWorkerPool.ts). 
* **Dynamic Sorting**: As the camera flies, the scheduler calculates the weight of each pending request using:
  $$\text{Priority} = -\text{cameraPosGlobal.distanceTo(tileCenter)}$$
  The queue is resorted every time a new tile request is submitted, so the worker pool always launches the task that will have the highest immediate impact on the user's viewport.

---

## 3. Active Culling & Request Abort (Cancelation)

### The pTolemy3D Concept
When a camera pans away or zooms out rapidly, many tiles that were queued or loading are no longer visible. Leaving these downloads running wastes CPU and occupies the browser's maximum connection slots. pTolemy3D cancels culled tile loads immediately.

### Our Adaptation
* **Abort Controllers**: We integrated `AbortController` handles into the worker request pipeline.
* **Eviction Triggers**: In [tileManager.ts](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/core/tileManager.ts), when a node is culled out of view (`pruneNode()`) or when the scene cache resets (`clear()`), the manager calls `cancelTile()`. This immediately sends an `ABORT` signal to the background worker, which aborts the fetch request mid-flight.

---

## 4. Camera Pitch & FOV-Aware LOD Calculations

### The pTolemy3D Concept
A simple distance check to subdivide tiles is highly inefficient when looking towards the horizon: distant tiles are compressed into a few vertical pixels but still trigger heavy subdivision checks. pTolemy3D scales the LOD (Level of Detail) threshold dynamically based on the camera look vector and view angle.

### Our Adaptation
* **Off-Axis and Pitch Scaling**: Inside [tileManager.ts](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/core/tileManager.ts#L296-L311), we project the look vector against the tile center direction:
  $$\text{dynamicLodFactor} = \text{lodFactor} \times (0.4 + 0.6 \times \text{tilt}) \times \cos(\theta)$$
  * **Tilt factor** decreases the subdivision distance by up to 60% when looking horizontally at the horizon.
  * **Cosine angle factor** scales down subdivision thresholds in the peripheral view.
* This dramatically reduces the active tile count when flying horizontally while maintaining high-resolution detail directly under the aircraft.

---

## 5. Altitude-Based Translation Speed

### The pTolemy3D Concept
Moving the camera at a constant speed makes high-altitude navigation feel static and slow, while low-altitude flight becomes impossibly fast and uncontrollable. pTolemy3D scales keyboard translation speed as a function of current altitude.

### Our Adaptation
* **Dynamic Knots Multiplier**: In [main.ts:L658-L660](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/main.ts#L658-L660), speed scales relative to altitude:
  $$\text{Altitude Factor} = \max\left(1.0, \frac{\text{camera.position.z}}{1500.0}\right)$$
  This guarantees that climbing to $30,000\text{m}$ speeds up translation proportionally, keeping flight fluid across all zoom scales.

---

## 6. Double-Click to Recenter and Zoom

### The pTolemy3D Concept
To explore high-detail features quickly, double-clicking on a point on the terrain moves the camera there and centers the look target.

### Our Adaptation
* **Raycast Flight Controls**: We implemented double-click listening in [main.ts:L602-L636](file:///Users/mwkorver/working/deckgl-cf-xyz-s1m/client/src/main.ts#L602-L636) using Three.js raycasting. Double clicking a point on the mesh smoothly updates the camera look target and translates the camera closer by 50% along the offset vector, magnifying that area.
