import { decodeTerrarium } from "./terrarium";
import { buildTerrainMesh, buildFlatMesh } from "./terrainMesh";
import { type TileId } from "./mercator";

const ctx: any = self;

async function fetchTile(url: string, label: string, maxAttempts = 5, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return res;
      
      const transient = res.status === 429 || res.status === 503;
      if (!transient || attempt >= maxAttempts - 1) {
        throw new Error(`${label}: ${res.status}`);
      }
      
      const retryAfter = Number(res.headers.get("retry-after")) * 1000;
      const backoff = retryAfter > 0 ? retryAfter : 300 * 2 ** attempt * (0.5 + Math.random());
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, Math.min(backoff, 8000));
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      if (attempt >= maxAttempts - 1) {
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function bitmapToRgba(bmp: ImageBitmap): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx2d.drawImage(bmp, 0, 0);
  const { data } = ctx2d.getImageData(0, 0, bmp.width, bmp.height);
  return { rgba: data, w: bmp.width, h: bmp.height };
}

ctx.onmessage = async (e: MessageEvent) => {
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
    let heights: Float32Array | null = null;
    let demSource = "flat";

    // 1. Fetch & decode terrain WebP if above the floor
    if (tile.z >= terrainMinZoom) {
      const res = await fetchTile(
        `${baseUrl}/terrain/${tile.z}/${tile.x}/${tile.y}.webp`,
        `terrain ${tile.z}/${tile.x}/${tile.y}`,
        5,
        signal
      );
      demSource = res.headers.get("X-DEM-Source") || "farfield";
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const { rgba, w, h } = await bitmapToRgba(bmp);
      bmp.close();
      heights = decodeTerrarium(rgba, w, h);
    }

    // 2. Fetch & decode imagery WebP/PNG
    let imageBitmap: ImageBitmap | null = null;
    try {
      let imgRes: Response;
      if (imagerySource === "osm") {
        imgRes = await fetchTile(
          `https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`,
          `osm ${tile.z}/${tile.x}/${tile.y}`,
          5,
          signal
        );
      } else {
        if (tile.z <= externalImageryMaxZoom) {
          imgRes = await fetchTile(
            `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${tile.z}/${tile.y}/${tile.x}`,
            `usgs ${tile.z}/${tile.x}/${tile.y}`,
            5,
            signal
          );
        } else {
          imgRes = await fetchTile(
            `${baseUrl}/imagery/${layer}/${year}/${tile.z}/${tile.x}/${tile.y}.webp`,
            `imagery ${tile.z}/${tile.x}/${tile.y}`,
            5,
            signal
          );
        }
      }
      const imgBlob = await imgRes.blob();
      imageBitmap = await createImageBitmap(imgBlob);
    } catch (err) {
      // Imagery loading failure is non-fatal; the tile renders with fallbackColor
      console.warn(`Imagery failed to load for tile ${tile.z}/${tile.x}/${tile.y}:`, err);
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
      imageBitmap
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
