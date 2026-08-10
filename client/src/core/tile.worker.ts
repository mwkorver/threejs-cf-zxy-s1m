import { decodeTerrarium } from "./terrarium";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import { buildingsRequest, imageryRequest, terrainRequest } from "./tileUrls";
import { decodeBuildings, type BuildingRecord } from "./buildingMesh";

import type { ImageryCacheState, WorkerRequest, WorkerTileResponse } from "./workerTypes";

/**
 * `self` in a dedicated worker is a DedicatedWorkerGlobalScope, but that type
 * only exists in TypeScript's "webworker" lib, which can't be combined with
 * "dom" -- they redeclare hundreds of the same globals. The client compiles
 * against dom, so name the members this module actually uses instead. Not
 * `Worker`: that is the main thread's *handle to* a worker, and it type-checks
 * here only by coincidence of having the same three method names.
 *
 * Typing postMessage against WorkerTileResponse is the point -- it is what
 * makes the responses below checked against the contract rather than assumed.
 */
interface TileWorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerTileResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (e: MessageEvent<WorkerRequest>) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent<WorkerRequest>) => void): void;
}

const ctx = self as unknown as TileWorkerScope;

/** Abortable sleep that removes its abort listener on normal wake-up. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchTile(url: string, label: string, maxAttempts = 5, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      // Network-level failure: retry unless aborted or out of attempts.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt >= maxAttempts - 1) throw err;
      await sleep(1000, signal);
      continue;
    }
    if (res.ok) return res;

    // Only throttling/unavailable are retryable; anything else (404, 500...)
    // is terminal — retrying a 404 five times just clogs the worker.
    const transient = res.status === 429 || res.status === 503;
    if (!transient || attempt >= maxAttempts - 1) {
      throw new Error(`${label}: ${res.status}`);
    }

    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    const backoff = retryAfter > 0 ? retryAfter : 300 * 2 ** attempt * (0.5 + Math.random());
    await sleep(Math.min(backoff, 8000), signal);
  }
}

// One canvas per worker rather than one per tile: a worker interleaves several
// tile tasks, and churning a 512² OffscreenCanvas for each was pure allocation.
let sharedCanvas: OffscreenCanvas | null = null;
let sharedCtx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * Decode a bitmap to RGBA through the shared canvas.
 *
 * MUST NOT await. Concurrent tile tasks share this canvas, and the only thing
 * keeping them from overwriting each other's pixels is that the body runs to
 * completion in a single turn. Adding an await here would corrupt tiles
 * non-deterministically, in proportion to MAX_TASKS_PER_WORKER.
 */
async function bitmapToRgba(bmp: ImageBitmap): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const w = bmp.width;
  const h = bmp.height;
  if (!sharedCanvas || sharedCanvas.width !== w || sharedCanvas.height !== h) {
    sharedCanvas = new OffscreenCanvas(w, h);
    sharedCtx = sharedCanvas.getContext("2d", { willReadFrequently: true })!;
  } else {
    sharedCtx!.clearRect(0, 0, w, h);
  }
  sharedCtx!.drawImage(bmp, 0, 0);
  const { data } = sharedCtx!.getImageData(0, 0, w, h);
  return { rgba: data, w, h };
}

