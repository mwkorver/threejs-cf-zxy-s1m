import * as THREE from "three";

/**
 * Altitude-graded sky, adapted from pTolemy3D's `scene/Sky.java`.
 *
 * That viewer held a horizon colour and drew stars once the camera passed
 * `horizonAlt` (10 km), so climbing read as leaving the atmosphere. Here the
 * same idea drives three things off one 0..1 factor: the background fades from
 * the preset's sky colour toward space black, the fog thins out, and a
 * starfield fades in.
 */

/** Space black — the colour the sky approaches at and above `spaceAltitude`. */
const SPACE_COLOR = new THREE.Color(0x05070f);

const STAR_COUNT = 1500;

/**
 * A starfield sphere large enough to sit beyond any terrain the camera sees.
 * Rendered without depth write so it never occludes tiles, and re-centred on
 * the camera each frame so it reads as infinitely far away.
 */
export function createStarfield(radius: number): THREE.Points {
  const positions = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform on the sphere: acos(1-2u) avoids the pole clustering that
    // sampling theta uniformly would give.
    const theta = Math.acos(1 - 2 * Math.random());
    const phi = 2 * Math.PI * Math.random();
    const sinTheta = Math.sin(theta);
    positions[i * 3] = radius * sinTheta * Math.cos(phi);
    positions[i * 3 + 1] = radius * sinTheta * Math.sin(phi);
    positions[i * 3 + 2] = radius * Math.cos(theta);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    // sizeAttenuation:false means size is in *pixels*, not world units — a
    // radius-scaled value here would paint screen-filling squares.
    size: 2,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = -1; // behind terrain
  return stars;
}

/**
 * How far "into space" the camera is: 0 at the ground, 1 at `spaceAltitude`.
 * Squared so the sky holds its colour through low-altitude flight and darkens
 * mostly over the back half of the climb.
 */
export function spaceFactor(altitude: number, spaceAltitude: number): number {
  if (spaceAltitude <= 0) return 0;
  const t = THREE.MathUtils.clamp(altitude / spaceAltitude, 0, 1);
  return t * t;
}

/**
 * Grade the sky for the camera's current altitude.
 *
 * @param groundSky the active preset's sky colour, i.e. the sea-level look
 * @param baseFogDensity the fog density the user asked for at ground level
 */
export function updateSky(
  scene: THREE.Scene,
  camera: THREE.Camera,
  stars: THREE.Points,
  groundSky: THREE.Color,
  baseFogDensity: number,
  spaceAltitude: number
): number {
  const factor = spaceFactor(camera.position.z, spaceAltitude);

  const background = scene.background as THREE.Color | null;
  if (background && background.isColor) {
    background.copy(groundSky).lerp(SPACE_COLOR, factor);
  }

  // Thin the haze out as the atmosphere does, so distant terrain stays
  // readable from altitude instead of washing to fog colour.
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.density = baseFogDensity * (1 - factor);
  }

  const material = stars.material as THREE.PointsMaterial;
  material.opacity = factor;
  material.visible = factor > 0.01;
  // Keep the starfield centred on the viewer: it is a backdrop, not geometry.
  stars.position.copy(camera.position);

  return factor;
}
