/**
 * Entry point: wires the three.js renderer (the engine picked in plan §10.2)
 * to the tile manager, the HUD, and the flight controls.
 *
 * Reads config from URL query params, builds the scene and camera, hands
 * streaming and LOD to TileManager, renders the HUD overlay, then runs the
 * flight controller each frame. Numbered sections below follow that order.
 */

import * as THREE from "three";
import "./hud.css";
import { lonLatToMercator, mercatorToLonLat } from "./core/mercator";
import { BundleCache } from "./core/bundleCache";
import { TileManager } from "./core/tileManager";
import { TexturePool } from "./core/texturePool";
import { createStarfield, updateSky } from "./core/sky";

// 1. Setup default configurations & URL query parameters
const params = new URLSearchParams(window.location.search);
const useLocal = params.get("src") === "local";
const useLocalTiler = params.get("src") === "tiler-local";

// Deployed tile CDN. Mirrored into client/.env.local by infra/deploy-edge.sh
// from the edge stack's DistributionDomain output — same lockstep trick as
// VITE_TILE_KEY — so a recreated distribution doesn't need a source edit. The
// fallback is the current distribution, so an unset var behaves as before.
const CDN_BASE_URL = import.meta.env.VITE_TILE_BASE_URL ?? "https://REDACTED.cloudfront.net";

const BASE_URL = useLocal
  ? "/tiles"
  : (useLocalTiler ? "http://localhost:8000" : CDN_BASE_URL);

const LAYER = params.get("layer") ?? "naip-visualization";
const YEAR = Number(params.get("year") ?? 2023);
const MAX_ZOOM = Number(params.get("maxzoom") ?? 18);
const LOD_FACTOR = Number(params.get("lod") ?? 2.2);
const CULL_TILES = params.get("cull") !== "false";
const PREFETCH_LOOKAHEAD = Number(params.get("lookahead") ?? 4);
const PREFETCH_SAMPLES = Number(params.get("samples") ?? 4);


// Wyoming S1M tile group; framing (lat/lon/altitude) read back from the HUD
// after manually flying to a level, horizon-centered view over the range.
const startLon = Number(params.get("lon") ?? -109.5294);
const startLat = Number(params.get("lat") ?? 43.70915);
const worldAnchor = lonLatToMercator(startLon, startLat);

// 2. Setup Three.js scene, camera, lights, and renderer
const appDiv = document.querySelector<HTMLDivElement>("#app")!;
appDiv.innerHTML = ""; // Clear loader text
appDiv.style.position = "relative";
appDiv.style.width = "100%";
appDiv.style.height = "100%";


const scene = new THREE.Scene();
// Sea-level sky colour and fog density the user asked for. updateSky grades
// both toward space with altitude, so it needs the ground intent kept apart
// from what is actually on scene.background/scene.fog this frame.
const groundSkyColor = new THREE.Color(0xa3c2f0);
let baseFogDensity = 0.0;
const fogColor = new THREE.Color(0xdce8f7);
scene.background = groundSkyColor.clone();
scene.fog = new THREE.FogExp2(fogColor.getHex(), baseFogDensity);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 10000000);
camera.up.set(0, 0, 1); // Z-up world

// Camera sits directly on worldAnchor (LAT/LON readout on load == startLat/
// startLon) at a fixed absolute altitude (ALTITUDE readout == initialHeight),
// looking level and due north so the horizon sits mid-frame rather than the
// ground-biased pitch a lower/closer start would need.
const initialHeight = 6460;
camera.position.set(0, 0, initialHeight);
camera.lookAt(new THREE.Vector3(0, 1000, initialHeight));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = false; // Performance priority
appDiv.appendChild(renderer.domElement);

// Add hemispheric and directional lighting at lower intensity for any standard mesh assets
const ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff2e0, 0.6);
sun.position.set(-1, -1, 1.4).normalize();
scene.add(sun);

// 3. Initialize caching and tile management
// Allocate a 256MB VRAM cache budget for meshes & textures
const cacheBudget = 256 * 1024 * 1024;
// Recycle tile textures rather than allocating one per tile: the cache hands
// evicted textures back to the pool, TileManager takes them out again.
const texturePool = new TexturePool();
const bundleCache = new BundleCache(cacheBudget, texturePool);
const tileManager = new TileManager(
  BASE_URL,
  LAYER,
  YEAR,
  scene,
  bundleCache,
  worldAnchor,
  12, // Base zoom
  MAX_ZOOM,
  LOD_FACTOR,
  CULL_TILES
);
tileManager.terrainMinZoom = 0;
tileManager.texturePool = texturePool;
// Pinned tiles are exempt from cache eviction, so the tile cap is what makes
// the byte budget real — derive one from the other rather than letting them
// drift. ~1 MB per tile (mesh + 512² texture); the 0.8 is headroom for the
// transient while culled subtrees behind the camera are still being pruned.
tileManager.maxActiveTiles = Math.floor((cacheBudget / (1024 * 1024)) * 0.8);
tileManager.prefetchLookaheadSec = PREFETCH_LOOKAHEAD;
tileManager.prefetchSamples = PREFETCH_SAMPLES;

// Debug handles for the browser console.
(window as any).tileManager = tileManager;
(window as any).camera = camera;

// 4. Create floating HUD overlay (styles in hud.css)
const hud = document.createElement("div");
hud.id = "hud";
hud.className = "hud";

/** A labelled slider. Every one pairs `ctrl-<id>` with a `val-<id>` readout. */
const slider = (id: string, label: string, attrs: string, value: string) => `
  <div class="hud-group">
    <div class="hud-label"><span>${label}</span><span id="val-${id}">${value}</span></div>
    <input type="range" class="hud-slider" id="ctrl-${id}" ${attrs}>
  </div>`;

/**
 * Per-source imagery brightness. NAIP aerial needs lifting; OSM raster tiles
 * are already near-white and blow out at the same setting, so switching source
 * carries its own default rather than leaving the old one applied.
 */
const BRIGHTNESS_BY_SOURCE = { satellite: 1.5, osm: 1.0 } as const;

/** A checkbox or radio with its caption. */
const toggle = (input: string, caption: string) =>
  `<label class="hud-toggle">${input} ${caption}</label>`;

