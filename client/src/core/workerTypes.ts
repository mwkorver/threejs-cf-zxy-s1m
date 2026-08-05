/**
 * The tile worker's message contract.
 *
 * These types are derived from the modules that own the shapes rather than
 * restated: ImageryRouting (tileUrls) already defines what the imagery fetch
 * needs, and TerrainMesh (terrainMesh) already defines what the mesh builders
 * return. Restating either here is how the two drift apart -- the first version
 * of this file declared fields (`vertices`, `hasTerrain`, `imageryRgba`) that no
 * message has ever carried, and an imagerySource union of "tiler" | "external"
 * when the real values are "satellite" | "osm".
 *
 * Nothing catches that unless the types sit on the boundary, so they are
 * applied at all four crossings: the worker's onmessage and postMessage
 * (tile.worker.ts) and the pool's postMessage and onmessage (tileWorkerPool.ts).
 */

import { type TileId } from "./mercator";
import type { TerrainMesh } from "./terrainMesh";
import type { ImageryRouting } from "./tileUrls";
import type { BuildingRecord } from "./buildingMesh";

/**
 * Everything a tile load needs beyond the tile itself. Extends the imagery
 * routing contract so the worker's imageryRequest call and the pool's option
 * object cannot disagree about how a tile's imagery is addressed.
 */
export interface TileWorkerTaskOptions extends ImageryRouting {
  /** Below this zoom the worker skips the DEM fetch and builds a flat quad. */
  terrainMinZoom: number;
  /** Mesh vertices every N source texels; the LOD manager picks it per tile. */
  gridStep: number;
  /**
   * Whether to fetch Overture buildings for this tile.
   *
   * Required, not optional. As `showBuildings?: boolean` the pool's explicit
   * request list simply omitted it, the worker destructured `undefined`, and
   * the buildings branch never ran -- with nothing for tsc to object to. All
   * three call sites in tileManager already pass it.
   */
  showBuildings: boolean;
  /**
   * The single zoom that fetches buildings. The worker requests /buildings only
   * when `tile.z === buildingSourceZoom`; every finer tile re-extrudes from the
   * main thread's BuildingCache instead.
   */
  buildingSourceZoom: number;
}

export interface WorkerTileRequest extends TileWorkerTaskOptions {
  /**
   * Never sent -- a load request has no `type` field on the wire. Declared as
   * optional-undefined so the union below is still discriminable by `type`,
   * which is what lets the worker's `=== "ABORT"` guard narrow to this member.
   * An earlier version wrote `type?: "LOAD"`, which narrows identically but
   * claims a tag no sender has ever set.
   */
  type?: undefined;
  requestId: string;
  tile: TileId;
}

/** Cancels an in-flight request. Handled by per-request listeners, not onmessage. */
export interface WorkerAbortRequest {
  type: "ABORT";
  requestId: string;
}

export type WorkerRequest = WorkerTileRequest | WorkerAbortRequest;

/**
 * The mesh as it crosses the thread boundary: TerrainMesh minus `tile`, which
 * the worker drops because the response carries it alongside. Omit rather than
 * a fresh interface, so adding a field to TerrainMesh fails to compile here
 * instead of silently not being transferred.
 */
export type WorkerMeshData = Omit<TerrainMesh, "tile">;

export interface WorkerTileSuccessResponse {
  type: "SUCCESS";
  requestId: string;
  tile: TileId;
  /** Which DEM band served the tile, or "flat" below terrainMinZoom. */
  demSource: string;
  centerElevation: number;
  meshData: WorkerMeshData;
  /**
   * Decoded building footprints for this tile, or null when it is not the
   * source zoom, buildings are off, or nothing decoded.
   *
   * Vectors rather than extruded geometry: the same buildings are drawn at
   * every zoom above the source, and each zoom needs its own base elevations
   * and roof UVs. The main thread caches these and extrudes per terrain tile.
   *
   * Required-but-nullable, deliberately. As an optional field its predecessor
   * was silently dropped: tileWorkerPool forwards the success payload field by
   * field, and an omitted optional still satisfies TileLoadResult, so the worker
   * sent buildings, the pool discarded them, and tsc saw nothing wrong.
   */
  buildingRecords: BuildingRecord[] | null;
  /** null when imagery 404s: no coverage, but the mesh is still good. */
  imageBitmap: ImageBitmap | null;
  minElevation: number;
  maxElevation: number;
}

export interface WorkerTileAbortedResponse {
  type: "ABORTED";
  requestId: string;
  tile: TileId;
}

export interface WorkerTileErrorResponse {
  type: "ERROR";
  requestId: string;
  tile: TileId;
  error: string;
}

export type WorkerTileResponse =
  | WorkerTileSuccessResponse
  | WorkerTileAbortedResponse
  | WorkerTileErrorResponse;

/** What requestTile resolves with: the success payload minus the message envelope. */
export type TileLoadResult = Omit<WorkerTileSuccessResponse, "type" | "requestId" | "tile">;
