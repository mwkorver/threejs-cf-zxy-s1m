import { type TileId } from "./mercator";
import { loadTerrain, loadImageryFor } from "./tileLoader";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import type {
  TileLoadResult,
  TileWorkerTaskOptions,
  WorkerAbortRequest,
  WorkerTileRequest,
  WorkerTileResponse,
} from "./workerTypes";

interface PendingTask {
  requestId: string;
  key: string;
  tile: TileId;
  priority: number;
  options: TileWorkerTaskOptions;
  resolve: (value: TileLoadResult) => void;
  // `unknown`, matching what a promise rejection actually carries: callers here
  // reject with DOMException (abort) or Error (load failure), and consumers
  // narrow before using it.
  reject: (reason: unknown) => void;
  aborted: boolean;
  /** Worker this task was dispatched to (set on dispatch). */
  worker?: Worker;
}

// Tile tasks are almost entirely I/O (fetch + decode awaits), so a worker can
// interleave several concurrently. Modern HTTP/2-multiplexed connections
// handle high concurrency cleanly; now that memory is bounded, 8 tasks/worker
// expands total pipeline depth to avoid starving forward flight.
const MAX_TASKS_PER_WORKER = 8;

export class TileWorkerPool {
  private workers: Worker[] = [];
  /** Tasks in flight per worker. */
  private workerLoad = new Map<Worker, number>();
  /** Dispatched tasks by requestId (kept until the worker responds). */
  private tasksByRequestId = new Map<string, PendingTask>();
  private pendingTasks = new Map<string, PendingTask>();
  private runningTasks = new Map<string, PendingTask>();
  private nextRequestId = 0;
  private isFallback = false;

  constructor() {
    this.isFallback = typeof Worker === "undefined";
    if (this.isFallback) {
      console.warn("TileWorkerPool: Web Workers not supported in this environment. Falling back to main-thread loading.");
      return;
    }

    // `navigator` is absent outside browsers (Node <21 in particular), so guard
    // the global itself and not just the property.
    const cores = typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency;
    const numWorkers = cores ? Math.min(8, cores) : 6;
    for (let i = 0; i < numWorkers; i++) {
      // Use standard module worker instantiation which Vite natively compiles
      const worker = new Worker(new URL("./tile.worker.ts", import.meta.url), { type: "module" });

      worker.onmessage = (e: MessageEvent<WorkerTileResponse>) => {
        this.handleWorkerMessage(e.data);
      };

      this.workers.push(worker);
      this.workerLoad.set(worker, 0);
    }
  }

  private getTileKey(t: TileId): string {
    return `${t.z}_${t.x}_${t.y}`;
  }

  /**
   * Request a tile to be loaded and built. Returns a Promise with the mesh data and imagery.
   */
  requestTile(tile: TileId, priority: number, options: TileWorkerTaskOptions): Promise<TileLoadResult> {
    const key = this.getTileKey(tile);

    // 1. De-duplication: check if already pending or running
    const existing = this.pendingTasks.get(key) || this.runningTasks.get(key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority); // Elevate priority if requested again
      return new Promise((resolve, reject) => {
        const oldResolve = existing.resolve;
        const oldReject = existing.reject;
        existing.resolve = (val) => { oldResolve(val); resolve(val); };
        existing.reject = (err) => { oldReject(err); reject(err); };
      });
    }

    // 2. Environment fallback (Vitest testing under Node.js / jsdom)
    if (this.isFallback) {
      return this.loadOnMainThread(tile, options);
    }