/** A colour key entry: swatch (or letter) plus caption. */
const key = (mark: string, caption: string) =>
  `<span class="hud-legend-item">${mark} ${caption}</span>`;

const swatch = (color: string) => `<span class="hud-swatch" style="background:${color}"></span>`;

/**
 * A collapsible section. Native <details>, so open/close costs no JS and is
 * keyboard-accessible for free. Everything past the flight controls is tuning
 * you set once, and expanded it ran the panel to 1350px — taller than a laptop
 * viewport, with no way to scroll it.
 */
const section = (title: string, body: string, open = false) => `
  <details class="hud-details"${open ? " open" : ""}>
    <summary class="hud-summary">${title}</summary>
    ${body}
  </details>`;

hud.innerHTML = `
  <div class="hud-title">✈️ FLIGHT SIM DEMO</div>
  <div class="hud-readout">FPS: <span id="hud-fps">60</span></div>
  <div class="hud-readout">LAT/LON: <span id="hud-pos">- / -</span></div>
  <div class="hud-readout">ALTITUDE: <span id="hud-alt">0</span> m</div>
  <div class="hud-readout">SPEED: <span id="hud-speed">0</span> kt</div>

  ${slider("speed-ctrl", "FLIGHT SPEED SETTING", 'min="50" max="1000" step="10" value="800"', "800 kt")}
  ${slider("inertia", "INERTIA (glide time)", 'min="0" max="2" step="0.05" value="0.35"', "0.35 s")}
  ${slider("clearance", "MIN GROUND CLEARANCE", 'min="0" max="500" step="10" value="50"', "50 m")}

  <div class="hud-group">
    ${toggle('<input type="checkbox" class="hud-check" id="ctrl-panorama">', "PANORAMA (auto-orbit)")}
  </div>
  <!-- Only read while panorama is running; main.ts shows it with the mode. -->
  <div id="container-orbit-speed" style="display: none;">
    ${slider("orbit-speed", "ORBIT SPEED", 'min="1" max="30" step="1" value="6"', "6 °/s")}
  </div>

  <div class="hud-group">
    ${toggle('<input type="checkbox" class="hud-check" id="ctrl-follow-dem">', "FOLLOW TERRAIN (AGL hold)")}
  </div>
  <!-- Only read while the AGL hold is on; main.ts shows it with the mode. -->
  <div id="container-agl-alt" style="display: none;">
    ${slider("agl-alt", "AGL ALTITUDE", 'min="50" max="5000" step="50" value="1500"', "1500 m")}
  </div>

  <div class="hud-section">ACTIVE TILES: <span id="hud-tiles">0</span></div>
  <div>GPU CACHE: <span id="hud-cache">0.00</span> / ${Math.round(cacheBudget / (1024 * 1024))} MB</div>
  <div>PREFETCH: <span id="hud-prefetch">0 now / 0 total</span></div>
  <div>TEX POOL: <span id="hud-texpool">0 new / 0 reused</span></div>

  ${section("TERRAIN &amp; OVERLAYS", `
    <div class="hud-group">
      ${toggle('<input type="checkbox" class="hud-check" id="ctrl-footprints">', "SHOW DEM FOOTPRINTS")}
      <div class="hud-legend">
        ${key(swatch("#00ffff"), "S1M (1m)")}
        ${key(swatch("#ff00ff"), 'USGS 1/3" (10m)')}
      </div>
    </div>

    <div class="hud-group">
      ${toggle('<input type="checkbox" class="hud-check" id="ctrl-outlines">', "SHOW TMS OUTLINES &amp; LABELS")}
      <div class="hud-legend">
        ${key('<span class="hud-key" style="color:#ffd400">U</span>', "USDA server")}
        ${key('<span class="hud-key" style="color:#00e5ff">N</span>', "NAIP COG (DuckDB)")}
      </div>
    </div>

    <div class="hud-group">
      <div class="hud-label"><span>SHADING MODE</span></div>
      ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="0" checked>', "Satellite / Imagery")}
      ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="1">', "DEM Shading (DEM Colors)")}
      ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="2">', "Hypsometric Tinting")}
    </div>

    <!-- Shown by main.ts only while DEM Shading is the active mode. -->
    <div class="hud-legend" id="container-dem-legend" style="display: none;">
      ${key(swatch("#00cccc"), "S1M (1m)")}
      ${key(swatch("#cc00cc"), 'USGS 1/3" (10m)')}
      ${key(swatch("#666666"), "Far-field")}
      ${key(swatch("#ccb300"), "Flat")}
    </div>

    <!-- Shown by main.ts only while Hypsometric Tinting is the active mode. -->
    <div class="hud-sub" id="container-hypsometric" style="display: none;">
      <div class="hud-row">
        ${toggle('<input type="radio" class="hud-radio" name="ctrl-hyp-bounds" value="global">', "Global")}
        ${toggle('<input type="radio" class="hud-radio" name="ctrl-hyp-bounds" value="local" checked>', "Local to Viewport")}
      </div>
      ${slider("hypblend", "TINT BLEND", 'min="0" max="1" step="0.05" value="0.5"', "50%")}
    </div>

    ${slider("extimagery", "USDA SERVER MAX ZOOM (else COG Tiler)", 'min="0" max="18" step="1" value="13"', "13")}
    ${slider("exaggeration", "VERTICAL EXAGGERATION", 'min="1" max="10" step="0.5" value="1.5"', "1.5x")}
  `)}

  ${section("IMAGERY &amp; LIGHTING", `
    <div class="hud-group">
      <label class="hud-label" for="ctrl-imagery-source">IMAGERY SOURCE</label>
      <select class="hud-select" id="ctrl-imagery-source">
        <option value="satellite">NAIP Aerial (USDA)</option>
        <option value="osm">OpenStreetMap Roads</option>
      </select>
    </div>

    <div class="hud-group">
      <label class="hud-label" for="ctrl-preset">PRESET MOOD</label>
      <select class="hud-select" id="ctrl-preset">
        <option value="midday">Bright Midday (Realism)</option>
        <option value="golden">Golden Hour (Moody)</option>
        <option value="overcast">Overcast (Soft)</option>
        <option value="unlit">Unlit (Pure Photo)</option>
        <option value="custom" disabled style="display: none;">Custom</option>
      </select>
    </div>

    ${slider("hillshade", "HILLSHADE OPACITY", 'min="0" max="1" step="0.05" value="0.25"', "0.25")}
    ${slider("brightness", "IMAGERY BRIGHTNESS", `min="0.5" max="2.0" step="0.05" value="${BRIGHTNESS_BY_SOURCE.satellite}"`, BRIGHTNESS_BY_SOURCE.satellite.toFixed(2))}
    ${slider("contrast", "IMAGERY CONTRAST", 'min="0.5" max="2.0" step="0.05" value="1.10"', "1.10")}
    ${slider("saturation", "IMAGERY SATURATION", 'min="0.5" max="2.0" step="0.05" value="1.15"', "1.15")}
    ${slider("azimuth", "SUN AZIMUTH", 'min="0" max="360" step="5" value="225"', "225°")}
    ${slider("altitude", "SUN ALTITUDE", 'min="5" max="90" step="5" value="55"', "55°")}
    ${slider("fog", "FOG DENSITY", 'min="0" max="0.0003" step="0.00001" value="0"', "0.00000")}
    ${slider("space-alt", "SPACE ALTITUDE", 'min="2" max="60" step="1" value="10"', "10 km")}
  `)}

  ${section("CONTROLS", `
    <div class="hud-help">
      • Drag — Pan<br>
      • Right-drag — Rotate / Tilt<br>
      • Scroll — Zoom to cursor<br>
      • Double-click — Fly to point<br>
      • [W/A/S/D] Fly · [Q/E] Up/Down · [Shift] Boost
    </div>
  `, true)}
`;
appDiv.appendChild(hud);

