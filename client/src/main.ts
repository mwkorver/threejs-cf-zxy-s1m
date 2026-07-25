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
const skyColor = new THREE.Color(0xa3c2f0);
const fogColor = new THREE.Color(0xdce8f7);
scene.background = skyColor;
scene.fog = new THREE.FogExp2(fogColor.getHex(), 0.0);

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
tileManager.prefetchLookaheadSec = PREFETCH_LOOKAHEAD;
tileManager.prefetchSamples = PREFETCH_SAMPLES;

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
      <span id="val-speed-ctrl">800 kt</span>
    </div>
    <input type="range" id="ctrl-speed-ctrl" min="50" max="1000" step="10" value="800" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
  </div>

  <div style="margin-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px; margin-bottom: 4px;">ACTIVE TILES: <span id="hud-tiles">0</span></div>
  <div>GPU CACHE: <span id="hud-cache">0.00</span> / 256 MB</div>
  <div>PREFETCH: <span id="hud-prefetch">0</span> tiles ahead</div>

  
  <div style="margin-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px;">
    <div style="font-weight: bold; color: #38bdf8; margin-bottom: 8px;">🌅 ATMOSPHERE & LIGHTING</div>
    
    <div style="margin-bottom: 8px;">
      <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">IMAGERY SOURCE</label>
      <select id="ctrl-imagery-source" style="width: 100%; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; padding: 4px; font-family: monospace; font-size: 12px; cursor: pointer; outline: none;">
        <option value="satellite">NAIP Aerial (USDA)</option>
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
        <span id="val-brightness">1.75</span>
      </div>
      <input type="range" id="ctrl-brightness" min="0.5" max="2.0" step="0.05" value="1.75" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
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
        <span id="val-fog">0.00000</span>
      </div>
      <input type="range" id="ctrl-fog" min="0" max="0.0003" step="0.00001" value="0" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>VERTICAL EXAGGERATION</span>
        <span id="val-exaggeration">2.0x</span>
      </div>
      <input type="range" id="ctrl-exaggeration" min="1" max="10" step="0.5" value="2.0" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <label style="display: flex; align-items: center; gap: 6px; font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">
        <input type="checkbox" id="ctrl-follow-dem" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
        FOLLOW TERRAIN (AGL hold)
      </label>
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-top: 4px; margin-bottom: 2px;">
        <span>AGL ALTITUDE</span>
        <span id="val-agl-alt">500 m</span>
      </div>
      <input type="range" id="ctrl-agl-alt" min="50" max="5000" step="50" value="500" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>

    <div style="margin-bottom: 8px;">
      <div style="display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; margin-bottom: 2px;">
        <span>USDA IMAGERY &le; Z (else COG tiler)</span>
        <span id="val-extimagery">13</span>
      </div>
      <input type="range" id="ctrl-extimagery" min="0" max="18" step="1" value="13" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
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

    <div style="margin-top: 8px; margin-bottom: 4px; display: flex; flex-direction: column; gap: 4px;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" id="ctrl-outlines" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
        <label for="ctrl-outlines" style="font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">SHOW TMS OUTLINES & LABELS</label>
      </div>
      <div style="display: flex; gap: 12px; font-size: 9px; color: #94a3b8; margin-left: 22px;">
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="color: #ffd400; font-weight: bold;">U</span> USDA server
        </span>
        <span style="display: flex; align-items: center; gap: 4px;">
          <span style="color: #00e5ff; font-weight: bold;">N</span> NAIP COG (DuckDB)
        </span>
      </div>
    </div>

    <div style="margin-top: 8px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 4px;">
      <span style="font-size: 10px; color: #94a3b8; margin-bottom: 2px;">SHADING MODE</span>
      
      <div style="display: flex; flex-direction: column; gap: 4px; margin-left: 2px;">
        <label style="display: flex; align-items: center; gap: 8px; font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">
          <input type="radio" name="ctrl-shading-mode" value="0" checked style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
          Satellite / Imagery
        </label>
        
        <label style="display: flex; align-items: center; gap: 8px; font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">
          <input type="radio" name="ctrl-shading-mode" value="1" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
          DEM Shading (DEM Colors)
        </label>
        
        <label style="display: flex; align-items: center; gap: 8px; font-size: 10px; color: #f8fafc; cursor: pointer; user-select: none;">
          <input type="radio" name="ctrl-shading-mode" value="2" style="cursor: pointer; width: 14px; height: 14px; accent-color: #38bdf8;">
          Hypsometric Tinting
        </label>
      </div>
    </div>

    <!-- DEM Shading Legend (visible only when DEM Shading is active) -->
    <div id="container-dem-legend" style="display: none; gap: 10px; font-size: 9px; color: #94a3b8; margin-left: 22px; margin-bottom: 6px; flex-wrap: wrap;">
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

    <!-- Hypsometric Blend slider (visible only when Hypsometric Tinting is active) -->
    <div id="container-hypsometric" style="display: none; margin-bottom: 8px; margin-left: 22px;">
      <!-- Hypsometric bounds mode (Global vs Local) -->
      <div style="display: flex; gap: 12px; margin-bottom: 6px; font-size: 9px; color: #cbd5e1;">
        <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;">
          <input type="radio" name="ctrl-hyp-bounds" value="global" style="cursor: pointer; width: 12px; height: 12px; accent-color: #38bdf8;">
          Global
        </label>
        <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none;">
          <input type="radio" name="ctrl-hyp-bounds" value="local" checked style="cursor: pointer; width: 12px; height: 12px; accent-color: #38bdf8;">
          Local to Viewport
        </label>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; margin-bottom: 2px;">
        <span>TINT BLEND</span>
        <span id="val-hypblend">50%</span>
      </div>
      <input type="range" id="ctrl-hypblend" min="0" max="1" step="0.05" value="0.5" style="width: 100%; accent-color: #38bdf8; cursor: pointer;">
    </div>
  </div>

  <div style="margin-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.15); padding-top: 10px; font-size: 11px; color: #94a3b8; line-height: 1.4;">
    Controls:<br>
    • Drag — Pan<br>
    • Right-drag — Rotate / Tilt<br>
    • Scroll — Zoom to cursor<br>
    • Double-click — Fly to point
    • [W/A/S/D] Fly · [Q/E] Up/Down · [Shift] Boost
  </div>
