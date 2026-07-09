/**
 * Deterministic camera path shared by all engine spikes (plan §10.2), so the
 * perf comparison drives identical work. World space is the spikes' flat Z-up
 * Mercator, relative to the same world anchor (center tile NW corner).
 *
 * The path banks around the baked block while descending and climbing, so it
 * exercises oblique horizon views (heavy overdraw) and top-down views (light).
 */

export interface Pose {
  eye: [number, number, number];
  target: [number, number, number];
}

export interface PathConfig {
  centerX: number;
  centerY: number;
  radius: number;
  minH: number;
  maxH: number;
}

/** t in [0,1] -> camera pose. Two orbits with a sinusoidal altitude sweep. */
export function flightPose(t: number, c: PathConfig): Pose {
  const a = t * Math.PI * 4; // two full orbits
  const h = c.minH + (c.maxH - c.minH) * (0.5 - 0.5 * Math.cos(t * Math.PI * 2));
  return {
    eye: [c.centerX + Math.cos(a) * c.radius, c.centerY + Math.sin(a) * c.radius, h],
    target: [c.centerX, c.centerY, 0],
  };
}
