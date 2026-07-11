/**
 * Entry point. Real rendering starts once the engine spike (plan §10.2,
 * src/spikes/) picks the render path; until then this just proves the
 * toolchain and the core tile math.
 */

import * as THREE from "three";
import { lonLatToMercator, mercatorToLonLat } from "./core/mercator";
import { BundleCache } from "./core/bundleCache";
import { TileManager } from "./core/tileManager";

// 1. Setup default configurations & URL query parameters
const params = new URLSearchParams(window.location.search);
const useLocal = params.get("src") === "local";
const useLocalTiler = params.get("src") === "tiler-local";

const BASE_URL = useLocal 
  ? "/tiles" 
  : (useLocalTiler ? "http://localhost:8000" : "https://REDACTED.cloudfront.net");

const LAYER = params.get("layer") ?? "naip-visualization";
const YEAR = Number(params.get("year") ?? 2023);
const MAX_ZOOM = Number(params.get("maxzoom") ?? 16);
const LOD_FACTOR = Number(params.get("lod") ?? 2.2);

// NJ flight corridor center
const startLon = -74.44;
const startLat = 40.5;
const worldAnchor = lonLatToMercator(startLon, startLat);

// 2. Setup Three.js scene, camera, lights, and renderer
const appDiv = document.querySelector<HTMLDivElement>("#app")!;
appDiv.innerHTML = ""; // Clear loader text
appDiv.style.position = "relative";
appDiv.style.width = "100%";
appDiv.style.height = "100%";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d131a);
scene.fog = new THREE.FogExp2(0x0d131a, 0.0001);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 80000);
camera.up.set(0, 0, 1); // Z-up world

// Position camera initially relative to NJ worldAnchor (1500m altitude, offset south)
const initialHeight = 1500;
camera.position.set(0, -6000, initialHeight);
camera.lookAt(new THREE.Vector3(0, 0, 200));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false; // Performance priority
appDiv.appendChild(renderer.domElement);

// Add hemispheric and directional lighting
scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x3a3326, 1.0));
const sun = new THREE.DirectionalLight(0xfff2e0, 1.2);
sun.position.set(-1, -1, 1.4).normalize();
scene.add(sun);

// 3. Initialize caching and tile management
// Allocate a 256MB VRAM cache budget for meshes & textures
const cacheBudget = 256 * 1024 * 1024;
const bundleCache = new BundleCache(cacheBudget);
const tileManager = new TileManager(
  BASE_URL,
  LAYER,
  YEAR,
  scene,
  bundleCache,
  worldAnchor,
  12, // Base zoom
  MAX_ZOOM,
  LOD_FACTOR
);

// 4. Create floating HUD overlay
const hud = document.createElement("div");
hud.style.position = "absolute";
hud.style.top = "20px";
hud.style.left = "20px";
hud.style.background = "rgba(15, 23, 42, 0.8)";
hud.style.backdropFilter = "blur(12px)";
hud.style.border = "1px solid rgba(255, 255, 255, 0.1)";
hud.style.padding = "20px";
hud.style.borderRadius = "12px";
hud.style.fontFamily = "monospace";
hud.style.fontSize = "13px";
hud.style.color = "#f8fafc";
hud.style.pointerEvents = "none";
hud.style.zIndex = "100";
hud.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
hud.innerHTML = `
  <div style="font-weight: bold; font-size: 15px; margin-bottom: 10px; color: #38bdf8; letter-spacing: 1px;">✈️ FLIGHT SIM DEMO</div>
  <div style="margin-bottom: 4px;">LAT/LON: <span id="hud-pos">- / -</span></div>
  <div style="margin-bottom: 4px;">ALTITUDE: <span id="hud-alt">0</span> m</div>
  <div style="margin-bottom: 4px;">SPEED: <span id="hud-speed">0</span> kt</div>
  <div style="margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px; margin-bottom: 4px;">ACTIVE TILES: <span id="hud-tiles">0</span></div>
  <div>GPU CACHE: <span id="hud-cache">0.00</span> / 256 MB</div>
  <div style="margin-top: 12px; font-size: 11px; color: #94a3b8; line-height: 1.4;">
    Controls:<br>
    • [W / S] Fly Forward / Backward<br>
    • [A / D] Strafe Left / Right<br>
    • [Q / E] Fly Down / Up<br>
    • [Shift] Boost Speed<br>
    • Drag mouse to look around
  </div>
`;
appDiv.appendChild(hud);

