/**
 * Engine spike: bare luma.gl v9 (plan §10.2), same baked meshes + harness.
 *
 * Lowest level of the three: we own the device, buffers, shader, matrices, and
 * draw loop. Most code, most control, clearest path to WebGPU later. Camera is
 * driven directly from flightPose (eye/target), same as three.
 */

import { Buffer, luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import { Model, Geometry } from "@luma.gl/engine";
import { Matrix4 } from "@math.gl/core";
import { loadBlock, VERTICAL_EXAGGERATION } from "../shared/loadBlock";
import { flightPose } from "../shared/flightPath";
import { Bench, mountHud } from "../shared/perf";

const vs = `#version 300 es
  in vec3 position;
  in vec2 uv;
  uniform Transform { mat4 uMVP; };
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = uMVP * vec4(position, 1.0); }
`;

const fs = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;
  uniform sampler2D uTex;
  void main() { fragColor = vec4(texture(uTex, vUv).rgb, 1.0); }
`;

async function main() {
  const canvas = document.createElement("canvas");
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.body.appendChild(canvas);

  const device = await luma.createDevice({
    type: "webgl",
    adapters: [webgl2Adapter],
    createCanvasContext: { canvas },
  });

  const block = await loadBlock();

  const models = block.tiles.map((t) => {
    const geometry = new Geometry({
      topology: "triangle-list",
      indices: t.mesh.indices,
      attributes: {
        position: { value: t.mesh.positions, size: 3 },
        uv: { value: t.mesh.uvs, size: 2 },
      },
    });
    const texture = t.imagery
      ? device.createTexture({
          width: t.imagery.width,
          height: t.imagery.height,
          data: t.imagery,
          sampler: { minFilter: "linear", magFilter: "linear" },
        })
      : device.createTexture({ data: new Uint8Array([90, 100, 90, 255]), width: 1, height: 1 });
    const ubo = device.createBuffer({ usage: Buffer.UNIFORM | Buffer.COPY_DST, byteLength: 64 });
    const model = new Model(device, {
      vs,
      fs,
      geometry,
      bindings: { uTex: texture, Transform: ubo },
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
    });
    const model4 = new Matrix4().translate([t.offset[0], t.offset[1], 0]).scale([1, 1, VERTICAL_EXAGGERATION]);
    return { model, model4, ubo };
  });

  const proj = new Matrix4();
  const view = new Matrix4();
  const mvp = new Matrix4();
  const hud = mountHud();
  const bench = new Bench("luma.gl", hud);
  let last = performance.now();
  const t0 = last;

  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now();
    const interval = now - last;
    last = now;

    const t = ((now - t0) / 20000) % 1;
    const pose = flightPose(t, block.path);
    proj.perspective({ fovy: (65 * Math.PI) / 180, aspect: canvas.width / canvas.height, near: 1, far: 60000 });
    view.lookAt({ eye: pose.eye, center: pose.target, up: [0, 0, 1] });

    const c0 = performance.now();
    const rp = device.beginRenderPass({ clearColor: [0.05, 0.075, 0.1, 1], clearDepth: 1 });
    for (const { model, model4, ubo } of models) {
      mvp.copy(proj).multiplyRight(view).multiplyRight(model4);
      ubo.write(new Float32Array(mvp));
      model.draw(rp);
    }
    rp.end();
    const cpu = performance.now() - c0;
    bench.sample(cpu, interval, now);
  }
  loop();
}

main().catch((e) => {
  mountHud().textContent = `error: ${e.message}`;
  console.error(e);
});