async function handleTileRequest(e: MessageEvent<WorkerRequest>): Promise<void> {
  // ABORT control messages are handled by the per-request listeners below;
  // without this guard they'd fall through, crash on the missing tile field,
  // and post a spurious ERROR for the aborted requestId. It doubles as the
  // union's discriminant: everything after it is a WorkerTileRequest.
  if (e.data.type === "ABORT") return;

  const { requestId, tile, baseUrl, layer, year, imagerySource, terrainMinZoom, gridStep, externalImageryMaxZoom, showBuildings, buildingSourceZoom } = e.data;

  const abortController = new AbortController();
  const signal = abortController.signal;

  const onAbortMessage = (msgEvent: MessageEvent<WorkerRequest>) => {
    if (msgEvent.data.type === "ABORT" && msgEvent.data.requestId === requestId) {
      abortController.abort();
      ctx.removeEventListener("message", onAbortMessage);
    }
  };
  ctx.addEventListener("message", onAbortMessage);

  try {
    // 1+2. Fetch terrain and imagery CONCURRENTLY — sequential awaits cost
    // terrain_time + imagery_time per tile instead of max(...).

    const terrainPromise = (async (): Promise<{ heights: Float32Array | null; demSource: string }> => {
      if (tile.z < terrainMinZoom) {
        return { heights: null, demSource: "flat" };
      }
      try {
        const { url, label } = terrainRequest(baseUrl, tile);
        const res = await fetchTile(url, label, 5, signal);
        const demSource = res.headers.get("X-DEM-Source") || "farfield";
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const { rgba, w, h } = await bitmapToRgba(bmp);
        bmp.close();
        return { heights: decodeTerrarium(rgba, w, h), demSource };
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        // 404 = genuinely no DEM coverage: fall back to flat so the LOD can
        // subdivide past the coverage edge. Anything else (5xx burst, network)
        // is transient — rethrow so the manager's retry cooldown handles it
        // instead of caching a permanently-flat tile as loaded.
        if (err instanceof Error && err.message.endsWith(": 404")) {
          console.warn(`No terrain coverage for tile ${tile.z}/${tile.x}/${tile.y}, using flat terrain`);
          return { heights: null, demSource: "flat" };
        }
        throw err;
      }
    })();

    // Set when imagery failed transiently: the tile still draws, and
    // TileManager re-requests it later rather than settling for no texture.
    let imageryFailed = false;
    // CloudFront reports "Hit from cloudfront" / "Miss from cloudfront" /
    // "RefreshHit from cloudfront". A miss means the tiler generated this tile
    // for real; a hit means the edge served it and the origin was never asked.
    let imageryCache: ImageryCacheState = "unknown";
    const imageryPromise = (async (): Promise<ImageBitmap | null> => {
      try {
        // Routing (OSM / low-zoom USGS basemap / NAIP COG mosaic) and key
        // handling live in tileUrls, shared with the main-thread fallback.
        const { url, label } = imageryRequest(tile, {
          baseUrl,
          layer,
          year,
          imagerySource,
          externalImageryMaxZoom,
        });
        const imgRes = await fetchTile(url, label, 5, signal);
        const xCache = imgRes.headers.get("x-cache") ?? "";
        if (xCache.includes("Hit")) {
          imageryCache = "hit";
        } else if (xCache.includes("Miss")) {
          imageryCache = "miss";
        }
        const imgBlob = await imgRes.blob();
        return await createImageBitmap(imgBlob);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        const is404 = err instanceof Error && err.message.includes("404");
        if (is404) {
          console.warn(`No imagery coverage for tile ${tile.z}/${tile.x}/${tile.y} (404)`);
          return null;
        }
        // Transient error (5xx, network glitch, timeout). Reported, not thrown:
        // throwing took the terrain down with it, and terrain is the tile --
        // without it there is no mesh at all, so an upstream 503 on one basemap
        // tile punched a hole in the world and the sky showed through. Observed
        // over Long Island Sound, where /basemap/9/151/192 answers 503
        // "basemap upstream unavailable" while its neighbours are fine.
        //
        // The original intent -- do not permanently accept a fallback for what
        // is only a blip -- is kept, and now actually delivered: the tile draws
        // its terrain untextured and is marked imageryPending, which makes
        // TileManager re-request it once the cooldown expires, so it upgrades to
        // real imagery when the upstream recovers.
        console.warn(`Imagery unavailable for tile ${tile.z}/${tile.x}/${tile.y}, retrying later:`, err);
        imageryFailed = true;
        return null;
      }
    })();

    // Settle both so a terrain failure can't leak a fulfilled imagery bitmap.
    // Only terrain can fail the tile: it IS the tile, and imagery is a skin on
    // it. An imagery rejection now arrives as a null bitmap plus imageryFailed.
    const [terrainSettled, imagerySettled] = await Promise.allSettled([terrainPromise, imageryPromise]);
    if (terrainSettled.status === "rejected") {
      if (imagerySettled.status === "fulfilled") {
        imagerySettled.value?.close();
      }
      throw terrainSettled.reason;
    }
    const { heights, demSource } = terrainSettled.value;
    const imageBitmap = imagerySettled.status === "fulfilled" ? imagerySettled.value : null;
    if (imagerySettled.status === "rejected") {
      imageryFailed = true;
    }

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

    // 3. Build the mesh geometry on the background thread
    const meshData = heights
      ? buildTerrainMesh(heights, tile, gridStep)
      : buildFlatMesh(tile);

    // 4. Fetch building footprints -- ONLY at the source zoom.
    //
    // Buildings do not change with zoom, so finer tiles re-extrude from the
    // main thread's BuildingCache instead of asking again. Requesting per
    // terrain tile, as this used to, ran the tiler's DuckDB query 256 times
    // over between z14 and z18 for the same footprints.
    let buildingRecords: BuildingRecord[] | null = null;
    if (showBuildings && tile.z === buildingSourceZoom) {
      try {
        const { url, label } = buildingsRequest(baseUrl, tile);
        const res = await fetchTile(url, label, 3, signal);
        const pbfBuf = await res.arrayBuffer();
        buildingRecords = decodeBuildings(pbfBuf, tile);
      } catch (err) {
        // Buildings are an overlay: losing them must not cost the tile its
        // terrain and imagery. Warned rather than silent -- a swallowed 403
        // here is what made the whole feature look like "no coverage".
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.warn(`Building fetch failed for tile ${tile.z}/${tile.x}/${tile.y}:`, err);
        }
        buildingRecords = null;
      }
    }

    // 5. Pass back ownership via transferable ArrayBuffers
    const transferList: Transferable[] = [
      meshData.positions.buffer,
      meshData.uvs.buffer,
      meshData.normals.buffer,
      meshData.indices.buffer
    ];
    if (imageBitmap) {
      transferList.push(imageBitmap);
    }
    // buildingRecords are plain arrays, not typed arrays: nothing to transfer,
    // they go by structured clone. Only sent on source-zoom tiles, so the clone
    // cost is paid once per source tile rather than once per terrain tile.

    ctx.postMessage({
      type: "SUCCESS",
      requestId,
      tile,
      demSource,
      centerElevation: heights ? (heights[256 * 512 + 256] ?? 0) : 0,
      meshData: {
        positions: meshData.positions,
        uvs: meshData.uvs,
        normals: meshData.normals,
        indices: meshData.indices,
        anchor: meshData.anchor,
        gridSize: meshData.gridSize
      },
      buildingRecords,
      imageBitmap,
      imageryPending: imageryFailed,
      imageryCache,
      minElevation,
      maxElevation
    }, transferList);

  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      ctx.postMessage({ type: "ABORTED", requestId, tile });
    } else {
      ctx.postMessage({
        type: "ERROR",
        requestId,
        tile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    ctx.removeEventListener("message", onAbortMessage);
  }
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  // onmessage is void-returning, so the handler's promise has to be dealt with
  // here rather than assigned straight in. Everything meaningful inside
  // handleTileRequest already sits in a try/catch that answers with ERROR; this
  // covers only the narrow window before it -- a message so malformed that
  // reading e.data.type throws, where there is no requestId to answer with.
  // Logged rather than discarded: an unhandled rejection inside a worker is
  // invisible from the main thread, which would leave the pool's task pending
  // with no clue why.
  handleTileRequest(e).catch((err: unknown) => {
    console.error("tile worker: request failed before setup completed", err);
  });
};
