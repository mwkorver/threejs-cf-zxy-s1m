import * as THREE from "three";
import "./hud.css";
import { type TileManager } from "../core/tileManager";

export const BRIGHTNESS_BY_SOURCE = { satellite: 1.5, osm: 1.0 } as const;

export interface MoodPreset {
  hillshade: number;
  azimuth: number;
  altitude: number;
  fogDensity: number;
  skyColor: number;
  fogColor: number;
}

export const PRESETS: Record<string, MoodPreset> = {
  midday: {
    hillshade: 0.25,
    azimuth: 225,
    altitude: 55,
    fogDensity: 0.0,
    skyColor: 0xa3c2f0,
    fogColor: 0xdce8f7,
  },
  golden: {
    hillshade: 0.50,
    azimuth: 240,
    altitude: 15,
    fogDensity: 0.00010,
    skyColor: 0xfca5a5,
    fogColor: 0xfef3c7,
  },
  overcast: {
    hillshade: 0.05,
    azimuth: 180,
    altitude: 90,
    fogDensity: 0.00014,
    skyColor: 0xcbd5e1,
    fogColor: 0xe2e8f0,
  },
  unlit: {
    hillshade: 0.00,
    azimuth: 225,
    altitude: 55,
    fogDensity: 0.00004,
    skyColor: 0xa5f3fc,
    fogColor: 0xe0f2fe,
  },
};

export interface HudStats {
  fps: number;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  speedKnots: number;
  activeTiles: number;
  maxActiveTiles: number;
  bytesUsed: number;
  cacheBudget: number;
  prefetchNow: number;
  prefetchTotal: number;
  texCreated: number;
  texReused: number;
  /** Visible tiles still chasing imagery an upstream will not serve. */
  imageryRetrying: number;
  /** Visible tiles that spent their retries and are drawing untextured. */
  imageryGaveUp: number;
}

export interface HudContext {
  hud: HTMLDivElement;
  compass: HTMLDivElement;
  compassRose: HTMLDivElement;
  ctrlPanorama: HTMLInputElement;
  ctrlOrbitSpeed: HTMLInputElement;
  ctrlFollowDem: HTMLInputElement;
  ctrlAglAlt: HTMLInputElement;
  ctrlSpeedCtrl: HTMLInputElement;
  ctrlInertia: HTMLInputElement;
  ctrlClearance: HTMLInputElement;
  ctrlSpaceAlt: HTMLInputElement;
  valAglAlt: HTMLElement;
  updateHUD: (stats: HudStats) => void;
  updateCompass: (bearingDeg: number) => void;
  setAglTarget: (metres: number) => void;
  getBaseSpeedKnots: () => number;
}

const slider = (id: string, label: string, attrs: string, value: string) => `
  <div class="hud-group">
    <div class="hud-label"><span>${label}</span><span id="val-${id}">${value}</span></div>
    <input type="range" class="hud-slider" id="ctrl-${id}" ${attrs}>
  </div>`;

const toggle = (input: string, caption: string) =>
  `<label class="hud-toggle">${input} ${caption}</label>`;

const key = (mark: string, caption: string) =>
  `<span class="hud-legend-item">${mark} ${caption}</span>`;

const swatch = (color: string) => `<span class="hud-swatch" style="background:${color}"></span>`;

const section = (title: string, body: string, open = false) => `
  <details class="hud-details"${open ? " open" : ""}>
    <summary class="hud-summary">${title}</summary>
    ${body}
  </details>`;

