import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TileWorkerPool } from "./tileWorkerPool";

/**
 * Tests for TileWorkerPool.
 *
 * Real Web Workers aren't available in Vitest/Node.js, so the pool falls back to
 * its main-thread `loadOnMainThread` path (typeof Worker === "undefined"). This
 * path executes synchronously: by the time requestTile's promise chain settles,
 * the load is already complete. Because of this, cancelTile and clear cannot
 * reject a promise that has already resolved — that behavior only manifests
 * with real workers (where there's async I/O between dispatch and response).
 *
 * These tests validate:
 * - Main-thread fallback: correct mesh data returned
 * - Deduplication: same tile key returns shared promise
 * - Multiple concurrent requests
 * - Worker dispatch path (mocked Worker): correct message shape
 * - cancelTile for unknown tiles: no-op
 */

const TILE_12_2048_2048 = { z: 12, x: 2048, y: 2048 };
const TILE_12_2048_2049 = { z: 12, x: 2048, y: 2049 };
const TILE_12_2049_2048 = { z: 12, x: 2049, y: 2048 };
const TILE_12_2049_2049 = { z: 12, x: 2049, y: 2049 };

const BASE_OPTIONS = {
  baseUrl: "http://test-tiler",
  layer: "test-layer",
  year: 2023,
  imagerySource: "satellite" as const,
  terrainMinZoom: 14,
  gridStep: 8,
  externalImageryMaxZoom: 13,
};

// Suppress noisy console output from tile loading warnings
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("TileWorkerPool (main-thread fallback)", () => {
  it("loads a tile and returns mesh data with correct structure", async () => {
    const pool = new TileWorkerPool();
    const result = await pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);

    expect(result).toBeDefined();
    expect(result.meshData).toBeDefined();
    expect(result.meshData.positions).toBeInstanceOf(Float32Array);
    expect(result.meshData.indices).toBeInstanceOf(Uint32Array);
    expect(result.meshData.uvs).toBeInstanceOf(Float32Array);
    expect(result.meshData.normals).toBeInstanceOf(Float32Array);
    expect(result.meshData.anchor).toHaveLength(2);
    expect(result.meshData.gridSize).toBeGreaterThan(0);
    // z12 < terrainMinZoom(14), so no terrain fetch → flat
    expect(result.demSource).toBe("flat");
    expect(result.centerElevation).toBe(0);
    // Imagery fails in test env (no real fetch), so null is expected
    expect(result.imageBitmap).toBeNull();
  });

  it("de-duplicates concurrent requests for the same tile", async () => {
    const pool = new TileWorkerPool();
    const p1 = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    const p2 = pool.requestTile(TILE_12_2048_2048, 5, BASE_OPTIONS);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    // Both should resolve (de-dup shares the underlying promise)
  });

  it("handles multiple concurrent requests for different tiles", async () => {
    const pool = new TileWorkerPool();
    const results = await Promise.all([
      pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS),
      pool.requestTile(TILE_12_2048_2049, 9, BASE_OPTIONS),
      pool.requestTile(TILE_12_2049_2048, 8, BASE_OPTIONS),
      pool.requestTile(TILE_12_2049_2049, 7, BASE_OPTIONS),
    ]);

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.meshData).toBeDefined();
      expect(r.meshData.positions.length).toBeGreaterThan(0);
    }
  });

  it("cancelTile for an unknown tile is a no-op", () => {
    const pool = new TileWorkerPool();
    expect(() => pool.cancelTile(TILE_12_2048_2048)).not.toThrow();
  });

  it("pool remains usable after clear", async () => {
    const pool = new TileWorkerPool();
    // In main-thread fallback, the request resolves synchronously before clear runs.
    // This is expected: with real workers the I/O gap allows cancellation.
    const p1 = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    pool.clear();
    // p1 already resolved (main-thread fallback), so no rejection.
    // But the pool should accept new requests after clear.
    const result = await pool.requestTile(TILE_12_2048_2049, 10, BASE_OPTIONS);
    expect(result.meshData).toBeDefined();
  });
});

