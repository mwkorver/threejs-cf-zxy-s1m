import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import earcut from "earcut";
import { EARTH_CIRCUMFERENCE, type TileId } from "./mercator";

/**
 * One building, decoded from MVT and kept as vectors rather than geometry.
 *
 * Vectors, because the same building is drawn at several zooms: it is fetched
 * once at the source zoom and re-assembled against whichever terrain tile is
 * under it, which changes its base elevation and its roof UVs. Merged geometry
 * cannot be re-seated per building, so caching that instead would force a
 * refetch on every LOD change -- the thing this exists to avoid.
 *
 * Coordinates are metres relative to the NW corner of the SOURCE tile, on the
 * terrain convention: x grows east, y grows south (negative). The assembler
 * rebases them onto the target tile.
 */
export interface BuildingRecord {
  id: string;
  /** Height in metres above local ground. */
  height: number;
  /** [x, y] centroid of the outer ring. Decides which tile draws the walls. */
  centroid: [number, number];
  /**
   * [minX, minY, maxX, maxY] of the outer ring.
   *
   * Roofs are drawn by every tile the building overlaps, not just the one
   * holding its centroid, so each tile needs a cheap overlap test. At z18 a
   * tile is 153 m while 9% of buildings here are bigger than that -- the
   * largest is 591 m -- so centroid-only roofs left most of a warehouse
   * sampling UVs outside [0,1], which clamp to the edge texel and smear.
   */
  bbox: [number, number, number, number];
  /**
   * Polygons, each `[outerRing, ...holes]`, each ring a flat [x, y, x, y, ...].
   * Flat arrays because they cross a postMessage boundary; nested point objects
   * would clone far more slowly.
   */
  polygons: number[][][];
}

/** Merged, GPU-ready geometry for one terrain tile's worth of buildings. */
export interface ExtrudedBuildingMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  /**
   * Index at which roof triangles begin; everything before it is walls. Lets
   * the consumer split the geometry into two draw groups so roofs can take the
   * terrain material (imagery) while walls stay flat-shaded.
   */
  roofIndexStart: number;
}

/** Mercator metres spanned by one tile at this zoom. */
export function tileSizeMeters(z: number): number {
  return EARTH_CIRCUMFERENCE / 2 ** z;
}

/**
 * Sutherland-Hodgman clip of a flat [x,y,...] ring to an axis-aligned rect.
 *
 * Used so a roof is drawn by every tile it overlaps, each tile emitting only
 * the part inside itself. That keeps roof UVs inside [0,1] by construction,
 * which is what stops a warehouse larger than its tile from clamping to the
 * edge texel and smearing.
 *
 * Convex clip region, so the classic algorithm applies unchanged. Returns [] if
 * the ring falls entirely outside.
 */