export function setupHUD(
  appDiv: HTMLDivElement,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  tileManager: TileManager,
  cacheBudget: number,
  groundSkyColor: THREE.Color,
  setBaseFogDensity: (density: number) => void,
  onResetHeadingToNorth: () => void,
  onCancelFlyTo: () => void
): HudContext {
  const hud = document.createElement("div");
  hud.id = "hud";
  hud.className = "hud";

  hud.innerHTML = `
    <div class="hud-title">✈️ FLIGHT SIM DEMO</div>
    <div class="hud-readout">FPS: <span id="hud-fps">60</span></div>
    <div class="hud-readout">LAT/LON: <span id="hud-pos">- / -</span></div>
    <div class="hud-readout">ALTITUDE: <span id="hud-alt">0</span> m &nbsp;&middot;&nbsp; HEADING: <span id="hud-heading">000&deg;</span></div>
    <div class="hud-readout">SPEED: <span id="hud-speed">0</span> kt</div>

    ${slider("speed-ctrl", "FLIGHT SPEED SETTING", 'min="50" max="1000" step="10" value="800"', "800 kt")}
    ${slider("inertia", "INERTIA (glide time)", 'min="0" max="2" step="0.05" value="0.35"', "0.35 s")}
    ${slider("clearance", "MIN GROUND CLEARANCE", 'min="0" max="500" step="10" value="50"', "50 m")}

    <div class="hud-group">
      ${toggle('<input type="checkbox" class="hud-check" id="ctrl-panorama">', "PANORAMA (360° auto-rotate)")}
    </div>
    <div id="container-orbit-speed" style="display: none;">
      ${slider("orbit-speed", "ROTATION SPEED", 'min="1" max="30" step="1" value="6"', "6 °/s")}
    </div>

    <div class="hud-group">
      ${toggle('<input type="checkbox" class="hud-check" id="ctrl-follow-dem">', "FOLLOW TERRAIN (AGL hold)")}
    </div>
    <div id="container-agl-alt" style="display: none;">
      ${slider("agl-alt", "AGL ALTITUDE", 'min="50" max="5000" step="50" value="1500"', "1500 m")}
    </div>

    <div class="hud-section">ACTIVE TILES: <span id="hud-tiles">0</span></div>
    <div>GPU CACHE: <span id="hud-cache">0.00</span> / ${Math.round(cacheBudget / (1024 * 1024))} MB</div>
    <div>PREFETCH: <span id="hud-prefetch">0 now / 0 total</span></div>
    <div>TEX POOL: <span id="hud-texpool">0 new / 0 reused</span></div>
    <div>IMAGERY: <span id="hud-imagery">OK</span></div>

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
          ${key('<span class="hud-key" style="color:#ffd400">U</span>', "USGS server")}
          ${key('<span class="hud-key" style="color:#00e5ff">N</span>', "NAIP COG (DuckDB)")}
          ${key('<span class="hud-key" style="color:#4ade80">&bull;</span>', "baked on demand")}
          ${key('<span class="hud-key" style="color:#94a3b8">&bull;</span>', "served from CDN cache")}
        </div>
      </div>

      <div class="hud-group">
        ${toggle('<input type="checkbox" class="hud-check" id="ctrl-buildings" checked>', "SHOW 3D BUILDINGS (z &ge; 14)")}
        <div class="hud-range-row" id="container-wall-opacity">
          <label class="hud-label"><span>WALL OPACITY</span></label>
          <input type="range" class="hud-range" id="ctrl-wall-opacity" min="0" max="1" step="0.05" value="0.85">
          <span class="hud-val" id="val-wall-opacity">85%</span>
        </div>
      </div>

      <div class="hud-group">
        <div class="hud-label"><span>SHADING MODE</span></div>
        ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="0" checked>', "Satellite / Imagery")}
        ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="1">', "DEM Shading (DEM Colors)")}
        ${toggle('<input type="radio" class="hud-radio" name="ctrl-shading-mode" value="2">', "Hypsometric Tinting")}
      </div>

      <div class="hud-legend" id="container-dem-legend" style="display: none;">
        ${key(swatch("#00cccc"), "S1M (1m)")}
        ${key(swatch("#cc00cc"), 'USGS 1/3" (10m)')}
        ${key(swatch("#666666"), "Far-field")}
        ${key(swatch("#ccb300"), "Flat")}
      </div>

      <div class="hud-sub" id="container-hypsometric" style="display: none;">
        <div class="hud-row">
          ${toggle('<input type="radio" class="hud-radio" name="ctrl-hyp-bounds" value="global">', "Global")}
          ${toggle('<input type="radio" class="hud-radio" name="ctrl-hyp-bounds" value="local" checked>', "Local to Viewport")}
        </div>
        ${slider("hypblend", "TINT BLEND", 'min="0" max="1" step="0.05" value="0.5"', "50%")}
      </div>

      ${slider("extimagery", "USGS SERVER MAX ZOOM (else COG Tiler)", 'min="0" max="18" step="1" value="13"', "13")}
      ${slider("exaggeration", "VERTICAL EXAGGERATION", 'min="1" max="10" step="0.5" value="1.5"', "1.5x")}
    `)}

    ${section("IMAGERY &amp; LIGHTING", `
      <div class="hud-group">
        <label class="hud-label" for="ctrl-imagery-source">IMAGERY SOURCE</label>
        <select class="hud-select" id="ctrl-imagery-source">
          <option value="satellite">NAIP Aerial (USGS)</option>
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

  compass.addEventListener("mousedown", (e) => e.stopPropagation());
  compass.addEventListener("click", () => {
    onResetHeadingToNorth();
  });

  const hudFps = document.getElementById("hud-fps")!;
  const hudPos = document.getElementById("hud-pos")!;
  const hudAlt = document.getElementById("hud-alt")!;
  const hudHeading = document.getElementById("hud-heading")!;
  const hudSpeed = document.getElementById("hud-speed")!;
  const hudTiles = document.getElementById("hud-tiles")!;
  const hudCache = document.getElementById("hud-cache")!;
  const hudPrefetch = document.getElementById("hud-prefetch")!;
  const hudTexPool = document.getElementById("hud-texpool")!;
  const hudImagery = document.getElementById("hud-imagery")!;

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
  const ctrlBuildings = document.getElementById("ctrl-buildings") as HTMLInputElement;
  const ctrlWallOpacity = document.getElementById("ctrl-wall-opacity") as HTMLInputElement;
  const valWallOpacity = document.getElementById("val-wall-opacity")!;
  const ctrlShadingModes = document.getElementsByName("ctrl-shading-mode") as NodeListOf<HTMLInputElement>;
  const containerDemLegend = document.getElementById("container-dem-legend") as HTMLDivElement;
  const containerHypsometric = document.getElementById("container-hypsometric") as HTMLDivElement;
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

  let baseSpeedKnots = 800;

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

    groundSkyColor.set(mood.skyColor);
    setBaseFogDensity(mood.fogDensity);
    if (scene.fog && scene.fog instanceof THREE.FogExp2) {
      scene.fog.color = new THREE.Color(mood.fogColor);
    }
  }

  ctrlHillshade.addEventListener("input", () => {
    const val = parseFloat(ctrlHillshade.value);
    valHillshade.textContent = val.toFixed(2);
    tileManager.globalUniforms.hillshadeIntensity.value = val;
    ctrlPreset.value = "custom";
  });

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
    setBaseFogDensity(fogD);
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

  ctrlPanorama.addEventListener("change", () => {
    if (ctrlPanorama.checked) {
      onCancelFlyTo();
    }
    containerOrbitSpeed.style.display = ctrlPanorama.checked ? "block" : "none";
  });

  ctrlFollowDem.addEventListener("change", () => {
    containerAglAlt.style.display = ctrlFollowDem.checked ? "block" : "none";
  });

  ctrlOutlines.addEventListener("change", () => {
    const isChecked = ctrlOutlines.checked;
    tileManager.setShowOutlines(isChecked);
    tileManager.setShowTileLabels(isChecked);
  });

  ctrlBuildings.addEventListener("change", () => {
    tileManager.showBuildings = ctrlBuildings.checked;
    tileManager.updateBuildingVisibility();
  });

  ctrlWallOpacity.addEventListener("input", () => {
    const opacity = parseFloat(ctrlWallOpacity.value);
    valWallOpacity.textContent = `${Math.round(opacity * 100)}%`;
    tileManager.setBuildingWallOpacity(opacity);
  });

  ctrlShadingModes.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        const mode = parseFloat(radio.value);
        tileManager.setShadingMode(mode);
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
    const keyStr = ctrlPreset.value;
    if (keyStr in PRESETS) {
      applyPreset(PRESETS[keyStr as keyof typeof PRESETS]!);
    }
  });

  applyPreset(PRESETS.midday!);

  function setAglTarget(metres: number): void {
    const min = parseFloat(ctrlAglAlt.min);
    const max = parseFloat(ctrlAglAlt.max);
    const clamped = Math.round(THREE.MathUtils.clamp(metres, min, max));
    ctrlAglAlt.value = String(clamped);
    valAglAlt.textContent = `${clamped} m`;
  }

  function updateHUD(stats: HudStats): void {
    hudFps.textContent = stats.fps.toString();
    hudPos.textContent = `${stats.lat.toFixed(5)} / ${stats.lon.toFixed(5)}`;
    hudAlt.textContent = Math.round(stats.altitude).toString();
    hudSpeed.textContent = stats.speedKnots.toString();
    hudTiles.textContent = `${stats.activeTiles} / ${stats.maxActiveTiles}`;
    hudCache.textContent = (stats.bytesUsed / (1024 * 1024)).toFixed(2);
    hudPrefetch.textContent = `${stats.prefetchNow} now / ${stats.prefetchTotal} total`;
    hudTexPool.textContent = `${stats.texCreated} new / ${stats.texReused} reused`;

    // The state the ground is already showing, named. Flat green terrain is
    // what an imagery upstream failing looks like, and it is indistinguishable
    // from terrain that simply has no imagery unless something says so.
    // Retrying resolves itself; given up will not until those tiles reload.
    if (stats.imageryGaveUp > 0) {
      hudImagery.textContent = `${stats.imageryGaveUp} tiles unavailable (upstream)`;
      hudImagery.style.color = "#f87171";
    } else if (stats.imageryRetrying > 0) {
      hudImagery.textContent = `retrying ${stats.imageryRetrying}...`;
      hudImagery.style.color = "#fbbf24";
    } else {
      hudImagery.textContent = "OK";
      hudImagery.style.color = "";
    }
  }

  function updateCompass(bearingDeg: number): void {
    const headingDeg = Math.round((bearingDeg + 360) % 360);
    hudHeading.textContent = `${headingDeg.toString().padStart(3, "0")}°`;
    compassRose.style.transform = `rotate(${-bearingDeg}deg)`;
  }

  return {
    hud,
    compass,
    compassRose,
    ctrlPanorama,
    ctrlOrbitSpeed,
    ctrlFollowDem,
    ctrlAglAlt,
    ctrlSpeedCtrl,
    ctrlInertia,
    ctrlClearance,
    ctrlSpaceAlt,
    valAglAlt,
    updateHUD,
    updateCompass,
    setAglTarget,
    getBaseSpeedKnots: () => baseSpeedKnots,
  };
}