// North compass (top-right): the rose rotates to show where north is relative
// to the current heading; clicking it yaws the view back to north-up.
const compass = document.createElement("div");
compass.id = "compass";
compass.className = "compass";
compass.title = "Click to point North";
compass.innerHTML = `
  <div class="compass-dial" id="compass-rose">
    <svg viewBox="0 0 56 56" width="56" height="56">
      <circle cx="28" cy="28" r="26" fill="rgba(15, 23, 42, 0.75)" stroke="rgba(148, 163, 184, 0.4)" stroke-width="1.5"></circle>
      <polygon points="28,7 22,29 34,29" fill="#ef4444"></polygon>
      <polygon points="28,49 22,29 34,29" fill="#cbd5e1"></polygon>
      <circle cx="28" cy="29" r="2.5" fill="#0f172a" stroke="#94a3b8" stroke-width="1"></circle>
      <text x="28" y="17.5" text-anchor="middle" font-family="monospace" font-size="9" font-weight="bold" fill="#ffffff">N</text>
    </svg>
  </div>`;
appDiv.appendChild(compass);
const compassRose = document.getElementById("compass-rose") as HTMLDivElement;
const compassFwd = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 0, 1);

// Swallow mousedown so a compass click doesn't start a world look-drag.
compass.addEventListener("mousedown", (e) => e.stopPropagation());
compass.addEventListener("click", () => {
  compassFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const bearing = Math.atan2(compassFwd.x, compassFwd.y); // 0 = +Y (north)
  // Yaw about world Z to null the bearing — resets heading to north while
  // preserving pitch and position.
  camera.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(worldUp, bearing));
});

const hudFps = document.getElementById("hud-fps")!;
const hudPos = document.getElementById("hud-pos")!;
const hudAlt = document.getElementById("hud-alt")!;
const hudSpeed = document.getElementById("hud-speed")!;
const hudTiles = document.getElementById("hud-tiles")!;
const hudCache = document.getElementById("hud-cache")!;
const hudPrefetch = document.getElementById("hud-prefetch")!;
const hudTexPool = document.getElementById("hud-texpool")!;


const ctrlPreset = document.getElementById("ctrl-preset") as HTMLSelectElement;
const ctrlImagerySource = document.getElementById("ctrl-imagery-source") as HTMLSelectElement;
const ctrlHillshade = document.getElementById("ctrl-hillshade") as HTMLInputElement;
const ctrlAzimuth = document.getElementById("ctrl-azimuth") as HTMLInputElement;
const ctrlAltitude = document.getElementById("ctrl-altitude") as HTMLInputElement;
const ctrlFog = document.getElementById("ctrl-fog") as HTMLInputElement;
const ctrlExaggeration = document.getElementById("ctrl-exaggeration") as HTMLInputElement;
const ctrlFollowDem = document.getElementById("ctrl-follow-dem") as HTMLInputElement;
const ctrlAglAlt = document.getElementById("ctrl-agl-alt") as HTMLInputElement;
const ctrlExtImagery = document.getElementById("ctrl-extimagery") as HTMLInputElement;
const ctrlFootprints = document.getElementById("ctrl-footprints") as HTMLInputElement;
const ctrlSpeedCtrl = document.getElementById("ctrl-speed-ctrl") as HTMLInputElement;
const ctrlInertia = document.getElementById("ctrl-inertia") as HTMLInputElement;
const ctrlClearance = document.getElementById("ctrl-clearance") as HTMLInputElement;
const ctrlPanorama = document.getElementById("ctrl-panorama") as HTMLInputElement;
const ctrlOrbitSpeed = document.getElementById("ctrl-orbit-speed") as HTMLInputElement;
const ctrlSpaceAlt = document.getElementById("ctrl-space-alt") as HTMLInputElement;
const ctrlOutlines = document.getElementById("ctrl-outlines") as HTMLInputElement;
const ctrlShadingModes = document.getElementsByName("ctrl-shading-mode") as NodeListOf<HTMLInputElement>;
const containerDemLegend = document.getElementById("container-dem-legend") as HTMLDivElement;
const containerHypsometric = document.getElementById("container-hypsometric") as HTMLDivElement;
// Rows for sliders their mode ignores when it is off — same disclosure pattern
// as the two containers above.
const containerOrbitSpeed = document.getElementById("container-orbit-speed") as HTMLDivElement;
const containerAglAlt = document.getElementById("container-agl-alt") as HTMLDivElement;
const ctrlHypBlend = document.getElementById("ctrl-hypblend") as HTMLInputElement;
const valHypBlend = document.getElementById("val-hypblend")!;
const ctrlHypBounds = document.getElementsByName("ctrl-hyp-bounds") as NodeListOf<HTMLInputElement>;
const ctrlBrightness = document.getElementById("ctrl-brightness") as HTMLInputElement;
const ctrlContrast = document.getElementById("ctrl-contrast") as HTMLInputElement;
const ctrlSaturation = document.getElementById("ctrl-saturation") as HTMLInputElement;

