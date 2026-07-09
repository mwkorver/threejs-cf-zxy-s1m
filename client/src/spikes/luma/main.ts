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
  uniform Transform { mat4 uMVP; } transform;
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = transform.uMVP * vec4(position, 1.0); }
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
  // Must give the canvas a real CSS layout size: luma's CanvasContext sizes
  // the drawing buffer from clientWidth*dpr, and with no CSS it falls back to
  // the 16384 max -> a 268MP framebuffer (black + GPU-fill-bound).
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  document.body.appendChild(canvas);

  const device = await luma.createDevice({
    type: "webgl",
    adapters: [webgl2Adapter],
    createCanvasContext: { canvas },
  });

  const block = await loadBlock();
  console.log("[spike] ", block.label);

  // One shared uniform buffer for the per-frame MVP, written once per frame.
  // Per-tile world placement is baked into the vertices on the CPU so every
  // tile shares one model space (model = identity). This both matches how a
  // real renderer batches and avoids a UBO write->draw stall on every tile.
  const ubo = device.createBuffer({ usage: Buffer.UNIFORM | Buffer.COPY_DST, byteLength: 64 });

  const models = block.tiles.map((t) => {
    const src = t.mesh.positions;
    const world = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      world[i] = src[i]! + t.offset[0];
      world[i + 1] = src[i + 1]! + t.offset[1];
      world[i + 2] = src[i + 2]! * VERTICAL_EXAGGERATION;
    }
    const geometry = new Geometry({
      topology: "triangle-list",
      indices: t.mesh.indices,
      attributes: {
        position: { value: world, size: 3 },
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
    return new Model(device, {
      vs,
      fs,
      geometry,
      bindings: { uTex: texture, Transform: ubo },
      parameters: { depthWriteEnabled: true, depthCompare: "less-equal" },
    });
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
    mvp.copy(proj).multiplyRight(view); // model baked into vertices

    const c0 = performance.now();
    ubo.write(new Float32Array(mvp)); // once per frame
    const rp = device.beginRenderPass({ clearColor: [0.05, 0.075, 0.1, 1], clearDepth: 1 });
    for (const model of models) model.draw(rp);
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
