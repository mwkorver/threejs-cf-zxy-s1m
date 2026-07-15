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
  : (useLocalTiler ? "http://localhost:8000" : "https://d2ua3aiihdkajg.cloudfront.net");

const LAYER = params.get("layer") ?? "naip-visualization";
const YEAR = Number(params.get("year") ?? 2023);
const MAX_ZOOM = Number(params.get("maxzoom") ?? 18);
const LOD_FACTOR = Number(params.get("lod") ?? 2.2);
const CULL_TILES = params.get("cull") !== "false";

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

const dualSliderStyle = document.createElement("style");
dualSliderStyle.textContent = `
  .dual-slider-container input[type="range"] {
    -webkit-appearance: none;
    pointer-events: none;
  }
  .dual-slider-container input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #f8fafc;
    border: 2px solid #38bdf8;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  .dual-slider-container input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #f8fafc;
    border: 2px solid #38bdf8;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
`;
document.head.appendChild(dualSliderStyle);

const scene = new THREE.Scene();
const skyColor = new THREE.Color(0xa3c2f0);
const fogColor = new THREE.Color(0xdce8f7);
scene.background = skyColor;
scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.00006);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 10000000);
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

// Add hemispheric and directional lighting at lower intensity for any standard mesh assets
const ambient = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xfff2e0, 0.6);
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
  LOD_FACTOR,
  CULL_TILES
);
tileManager.terrainMinZoom = 0;
// Debug handles for the browser console.
(window as any).tileManager = tileManager;
(window as any).camera = camera;

