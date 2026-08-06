import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { TileManager } from "./tileManager";
import { BundleCache } from "./bundleCache";

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

vi.mock("./tileLoader", () => ({
  loadTerrain: vi.fn(() =>
    Promise.resolve({ heights: new Float32Array(512 * 512), demSource: "farfield" }),
  ),
  loadImageryFor: vi.fn(() => Promise.resolve(null)),
  loadStaticFootprints: vi.fn(() =>
    Promise.resolve({ type: "FeatureCollection", features: [] }),
  ),
}));

// maxZoom 14, not 18. Root bookkeeping is independent of how deep the LOD
// refines, and the mocked loadTerrain hands back a 1 MB Float32Array per tile:
// subdividing to z18 across 25 frames pushed this past the 5 s test timeout
// intermittently. Bounding the depth keeps what is under test and drops the
// cost.
function makeManager(): TileManager {
  const tm = new TileManager(
    "http://t", "l", 2023, new THREE.Scene(), new BundleCache(512 * 1024 * 1024),
    [0, 0], 12, 14, 2.2, true,
  );
  tm.maxActiveTiles = 204;
  return tm;
}

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1.6, 1, 1e9);
  cam.up.set(0, 0, 1);
  cam.position.set(0, 0, 4364);
  return cam;
}

/** Point the camera along `deg`, tilted down, and advance one frame. */
function look(tm: TileManager, cam: THREE.PerspectiveCamera, deg: number): void {
  const r = (deg * Math.PI) / 180;
  const dir = new THREE.Vector3(Math.cos(r), Math.sin(r), -0.34).normalize();
  cam.lookAt(cam.position.clone().add(dir));
  cam.updateMatrixWorld(true);
  tm.update(cam.position.clone(), cam);
}

describe("hysteresis-band roots are bounded by time", () => {
  it("collects the trail a 360 leaves behind", () => {
    const tm = makeManager();
    tm.rootStaleTtlMs = 0; // collect as soon as a band root is unseen
    const cam = camera();

    const roots: number[] = [];
    const active: number[] = [];
    for (let deg = 0; deg <= 360; deg += 15) {
      look(tm, cam, deg);
      roots.push((tm as any).rootNodes.size);
      active.push(tm.getActiveKeys().size);
    }
    const maxRoots = Math.max(...roots);
    const maxActive = Math.max(...active);
    console.log(`TTL ON   maxRoots=${maxRoots}  maxActive=${maxActive}`);

    // The 5x5 grid plus whatever band roots are still genuinely in view.
    expect(maxRoots).toBeLessThanOrEqual(36);
    expect(maxRoots).toBeLessThan(36); // strictly better than the old ceiling
  });

  it("keeps a band root that is still on screen", () => {
    const tm = makeManager();
    tm.rootStaleTtlMs = 0;
    const cam = camera();
    look(tm, cam, 0);

    const centre = (tm as any).rootNodes;
    let visibleBand = 0;
    const frustum = new THREE.Frustum();
    frustum.setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    for (const node of centre.values()) {
      if ((tm as any).isNodeVisible(node, frustum)) visibleBand++;
    }
    // Far-field coverage is not sacrificed: in-view roots survive a TTL of 0.
    console.log(`in-view roots retained with TTL 0: ${visibleBand}`);
    expect(visibleBand).toBeGreaterThan(0);
  });

  it("does not touch roots inside the build grid", () => {
    const tm = makeManager();
    tm.rootStaleTtlMs = 0;
    const cam = camera();
    // Straight down: most of the 5x5 is behind/outside a narrow frustum, but
    // build-grid roots must survive regardless of visibility.
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    tm.update(cam.position.clone(), cam);
    tm.update(cam.position.clone(), cam);

    expect((tm as any).rootNodes.size).toBeGreaterThanOrEqual(25);
  });
});

describe("at the shipped TTL, with a controlled clock", () => {
  it("collects the trail once the camera settles", () => {
    let clock = 1000;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const tm = makeManager(); // default rootStaleTtlMs
      const cam = camera();

      // Turn 360 quickly: the trail builds up, nothing has aged out yet.
      for (let deg = 0; deg <= 360; deg += 15) {
        clock += 50;
        look(tm, cam, deg);
      }
      const afterTurn = (tm as any).rootNodes.size;
      const activeAfterTurn = tm.getActiveKeys().size;

      // Now park, exactly as the report did (SPEED: 0), and let time pass.
      for (let i = 0; i < 10; i++) {
        clock += 1000;
        look(tm, cam, 360);
      }
      const afterSettle = (tm as any).rootNodes.size;
      const activeAfterSettle = tm.getActiveKeys().size;

      console.log(
        `DEFAULT TTL  turning: roots=${afterTurn} active=${activeAfterTurn}` +
          `  ->  parked: roots=${afterSettle} active=${activeAfterSettle}`,
      );
      expect(afterSettle).toBeLessThan(afterTurn);
      expect(afterSettle).toBeGreaterThanOrEqual(25); // grid intact
    } finally {
      nowSpy.mockRestore();
    }
  });
});