describe("TileWorkerPool worker dispatch (mocked Worker)", () => {
  /**
   * Tests the worker dispatch path by stubbing the global Worker constructor.
   * This validates that processQueue sends correctly shaped messages to workers,
   * and that handleWorkerMessage correctly routes responses back to callers.
   */

  let pool: TileWorkerPool;
  let capturedMessages: Array<{ msg: any; worker: any }>;
  let workers: any[];

  beforeEach(() => {
    capturedMessages = [];
    workers = [];

    vi.stubGlobal("Worker", class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      _id: number;

      constructor() {
        this._id = workers.length;
        workers.push(this);
      }

      postMessage(msg: any) {
        capturedMessages.push({ msg, worker: this });
        // Simulate ABORTED for ABORT messages
        if (msg.type === "ABORT") {
          setTimeout(() => {
            if (this.onmessage) {
              this.onmessage(new MessageEvent("message", {
                data: { type: "ABORTED", requestId: msg.requestId, tile: msg.tile },
              }));
            }
          }, 0);
        }
      }
    });

    pool = new TileWorkerPool();
  });

  afterEach(() => {
    pool.clear();
    vi.unstubAllGlobals();
  });

  it("dispatches requests to workers with correct payload shape", async () => {
    const promise = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);

    // Let microtasks flush (processQueue runs synchronously but postMessage is async)
    await new Promise((r) => setTimeout(r, 0));

    expect(capturedMessages.length).toBeGreaterThan(0);
    const dispatched = capturedMessages.find(
      (c) => c.msg.tile && c.msg.tile.x === 2048 && c.msg.tile.y === 2048,
    );
    expect(dispatched).toBeDefined();
    expect(dispatched!.msg.tile).toEqual({ z: 12, x: 2048, y: 2048 });
    expect(dispatched!.msg.baseUrl).toBe("http://test-tiler");
    expect(dispatched!.msg.layer).toBe("test-layer");
    expect(dispatched!.msg.year).toBe(2023);
    expect(dispatched!.msg.imagerySource).toBe("satellite");
    expect(dispatched!.msg.terrainMinZoom).toBe(14);
    expect(dispatched!.msg.gridStep).toBe(8);
    expect(dispatched!.msg.externalImageryMaxZoom).toBe(13);
    expect(dispatched!.msg.requestId).toMatch(/^req_\d+$/);

    // Clean up to avoid hanging promises
    pool.cancelTile(TILE_12_2048_2048);
    try { await promise; } catch { /* aborted */ }
  });

  it("cancels running worker tasks via ABORT message", async () => {
    const promise = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    await new Promise((r) => setTimeout(r, 0));

    // Verify a request was dispatched
    expect(capturedMessages.length).toBeGreaterThan(0);

    // Capture the rejection immediately when cancel fires
    const rejectPromise = promise.catch(() => {});

    // Cancel should post an ABORT message to the worker
    pool.cancelTile(TILE_12_2048_2048);
    await new Promise((r) => setTimeout(r, 10));

    const abortMsg = capturedMessages.find((c) => c.msg.type === "ABORT");
    expect(abortMsg).toBeDefined();
    expect(abortMsg!.msg.requestId).toBeDefined();

    await rejectPromise;
  });

  it("clear posts ABORT to all dispatched tasks", async () => {
    const p1 = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    const p2 = pool.requestTile(TILE_12_2048_2049, 9, BASE_OPTIONS);
    await new Promise((r) => setTimeout(r, 0));

    // Attach catch handlers before clear to avoid unhandled rejections
    const r1 = p1.catch(() => {});
    const r2 = p2.catch(() => {});

    pool.clear();
    await new Promise((r) => setTimeout(r, 10));

    // Should have ABORT messages for both dispatched tasks
    const abortMsgs = capturedMessages.filter((c) => c.msg.type === "ABORT");
    expect(abortMsgs.length).toBe(2);

    await Promise.all([r1, r2]);
  });

  it("routes SUCCESS responses back to the caller", async () => {
    const promise = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    await new Promise((r) => setTimeout(r, 0));

    // Find the dispatched message and its requestId
    const dispatched = capturedMessages.find(
      (c) => c.msg.tile && c.msg.tile.x === 2048,
    );
    expect(dispatched).toBeDefined();
    const requestId = dispatched!.msg.requestId;

    // Simulate a SUCCESS response from the worker
    const positions = new Float32Array(12);
    const uvs = new Float32Array(8);
    const normals = new Float32Array(12);
    const indices = new Uint32Array(6);
    const meshData = {
      positions,
      uvs,
      normals,
      indices,
      anchor: [0, 0] as [number, number],
      gridSize: 2,
    };

    // Fire the worker's onmessage handler with a SUCCESS payload
    const worker = dispatched!.worker;
    expect(worker!.onmessage).not.toBeNull();
    worker.onmessage!(new MessageEvent("message", {
      data: {
        type: "SUCCESS",
        requestId,
        tile: TILE_12_2048_2048,
        demSource: "flat",
        centerElevation: 0,
        meshData,
        imageBitmap: null,
      },
    }));

    const result = await promise;
    expect(result.demSource).toBe("flat");
    expect(result.meshData).toBe(meshData);
  });

  it("routes ERROR responses back to the caller", async () => {
    const promise = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    await new Promise((r) => setTimeout(r, 0));

    const dispatched = capturedMessages.find(
      (c) => c.msg.tile && c.msg.tile.x === 2048,
    );
    expect(dispatched).toBeDefined();
    const requestId = dispatched!.msg.requestId;
    const worker = dispatched!.worker;

    // Simulate an ERROR response
    worker.onmessage!(new MessageEvent("message", {
      data: {
        type: "ERROR",
        requestId,
        tile: TILE_12_2048_2048,
        error: "network failure",
      },
    }));

    await expect(promise).rejects.toThrow("network failure");
  });

  it("cancels the requestId task when pool is cleared mid-flight", async () => {
    // Verify cleanup: pool.clear should prevent dangling promises
    const promise = pool.requestTile(TILE_12_2048_2048, 10, BASE_OPTIONS);
    await new Promise((r) => setTimeout(r, 0));

    const caught = promise.catch(() => "caught");
    pool.clear();
    await new Promise((r) => setTimeout(r, 10));

    expect(await caught).toBe("caught");
  });
});
