import { type TileId } from "./mercator";
import { loadTerrain, loadImagery, loadImageryExternal, loadImageryOSM } from "./tileLoader";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";

interface PendingTask {
  requestId: string;
  key: string;
  tile: TileId;
  priority: number;
  options: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  aborted: boolean;
  /** Worker this task was dispatched to (set on dispatch). */
  worker?: Worker;
}

// Tile tasks are almost entirely I/O (fetch + decode awaits), so a worker can
// interleave several concurrently — capping at 1 task/worker throttled the
// whole pipeline to 4 tiles in flight and starved forward flight.
const MAX_TASKS_PER_WORKER = 4;

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

    const numWorkers = navigator.hardwareConcurrency ? Math.min(4, navigator.hardwareConcurrency) : 4;
    for (let i = 0; i < numWorkers; i++) {
      // Use standard module worker instantiation which Vite natively compiles
      const worker = new Worker(new URL("./tile.worker.ts", import.meta.url), { type: "module" });

      worker.onmessage = (e: MessageEvent) => {
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
  requestTile(tile: TileId, priority: number, options: any): Promise<any> {
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
      running.worker?.postMessage({ type: "ABORT", requestId: running.requestId });
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

      worker.postMessage({
        requestId: task.requestId,
        tile: task.tile,
        baseUrl: task.options.baseUrl,
        layer: task.options.layer,
        year: task.options.year,
        imagerySource: task.options.imagerySource,
        terrainMinZoom: task.options.terrainMinZoom,
        usgsMinZoom: task.options.usgsMinZoom,
        s1mMinZoom: task.options.s1mMinZoom,
        gridStep: task.options.gridStep,
        externalImageryMaxZoom: task.options.externalImageryMaxZoom
      });
    }
  }

  private handleWorkerMessage(data: any): void {
    const { type, requestId, error, demSource, centerElevation, meshData, imageBitmap } = data;

    const task = this.tasksByRequestId.get(requestId);
    if (!task) {
      // Task was cleaned up earlier (e.g. pool clear); don't leak the bitmap.
      imageBitmap?.close();
      return;
    }

    // Release the worker slot exactly once, on response.
    this.tasksByRequestId.delete(requestId);
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

    if (type === "SUCCESS") {
      task.resolve({
        demSource,
        centerElevation,
        meshData,
        imageBitmap
      });
    } else if (type === "ERROR") {
      task.reject(new Error(error));
    } else if (type === "ABORTED") {
      task.reject(new DOMException("Aborted", "AbortError"));
    }

    this.processQueue();
  }

  /**
   * Main thread fallback loader implementation for testing.
   */
  private async loadOnMainThread(tile: TileId, options: any): Promise<any> {
    let heights: Float32Array | null = null;
    let demSource = "flat";

    if (tile.z >= options.terrainMinZoom) {
      try {
        const terrain = await loadTerrain(options.baseUrl, tile, options.usgsMinZoom, options.s1mMinZoom);
        heights = terrain.heights;
        demSource = terrain.demSource;
      } catch (err: any) {
        // Mirror the worker: only a 404 (no DEM coverage) falls back to flat;
        // transient failures rethrow so the retry cooldown handles them.
        if (typeof err?.message === "string" && err.message.endsWith(": 404")) {
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
      if (options.imagerySource === "osm") {
        imageBitmap = await loadImageryOSM(tile);
      } else {
        if (tile.z <= options.externalImageryMaxZoom) {
          imageBitmap = await loadImageryExternal(tile);
        } else {
          imageBitmap = await loadImagery(options.baseUrl, options.layer, options.year, tile);
        }
      }
    } catch (err) {
      console.warn(`Fallback imagery load failed for tile ${tile.z}/${tile.x}/${tile.y}:`, err);
    }

    const meshData = heights
      ? buildTerrainMesh(heights, tile, options.gridStep)
      : buildFlatMesh(tile);

    return {
      demSource,
      centerElevation: heights ? (heights[256 * 512 + 256] ?? 0) : 0,
      meshData,
      imageBitmap
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
        task.worker?.postMessage({ type: "ABORT", requestId: task.requestId });
      }
    }
    this.runningTasks.clear();
  }
}
