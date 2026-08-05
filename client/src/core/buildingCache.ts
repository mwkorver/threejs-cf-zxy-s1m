/**
 * Decoded building vectors, held once per source tile and reused at every zoom
 * above it.
 *
 * Buildings do not change with zoom -- only the terrain under them and the
 * imagery on top do. Before this, the client asked /buildings for every terrain
 * tile at z >= 14, so flying z14 -> z18 ran the tiler's DuckDB query 256 times
 * for the same footprints, each clipped finer. Now exactly one zoom fetches,
 * and every finer tile re-extrudes from these records.
 *
 * This caches vectors, not GPU geometry, because the geometry is what changes:
 * base elevation comes from the target tile's heightfield and roof UVs from its
 * imagery, so it has to be rebuilt per tile. Rebuilding is arithmetic over a few
 * thousand points -- no network, no protobuf.
 */

import { type TileId } from "./mercator";
import { tileSizeMeters, type BuildingRecord } from "./buildingMesh";

/** Buildings owned by a target tile, plus the offset needed to place them. */
export interface TileBuildings {
  records: BuildingRecord[];
  /**
   * The target tile's NW corner expressed in the source tile's local metres.
   * buildTileBuildings subtracts this as it reads coordinates, so records are
   * never deep-copied to be rebased.
   */
  origin: [number, number];
}

export function tileKey(t: TileId): string {
  return `${t.z}/${t.x}/${t.y}`;
}

export class BuildingCache {
  /** Insertion-ordered, so the oldest key is the first one Map yields. */
  private map = new Map<string, BuildingRecord[]>();

  /**
   * Source tiles retained. Vectors are small next to textures -- a dense
   * Manhattan z14 tile is a few thousand footprints -- so this is generous
   * relative to the 256 MB GPU budget next door.
   */
  constructor(private readonly maxSourceTiles = 64) {}

  /** The source-zoom tile containing `t`. `t.z` must be >= sourceZoom. */
  static sourceTileFor(t: TileId, sourceZoom: number): TileId {
    const shift = t.z - sourceZoom;
    return { z: sourceZoom, x: t.x >> shift, y: t.y >> shift };
  }

  has(source: TileId): boolean {
    return this.map.has(tileKey(source));
  }

  put(source: TileId, records: BuildingRecord[]): void {
    const key = tileKey(source);
    this.map.delete(key); // re-insert so recency ordering stays honest
    this.map.set(key, records);

    while (this.map.size > this.maxSourceTiles) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * Buildings whose centroid falls inside `target`, with the offset to place
   * them in its local space. Null when the source tile has not been fetched.
   *
   * Centroid ownership means each building is drawn exactly once, by one tile.
   * A building straddling a boundary is drawn whole by its centroid's tile and
   * so extends slightly past that tile's edge -- deliberate, and why roofs
   * sample one tile's imagery rather than being cut at the seam.
   */
  forTile(target: TileId, sourceZoom: number): TileBuildings | null {
    if (target.z < sourceZoom) return null;

    const source = BuildingCache.sourceTileFor(target, sourceZoom);
    const key = tileKey(source);
    const records = this.map.get(key);
    if (!records) return null;

    // Refresh recency: a tile still feeding the view shouldn't be evicted.
    this.map.delete(key);
    this.map.set(key, records);

    const shift = target.z - sourceZoom;
    const span = tileSizeMeters(target.z);
    const ox = (target.x - (source.x << shift)) * span;
    const oy = -(target.y - (source.y << shift)) * span;

    const owned: BuildingRecord[] = [];
    for (const r of records) {
      const x = r.centroid[0] - ox;
      const y = r.centroid[1] - oy;
      if (x >= 0 && x < span && y <= 0 && y > -span) owned.push(r);
    }

    return owned.length > 0 ? { records: owned, origin: [ox, oy] } : null;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