// 4. Create floating HUD overlay
const hud = document.createElement("div");
hud.style.position = "absolute";
hud.style.top = "20px";
hud.style.left = "20px";
hud.style.background = "rgba(15, 23, 42, 0.85)";
hud.style.backdropFilter = "blur(12px)";
hud.style.border = "1px solid rgba(255, 255, 255, 0.1)";
hud.style.padding = "20px";
hud.style.borderRadius = "12px";
hud.style.fontFamily = "monospace";
hud.style.fontSize = "13px";
hud.style.color = "#f8fafc";
hud.style.pointerEvents = "auto"; // Allow interaction with controls
hud.style.zIndex = "100";
hud.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
hud.style.width = "280px";
hud.innerHTML = `
  <div style="font-weight: bold; font-size: 15px; margin-bottom: 10px; color: #38bdf8; letter-spacing: 1px;">✈️ FLIGHT SIM DEMO</div>
  <div style="margin-bottom: 4px;">LAT/LON: <span id="hud-pos">- / -</span></div>
  <div style="margin-bottom: 4px;">ALTITUDE: <span id="hud-alt">0</span> m</div>
  <div style="margin-bottom: 4px;">SPEED: <span id="hud-speed">0</span> kt</div>

  <div style="margin-top: 8px; margin-bottom: 8px;">
    <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
      <span>FLIGHT SPEED SETTING</span>
      <span id="val-speed-ctrl">200 kt</span>
    </div>
    <input type="range" id="ctrl-speed-ctrl" min="50" max="1000" step="10" value="200" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
  </div>

  <div style="margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px; margin-bottom: 4px;">ACTIVE TILES: <span id="hud-tiles">0</span></div>
  <div>GPU CACHE: <span id="hud-cache">0.00</span> / 256 MB</div>
  
  <div style="margin-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px;">
    <div style="font-weight: bold; color: #38bdf8; margin-bottom: 8px;">🌅 ATMOSPHERE & LIGHTING</div>
    
    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">IMAGERY SOURCE</label>
      <select id="ctrl-imagery-source" style="width: 100%; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; padding: 4px; font-family: monospace; font-size: 12px; cursor: pointer; outline: none;">
        <option value="satellite">USGS Satellite / NAIP</option>
        <option value="osm">OpenStreetMap Roads</option>
      </select>
    </div>
    
    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">PRESET MOOD</label>
      <select id="ctrl-preset" style="width: 100%; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; padding: 4px; font-family: monospace; font-size: 12px; cursor: pointer; outline: none;">
        <option value="midday">Bright Midday (Realism)</option>
        <option value="golden">Golden Hour (Moody)</option>
        <option value="overcast">Overcast (Soft)</option>
        <option value="unlit">Unlit (Pure Photo)</option>
        <option value="custom" disabled style="display: none;">Custom</option>
      </select>
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>HILLSHADE OPACITY</span>
        <span id="val-hillshade">0.25</span>
      </div>
      <input type="range" id="ctrl-hillshade" min="0" max="1" step="0.05" value="0.25" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>IMAGERY BRIGHTNESS</span>
        <span id="val-brightness">1.15</span>
      </div>
      <input type="range" id="ctrl-brightness" min="0.5" max="2.0" step="0.05" value="1.15" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>IMAGERY CONTRAST</span>
        <span id="val-contrast">1.10</span>
      </div>
      <input type="range" id="ctrl-contrast" min="0.5" max="2.0" step="0.05" value="1.10" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>IMAGERY SATURATION</span>
        <span id="val-saturation">1.15</span>
      </div>
      <input type="range" id="ctrl-saturation" min="0.5" max="2.0" step="0.05" value="1.15" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>SUN AZIMUTH</span>
        <span id="val-azimuth">225°</span>
      </div>
      <input type="range" id="ctrl-azimuth" min="0" max="360" step="5" value="225" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>SUN ALTITUDE</span>
        <span id="val-altitude">55°</span>
      </div>
      <input type="range" id="ctrl-altitude" min="5" max="90" step="5" value="55" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>FOG DENSITY</span>
        <span id="val-fog">0.00006</span>
      </div>
      <input type="range" id="ctrl-fog" min="0" max="0.0003" step="0.00001" value="0.00006" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>VERTICAL EXAGGERATION</span>
        <span id="val-exaggeration">4.0x</span>
      </div>
      <input type="range" id="ctrl-exaggeration" min="1" max="10" step="0.5" value="4.0" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>USDA IMAGERY &le; Z (else COG tiler)</span>
        <span id="val-extimagery">13</span>
      </div>
      <input type="range" id="ctrl-extimagery" min="0" max="18" step="1" value="13" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 4px;">
        <span>TERRAIN RESOLUTION BANDS</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 9px; color: #cbd5e1; margin-bottom: 6px; gap: 4px;">
        <span style="display: flex; align-items: center; gap: 3px;">
          <span style="display: inline-block; width: 6px; height: 6px; background: #64748b; border-radius: 1px;"></span>
          Mapzen: z1-<span id="val-mapzen-max">10</span>
        </span>
        <span style="display: flex; align-items: center; gap: 3px;">
          <span style="display: inline-block; width: 6px; height: 6px; background: #ff00ff; border-radius: 1px;"></span>
          USGS: z<span id="val-usgs-min">11</span>-<span id="val-usgs-max">14</span>
        </span>
        <span style="display: flex; align-items: center; gap: 3px;">
          <span style="display: inline-block; width: 6px; height: 6px; background: #00ffff; border-radius: 1px;"></span>
          S1M: z<span id="val-s1m-min">15</span>-20
        </span>
      </div>
      <div class="dual-slider-container" style="position: relative; height: 20px; width: 100%; margin-top: 4px; margin-bottom: 8px;">
        <div id="slider-track" style="position: absolute; top: 8px; left: 0; right: 0; height: 4px; border-radius: 2px;"></div>
        <input type="range" id="ctrl-usgs-min" min="1" max="20" value="11" step="1" style="position: absolute; width: 100%; top: 0; left: 0; height: 20px; margin: 0; -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; cursor: pointer;">
        <input type="range" id="ctrl-s1m-min" min="1" max="20" value="15" step="1" style="position: absolute; width: 100%; top: 0; left: 0; height: 20px; margin: 0; -webkit-appearance: none; appearance: none; background: transparent; pointer-events: none; cursor: pointer;">
      </div>
    </div>

    <div style="margin-bottom: 4px; display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" id="ctrl-footprints" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
        <label for="ctrl-footprints" style="font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">SHOW DEM FOOTPRINTS</label>
      </div>
      <div style="display: flex; gap: 12px; font-size: 9px; color: #94a3b8; margin-left: 22px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #00ffff; border-radius: 2px;"></span>
          S1M (1m)
        </span>
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #ff00ff; border-radius: 2px;"></span>
          USGS 1/3" (10m)
        </span>
      </div>
    </div>

    <div style="margin-top: 8px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
      <input type="checkbox" id="ctrl-outlines" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
      <label for="ctrl-outlines" style="font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">SHOW TMS OUTLINES & LABELS</label>
    </div>

    <div id="container-label-size" style="margin-top: 6px; margin-bottom: 8px; display: none;">
      <div style="display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; margin-bottom: 2px; margin-left: 22px;">
        <span>LABEL SIZE</span>
        <span id="val-label-size">1.0x</span>
      </div>
      <input type="range" id="ctrl-label-size" min="0.5" max="3.0" step="0.1" value="1.0" style="width: calc(100% - 22px); margin-left: 22px; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 4px; display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" id="ctrl-dem-colors" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
        <label for="ctrl-dem-colors" style="font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">SHOW DEM COLORS</label>
      </div>
      <div style="display: flex; gap: 12px; font-size: 9px; color: #94a3b8; margin-left: 22px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #00cccc; border-radius: 2px;"></span>
          S1M (1m)
        </span>
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #cc00cc; border-radius: 2px;"></span>
          USGS 1/3" (10m)
        </span>
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #666666; border-radius: 2px;"></span>
          Far-field
        </span>
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="display: inline-block; width: 8px; height: 8px; background: #ccb300; border-radius: 2px;"></span>
          Flat
        </span>
      </div>
    </div>
  </div>

  <div style="margin-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px; font-size: 11px; color: #94a3b8; line-height: 1.4;">
    Controls:<br>
    • [W / S] Fly Forward / Backward<br>
    • [A / D] Strafe Left / Right<br>
    • [Q / E] Fly Down / Up<br>
    • [Shift] Boost Speed<br>
    • Drag mouse outside HUD to look
  </div>
`;
appDiv.appendChild(hud);