`;
appDiv.appendChild(hud);

// North compass (top-right): the rose rotates to show where north is relative
// to the current heading; clicking it yaws the view back to north-up.
const compass = document.createElement("div");
compass.id = "compass";
compass.title = "Face north (north-up)";
compass.style.cssText =
  "position:absolute; top:20px; right:20px; width:56px; height:56px; border-radius:50%;" +
  "background:rgba(15,23,42,0.85); border:1px solid #475569; box-shadow:0 2px 8px rgba(0,0,0,0.4);" +
  "cursor:pointer; display:flex; align-items:center; justify-content:center; user-select:none; z-index:10;";
compass.innerHTML = `
  <div id="compass-rose" style="width:100%; height:100%;">
    <svg viewBox="0 0 56 56" width="56" height="56">
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

const hudPos = document.getElementById("hud-pos")!;
const hudAlt = document.getElementById("hud-alt")!;
const hudSpeed = document.getElementById("hud-speed")!;
const hudTiles = document.getElementById("hud-tiles")!;
const hudCache = document.getElementById("hud-cache")!;
const hudPrefetch = document.getElementById("hud-prefetch")!;


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
const ctrlOutlines = document.getElementById("ctrl-outlines") as HTMLInputElement;
const ctrlShadingModes = document.getElementsByName("ctrl-shading-mode") as NodeListOf<HTMLInputElement>;
const containerDemLegend = document.getElementById("container-dem-legend") as HTMLDivElement;
const containerHypsometric = document.getElementById("container-hypsometric") as HTMLDivElement;
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
  const start = camera.position.clone();
  const dist = start.distanceTo(targetGround);
  // Duration scales with distance: ~2s for 1km, ~6s for 100km, capped.
  const duration = Math.min(8000, Math.max(2000, dist * 0.04));
  // Cruise altitude: arc above the direct path. Raise the midpoint Z so
  // the camera climbs then descends, mirroring pTolemy3D's cruise_alt.
  const cruiseAlt = Math.max(start.z, targetGround.z) + Math.min(dist * 0.15, 5000);

  // End orientation: look straight down at the target from the arrival altitude.
  const endQuat = new THREE.Quaternion();
  const lookFrom = targetGround.clone();
  lookFrom.z = targetGround.z + 500; // arrive 500m above the clicked point
  const m = new THREE.Matrix4().lookAt(lookFrom, targetGround, new THREE.Vector3(0, 0, 1));
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

  const target = pickGround(e.clientX, e.clientY);
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

  // FlyTo trajectory takes over camera position/orientation until it completes.
  // Manual input (keys/mouse) cancels it via cancelFlyTo().
  let direction: THREE.Vector3 | null = null;
  if (updateFlyTo()) {
    // Skip manual movement; still update LOD and render.
  } else {
    // Process movement input relative to camera heading
    direction = new THREE.Vector3();
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
  }

  // Follow-DEM: maintain constant above-ground clearance instead of
  // above-sea-level altitude (ported from pTolemy3D's setFollowDem). The
  // terrain Z under the camera is sampled from loaded tiles; camera Z is
  // adjusted to hold the target AGL. Skipped when no terrain is loaded
  // under the camera (e.g. over open ocean or during cold start).
  if (ctrlFollowDem.checked) {
    const gx = camera.position.x + worldAnchor[0];
    const gy = camera.position.y + worldAnchor[1];
    const groundElev = tileManager.getElevationAt(gx, gy);
    if (groundElev !== null) {
      const zScale = 1 / Math.cos((mercatorToLonLat(gx, gy)[1] * Math.PI) / 180);
      const targetZ = groundElev * zScale + parseFloat(ctrlAglAlt.value);
      // Smooth toward target (exponential smoothing) to avoid jitter when
      // tiles swap LOD and centerElevation steps. τ = 0.2s.
      camera.position.z += (targetZ - camera.position.z) * Math.min(1, dt / 0.2);
    }
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
  hudSpeed.textContent = (direction && direction.lengthSq() > 0) ? speedKnots.toString() : "0";
  hudTiles.textContent = tileManager.getActiveKeys().size.toString();
  hudCache.textContent = (bundleCache.bytesUsed() / (1024 * 1024)).toFixed(2);
  hudPrefetch.textContent = tileManager.getLastPrefetchCount().toString();


  // Rotate the compass rose so the red N points to where north is on screen.
  compassFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const bearingDeg = (Math.atan2(compassFwd.x, compassFwd.y) * 180) / Math.PI;
  compassRose.style.transform = `rotate(${-bearingDeg}deg)`;
}

// Start visual frame loop
frameLoop();

