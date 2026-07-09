/**
 * Engine spike: deck.gl (plan §10.2), same baked meshes + benchmark harness.
 *
 * Friction surfaced by the port: deck has no free eye/target camera — you feed
 * it a view *state*. OrbitView is its non-geo 3D view, so the flight is driven
 * as an orbit around the block with an elevation sweep (same conceptual path
 * and rendered load as the three/luma spikes, not a byte-identical framing).
 * Timing uses deck's own render cadence (onAfterRender) and metrics.cpuTime —
 * the honest deck numbers rather than forcing a synchronous redraw.
 */

import { COORDINATE_SYSTEM, Deck, OrbitView } from "@deck.gl/core";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { loadBlock, VERTICAL_EXAGGERATION } from "../shared/loadBlock";
import { Bench, mountHud } from "../shared/perf";

async function main() {
  const block = await loadBlock();

  const layers = block.tiles.map(
    (t, i) =>
      new SimpleMeshLayer({
        id: `tile-${i}`,
        data: [{ position: [t.offset[0], t.offset[1], 0] }],
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        mesh: {
          attributes: {
            positions: { value: t.mesh.positions, size: 3 },
            texCoords: { value: t.mesh.uvs, size: 2 },
          },
          indices: { value: t.mesh.indices, size: 1 },
        } as never,
        texture: t.imagery ?? undefined,
        getPosition: (d: { position: number[] }) => d.position as [number, number, number],
        getColor: [255, 255, 255, 255],
        getScale: [1, 1, VERTICAL_EXAGGERATION],
        material: { ambient: 0.5, diffuse: 0.6, shininess: 2, specularColor: [40, 40, 40] },
      }),
  );

  // Frame the block: zoom so ~2.5 block-widths are visible at the target plane.
  const blockW = 4 * block.tileW;
  const zoom = Math.log2(innerWidth / (2.5 * blockW));

  const hud = mountHud();
  const bench = new Bench("deck.gl", hud);

  let last = performance.now();
  const t0 = last;
  const deck = new Deck({
    views: new OrbitView({ orbitAxis: "Z", fovy: 65, near: 1, far: 60000 }),
    controller: false,
    _animate: true,
    parent: document.body as HTMLDivElement,
    initialViewState: {
      target: [block.path.centerX, block.path.centerY, 0],
      zoom,
      rotationX: 45,
      rotationOrbit: 0,
    },
    layers,
    onAfterRender: () => {
      const now = performance.now();
      const interval = now - last;
      last = now;
      const t = ((now - t0) / 20000) % 1;
      // Orbit + elevation sweep mirroring flightPose's spirit.
      deck.setProps({
        viewState: {
          target: [block.path.centerX, block.path.centerY, 0],
          zoom,
          rotationOrbit: (t * 720) % 360,
          rotationX: 20 + 60 * (0.5 - 0.5 * Math.cos(t * Math.PI * 2)),
        },
      });
      const cpu = (deck as unknown as { metrics?: { cpuTime: number } }).metrics?.cpuTime ?? 0;
      bench.sample(cpu, interval, now);
    },
  });
}

main().catch((e) => {
  mountHud().textContent = `error: ${e.message}`;
  console.error(e);
});
