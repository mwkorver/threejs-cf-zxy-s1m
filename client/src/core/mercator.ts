/**
 * Coordinates & precision (bake in from day one).
 *
 * World = Mercator meters (float64 on CPU), Z-up. A Mercator meter is not a
 * ground meter: EVERY true-meters -> world conversion (terrain Z, building
 * heights, airspeed/physics) routes through mercatorScale(lat). Miss one and
 * slopes flatten going north / the plane "slows down" going south.
 *
 * GPU rendering must be anchor-relative float32 (camera- or tile-anchor
 * offsets): raw Mercator X for CONUS is ~1e7, where float32 resolution is
 * ~1 m — useless against 8 cm imagery.
 */

export const EARTH_RADIUS = 6378137; // WGS84 semi-major, meters
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
const MERCATOR_ORIGIN = EARTH_CIRCUMFERENCE / 2;

/** Mercator-meters per ground-meter at latitude (degrees) = sec(lat). */
export function mercatorScale(latDeg: number): number {
  return 1 / Math.cos((latDeg * Math.PI) / 180);
}

/** lon/lat (degrees) -> EPSG:3857 meters. */
export function lonLatToMercator(lonDeg: number, latDeg: number): [number, number] {
  const x = (lonDeg / 180) * MERCATOR_ORIGIN;
  const latRad = (latDeg * Math.PI) / 180;
  const y = (EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + latRad / 2)));
  return [x, y];
}

/** EPSG:3857 meters -> lon/lat (degrees). */
export function mercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / MERCATOR_ORIGIN) * 180;
  const lat = ((2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * 180) / Math.PI;
  return [lon, lat];
}

export interface TileId {
  z: number;
  x: number;
  y: number;
}

export function tileKey(t: TileId): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** Web-Mercator bounds of tile z/x/y in EPSG:3857 meters (XYZ scheme, y-down). */
export function tileBoundsMercator(t: TileId): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const worldSize = EARTH_CIRCUMFERENCE;
  const tileSize = worldSize / 2 ** t.z;
  return {
    west: t.x * tileSize - MERCATOR_ORIGIN,
    east: (t.x + 1) * tileSize - MERCATOR_ORIGIN,
    north: MERCATOR_ORIGIN - t.y * tileSize,
    south: MERCATOR_ORIGIN - (t.y + 1) * tileSize,
  };
}

/** Tile containing a Mercator point at zoom z. */
export function mercatorToTile(x: number, y: number, z: number): TileId {
  const n = 2 ** z;
  const tx = Math.min(n - 1, Math.max(0, Math.floor(((x + MERCATOR_ORIGIN) / EARTH_CIRCUMFERENCE) * n)));
  const ty = Math.min(n - 1, Math.max(0, Math.floor(((MERCATOR_ORIGIN - y) / EARTH_CIRCUMFERENCE) * n)));
  return { z, x: tx, y: ty };
}