const valHillshade = document.getElementById("val-hillshade")!;
const valAzimuth = document.getElementById("val-azimuth")!;
const valAltitude = document.getElementById("val-altitude")!;
const valFog = document.getElementById("val-fog")!;
const valExaggeration = document.getElementById("val-exaggeration")!;
const valAglAlt = document.getElementById("val-agl-alt")!;
const valExtImagery = document.getElementById("val-extimagery")!;
const valSpeedCtrl = document.getElementById("val-speed-ctrl")!;
const valInertia = document.getElementById("val-inertia")!;
const valClearance = document.getElementById("val-clearance")!;
const valOrbitSpeed = document.getElementById("val-orbit-speed")!;
const valSpaceAlt = document.getElementById("val-space-alt")!;
const valBrightness = document.getElementById("val-brightness")!;
const valContrast = document.getElementById("val-contrast")!;
const valSaturation = document.getElementById("val-saturation")!;

// Preset configurations
interface MoodPreset {
  hillshade: number;
  azimuth: number;
  altitude: number;
  fogDensity: number;
  skyColor: number;
  fogColor: number;
}

const PRESETS = {
  midday: {
    hillshade: 0.25,
    azimuth: 225,
    altitude: 55,
    fogDensity: 0.0,
    skyColor: 0xa3c2f0,
    fogColor: 0xdce8f7
  },
  golden: {
    hillshade: 0.50,
    azimuth: 240,
    altitude: 15,
    fogDensity: 0.00010,
    skyColor: 0xfca5a5,
    fogColor: 0xfef3c7
  },
  overcast: {
    hillshade: 0.05,
    azimuth: 180,
    altitude: 90,
    fogDensity: 0.00014,
    skyColor: 0xcbd5e1,
    fogColor: 0xe2e8f0
  },
  unlit: {
    hillshade: 0.00,
    azimuth: 225,
    altitude: 55,
    fogDensity: 0.00004,
    skyColor: 0xa5f3fc,
    fogColor: 0xe0f2fe
  }
} satisfies Record<string, MoodPreset>;

function updateSunDirection(azimuth: number, altitude: number) {
  const azimuthRad = (azimuth * Math.PI) / 180;
  const altitudeRad = (altitude * Math.PI) / 180;

  const z = Math.sin(altitudeRad);
  const r = Math.cos(altitudeRad);
  const x = r * Math.sin(azimuthRad);
  const y = r * Math.cos(azimuthRad);

  tileManager.globalUniforms.sunDirection.value.set(x, y, z).normalize();
}

function applyPreset(mood: MoodPreset) {
  ctrlHillshade.value = mood.hillshade.toString();
  ctrlAzimuth.value = mood.azimuth.toString();
  ctrlAltitude.value = mood.altitude.toString();
  ctrlFog.value = mood.fogDensity.toString();

  valHillshade.textContent = mood.hillshade.toFixed(2);
  valAzimuth.textContent = `${mood.azimuth}°`;
  valAltitude.textContent = `${mood.altitude}°`;
  valFog.textContent = mood.fogDensity.toFixed(5);

  tileManager.globalUniforms.hillshadeIntensity.value = mood.hillshade;
  updateSunDirection(mood.azimuth, mood.altitude);

  // Record the sea-level look; updateSky grades it toward space each frame.
  groundSkyColor.set(mood.skyColor);
  baseFogDensity = mood.fogDensity;
  if (scene.fog && scene.fog instanceof THREE.FogExp2) {
    scene.fog.color = new THREE.Color(mood.fogColor);
  }
}

// Hook up event listeners for inputs
ctrlHillshade.addEventListener("input", () => {
  const val = parseFloat(ctrlHillshade.value);
  valHillshade.textContent = val.toFixed(2);
  tileManager.globalUniforms.hillshadeIntensity.value = val;
  ctrlPreset.value = "custom";
});

/** Set imagery brightness from code, keeping slider, readout and uniform together. */
function setBrightness(value: number): void {
  ctrlBrightness.value = String(value);
  valBrightness.textContent = value.toFixed(2);
  tileManager.globalUniforms.brightness.value = value;
}

ctrlBrightness.addEventListener("input", () => {
  setBrightness(parseFloat(ctrlBrightness.value));
});

ctrlContrast.addEventListener("input", () => {
  const val = parseFloat(ctrlContrast.value);
  valContrast.textContent = val.toFixed(2);
  tileManager.globalUniforms.contrast.value = val;
});

ctrlSaturation.addEventListener("input", () => {
  const val = parseFloat(ctrlSaturation.value);
  valSaturation.textContent = val.toFixed(2);
  tileManager.globalUniforms.saturation.value = val;
});

ctrlAzimuth.addEventListener("input", () => {
  const az = parseInt(ctrlAzimuth.value);
  valAzimuth.textContent = `${az}°`;
  updateSunDirection(az, parseInt(ctrlAltitude.value));
  ctrlPreset.value = "custom";
});

ctrlAltitude.addEventListener("input", () => {
  const alt = parseInt(ctrlAltitude.value);
  valAltitude.textContent = `${alt}°`;
  updateSunDirection(parseInt(ctrlAzimuth.value), alt);
  ctrlPreset.value = "custom";
});

ctrlFog.addEventListener("input", () => {
  const fogD = parseFloat(ctrlFog.value);
  valFog.textContent = fogD.toFixed(5);
  // Ground-level density; updateSky thins it out with altitude.
  baseFogDensity = fogD;
  ctrlPreset.value = "custom";
});

ctrlExaggeration.addEventListener("input", () => {
  const val = parseFloat(ctrlExaggeration.value);
  valExaggeration.textContent = `${val.toFixed(1)}x`;
  tileManager.setVerticalExaggeration(val);
});

ctrlAglAlt.addEventListener("input", () => {
  valAglAlt.textContent = `${parseInt(ctrlAglAlt.value)} m`;
});

