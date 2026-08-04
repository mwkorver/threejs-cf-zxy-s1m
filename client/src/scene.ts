import * as THREE from "three";
import { type TileManager } from "./core/tileManager";

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  groundSkyColor: THREE.Color;
  baseFogDensity: number;
  sun: THREE.DirectionalLight;
  appDiv: HTMLDivElement;
}

export function setupScene(): SceneContext {
  const appDiv = document.querySelector<HTMLDivElement>("#app")!;
  appDiv.innerHTML = "";
  appDiv.style.position = "relative";
  appDiv.style.width = "100%";
  appDiv.style.height = "100%";

  const scene = new THREE.Scene();
  const groundSkyColor = new THREE.Color(0xa3c2f0);
  const baseFogDensity = 0.0;
  const fogColor = new THREE.Color(0xdce8f7);
  scene.background = groundSkyColor.clone();
  scene.fog = new THREE.FogExp2(fogColor.getHex(), baseFogDensity);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 10000000);
  camera.up.set(0, 0, 1);

  const initialHeight = 6606;
  const headingRad = (56 * Math.PI) / 180;
  const fwdX = Math.sin(headingRad) * 1000;
  const fwdY = Math.cos(headingRad) * 1000;
  camera.position.set(0, 0, initialHeight);
  camera.lookAt(new THREE.Vector3(fwdX, fwdY, initialHeight));

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = false;
  appDiv.appendChild(renderer.domElement);

  const ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff2e0, 0.6);
  sun.position.set(-1, -1, 1.4).normalize();
  scene.add(sun);

  return {
    scene,
    camera,
    renderer,
    groundSkyColor,
    baseFogDensity,
    sun,
    appDiv,
  };
}

export function bindSceneResize(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  tileManager: TileManager
): void {
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    tileManager.setViewportSize(window.innerWidth, window.innerHeight);
  });
}
