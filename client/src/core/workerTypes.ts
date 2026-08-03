import { type TileId } from "./mercator";

export interface TileWorkerTaskOptions {
  baseUrl: string;
  layer: string;
  year: number;
  imagerySource: "tiler" | "external";
  terrainMinZoom: number;
  gridStep: number;
  externalImageryMaxZoom?: number;
}

export interface WorkerTileRequest extends TileWorkerTaskOptions {
  type?: "LOAD";
  requestId: string;
  tile: TileId;
}

export interface WorkerAbortRequest {
  type: "ABORT";
  requestId: string;
}

export interface WorkerTileSuccessResponse {
  type: "SUCCESS";
  requestId: string;
  gridStep: number;
  hasTerrain: boolean;
  vertices: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  demSource?: string;
  imageryRgba?: Uint8ClampedArray;
  imageryWidth?: number;
  imageryHeight?: number;
}

export interface WorkerTileErrorResponse {
  type: "ERROR";
  requestId: string;
  error: string;
}

export type WorkerTileResponse = WorkerTileSuccessResponse | WorkerTileErrorResponse;