// --- FlyTo animated trajectory (ported from pTolemy3D's flyTo) ---
// Replaces the instant lerp double-click with a smooth accel/decel path
// that climbs to a cruise altitude, arcs over, and descends to the target.
interface FlyToState {
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  startQuat: THREE.Quaternion;
  endQuat: THREE.Quaternion;
  startTime: number;
  duration: number;
  cruiseAlt: number;  // world Z apex along the arc
}
let flyToState: FlyToState | null = null;

/** Cancel any in-flight FlyTo trajectory. */
function cancelFlyTo(): void {
  flyToState = null;
}

/**
 * Move the Follow-DEM hold altitude, clamped to the slider's range.
 *
 * Follow-DEM drives camera Z every frame, so manual altitude input (wheel
 * zoom, Q/E) has to change the *target* or it is simply overwritten.
 */
function setAglTarget(metres: number): void {
  const min = parseFloat(ctrlAglAlt.min);
  const max = parseFloat(ctrlAglAlt.max);
  const clamped = Math.round(THREE.MathUtils.clamp(metres, min, max));
  ctrlAglAlt.value = String(clamped);
  valAglAlt.textContent = `${clamped} m`;
}

/**
 * Smoothstep easing: 0 at t=0, 1 at t=1, with zero velocity at both ends
 * (accel from rest, decel to rest). Matches pTolemy3D's brake-distance logic
 * but in a closed form.
 */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Initiate a smooth FlyTo trajectory to a ground point. The camera climbs
 * to a cruise altitude (midpoint Z raised by the arc factor), rotates to
 * look at the target, then descends. Duration scales with distance.
 */
function flyTo(targetGround: THREE.Vector3): void {
  // Pre-warm destination tiles at top-of-queue priority before camera starts moving
  tileManager.prefetchTargetGround(targetGround, 1500);

  const start = camera.position.clone();
  const dist = start.distanceTo(targetGround);
  // Duration scales with distance: ~2s for 1km, ~6s for 100km, capped.
  const duration = Math.min(8000, Math.max(2000, dist * 0.04));
  // Cruise altitude: arc above the direct path. Raise the midpoint Z so
  // the camera climbs then descends, mirroring pTolemy3D's cruise_alt.
  const cruiseAlt = Math.max(start.z, targetGround.z) + Math.min(dist * 0.15, 5000);

  // End orientation: position camera directly above target (nadir view looking straight down), top of screen aligned North (+Y).
  const endQuat = new THREE.Quaternion();
  const lookFrom = targetGround.clone();
  lookFrom.z += 1500; // arrive 1500m directly above the clicked point (nadir)
  const lookTarget = targetGround.clone();
  const m = new THREE.Matrix4().lookAt(lookFrom, lookTarget, new THREE.Vector3(0, 1, 0));
  endQuat.setFromRotationMatrix(m);

  flyToState = {
    startPos: start,
    endPos: lookFrom,
    startQuat: camera.quaternion.clone(),
    endQuat,
    startTime: performance.now(),
    duration,
    cruiseAlt,
  };
}

/** Advance the FlyTo trajectory by one frame; returns true if active. */
function updateFlyTo(): boolean {
  if (!flyToState) return false;
  const s = flyToState;
  const elapsed = performance.now() - s.startTime;
  const t = Math.min(1, elapsed / s.duration);
  const e = smoothstep(t);

  // Position: lerp start→end, but raise Z along a sine arc for cruise altitude.
  camera.position.lerpVectors(s.startPos, s.endPos, e);
  const arcZ = Math.sin(t * Math.PI) * (s.cruiseAlt - Math.max(s.startPos.z, s.endPos.z));
  camera.position.z += Math.max(0, arcZ);

  // Orientation: slerp from start to end quaternion.
  camera.quaternion.slerpQuaternions(s.startQuat, s.endQuat, e);

  if (t >= 1) {
    flyToState = null;
  }
  return true;
}

ctrlFootprints.addEventListener("change", () => {
  tileManager.setShowFootprints(ctrlFootprints.checked);
});

ctrlExtImagery.addEventListener("input", () => {
  const z = parseInt(ctrlExtImagery.value);
  valExtImagery.textContent = z.toString();
  tileManager.setExternalImageryMaxZoom(z);
});

ctrlSpeedCtrl.addEventListener("input", () => {
  baseSpeedKnots = parseInt(ctrlSpeedCtrl.value);
  valSpeedCtrl.textContent = `${baseSpeedKnots} kt`;
});

ctrlInertia.addEventListener("input", () => {
  valInertia.textContent = `${parseFloat(ctrlInertia.value).toFixed(2)} s`;
});

ctrlClearance.addEventListener("input", () => {
  const m = parseInt(ctrlClearance.value);
  valClearance.textContent = m === 0 ? "off" : `${m} m`;
});

ctrlOrbitSpeed.addEventListener("input", () => {
  valOrbitSpeed.textContent = `${parseInt(ctrlOrbitSpeed.value)} °/s`;
});

ctrlSpaceAlt.addEventListener("input", () => {
  valSpaceAlt.textContent = `${parseInt(ctrlSpaceAlt.value)} km`;
});

// Panorama pivots about the ground point under the camera when switched on.
ctrlPanorama.addEventListener("change", () => {
  if (ctrlPanorama.checked) {
    startPanorama();
  } else {
    panoramaPivot = null;
  }
  containerOrbitSpeed.style.display = ctrlPanorama.checked ? "block" : "none";
});

// AGL ALTITUDE only drives anything while the hold is engaged. Keep it a live
// slider rather than disabling it — wheel zoom and Q/E write back to it via
// setAglTarget(), so it is an output as well as an input.
ctrlFollowDem.addEventListener("change", () => {
  containerAglAlt.style.display = ctrlFollowDem.checked ? "block" : "none";
});

ctrlOutlines.addEventListener("change", () => {
  const isChecked = ctrlOutlines.checked;
  tileManager.setShowOutlines(isChecked);
  // One call sets both baked annotations ("z/x/y - N") so the refetch they
  // require happens once, not twice.
  tileManager.setShowTileLabels(isChecked);
});

ctrlShadingModes.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      const mode = parseFloat(radio.value);
      tileManager.setShadingMode(mode);

      // Toggle Legend/Blend containers visibility
      containerDemLegend.style.display = (mode === 1.0) ? "flex" : "none";
      containerHypsometric.style.display = (mode === 2.0) ? "block" : "none";
    }
  });
});