function clipRingToRect(
  ring: number[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): number[] {
  // side: 0 = x>=minX, 1 = x<=maxX, 2 = y>=minY, 3 = y<=maxY
  const inside = (x: number, y: number, side: number): boolean =>
    side === 0 ? x >= minX : side === 1 ? x <= maxX : side === 2 ? y >= minY : y <= maxY;

  let cur = ring;
  for (let side = 0; side < 4 && cur.length >= 6; side++) {
    const next: number[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const ax = cur[i]!;
      const ay = cur[i + 1]!;
      const j = (i + 2) % cur.length;
      const bx = cur[j]!;
      const by = cur[j + 1]!;
      const aIn = inside(ax, ay, side);
      const bIn = inside(bx, by, side);

      if (aIn !== bIn) {
        // Segment crosses this edge: emit the crossing point.
        let t: number;
        if (side === 0) t = (minX - ax) / (bx - ax);
        else if (side === 1) t = (maxX - ax) / (bx - ax);
        else if (side === 2) t = (minY - ay) / (by - ay);
        else t = (maxY - ay) / (by - ay);
        next.push(ax + t * (bx - ax), ay + t * (by - ay));
      }
      if (bIn) next.push(bx, by);
    }
    cur = next;
  }
  return cur.length >= 6 ? cur : [];
}

/** Twice the signed area of a flat [x,y,...] ring. Sign gives orientation. */
function signedArea2(ring: number[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    sum += (ring[j]! - ring[i]!) * (ring[i + 1]! + ring[j + 1]!);
  }
  return sum;
}

/**
 * Decode an MVT buildings tile into per-building vector records.
 *
 * Does no extrusion: heights and footprints only. Extrusion happens later, per
 * terrain tile, in buildTileBuildings().
 */
export function decodeBuildings(pbfBuffer: ArrayBuffer, tile: TileId): BuildingRecord[] | null {
  // Empty body, not a missing one: the caller passes res.arrayBuffer(), which
  // always resolves to a buffer. A zero-length one is a tile with no buildings.
  if (pbfBuffer.byteLength === 0) return null;

  try {
    const vectorTile = new VectorTile(new PbfReader(new Uint8Array(pbfBuffer)));
    const layerName = Object.keys(vectorTile.layers)[0] || "buildings";
    const layer = vectorTile.layers[layerName];
    if (!layer || layer.length === 0) return null;

    const scale = tileSizeMeters(tile.z) / layer.extent;
    const defaultHeight = 12.0; // metres, when the source carries neither height nor floors
    const out: BuildingRecord[] = [];

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties;
      const id = String(props.id ?? feature.id ?? `bldg_${tile.z}_${tile.x}_${tile.y}_${i}`);
      const height = Number(
        props.height ?? (props.num_floors ? Number(props.num_floors) * 3.5 : defaultHeight)
      );

      // loadGeometry() always returns an array; a zero-length one is a feature
      // whose geometry was clipped away at this tile's edge.
      const rings = feature.loadGeometry();
      if (rings.length === 0) continue;

      // classifyRings splits by signed area into [outer, ...holes] groups, so a
      // courtyard becomes a hole rather than a second building, and a
      // MultiPolygon keeps every part. Reading rings[0] alone -- as this did --
      // dropped both.
      const polygons: number[][][] = [];
      for (const group of classifyRings(rings)) {
        const flatGroup: number[][] = [];
        for (const ring of group) {
          if (ring.length < 3) continue;
          const flat: number[] = [];
          for (const p of ring) {
            // MVT y grows south; terrain local Y grows north, so negate.
            flat.push(p.x * scale, -p.y * scale);
          }
          flatGroup.push(flat);
        }
        if (flatGroup.length > 0) polygons.push(flatGroup);
      }
      if (polygons.length === 0) continue;

      // Centroid of the first outer ring. Only used to decide tile ownership,
      // so the cheap vertex average is enough -- no need for a true area centroid.
      const outer = polygons[0]![0]!;
      let sx = 0;
      let sy = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < outer.length; k += 2) {
        const x = outer[k]!;
        const y = outer[k + 1]!;
        sx += x;
        sy += y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const n = outer.length / 2;

      out.push({
        id,
        height,
        centroid: [sx / n, sy / n],
        bbox: [minX, minY, maxX, maxY],
        polygons,
      });
    }

    return out.length > 0 ? out : null;
  } catch (err) {
    // A malformed or unexpected-schema tile drops its buildings rather than
    // failing the whole tile: terrain and imagery are still worth showing.
    //
    // Warned, not swallowed. Silent, this branch is indistinguishable from "no
    // buildings here" -- which is how a wrong pbf import made every tile in
    // CONUS decode to null without leaving a trace anywhere.
    console.warn(`Building decode failed for tile ${tile.z}/${tile.x}/${tile.y}:`, err);
    return null;
  }
}

/**
 * Extrude cached buildings into one merged geometry in a target tile's space.
 *
 * Called whenever a terrain tile is built, at any zoom at or above the source
 * zoom, so the same cached records are re-seated onto progressively finer
 * terrain and re-UV'd onto progressively finer imagery. No network, no protobuf
 * -- this is arithmetic over a few thousand points.
 *
 * @param wallBuildings records whose centroid this tile owns. Walls are drawn
 *   whole by exactly one tile, so they are never duplicated at a seam; their
 *   UVs are synthetic per-quad, so extending past the tile edge is harmless.
 * @param roofBuildings records whose footprint OVERLAPS this tile, a superset
 *   of the above. Roof caps are clipped to the tile so their UVs stay in [0,1]
 *   and sample this tile's imagery -- the whole point of the exercise.
 * @param targetTile the terrain tile being built
 * @param groundAt terrain height at a tile UV, in the terrain mesh's own Z
 *   space. Sampling the mesh rather than a raw heightfield is what keeps
 *   buildings seated: terrain Z is elevation * mercatorScale(lat), and the
 *   previous code took base Z from the unscaled heightfield, so buildings sank
 *   or floated by that factor -- about 30 m per 100 m of relief at CONUS
 *   latitudes.
 * @param zScale the same mercatorScale factor, applied to building heights so
 *   they keep their proportions against the stretched vertical.
 * @param origin the target tile's NW corner in source-tile local metres,
 *   subtracted as coordinates are read. Passed rather than pre-rebasing the
 *   records, so a dense source tile isn't deep-copied once per terrain tile.
 */
