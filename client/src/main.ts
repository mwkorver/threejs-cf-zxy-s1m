/**
 * Entry point: wires Three.js renderer, TileManager LOD streaming, HUD overlay,
 * and flight controller into the frame render loop.
 */

import * as THREE from "three";
import { config } from "./config";
import { setupScene, bindSceneResize } from "./scene";
import { setupHUD } from "./ui/hud";
import { setupFlightController } from "./controls/flightController";
import { mercatorToLonLat } from "./core/mercator";
import { BundleCache } from "./core/bundleCache";
import { TileManager } from "./core/tileManager";
import { TexturePool } from "./core/texturePool";
import { updateSky } from "./core/sky";

// 1. Initialize Three.js scene, camera, lights, and renderer
const sceneCtx = setupScene();

// 2. Initialize caching and tile management
const cacheBudget = 256 * 1024 * 1024;
const texturePool = new TexturePool();
const bundleCache = new BundleCache(cacheBudget, texturePool);

const tileManager = new TileManager(
  config.baseUrl,
  config.layer,
  config.year,
  sceneCtx.scene,
  bundleCache,
  config.worldAnchor,
  12,
  config.maxZoom,
  config.lodFactor,
  config.cullTiles
);
tileManager.terrainMinZoom = 0;
tileManager.texturePool = texturePool;
tileManager.maxActiveTiles = Math.floor((cacheBudget / (1024 * 1024)) * 0.8);
tileManager.prefetchLookaheadSec = config.prefetchLookahead;
tileManager.prefetchSamples = config.prefetchSamples;

// Debug console handles
window.tileManager = tileManager;
window.camera = sceneCtx.camera;

// Bind viewport resize handler
bindSceneResize(sceneCtx.camera, sceneCtx.renderer, tileManager);

let flightControllerCtx: ReturnType<typeof setupFlightController>;

// 3. Initialize HUD overlay and UI controls
let baseFogDensity = sceneCtx.baseFogDensity;

const compassFwd = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 0, 1);

const hudCtx = setupHUD(
  sceneCtx.appDiv,
  sceneCtx.scene,
  sceneCtx.camera,
  tileManager,
  cacheBudget,
  sceneCtx.groundSkyColor,
  (d: number) => { baseFogDensity = d; },
  () => {
    compassFwd.set(0, 0, -1).applyQuaternion(sceneCtx.camera.quaternion);
    const bearing = Math.atan2(compassFwd.x, compassFwd.y);
    sceneCtx.camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(worldUp, bearing));
  },
  () => {
    flightControllerCtx.cancelFlyTo();
  }
);

// 4. Initialize flight controller
flightControllerCtx = setupFlightController(
  sceneCtx.scene,
  sceneCtx.camera,
  tileManager,
  hudCtx,
  config.worldAnchor
);

// 5. Frame render and telemetry update loop
let lastFrameTime = performance.now();
let fpsFrameCount = 0;
let fpsLastTime = performance.now();
let currentFps = 60;

function frameLoop() {
  requestAnimationFrame(frameLoop);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
  lastFrameTime = now;

  const speedKnots = flightControllerCtx.updateFlight(dt, sceneCtx.groundSkyColor, baseFogDensity);

  updateSky(
    sceneCtx.scene,
    sceneCtx.camera,
    undefined,
    sceneCtx.groundSkyColor,
    baseFogDensity,
    parseInt(hudCtx.ctrlSpaceAlt.value) * 1000
  );

  tileManager.update(sceneCtx.camera.position, sceneCtx.camera);
  sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);

  fpsFrameCount++;
  if (now - fpsLastTime >= 250) {
    currentFps = Math.round((fpsFrameCount * 1000) / (now - fpsLastTime));
    fpsFrameCount = 0;
    fpsLastTime = now;
  }

  const globalX = sceneCtx.camera.position.x + config.worldAnchor[0];
  const globalY = sceneCtx.camera.position.y + config.worldAnchor[1];
  const [lon, lat] = mercatorToLonLat(globalX, globalY);
  const pool = texturePool.stats();

  hudCtx.updateHUD({
    fps: currentFps,
    lat,
    lon,
    altitude: sceneCtx.camera.position.z,
    heading: 0,
    speedKnots,
    activeTiles: tileManager.getActiveKeys().size,
    maxActiveTiles: tileManager.maxActiveTiles,
    bytesUsed: bundleCache.bytesUsed(),
    cacheBudget,
    prefetchNow: tileManager.getLastPrefetchCount(),
    prefetchTotal: tileManager.getPrefetchTotal(),
    texCreated: pool.created,
    texReused: pool.reused,
  });
}

// 6. Test state hooks for Playwright & automated UI testing
if (config.testMode) {
  window.__VIEWER_STATE__ = {
    getCameraPos: () => ({ x: sceneCtx.camera.position.x, y: sceneCtx.camera.position.y, z: sceneCtx.camera.position.z }),
    getCameraRotation: () => ({ x: sceneCtx.camera.rotation.x, y: sceneCtx.camera.rotation.y, z: sceneCtx.camera.rotation.z }),
    setCameraPos: (x: number, y: number, z: number) => {
      sceneCtx.camera.position.set(x, y, z);
    },
    getTileCount: () => tileManager.getActiveKeys().size,
    getSpeedKts: () => 0,
    getAltitudeFt: () => Math.round(sceneCtx.camera.position.z),
    isHudVisible: () => hudCtx.hud.style.display !== "none",
    stepFrame: (_dtMs = 16.6) => {
      sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
    },
  };
  window.__STEP_FRAME__ = (_dtMs = 16.6) => {
    sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
  };
}

// Start frame loop
frameLoop();
