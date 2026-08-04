import { VectorTile } from "@mapbox/vector-tile";
import * as PbfModule from "pbf";
import { type TileId } from "./mercator";

const Pbf = (PbfModule as any).default || PbfModule;

export interface BuildingFeatureData {
  id: string;
  height: number;
  geometry: Array<Array<{ x: number; y: number }>>;
}

export interface ExtrudedBuildingMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * Decode 512px MVT protobuf vector tile and extrude 3D building wall/roof polygons.
 */
export function decodeAndExtrudeBuildings(
  pbfBuffer: ArrayBuffer,
  tile: TileId,
  heightfield: Float32Array | null,
  activeBuildingIds: Set<string>
): ExtrudedBuildingMesh | null {
  if (!pbfBuffer || pbfBuffer.byteLength === 0) return null;

  try {
    const tilePbf = new Pbf(new Uint8Array(pbfBuffer));
    const vectorTile = new VectorTile(tilePbf);
    const layerName = Object.keys(vectorTile.layers)[0] || "buildings";
    const layer = vectorTile.layers[layerName];
    if (!layer || layer.length === 0) return null;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    let vertexOffset = 0;
    const defaultHeight = 12.0; // 12 meters default height if absent

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties;
      const buildingId = String(props.id ?? feature.id ?? `bldg_${tile.z}_${tile.x}_${tile.y}_${i}`);

      // Deduplicate buildings across neighboring tiles
      if (activeBuildingIds.has(buildingId)) {
        continue;
      }

      const buildingHeight = Number(props.height ?? (props.num_floors ? Number(props.num_floors) * 3.5 : defaultHeight));
      const geom = feature.loadGeometry(); // array of rings

      if (!geom || geom.length === 0) continue;
      const outerRing = geom[0];
      if (!outerRing || outerRing.length < 3) continue;

      // Calculate anchor centroid & sample ground elevation
      let sumX = 0;
      let sumY = 0;
      for (const p of outerRing) {
        sumX += p.x;
        sumY += p.y;
      }
      const anchorX = sumX / outerRing.length;
      const anchorY = sumY / outerRing.length;

      let groundZ = 0;
      if (heightfield && heightfield.length === 512 * 512) {
        // Map 4096 MVT coordinate space -> 512 heightfield grid
        const gx = Math.min(511, Math.max(0, Math.floor((anchorX / 4096) * 512)));
        const gy = Math.min(511, Math.max(0, Math.floor((anchorY / 4096) * 512)));
        const hz = heightfield[gy * 512 + gx];
        if (hz !== undefined && !isNaN(hz)) {
          groundZ = hz;
        }
      }

      const baseZ = groundZ;
      const topZ = groundZ + buildingHeight;

      // Scale coordinates from tile 4096 extent to local tile meters.
      // Terrain mesh positions are NW-anchor-relative: X grows east [0, tileW],
      // Y grows south [0, -tileH]. MVT coordinates: x grows east [0, extent],
      // y grows south [0, extent]. Map MVT -> terrain local space directly.
      const tileSizeMeters = 40075016.68557849 / Math.pow(2, tile.z); // Mercator tile size
      const scale = tileSizeMeters / layer.extent;

      // Build 3D walls around ring
      for (let j = 0; j < outerRing.length; j++) {
        const curr = outerRing[j]!;
        const next = outerRing[(j + 1) % outerRing.length]!;

        const x1 = curr.x * scale;
        const y1 = -curr.y * scale;  // MVT y grows down, terrain Y grows south (negative)
        const x2 = next.x * scale;
        const y2 = -next.y * scale;

        // Normal for vertical wall segment
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;

        const nx = dy / len;
        const ny = -dx / len;

        // Wall quad: v0(x1, y1, baseZ), v1(x2, y2, baseZ), v2(x2, y2, topZ), v3(x1, y1, topZ)
        positions.push(
          x1, y1, baseZ,
          x2, y2, baseZ,
          x2, y2, topZ,
          x1, y1, topZ
        );

        normals.push(
          nx, ny, 0,
          nx, ny, 0,
          nx, ny, 0,
          nx, ny, 0
        );

        uvs.push(
          0, 0,
          1, 0,
          1, 1,
          0, 1
        );

        const v = vertexOffset;
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
        vertexOffset += 4;
      }
    }

    if (positions.length === 0) return null;

    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
    };
  } catch (err) {
    return null;
  }
}
