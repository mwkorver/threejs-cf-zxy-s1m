import { decodeTerrarium } from "./terrarium";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import { type TileId } from "./mercator";
import { imageryRequest, terrainRequest } from "./tileUrls";

const ctx: any = self;

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

ctx.onmessage = async (e: MessageEvent) => {
  // ABORT control messages are handled by the per-request listeners below;
  // without this guard they'd fall through, crash on the missing tile field,
  // and post a spurious ERROR for the aborted requestId.
  if (e.data.type === "ABORT") return;



  const { requestId, tile, baseUrl, layer, year, imagerySource, terrainMinZoom, gridStep, externalImageryMaxZoom } = e.data;
  
  const abortController = new AbortController();
  const signal = abortController.signal;

  const onAbortMessage = (msgEvent: MessageEvent) => {
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
      } catch (err: any) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw err;
        }
        // 404 = genuinely no DEM coverage: fall back to flat so the LOD can
        // subdivide past the coverage edge. Anything else (5xx burst, network)
        // is transient — rethrow so the manager's retry cooldown handles it
        // instead of caching a permanently-flat tile as loaded.
        if (typeof err?.message === "string" && err.message.endsWith(": 404")) {
          console.warn(`No terrain coverage for tile ${tile.z}/${tile.x}/${tile.y}, using flat terrain`);
          return { heights: null, demSource: "flat" };
        }
        throw err;
      }
    })();

    const imageryPromise = (async (): Promise<ImageBitmap | null> => {
      try {
        // Routing (OSM / low-zoom USDA stitch / NAIP COG mosaic) and key
        // handling live in tileUrls, shared with the main-thread fallback.
        const { url, label } = imageryRequest(tile, {
          baseUrl,
          layer,
          year,
          imagerySource,
          externalImageryMaxZoom,
        });
        const imgRes = await fetchTile(url, label, 5, signal);
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
        // Transient error (5xx, network glitch, timeout): rethrow so TileManager
        // retries instead of permanently marking the tile loaded with a fallback hole.
        throw err;
      }
    })();

    // Settle both so a terrain failure can't leak a fulfilled imagery bitmap.
    const [terrainSettled, imagerySettled] = await Promise.allSettled([terrainPromise, imageryPromise]);
    if (terrainSettled.status === "rejected" || imagerySettled.status === "rejected") {
      if (imagerySettled.status === "fulfilled") {
        imagerySettled.value?.close();
      }
      throw terrainSettled.status === "rejected"
        ? terrainSettled.reason
        : (imagerySettled as PromiseRejectedResult).reason;
    }
    const { heights, demSource } = terrainSettled.value;
    const imageBitmap = imagerySettled.value;

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

    // 4. Pass back ownership via transferable ArrayBuffers
    const transferList: Transferable[] = [
      meshData.positions.buffer,
      meshData.uvs.buffer,
      meshData.normals.buffer,
      meshData.indices.buffer
    ];
    if (imageBitmap) {
      transferList.push(imageBitmap);
    }

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
      imageBitmap,
      minElevation,
      maxElevation
    }, transferList);

  } catch (err: any) {
    if (err instanceof DOMException && err.name === "AbortError") {
      ctx.postMessage({ type: "ABORTED", requestId, tile });
    } else {
      ctx.postMessage({ type: "ERROR", requestId, tile, error: err?.message || String(err) });
    }
  } finally {
    ctx.removeEventListener("message", onAbortMessage);
  }
};
