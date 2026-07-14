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
}

export class TileWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private workerToTask = new Map<Worker, PendingTask>();
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
        this.handleWorkerMessage(worker, e.data);
      };
      
      this.workers.push(worker);
      this.idleWorkers.push(worker);
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

    // Abort actively running worker request. Keep the worker->task mapping and
    // do NOT re-idle the worker here: it is still executing until it posts its
    // ABORTED/SUCCESS response, and handleWorkerMessage re-idles it exactly
    // once. Re-idling early could assign a second task to a busy worker.
    const running = this.runningTasks.get(key);
    if (running) {
      running.aborted = true;
      this.runningTasks.delete(key);
      running.reject(new DOMException("Aborted", "AbortError"));

      for (const [worker, task] of this.workerToTask.entries()) {
        if (task.key === key) {
          worker.postMessage({ type: "ABORT", requestId: task.requestId });
          break;
        }
      }
    }
  }

  private processQueue(): void {
    if (this.idleWorkers.length === 0 || this.pendingTasks.size === 0) {
      return;
    }

    // Sort pending tasks by priority (highest first)
    const sortedTasks = Array.from(this.pendingTasks.values())
      .sort((a, b) => b.priority - a.priority);

    while (this.idleWorkers.length > 0 && sortedTasks.length > 0) {
      const task = sortedTasks.shift()!;
      this.pendingTasks.delete(task.key);

      const worker = this.idleWorkers.pop()!;
      this.workerToTask.set(worker, task);
      this.runningTasks.set(task.key, task);

      worker.postMessage({
        requestId: task.requestId,
        tile: task.tile,
        baseUrl: task.options.baseUrl,
        layer: task.options.layer,
        year: task.options.year,
        imagerySource: task.options.imagerySource,
        terrainMinZoom: task.options.terrainMinZoom,
        gridStep: task.options.gridStep,
        externalImageryMaxZoom: task.options.externalImageryMaxZoom
      });
    }
  }

  private handleWorkerMessage(worker: Worker, data: any): void {
    const { type, requestId, error, demSource, centerElevation, meshData, imageBitmap } = data;
    
    const task = this.workerToTask.get(worker);
    if (!task || task.requestId !== requestId) {
      // Task was cleaned up earlier (e.g. pool clear); don't leak the bitmap.
      imageBitmap?.close();
      return;
    }

    this.workerToTask.delete(worker);
    this.idleWorkers.push(worker);
    this.runningTasks.delete(task.key);

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
        const terrain = await loadTerrain(options.baseUrl, tile);
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
   * Clear all pending tasks from the queue.
   */
  clear(): void {
    for (const task of this.pendingTasks.values()) {
      task.reject(new DOMException("Aborted", "AbortError"));
    }
    this.pendingTasks.clear();

    // Send abort to all running tasks
    for (const [worker, task] of this.workerToTask.entries()) {
      worker.postMessage({ type: "ABORT", requestId: task.requestId });
      task.reject(new DOMException("Aborted", "AbortError"));
    }
    this.workerToTask.clear();
    this.runningTasks.clear();
    
    this.idleWorkers = [...this.workers];
  }
}