const hudPos = document.getElementById("hud-pos")!;
const hudAlt = document.getElementById("hud-alt")!;
const hudSpeed = document.getElementById("hud-speed")!;
const hudTiles = document.getElementById("hud-tiles")!;
const hudCache = document.getElementById("hud-cache")!;

const ctrlPreset = document.getElementById("ctrl-preset") as HTMLSelectElement;
const ctrlImagerySource = document.getElementById("ctrl-imagery-source") as HTMLSelectElement;
const ctrlHillshade = document.getElementById("ctrl-hillshade") as HTMLInputElement;
const ctrlAzimuth = document.getElementById("ctrl-azimuth") as HTMLInputElement;
const ctrlAltitude = document.getElementById("ctrl-altitude") as HTMLInputElement;
const ctrlFog = document.getElementById("ctrl-fog") as HTMLInputElement;
const ctrlExaggeration = document.getElementById("ctrl-exaggeration") as HTMLInputElement;
const ctrlExtImagery = document.getElementById("ctrl-extimagery") as HTMLInputElement;
const ctrlUsgsMin = document.getElementById("ctrl-usgs-min") as HTMLInputElement;
const ctrlS1mMin = document.getElementById("ctrl-s1m-min") as HTMLInputElement;
const sliderTrack = document.getElementById("slider-track")!;
const ctrlFootprints = document.getElementById("ctrl-footprints") as HTMLInputElement;
const ctrlSpeedCtrl = document.getElementById("ctrl-speed-ctrl") as HTMLInputElement;
const ctrlOutlines = document.getElementById("ctrl-outlines") as HTMLInputElement;
const ctrlDemColors = document.getElementById("ctrl-dem-colors") as HTMLInputElement;
const containerLabelSize = document.getElementById("container-label-size") as HTMLDivElement;
const ctrlLabelSize = document.getElementById("ctrl-label-size") as HTMLInputElement;
const ctrlBrightness = document.getElementById("ctrl-brightness") as HTMLInputElement;
const ctrlContrast = document.getElementById("ctrl-contrast") as HTMLInputElement;
const ctrlSaturation = document.getElementById("ctrl-saturation") as HTMLInputElement;

const valHillshade = document.getElementById("val-hillshade")!;
const valAzimuth = document.getElementById("val-azimuth")!;
const valAltitude = document.getElementById("val-altitude")!;
const valFog = document.getElementById("val-fog")!;
const valExaggeration = document.getElementById("val-exaggeration")!;
const valExtImagery = document.getElementById("val-extimagery")!;
const valMapzenMax = document.getElementById("val-mapzen-max")!;
const valUsgsMin = document.getElementById("val-usgs-min")!;
const valUsgsMax = document.getElementById("val-usgs-max")!;
const valS1mMin = document.getElementById("val-s1m-min")!;
const valSpeedCtrl = document.getElementById("val-speed-ctrl")!;
const valLabelSize = document.getElementById("val-label-size")!;
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
    fogDensity: 0.00006,
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
  
  scene.background = new THREE.Color(mood.skyColor);
  if (scene.fog && scene.fog instanceof THREE.FogExp2) {
    scene.fog.color = new THREE.Color(mood.fogColor);
    scene.fog.density = mood.fogDensity;
  }
}