export function buildTileBuildings(
  wallBuildings: BuildingRecord[],
  roofBuildings: BuildingRecord[],
  targetTile: TileId,
  groundAt: (u: number, v: number) => number,
  zScale: number,
  origin: readonly [number, number] = [0, 0]
): ExtrudedBuildingMesh | null {
  if (wallBuildings.length === 0 && roofBuildings.length === 0) return null;
  const [ox, oy] = origin;

  const size = tileSizeMeters(targetTile.z);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const wallIndices: number[] = [];
  const roofIndices: number[] = [];
  let vertexOffset = 0;

  // Tile-local metres -> the terrain's UV space: u east across the tile, v
  // south down it with v=0 at the north edge. Terrain meshes use exactly this,
  // so a roof samples the imagery at the ground position it covers.
  const uvOf = (x: number, y: number): [number, number] => [x / size, -y / size];

  // Ground under a building, sampled at its centroid clamped into this tile.
  // Clamping matters for roof pieces whose owner is a neighbouring tile: the
  // whole cap must sit at one height or it shears at the seam. Terrain is
  // near-identical across a shared edge, so the clamp is accurate wherever
  // these large buildings actually occur -- ports and industrial flats. On
  // steep ground a building spanning several tiles could still step slightly.
  const topOf = (b: BuildingRecord): number => {
    const [cu, cv] = uvOf(b.centroid[0] - ox, b.centroid[1] - oy);
    const cl = (t: number) => Math.min(1, Math.max(0, t));
    return groundAt(cl(cu), cl(cv)) + b.height * zScale;
  };

  for (const b of wallBuildings) {
    const topZ = topOf(b);
    const baseZ = topZ - b.height * zScale;

    for (const polygon of b.polygons) {
      // Walls around every ring, holes included: a courtyard has interior walls.
      for (const ring of polygon) {
        for (let j = 0; j < ring.length; j += 2) {
          const x1 = ring[j]! - ox;
          const y1 = ring[j + 1]! - oy;
          const k = (j + 2) % ring.length;
          const x2 = ring[k]! - ox;
          const y2 = ring[k + 1]! - oy;

          const dx = x2 - x1;
          const dy = y2 - y1;
          const len = Math.hypot(dx, dy);
          if (len < 1e-4) continue;

          const nx = dy / len;
          const ny = -dx / len;

          positions.push(x1, y1, baseZ, x2, y2, baseZ, x2, y2, topZ, x1, y1, topZ);
          normals.push(nx, ny, 0, nx, ny, 0, nx, ny, 0, nx, ny, 0);
          uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

          const v = vertexOffset;
          wallIndices.push(v, v + 1, v + 2, v, v + 2, v + 3);
          vertexOffset += 4;
        }
      }

    }
  }

  // Roofs, from every building overlapping this tile rather than only the ones
  // it owns, each clipped to the tile so its UVs land inside [0,1].
  const rebase = (ring: number[]) => {
    const r = new Array<number>(ring.length);
    for (let k = 0; k < ring.length; k += 2) {
      r[k] = ring[k]! - ox;
      r[k + 1] = ring[k + 1]! - oy;
    }
    return r;
  };

  for (const b of roofBuildings) {
    const topZ = topOf(b);

    for (const polygon of b.polygons) {
      const contour = clipRingToRect(rebase(polygon[0]!), 0, -size, size, 0);
      if (contour.length < 6) continue; // nothing of this ring lands here

      const flat: number[] = [...contour];
      const holeIndices: number[] = [];
      for (let h = 1; h < polygon.length; h++) {
        const hole = clipRingToRect(rebase(polygon[h]!), 0, -size, size, 0);
        if (hole.length < 6) continue; // courtyard clipped away entirely
        holeIndices.push(flat.length / 2);
        flat.push(...hole);
      }

      const tri = earcut(flat, holeIndices.length > 0 ? holeIndices : null, 2);
      if (tri.length === 0) continue;

      const capBase = vertexOffset;
      for (let k = 0; k < flat.length; k += 2) {
        const x = flat[k]!;
        const y = flat[k + 1]!;
        const [u, v] = uvOf(x, y);
        positions.push(x, y, topZ);
        normals.push(0, 0, 1);
        uvs.push(u, v);
        vertexOffset++;
      }

      // Negating y above flipped the ring's orientation, so the triangles earcut
      // returns may wind clockwise in this space. The cap renders with the
      // terrain material, which is FrontSide, so a reversed cap is invisible
      // from above -- exactly the bug this guards against.
      const flip = signedArea2(contour) > 0;
      for (let t = 0; t < tri.length; t += 3) {
        const a = capBase + tri[t]!;
        const b2 = capBase + tri[t + 1]!;
        const c = capBase + tri[t + 2]!;
        if (flip) roofIndices.push(a, c, b2);
        else roofIndices.push(a, b2, c);
      }
    }
  }

  if (positions.length === 0) return null;

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array([...wallIndices, ...roofIndices]),
    roofIndexStart: wallIndices.length,
  };
}
