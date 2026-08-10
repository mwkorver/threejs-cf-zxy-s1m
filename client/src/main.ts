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
//
// 512 MB, raised from 256. The old figure was never what the app used: building
// geometry lives on the tile mesh rather than in the Bundle, so BundleCache
// could not see it, and measurement over Newark found 254.9 MB of bundles
// against 135.6 MB of untracked building geometry -- 390 MB real, against a
// budget that believed it was at 99.6% of 256. Rolling the camera made it
// visible, because the forward-biased root grid inflates the working set.
//
// Raised rather than clamped: 390 MB is affordable here, and a budget that
// reflects what is actually held is worth more than a smaller one that is
// quietly wrong. TileManager keeps BundleCache's share at this total minus live
// building bytes, so the two together respect it.
const cacheBudget = 512 * 1024 * 1024;
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
// ~2 MB per tile, not the 1 MB this assumed. Measured over Newark at 210 active
// tiles: 254.9 MB of bundles plus 135.6 MB of building geometry is 1.86 MB each.
// The old figure is why the tile cap failed to protect the byte budget -- it
// permitted twice the tiles the budget could hold. Raising the budget without
// correcting this would just have bought more tiles rather than more headroom;
// together they leave the cap at ~204, the same number, now for the right reason.
const MB_PER_TILE = 2;
tileManager.maxActiveTiles = Math.floor((cacheBudget / (1024 * 1024) / MB_PER_TILE) * 0.8);
tileManager.buildingSourceZoom = config.buildingSourceZoom;
tileManager.prefetchLookaheadSec = config.prefetchLookahead;
tileManager.prefetchSamples = config.prefetchSamples;

// Debug console handles
window.tileManager = tileManager;
window.camera = sceneCtx.camera;

// Bind viewport resize handler
bindSceneResize(sceneCtx.camera, sceneCtx.renderer, tileManager);

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

// 4. Initialize flight controller.
//
// The HUD's fly-to-cancel callback above closes over this before the line that
// declares it. That is fine: the callback only runs on user input, by which
// time this has been assigned. It is why the binding was previously a
// forward-declared `let`.
const flightControllerCtx = setupFlightController(
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
let hudPrimed = false;
/** How often the DOM HUD is rewritten, and the window the FPS figure averages over. */
const HUD_UPDATE_MS = 250;

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

  // The HUD is DOM, not WebGL: updateHUD writes eight textContent values, and
  // at frame rate that is ~480 layout-dirtying writes a second to show numbers
  // that flicker too fast to read. It rides the FPS counter's existing cadence
  // instead -- which is why that interval was already here. Everything feeding
  // it is sampled inside the same branch, so the per-frame cost drops to the
  // clock comparison.
  //
  // Deliberately not on this path: the compass. flightController calls
  // updateCompass directly, so the rose keeps rotating smoothly, and
  // __VIEWER_STATE__ reads live state through getters rather than anything the
  // HUD publishes.
  // Primed on the very first frame regardless of the interval: otherwise the
  // panel sits on the placeholder zeroes baked into its markup for the first
  // quarter second, and anything sampling it in that window -- a test, a
  // screenshot -- reads "0" instead of the real figures. FPS is not computed on
  // that frame, since there is no elapsed window to average over yet.
  fpsFrameCount++;
  if (!hudPrimed || now - fpsLastTime >= HUD_UPDATE_MS) {
    if (hudPrimed) {
      currentFps = Math.round((fpsFrameCount * 1000) / (now - fpsLastTime));
    }
    hudPrimed = true;
    fpsFrameCount = 0;
    fpsLastTime = now;

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
    isSceneReady: () => tileManager.isSceneReady(),
    getRendererInfo: () => ({
      geometries: sceneCtx.renderer.info.memory.geometries,
      textures: sceneCtx.renderer.info.memory.textures,
      calls: sceneCtx.renderer.info.render.calls,
      triangles: sceneCtx.renderer.info.render.triangles,
    }),
  };
  window.__STEP_FRAME__ = (_dtMs = 16.6) => {
    sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
  };
}

// Start frame loop
frameLoop();