// Hook up event listeners for inputs
ctrlHillshade.addEventListener("input", () => {
  const val = parseFloat(ctrlHillshade.value);
  valHillshade.textContent = val.toFixed(2);
  tileManager.globalUniforms.hillshadeIntensity.value = val;
  ctrlPreset.value = "custom";
});

ctrlBrightness.addEventListener("input", () => {
  const val = parseFloat(ctrlBrightness.value);
  valBrightness.textContent = val.toFixed(2);
  tileManager.globalUniforms.brightness.value = val;
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
  if (scene.fog && scene.fog instanceof THREE.FogExp2) {
    scene.fog.density = fogD;
  }
  ctrlPreset.value = "custom";
});

ctrlExaggeration.addEventListener("input", () => {
  const val = parseFloat(ctrlExaggeration.value);
  valExaggeration.textContent = `${val.toFixed(1)}x`;
  tileManager.setVerticalExaggeration(val);
});

ctrlFootprints.addEventListener("change", () => {
  tileManager.setShowFootprints(ctrlFootprints.checked);
});

ctrlExtImagery.addEventListener("input", () => {
  const z = parseInt(ctrlExtImagery.value);
  valExtImagery.textContent = z.toString();
  tileManager.setExternalImageryMaxZoom(z);
});

function updateTerrainBands() {
  const u = parseInt(ctrlUsgsMin.value);
  const s = parseInt(ctrlS1mMin.value);

  valMapzenMax.textContent = (u - 1).toString();
  valUsgsMin.textContent = u.toString();
  valUsgsMax.textContent = (s - 1).toString();
  valS1mMin.textContent = s.toString();

  const pctU = ((u - 1) / 19) * 100;
  const pctS = ((s - 1) / 19) * 100;
  sliderTrack.style.background = `linear-gradient(to right, #64748b 0%, #64748b ${pctU}%, #ff00ff ${pctU}%, #ff00ff ${pctS}%, #00ffff ${pctS}%, #00ffff 100%)`;

  tileManager.setUsgsMinZoom(u);
  tileManager.setS1mMinZoom(s);
}

ctrlUsgsMin.addEventListener("input", () => {
  const usgsVal = parseInt(ctrlUsgsMin.value);
  const s1mVal = parseInt(ctrlS1mMin.value);
  if (usgsVal >= s1mVal) {
    ctrlUsgsMin.value = (s1mVal - 1).toString();
  }
  updateTerrainBands();
});

ctrlS1mMin.addEventListener("input", () => {
  const usgsVal = parseInt(ctrlUsgsMin.value);
  const s1mVal = parseInt(ctrlS1mMin.value);
  if (s1mVal <= usgsVal) {
    ctrlS1mMin.value = (usgsVal + 1).toString();
  }
  updateTerrainBands();
});

// Initialize slider bands & TileManager
updateTerrainBands();

ctrlSpeedCtrl.addEventListener("input", () => {
  baseSpeedKnots = parseInt(ctrlSpeedCtrl.value);
  valSpeedCtrl.textContent = `${baseSpeedKnots} kt`;
});

ctrlOutlines.addEventListener("change", () => {
  const isChecked = ctrlOutlines.checked;
  tileManager.setShowOutlines(isChecked);
  tileManager.setShowLabels(isChecked);
  containerLabelSize.style.display = isChecked ? "block" : "none";
});

ctrlLabelSize.addEventListener("input", () => {
  const scale = parseFloat(ctrlLabelSize.value);
  valLabelSize.textContent = `${scale.toFixed(1)}x`;
  tileManager.setLabelScale(scale);
});

ctrlDemColors.addEventListener("change", () => {
  tileManager.setShowDemColors(ctrlDemColors.checked);
});

