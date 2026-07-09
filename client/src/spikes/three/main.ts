/**
 * Engine spike: three.js (plan §10.2), wired to the shared benchmark harness.
 * Same CPU meshes, flight path, and frame timing as the deck.gl and luma.gl
 * spikes — only the GPU upload + draw differs.
 */

import * as THREE from "three";
import { loadBlock, VERTICAL_EXAGGERATION } from "../shared/loadBlock";
import { flightPose } from "../shared/flightPath";
import { Bench, mountHud } from "../shared/perf";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d131a);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 1, 60000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x3a3326, 1.0));
const sun = new THREE.DirectionalLight(0xfff2e0, 1.0);
sun.position.set(-1, -1, 1.4);
scene.add(sun);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function main() {
  const block = await loadBlock();
  console.log("[spike] ", block.label);
  for (const t of block.tiles) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(t.mesh.positions, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(t.mesh.uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(t.mesh.indices, 1));
    geom.computeVertexNormals();
    let material: THREE.Material;
    if (t.imagery) {
      const tex = new THREE.CanvasTexture(t.imagery as unknown as HTMLCanvasElement);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      material = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
    } else {
      material = new THREE.MeshStandardMaterial({ color: 0x556655, roughness: 1 });
    }
    const obj = new THREE.Mesh(geom, material);
    obj.position.set(t.offset[0], t.offset[1], 0);
    obj.scale.z = VERTICAL_EXAGGERATION;
    scene.add(obj);
  }

  const hud = mountHud();
  const bench = new Bench("three.js", hud);
  let last = performance.now();
  const t0 = last;

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const interval = now - last;
    last = now;

    const t = ((now - t0) / 20000) % 1; // 20s per path lap
    const pose = flightPose(t, block.path);
    camera.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);

    const c0 = performance.now();
    renderer.render(scene, camera);
    const cpu = performance.now() - c0;
    bench.sample(cpu, interval, now);
  }
  loop();
}

main().catch((e) => {
  mountHud().textContent = `error: ${e.message}`;
  console.error(e);
});