ctrlHypBlend.addEventListener("input", () => {
  const val = parseFloat(ctrlHypBlend.value);
  valHypBlend.textContent = `${Math.round(val * 100)}%`;
  tileManager.setHypsometricBlend(val);
});

ctrlHypBounds.forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      tileManager.setUseLocalHypso(radio.value === "local");
    }
  });
});

ctrlImagerySource.addEventListener("change", () => {
  const source = ctrlImagerySource.value as "satellite" | "osm";
  tileManager.setImagerySource(source);
  setBrightness(BRIGHTNESS_BY_SOURCE[source]);
});

ctrlPreset.addEventListener("change", () => {
  const key = ctrlPreset.value;
  if (key in PRESETS) {
    applyPreset(PRESETS[key as keyof typeof PRESETS]);
  }
});

// Initialize mood preset
applyPreset(PRESETS.midday);

// 5. Setup simple keyboard & mouse flight controls
const activeKeys = new Set<string>();
let isInteractingWithHud = false;
let previousMousePosition = { x: 0, y: 0 };
let baseSpeedKnots = 800; // Customizable flight speed setting in knots
let speedKnots = 800; // Default active airspeed simulation

// Carried velocity, so the camera accelerates and coasts instead of starting
// and stopping dead. pTolemy3D held velocity/vert_velocity/horz_velocity with
// an acceleration term; the same feel falls out of easing toward the input
// velocity with a time constant, which also collapses to the old instant
// behaviour when the INERTIA slider is 0.
const velocity = new THREE.Vector3();

// Auto-orbit (pTolemy3D's panorama()): pivot stays fixed while the camera
// sweeps around it. Null when the mode is off.
let panoramaPivot: THREE.Vector3 | null = null;

/**
 * Begin auto-orbit about whatever the camera is looking at.
 *
 * Deliberately not the ground directly beneath the camera: that pivot has zero
 * horizontal radius, so rotating about it moves the camera nowhere.
 */