ctrlImagerySource.addEventListener("change", () => {
  const source = ctrlImagerySource.value as "satellite" | "osm";
  tileManager.setImagerySource(source);
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
let baseSpeedKnots = 200; // Customizable flight speed setting in knots
let speedKnots = 200; // Default active airspeed simulation

// Track keyboard state
window.addEventListener("keydown", (e) => activeKeys.add(e.code));
window.addEventListener("keyup", (e) => activeKeys.delete(e.code));

// Prevent standard context menu when clicking on the 3D scene (outside HUD)
window.addEventListener("contextmenu", (e) => {
  if (!hud.contains(e.target as Node)) {
    e.preventDefault();
  }
});

// Mouse rotation and panning controls
window.addEventListener("mousedown", (e) => {
  if (hud.contains(e.target as Node)) {
    isInteractingWithHud = true;
    return; // Don't drag camera when interacting with HUD!
  }
  isInteractingWithHud = false;
  previousMousePosition = { x: e.clientX, y: e.clientY };
});

window.addEventListener("mousemove", (e) => {
  if (isInteractingWithHud || e.buttons === 0) return;

  const deltaX = e.clientX - previousMousePosition.x;
  const deltaY = e.clientY - previousMousePosition.y;

  if (e.ctrlKey || e.buttons === 3) {
    // Ctrl key held OR both left and right buttons: change heading (yaw) only
    const euler = new THREE.Euler(0, 0, 0, "ZXY");
    euler.setFromQuaternion(camera.quaternion);
    euler.z -= deltaX * 0.003; // yaw (heading)
    euler.y = 0; // force roll to 0
    camera.quaternion.setFromEuler(euler);
  } else if (e.buttons === 1) {
    // Left button: rotate yaw (heading) and pitch
    const euler = new THREE.Euler(0, 0, 0, "ZXY");
    euler.setFromQuaternion(camera.quaternion);

    euler.z -= deltaX * 0.003; // yaw (heading)
    euler.x -= deltaY * 0.003; // pitch
    euler.y = 0; // force roll to 0

    // Limit pitch to avoid flipping upside down (-85 to 85 degrees)
    const maxPitch = Math.PI / 2 - 0.05;
    euler.x = Math.max(-maxPitch, Math.min(maxPitch, euler.x));

    camera.quaternion.setFromEuler(euler);
  } else if (e.buttons === 2) {
    // Right button: pan camera
    const panScale = Math.max(10, camera.position.z) * 0.0015;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    // Translate position along camera local axes
    camera.position.addScaledVector(right, -deltaX * panScale);
    camera.position.addScaledVector(up, deltaY * panScale);
  }

  previousMousePosition = { x: e.clientX, y: e.clientY };
});

window.addEventListener("mouseup", () => {
  isInteractingWithHud = false;
});

// Dynamic mouse wheel zoom (dolly) along the camera's viewing axis
window.addEventListener("wheel", (e) => {
  if (hud.contains(e.target as Node)) {
    return; // Do not zoom when scrolling inside the HUD panel
  }
  e.preventDefault(); // Prevent page scrolling

  // Proportional zoom speed based on current height to keep interaction fluid at all scales
  const zoomScale = Math.max(50, camera.position.z) * 0.12;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const direction = e.deltaY > 0 ? -1 : 1;

  camera.position.addScaledVector(forward, direction * zoomScale);
}, { passive: false });

// Mouse double click to center view and zoom in by 2x at the clicked terrain point
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener("dblclick", (e) => {
  if (hud.contains(e.target as Node)) {
    return; // Ignore double clicks inside the HUD controls
  }

  // Calculate mouse position in normalized device coordinates (-1 to +1)
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Intersect with active terrain mesh objects in the scene
  const intersects = raycaster.intersectObjects(scene.children, true)
    .filter(hit => hit.object.type === "Mesh");

  if (intersects.length > 0) {
    const firstHit = intersects[0];
    if (firstHit) {
      const point = firstHit.point;

      // Zoom in by 2x (halve the distance between camera and target point)
      const offset = new THREE.Vector3().subVectors(camera.position, point);
      offset.multiplyScalar(0.5);
      const newPosition = new THREE.Vector3().addVectors(point, offset);

      // Smoothly relocate camera and center gaze on the clicked point
      camera.position.copy(newPosition);
      camera.lookAt(point);
    }
  }
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

  // Convert knots setting to Mercator meters per second (1 knot = 0.514444 m/s)
  const baseSpeed = baseSpeedKnots * 0.514444;
  const speedMultiplier = activeKeys.has("ShiftLeft") || activeKeys.has("ShiftRight") ? 4 : 1;
  // Scale speed dynamically as a function of altitude (with a floor of 1.0 at 1500m)
  const altitudeFactor = Math.max(1.0, camera.position.z / 1500.0);
  const speed = baseSpeed * speedMultiplier * altitudeFactor;
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
  tileManager.update(camera.position, camera);

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