    // 3. Queue task
    const requestId = `req_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const task: PendingTask = {
        requestId,
        key,
        tile,
        priority,
        options,
        resolve,
        reject,
        aborted: false
      };
      this.pendingTasks.set(key, task);
      this.processQueue();
    });
  }

  /**
   * Update the priority of a still-queued tile. Priorities are captured at
   * enqueue time; without this, tiles queued near an old camera position
   * outrank the tiles now in front of a moving camera (stale-priority
   * inversion). The manager calls this every frame for loading nodes.
   */
  reprioritize(tile: TileId, priority: number): void {
    const pending = this.pendingTasks.get(this.getTileKey(tile));
    if (pending) {
      pending.priority = priority;
    }
  }

  /**
   * Cancel an active or pending tile load request.
   */
  cancelTile(tile: TileId): void {
    const key = this.getTileKey(tile);

    // Remove from pending queue immediately
    const pending = this.pendingTasks.get(key);
    if (pending) {
      pending.aborted = true;
      this.pendingTasks.delete(key);
      pending.reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    // Abort actively running worker request. Keep the requestId mapping and
    // the worker's load slot occupied: the worker is still executing until it
    // posts its ABORTED/SUCCESS response, and handleWorkerMessage releases the
    // slot exactly once when that arrives.
    const running = this.runningTasks.get(key);
    if (running) {
      running.aborted = true;
      this.runningTasks.delete(key);
      running.reject(new DOMException("Aborted", "AbortError"));
      const abort: WorkerAbortRequest = { type: "ABORT", requestId: running.requestId };
      running.worker?.postMessage(abort);
    }
  }



  /** Least-loaded worker with a free slot, or null if all are saturated. */
  private pickWorker(): Worker | null {
    let best: Worker | null = null;
    let bestLoad = MAX_TASKS_PER_WORKER;
    for (const worker of this.workers) {
      const load = this.workerLoad.get(worker) ?? 0;
      if (load < bestLoad) {
        best = worker;
        bestLoad = load;
      }
    }
    return best;
  }

  private processQueue(): void {
    if (this.pendingTasks.size === 0) {
      return;
    }

    // Sort pending tasks by priority (highest first)
    const sortedTasks = Array.from(this.pendingTasks.values())
      .sort((a, b) => b.priority - a.priority);

    for (const task of sortedTasks) {
      const worker = this.pickWorker();
      if (!worker) break; // every worker is at MAX_TASKS_PER_WORKER

      this.pendingTasks.delete(task.key);
      task.worker = worker;
      this.workerLoad.set(worker, (this.workerLoad.get(worker) ?? 0) + 1);
      this.runningTasks.set(task.key, task);
      this.tasksByRequestId.set(task.requestId, task);

      // Annotated, not spread: the explicit list keeps a caller's extra
      // properties out of the structured clone, and the annotation makes a new
      // REQUIRED field on WorkerTileRequest a compile error here rather than an
      // undefined read in the worker.
      //
      // That guarantee stops at optional fields, which is not a detail: this
      // list silently omitted `showBuildings` for the life of the buildings
      // feature, so the worker never fetched a single building tile and tsc had
      // nothing to say. Anything added here that the worker must act on belongs
      // in the type as required-and-nullable, not optional.
      const request: WorkerTileRequest = {
        requestId: task.requestId,
        tile: task.tile,
        baseUrl: task.options.baseUrl,
        layer: task.options.layer,
        year: task.options.year,
        imagerySource: task.options.imagerySource,
        terrainMinZoom: task.options.terrainMinZoom,
        gridStep: task.options.gridStep,
        externalImageryMaxZoom: task.options.externalImageryMaxZoom,
        showBuildings: task.options.showBuildings
      };
      worker.postMessage(request);
    }
  }

  private handleWorkerMessage(data: WorkerTileResponse): void {
    // Narrowed up front rather than destructured off the union: only SUCCESS
    // carries a bitmap, and the two early returns below still have to close it.
    const imageBitmap = data.type === "SUCCESS" ? data.imageBitmap : null;

    const task = this.tasksByRequestId.get(data.requestId);
    if (!task) {
      // Task was cleaned up earlier (e.g. pool clear); don't leak the bitmap.
      imageBitmap?.close();
      return;
    }

    // Release the worker slot exactly once, on response.
    this.tasksByRequestId.delete(data.requestId);
    if (task.worker) {
      this.workerLoad.set(task.worker, Math.max(0, (this.workerLoad.get(task.worker) ?? 1) - 1));
    }
    // Only remove the running entry if it is still THIS task (a cancelled key
    // may have been re-requested, creating a newer task under the same key).
    if (this.runningTasks.get(task.key) === task) {
      this.runningTasks.delete(task.key);
    }

    if (task.aborted) {
      imageBitmap?.close();
      this.processQueue();
      return;
    }

    if (data.type === "SUCCESS") {
      task.resolve({
        demSource: data.demSource,
        centerElevation: data.centerElevation,
        meshData: data.meshData,
        buildingMeshData: data.buildingMeshData,
        imageBitmap: data.imageBitmap,
        minElevation: data.minElevation,
        maxElevation: data.maxElevation
      });
    } else if (data.type === "ERROR") {
      task.reject(new Error(data.error));
    } else {
      task.reject(new DOMException("Aborted", "AbortError"));
    }

    this.processQueue();
  }

  /**
   * Main thread fallback loader implementation for testing.
   */
  private async loadOnMainThread(tile: TileId, options: TileWorkerTaskOptions): Promise<TileLoadResult> {
    let heights: Float32Array | null = null;
    let demSource = "flat";

    if (tile.z >= options.terrainMinZoom) {
      try {
        const terrain = await loadTerrain(options.baseUrl, tile);
        heights = terrain.heights;
        demSource = terrain.demSource;
      } catch (err: unknown) {
        // Mirror the worker: only a 404 (no DEM coverage) falls back to flat;
        // transient failures rethrow so the retry cooldown handles them.
        if (err instanceof Error && err.message.endsWith(": 404")) {
          console.warn(`No terrain coverage for tile ${tile.z}/${tile.x}/${tile.y}, using flat terrain`);
          heights = null;
          demSource = "flat";
        } else {
          throw err;
        }
      }
    }

    let imageBitmap: ImageBitmap | null = null;
    try {
      // Same shared routing the worker uses, so this fallback (and the tests
      // that run it) can't drift from the browser's real path.
      imageBitmap = await loadImageryFor(tile, {
        baseUrl: options.baseUrl,
        layer: options.layer,
        year: options.year,
        imagerySource: options.imagerySource,
        externalImageryMaxZoom: options.externalImageryMaxZoom,
      });
    } catch (err) {
      console.warn(`Fallback imagery load failed for tile ${tile.z}/${tile.x}/${tile.y}:`, err);
    }

    const meshData = heights
      ? buildTerrainMesh(heights, tile, options.gridStep)
      : buildFlatMesh(tile);

    let minElevation = 0;
    let maxElevation = 0;
    if (heights) {
      minElevation = Infinity;
      maxElevation = -Infinity;
      for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h !== undefined) {
          if (h < minElevation) minElevation = h;
          if (h > maxElevation) maxElevation = h;
        }
      }
    }

    return {
      demSource,
      centerElevation: heights ? (heights[256 * 512 + 256] ?? 0) : 0,
      meshData,
      // This fallback exists for Vitest under jsdom, where Worker is absent. It
      // deliberately skips the buildings fetch: the tests that run it assert on
      // terrain and imagery, and MVT decoding needs no coverage from here.
      buildingMeshData: null,
      imageBitmap,
      minElevation,
      maxElevation
    };
  }

  /**
   * Clear all pending tasks and abort all dispatched ones. Dispatched tasks
   * keep their requestId mapping and worker slot until the worker responds —
   * handleWorkerMessage releases each slot exactly once, so capacity can't
   * leak or double-count.
   */
  clear(): void {
    for (const task of this.pendingTasks.values()) {
      task.reject(new DOMException("Aborted", "AbortError"));
    }
    this.pendingTasks.clear();

    for (const task of this.tasksByRequestId.values()) {
      if (!task.aborted) {
        task.aborted = true;
        task.reject(new DOMException("Aborted", "AbortError"));
        const abort: WorkerAbortRequest = { type: "ABORT", requestId: task.requestId };
        task.worker?.postMessage(abort);
      }
    }
    this.runningTasks.clear();
  }
}