function startPanorama(): void {
  cancelFlyTo();
  velocity.set(0, 0, 0);

  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  // Terrain under the view centre, else where that ray crosses sea level.
  let pivot = pickGround(cx, cy) ?? rayToPlane(cx, cy, 0);

  if (!pivot) {
    // Camera is looking up: orbit a point ahead along the ground track instead.
    const forward = tmpV.set(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.z = 0;
    if (forward.lengthSq() < 1e-9) forward.set(0, 1, 0);
    forward.normalize().multiplyScalar(Math.max(camera.position.z, 1000) * 2);
    pivot = new THREE.Vector3(camera.position.x + forward.x, camera.position.y + forward.y, 0);
  }

  panoramaPivot = pivot.clone();
}

// Track keyboard state — any movement key cancels an in-flight FlyTo trajectory.
const movementCodes = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
window.addEventListener("keydown", (e) => {
  activeKeys.add(e.code);
  if (movementCodes.has(e.code)) cancelFlyTo();
});
window.addEventListener("keyup", (e) => activeKeys.delete(e.code));

// Prevent standard context menu when clicking on the 3D scene (outside HUD)
window.addEventListener("contextmenu", (e) => {
  if (!hud.contains(e.target as Node)) {
    e.preventDefault();
  }
});

// ---- Globe-style navigation (GIS default) --------------------------------
// Left-drag = pan (grab the ground under the cursor), right-drag = orbit/tilt
// around the screen-centre ground point, wheel = zoom toward the cursor point.
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmpV = new THREE.Vector3();
// Camera position at the top of the frame, for measuring actual ground speed.
const framePrevPos = new THREE.Vector3();

/** Ground point (world/offset coords) under a screen pixel, or null on a miss. */
function pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
  camera.updateMatrixWorld(); // pan moves the camera between renders; refresh so the ray uses the current position
  ndc.x = (clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster
    .intersectObjects(scene.children, true)
    .filter((h) => (h.object as THREE.Mesh).isMesh);
  return hits.length ? hits[0]!.point.clone() : null;
}

/** Where the ray through a screen pixel meets the horizontal plane z=planeZ. */
function rayToPlane(clientX: number, clientY: number, planeZ: number): THREE.Vector3 | null {
  camera.updateMatrixWorld(); // ensure the ray reflects the latest camera position (moved since last render)
  ndc.x = (clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const o = raycaster.ray.origin;
  const d = raycaster.ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const t = (planeZ - o.z) / d.z;
  if (t <= 0) return null;
  return tmpV.copy(d).multiplyScalar(t).add(o).clone();
}

let dragMode: "pan" | "orbit" | null = null;
const panAnchor = new THREE.Vector3(); // fixed world point kept under the cursor while panning
let panPlaneZ = 0;
const orbitTarget = new THREE.Vector3(); // fixed pivot while orbiting

window.addEventListener("mousedown", (e) => {
  if (hud.contains(e.target as Node)) {
    isInteractingWithHud = true;
    return;
  }
  isInteractingWithHud = false;
  dragMode = null;
  previousMousePosition = { x: e.clientX, y: e.clientY };

  if (e.button === 0) {
    // Pan: anchor the ground point under the cursor (fall back to a flat plane).
    const g = pickGround(e.clientX, e.clientY);
    panPlaneZ = g ? g.z : 0;
    const anchor = g ?? rayToPlane(e.clientX, e.clientY, panPlaneZ);
    if (anchor) {
      panAnchor.copy(anchor);
      dragMode = "pan";
    }
  } else if (e.button === 2) {
    // Orbit/tilt about the ground point at screen centre.
    const t =
      pickGround(window.innerWidth / 2, window.innerHeight / 2) ??
      pickGround(e.clientX, e.clientY) ??
      rayToPlane(window.innerWidth / 2, window.innerHeight / 2, 0);
    if (t) {
      orbitTarget.copy(t);
      dragMode = "orbit";
    }
  }
});

window.addEventListener("mousemove", (e) => {
  if (dragMode === null || e.buttons === 0) return;
  cancelFlyTo();
  const dx = e.clientX - previousMousePosition.x;
  const dy = e.clientY - previousMousePosition.y;
  previousMousePosition = { x: e.clientX, y: e.clientY };

  if (dragMode === "pan") {
    // Translate so the anchored ground point stays under the cursor.
    const q = rayToPlane(e.clientX, e.clientY, panPlaneZ);
    if (q) camera.position.add(tmpV.copy(panAnchor).sub(q));
  } else if (dragMode === "orbit") {
    // Spherical offset about the pivot: dx -> azimuth (bearing), dy -> polar (tilt).
    const off = tmpV.copy(camera.position).sub(orbitTarget);
    const r = off.length();
    let az = Math.atan2(off.y, off.x);
    let po = Math.acos(Math.min(1, Math.max(-1, off.z / r))); // 0 = top-down, PI/2 = horizon
    az -= dx * 0.005;
    po -= dy * 0.005; // drag down -> tilt toward top-down
    po = Math.max(0.05, Math.min(1.45, po)); // ~3deg .. ~83deg from vertical (stay above ground)
    off.set(r * Math.sin(po) * Math.cos(az), r * Math.sin(po) * Math.sin(az), r * Math.cos(po));
    camera.position.copy(orbitTarget).add(off);
    camera.up.set(0, 0, 1);
    camera.lookAt(orbitTarget);
  }
});

window.addEventListener("mouseup", () => {
  dragMode = null;
  isInteractingWithHud = false;
});

// Wheel = zoom toward the ground point under the cursor (keeps it under the cursor).
window.addEventListener("wheel", (e) => {
  if (hud.contains(e.target as Node)) return;
  e.preventDefault();

  // Exponential in deltaY (MapLibre-style), not a flat step per event: one
  // mouse notch (deltaY~100) ≈ ×1.2, a trackpad's small deltas zoom smoothly,
  // and fast flicks/coalesced events compound (capped ~×2 per event) instead
  // of collapsing to a single notch — street level to CONUS in a few flicks.
  const factor = Math.exp(THREE.MathUtils.clamp(e.deltaY, -400, 400) * 0.0018);

  const groundZ = tileManager.groundZAt(
    camera.position.x + worldAnchor[0],
    camera.position.y + worldAnchor[1]
  ) ?? 0;

  // Try mesh raycast first; if miss (or before tiles load), fall back to plane at groundZ.
  const target = pickGround(e.clientX, e.clientY) ?? rayToPlane(e.clientX, e.clientY, groundZ);
  if (target) {
    const off = tmpV.copy(camera.position).sub(target).multiplyScalar(factor);
    const dist = off.length();
    if (dist > 20 && dist < 8_000_000) camera.position.copy(target).add(off);
  } else {
    // Miss (aiming at sky): fall back to dolly along the view axis.
    const step = Math.max(50, camera.position.z) * (factor - 1);
    const fwd = tmpV.set(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(fwd, -step);
  }

  // Follow-DEM rewrites camera Z every frame, so carry the new clearance into
  // the hold target. If zooming out past the slider's max AGL, disengage
  // Follow-DEM so high-altitude flight isn't rubber-banded back down.
  if (ctrlFollowDem.checked) {
    const newAgl = camera.position.z - groundZ;
    const maxAgl = parseFloat(ctrlAglAlt.max);
    if (newAgl > maxAgl) {
      ctrlFollowDem.checked = false;
      // Setting .checked in code fires no change event, so tell the disclosure.
      ctrlFollowDem.dispatchEvent(new Event("change"));
    } else {
      setAglTarget(newAgl);
    }
  }
}, { passive: false });

// Double-click = FlyTo the clicked ground point (smooth animated trajectory).
window.addEventListener("dblclick", (e) => {
  if (hud.contains(e.target as Node)) return;
  const point = pickGround(e.clientX, e.clientY);
  if (point) flyTo(point);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  tileManager.setViewportSize(window.innerWidth, window.innerHeight);
});

// 6. Running frame render and flight controller loop
let lastFrameTime = performance.now();
let fpsFrameCount = 0;
let fpsLastTime = performance.now();

function frameLoop() {
  requestAnimationFrame(frameLoop);

  const now = performance.now();
  const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // Clamp to avoid spikes
  lastFrameTime = now;

  // Convert knots setting to Mercator meters per second (1 knot = 0.514444 m/s)
  const baseSpeed = baseSpeedKnots * 0.514444;
  const speedMultiplier = activeKeys.has("ShiftLeft") || activeKeys.has("ShiftRight") ? 4 : 1;
  // Scale speed dynamically as a function of altitude (with a floor of 1.0 at 1500m)
  const altitudeFactor = Math.max(1.0, camera.position.z / 1500.0);
  const speed = baseSpeed * speedMultiplier * altitudeFactor;
  // Measured after the camera has moved, so the readout covers coasting,
  // FlyTo and panorama too, not just the requested key speed.
  framePrevPos.copy(camera.position);

  // FlyTo trajectory takes over camera position/orientation until it completes.
  // Manual input (keys/mouse) cancels it via cancelFlyTo().
  if (updateFlyTo()) {
    // Skip manual movement; still update LOD and render.
    velocity.set(0, 0, 0);
  } else if (panoramaPivot) {
    // Auto-orbit: swing the camera around the fixed pivot, holding its radius
    // and height, and keep it aimed at the pivot.
    const omega = (parseInt(ctrlOrbitSpeed.value) * Math.PI) / 180;
    const offset = tmpV.copy(camera.position).sub(panoramaPivot);
    const cos = Math.cos(omega * dt);
    const sin = Math.sin(omega * dt);
    const ox = offset.x * cos - offset.y * sin;
    const oy = offset.x * sin + offset.y * cos;
    camera.position.set(panoramaPivot.x + ox, panoramaPivot.y + oy, camera.position.z);
    camera.lookAt(panoramaPivot);
  } else {
    // Process movement input relative to camera heading
    const direction = new THREE.Vector3();
    if (activeKeys.has("KeyW")) direction.z -= 1;
    if (activeKeys.has("KeyS")) direction.z += 1;
    if (activeKeys.has("KeyA")) direction.x -= 1;
    if (activeKeys.has("KeyD")) direction.x += 1;

    // Apply camera orientation to horizontal inputs
    direction.normalize();
    direction.applyQuaternion(camera.quaternion);

    // Vertical flying inputs (Q=down, E=up). While Follow-DEM holds an AGL,
    // it owns camera Z and would undo any climb next frame, so retarget the
    // hold instead of fighting it — the same "manual input wins" rule that
    // makes a movement key cancel an in-flight FlyTo.
    let verticalInput = 0;
    if (activeKeys.has("KeyQ")) verticalInput -= 1;
    if (activeKeys.has("KeyE")) verticalInput += 1;
    if (verticalInput !== 0 && ctrlFollowDem.checked) {
      setAglTarget(parseFloat(ctrlAglAlt.value) + verticalInput * speed * dt);
    } else {
      direction.z += verticalInput;
    }

    // Ease the carried velocity toward what the keys are asking for. tau = 0
    // snaps (no inertia); larger values accelerate in and coast out.
    const targetVelocity = tmpV.set(0, 0, 0);
    if (direction.lengthSq() > 0) {
      targetVelocity.copy(direction.normalize()).multiplyScalar(speed);
    }
    const tau = parseFloat(ctrlInertia.value);
    const blend = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
    velocity.lerp(targetVelocity, blend);
    // Stop chasing an asymptote once the glide is imperceptible.
    if (velocity.lengthSq() < 1e-4) velocity.set(0, 0, 0);

    camera.position.addScaledVector(velocity, dt);
  }

  // Follow-DEM: maintain constant above-ground clearance instead of
  // above-sea-level altitude (ported from pTolemy3D's setFollowDem). The
  // terrain Z under the camera is sampled from loaded tiles; camera Z is
  // adjusted to hold the target AGL. Skipped when no terrain is loaded
  // under the camera (e.g. over open ocean or during cold start).
  //
  // groundZAt reports the surface as rendered, so the held clearance is the
  // gap the pilot can see. Measuring raw elevation instead would hold 500 m
  // above where the terrain would be *unexaggerated* — at the default 2x that
  // is a different, and much smaller, gap than the one on screen.
  if (ctrlFollowDem.checked) {
    const groundZ = tileManager.groundZAt(
      camera.position.x + worldAnchor[0],
      camera.position.y + worldAnchor[1]
    );
    if (groundZ !== null) {
      const targetZ = groundZ + parseFloat(ctrlAglAlt.value);
      // Smooth toward target (exponential smoothing) to avoid jitter when
      // tiles swap LOD and centerElevation steps. τ = 0.2s.
      camera.position.z += (targetZ - camera.position.z) * Math.min(1, dt / 0.2);
    }
  }

  // Hard floor under the camera, adapted from pTolemy3D's checkAlt(), which
  // refused any move landing within 25 units of the ground. Uses the *rendered*
  // ground height so the floor holds under vertical exaggeration. 0 = off.
  const clearance = parseInt(ctrlClearance.value);
  if (clearance > 0) {
    const groundZ = tileManager.groundZAt(
      camera.position.x + worldAnchor[0],
      camera.position.y + worldAnchor[1]
    );
    if (groundZ !== null && camera.position.z < groundZ + clearance) {
      camera.position.z = groundZ + clearance;
      // Shed downward momentum so holding Q doesn't build speed into the floor.
      if (velocity.z < 0) velocity.z = 0;
    }
  }

  // Actual ground speed this frame (Mercator m/s -> knots).
  speedKnots = dt > 0 ? Math.round((camera.position.distanceTo(framePrevPos) / dt) * 1.94384) : 0;

  // Sky/fog grade with altitude (pTolemy3D's Sky.horizonAlt).
  updateSky(
    scene,
    camera,
    undefined,
    groundSkyColor,
    baseFogDensity,
    parseInt(ctrlSpaceAlt.value) * 1000
  );

  // Update LOD and stream/cache terrain tiles
  tileManager.update(camera.position, camera);

  // Render frame
  renderer.render(scene, camera);

  // Update HUD elements
  const globalX = camera.position.x + worldAnchor[0];
  const globalY = camera.position.y + worldAnchor[1];
  const [lon, lat] = mercatorToLonLat(globalX, globalY);

  // Update FPS counter every 250ms for smooth 4Hz readout with 0 jank
  fpsFrameCount++;
  if (now - fpsLastTime >= 250) {
    const fps = Math.round((fpsFrameCount * 1000) / (now - fpsLastTime));
    hudFps.textContent = fps.toString();
    fpsFrameCount = 0;
    fpsLastTime = now;
  }

  hudPos.textContent = `${lat.toFixed(5)} / ${lon.toFixed(5)}`;
  hudAlt.textContent = Math.round(camera.position.z).toString();
  // Report ground truth rather than the requested speed: with inertia the
  // camera still coasts after the keys are released, and FlyTo/panorama move
  // it with no key held at all.
  hudSpeed.textContent = speedKnots.toString();
  hudTiles.textContent = `${tileManager.getActiveKeys().size} / ${tileManager.maxActiveTiles}`;
  hudCache.textContent = (bundleCache.bytesUsed() / (1024 * 1024)).toFixed(2);
  // Per-frame count plus a running total: the current frame is 0 most of the
  // time (parked, or the tiles ahead are already cached), which made a working
  // prefetch look dead.
  hudPrefetch.textContent =
    `${tileManager.getLastPrefetchCount()} now / ${tileManager.getPrefetchTotal()} total`;
  const pool = texturePool.stats();
  hudTexPool.textContent = `${pool.created} new / ${pool.reused} reused`;


  // Rotate the compass rose so the red N points to where north is on screen.
  compassFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const bearingDeg = (Math.atan2(compassFwd.x, compassFwd.y) * 180) / Math.PI;
  compassRose.style.transform = `rotate(${-bearingDeg}deg)`;
}

// 7. Expose test state hooks for Playwright & automated UI testing
if (params.get("test") === "1" || import.meta.env.MODE === "test" || window.location.hostname === "localhost") {
  window.__VIEWER_STATE__ = {
    getCameraPos: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
    getCameraRotation: () => ({ x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z }),
    setCameraPos: (x: number, y: number, z: number) => {
      camera.position.set(x, y, z);
    },
    getTileCount: () => tileManager.getActiveKeys().size,
    getSpeedKts: () => speedKnots,
    getAltitudeFt: () => Math.round(camera.position.z),
    isHudVisible: () => hud.style.display !== "none",
    stepFrame: (dtMs = 16.6) => {
      renderer.render(scene, camera);
    },
  };
  window.__STEP_FRAME__ = (dtMs = 16.6) => {
    renderer.render(scene, camera);
  };
}

// Start visual frame loop
frameLoop();