const hudPos = document.getElementById("hud-pos")!;
const hudAlt = document.getElementById("hud-alt")!;
const hudSpeed = document.getElementById("hud-speed")!;
const hudTiles = document.getElementById("hud-tiles")!;
const hudCache = document.getElementById("hud-cache")!;

// 5. Setup simple keyboard & mouse flight controls
const activeKeys = new Set<string>();
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let speedKnots = 120; // Default airspeed simulation

// Track keyboard state
window.addEventListener("keydown", (e) => activeKeys.add(e.code));
window.addEventListener("keyup", (e) => activeKeys.delete(e.code));

// Mouse rotation look-around controls
window.addEventListener("mousedown", (e) => {
  if (e.button === 0) { // Left click
    isDragging = true;
    previousMousePosition = { x: e.clientX, y: e.clientY };
  }
});

window.addEventListener("mousemove", (e) => {
  if (!isDragging) return;

  const deltaX = e.clientX - previousMousePosition.x;
  const deltaY = e.clientY - previousMousePosition.y;

  // Rotate camera (yaw around global Z axis, pitch locally)
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  euler.setFromQuaternion(camera.quaternion);

  euler.y -= deltaX * 0.003; // yaw
  euler.x -= deltaY * 0.003; // pitch

  // Limit pitch to avoid flipping upside down (-85 to 85 degrees)
  const maxPitch = Math.PI / 2 - 0.05;
  euler.x = Math.max(-maxPitch, Math.min(maxPitch, euler.x));

  camera.quaternion.setFromEuler(euler);

  previousMousePosition = { x: e.clientX, y: e.clientY };
});

window.addEventListener("mouseup", () => {
  isDragging = false;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 6. Running frame render and flight controller loop
let lastFrameTime = performance.now();

function frameLoop() {
  requestAnimationFrame(frameLoop);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // Clamp to avoid spikes
  lastFrameTime = now;

  // Determine current flight speed (boost with shift)
  const baseSpeed = 100; // Mercator meters per second (~200 knots)
  const speedMultiplier = activeKeys.has("ShiftLeft") || activeKeys.has("ShiftRight") ? 4 : 1;
  const speed = baseSpeed * speedMultiplier;
  speedKnots = Math.round(speed * 1.94384); // Convert relative m/s to simulated knots

  // Process movement input relative to camera heading
  const direction = new THREE.Vector3();
  if (activeKeys.has("KeyW")) direction.z -= 1;
  if (activeKeys.has("KeyS")) direction.z += 1;
  if (activeKeys.has("KeyA")) direction.x -= 1;
  if (activeKeys.has("KeyD")) direction.x += 1;

  // Apply camera orientation to horizontal inputs
  direction.normalize();
  direction.applyQuaternion(camera.quaternion);

  // Vertical flying inputs (Q=down, E=up)
  if (activeKeys.has("KeyQ")) direction.z -= 1;
  if (activeKeys.has("KeyE")) direction.z += 1;

  // Update position
  if (direction.lengthSq() > 0) {
    camera.position.addScaledVector(direction.normalize(), speed * dt);
  }

  // Update LOD and stream/cache terrain tiles
  tileManager.update(camera.position);

  // Render frame
  renderer.render(scene, camera);

  // Update HUD elements
  const globalX = camera.position.x + worldAnchor[0];
  const globalY = camera.position.y + worldAnchor[1];
  const [lon, lat] = mercatorToLonLat(globalX, globalY);

  hudPos.textContent = `${lat.toFixed(5)} / ${lon.toFixed(5)}`;
  hudAlt.textContent = Math.round(camera.position.z).toString();
  hudSpeed.textContent = direction.lengthSq() > 0 ? speedKnots.toString() : "0";
  hudTiles.textContent = tileManager.getActiveKeys().size.toString();
  hudCache.textContent = (bundleCache.bytesUsed() / (1024 * 1024)).toFixed(2);
}

// Start visual frame loop
frameLoop();

