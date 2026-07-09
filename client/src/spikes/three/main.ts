/**
 * Engine spike: three.js (plan §10.2).
 *
 * Loads the baked NJ corridor, builds a skirted grid mesh per terrain tile
 * (core/terrainMesh), drapes the matching imagery tile as its texture, places
 * everything anchor-relative in a flat Mercator world (Z-up), and flies a
 * free camera. The point is to feel how much three fights custom mesh
 * generation, texturing on the same quadtree, and camera control — not to
 * ship. Losers get deleted (src/spikes/README.md).
 */

import * as THREE from "three";
import { buildTerrainMesh } from "../../core/terrainMesh";
import { tileBoundsMercator, type TileId } from "../../core/mercator";
import { loadImagery, loadManifest, loadTerrain } from "../../core/tileLoader";

const BASE = "/tiles";
const VERTICAL_EXAGGERATION = 4; // NJ relief is ~30 m over km tiles — lift it to read as 3D
const GRID_STEP = 8;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d131a);
scene.fog = new THREE.Fog(0x0d131a, 4000, 12000);

const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 1, 40000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x3a3326, 0.9));
const sun = new THREE.DirectionalLight(0xfff2e0, 1.1);
sun.position.set(-1, -1, 1.4); // NW, matching the hillshade convention
scene.add(sun);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function buildTile(worldAnchor: [number, number], t: TileId, layer: string, year: number) {
  const [heights, imagery] = await Promise.all([
    loadTerrain(BASE, t),
    loadImagery(BASE, layer, year, t).catch(() => null),
  ]);
  const mesh = buildTerrainMesh(heights, t, GRID_STEP);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geom.computeVertexNormals();

  let material: THREE.Material;
  if (imagery) {
    const tex = new THREE.CanvasTexture(imagery as unknown as HTMLCanvasElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    material = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
  } else {
    material = new THREE.MeshStandardMaterial({ color: 0x556655, roughness: 1 });
  }

  const obj = new THREE.Mesh(geom, material);
  // Place tile at its Mercator anchor relative to the world anchor; Z-up.
  obj.position.set(mesh.anchor[0] - worldAnchor[0], mesh.anchor[1] - worldAnchor[1], 0);
  obj.scale.z = VERTICAL_EXAGGERATION;
  scene.add(obj);
}

async function main() {
  const m = await loadManifest(BASE);
  const status = document.getElementById("status")!;
  status.textContent = `loading ${m.layer} ${m.year} z${m.z} …`;

  // World origin = center tile's NW anchor, so all mesh coords stay ~1e3.
  const cx = Math.floor((m.x[0] + m.x[1]) / 2);
  const cy = Math.floor((m.y[0] + m.y[1]) / 2);
  const worldAnchor = (() => {
    const b = tileBoundsMercator({ z: m.z, x: cx, y: cy });
    return [b.west, b.north] as [number, number];
  })();

  const jobs: Promise<void>[] = [];
  for (let x = m.x[0]; x <= m.x[1]; x++) {
    for (let y = m.y[0]; y <= m.y[1]; y++) {
      jobs.push(buildTile(worldAnchor, { z: m.z, x, y }, m.layer, m.year));
    }
  }
  await Promise.allSettled(jobs);
  status.textContent = `${m.layer} ${m.year} · z${m.z} · ${jobs.length} tiles · WASD + drag to fly`;

  // Start above the center, looking north-down into the block.
  const span = tileBoundsMercator({ z: m.z, x: cx, y: cy });
  const tileW = span.east - span.west;
  camera.position.set(tileW / 2, -tileW * 1.5, tileW * 0.8);
  camera.up.set(0, 0, 1);
  camera.lookAt(tileW / 2, -tileW, 0);

  flyLoop();
}

// --- minimal fly controls (WASD + Q/E, drag to look) ---
const keys = new Set<string>();
addEventListener("keydown", (e) => keys.add(e.code));
addEventListener("keyup", (e) => keys.delete(e.code));
let yaw = 0, pitch = -0.5, dragging = false;
renderer.domElement.addEventListener("pointerdown", () => (dragging = true));
addEventListener("pointerup", () => (dragging = false));
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.003;
  pitch = Math.max(-1.5, Math.min(1.5, pitch - e.movementY * 0.003));
});

const clock = new THREE.Clock();
function flyLoop() {
  requestAnimationFrame(flyLoop);
  const dt = clock.getDelta();
  const speed = (keys.has("ShiftLeft") ? 4000 : 1200) * dt;

  const dir = new THREE.Vector3(
    Math.cos(pitch) * Math.sin(yaw),
    Math.cos(pitch) * Math.cos(yaw),
    Math.sin(pitch),
  );
  const right = new THREE.Vector3(Math.sin(yaw - Math.PI / 2), Math.cos(yaw - Math.PI / 2), 0);
  if (keys.has("KeyW")) camera.position.addScaledVector(dir, speed);
  if (keys.has("KeyS")) camera.position.addScaledVector(dir, -speed);
  if (keys.has("KeyD")) camera.position.addScaledVector(right, speed);
  if (keys.has("KeyA")) camera.position.addScaledVector(right, -speed);
  if (keys.has("KeyE")) camera.position.z += speed;
  if (keys.has("KeyQ")) camera.position.z -= speed;
  camera.lookAt(camera.position.clone().add(dir));

  renderer.render(scene, camera);
}

main().catch((e) => {
  document.getElementById("status")!.textContent = `error: ${e.message}`;
  console.error(e);
});
