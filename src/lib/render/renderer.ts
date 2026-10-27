import type { Lbm } from "../sim/lbm";
import type { TunnelSetup } from "../sim/setup";
import type { Look } from "../types";
import { viewProjection, type Orbit } from "./camera";
import {
  ADVECT_SIZE,
  ADVECT_WG,
  advectShader,
  floorShader,
  FRAME_SIZE,
  modelShader,
  outlineShader,
  sliceShader,
  trailShader,
} from "./shaders";

export const SAMPLES = 4;

export interface Theme {
  dark: boolean;
  /** background, linear-ish 0…1 */
  bg: [number, number, number];
}

interface Targets {
  width: number;
  height: number;
  color: GPUTexture;
  depth: GPUTexture;
}

interface Smoke {
  count: number;
  trail: number;
  parts: GPUBuffer;
  hist: GPUBuffer;
  advectBind: GPUBindGroup;
  trailBind: GPUBindGroup;
  lanesU: number;
  lanesV: number;
  key: string;
  reset: boolean;
}

const hex = (h: string): [number, number, number] => {
  const v = parseInt(h.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

/**
 * Draws the tunnel: floor, model (with surface pressure), a slice through the flow, smoke
 * trails and the tunnel's outline. Reads the solver's buffers directly.
 */
export class Renderer {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  private frameBuf: GPUBuffer;
  private advectBuf: GPUBuffer;
  private layoutA: GPUBindGroupLayout;
  private layoutB: GPUBindGroupLayout;
  private modelPipe: GPURenderPipeline;
  private floorPipe: GPURenderPipeline;
  private slicePipe: GPURenderPipeline;
  private trailPipe: GPURenderPipeline;
  private outlinePipe: GPURenderPipeline;
  private advectPipe: GPUComputePipeline;
  private targets = new Map<string, Targets>();
  private bindA: GPUBindGroup | null = null;
  private vbuf: GPUBuffer | null = null;
  private vcount = 0;
  private smoke: Smoke | null = null;
  private lbm: Lbm | null = null;
  private setup: TunnelSetup | null = null;
  private head = 0;
  private frameNo = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.frameBuf = device.createBuffer({ size: FRAME_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.advectBuf = device.createBuffer({ size: ADVECT_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layoutA = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: VF, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: VF, buffer: { type: "read-only-storage" } },
      ],
    });
    this.layoutB = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: VF, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: VF, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: VF, buffer: { type: "read-only-storage" } },
      ],
    });
    const plA = device.createPipelineLayout({ bindGroupLayouts: [this.layoutA] });
    const plB = device.createPipelineLayout({ bindGroupLayouts: [this.layoutB] });
    const premul: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const ms = { count: SAMPLES };
    const depth = (write: boolean): GPUDepthStencilState => ({ format: "depth24plus", depthWriteEnabled: write, depthCompare: "less-equal" });
    const mod = (code: string, label: string) => device.createShaderModule({ code, label });

    const m = mod(modelShader, "model");
    this.modelPipe = device.createRenderPipeline({
      layout: plA,
      vertex: {
        module: m,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: { module: m, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth(true),
      multisample: ms,
    });
    const f = mod(floorShader, "floor");
    this.floorPipe = device.createRenderPipeline({
      layout: plA,
      vertex: { module: f, entryPoint: "vs" },
      fragment: { module: f, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth(true),
      multisample: ms,
    });
    const s = mod(sliceShader, "slice");
    this.slicePipe = device.createRenderPipeline({
      layout: plA,
      vertex: { module: s, entryPoint: "vs" },
      fragment: { module: s, entryPoint: "fs", targets: [{ format, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth(false),
      multisample: ms,
    });
    const t = mod(trailShader, "trails");
    this.trailPipe = device.createRenderPipeline({
      layout: plB,
      vertex: { module: t, entryPoint: "vs" },
      fragment: { module: t, entryPoint: "fs", targets: [{ format, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depth(false),
      multisample: ms,
    });
    const o = mod(outlineShader, "outline");
    this.outlinePipe = device.createRenderPipeline({
      layout: plA,
      vertex: { module: o, entryPoint: "vs" },
      fragment: { module: o, entryPoint: "fs", targets: [{ format, blend: premul }] },
      primitive: { topology: "line-list" },
      depthStencil: depth(false),
      multisample: ms,
    });
    this.advectPipe = device.createComputePipeline({
      layout: "auto",
      compute: { module: mod(advectShader, "advect"), entryPoint: "main" },
    });
  }

  /** Point the renderer at a new run: its grid, buffers and the model's triangles (in cells). */
  setRun(lbm: Lbm, setup: TunnelSetup) {
    this.lbm = lbm;
    this.setup = setup;
    this.bindA = this.device.createBindGroup({
      layout: this.layoutA,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: lbm.macro } },
        { binding: 2, resource: { buffer: lbm.solid } },
      ],
    });
    this.vbuf?.destroy();
    const p = setup.mesh.positions;
    const n = setup.mesh.normals;
    const inter = new Float32Array((p.length / 3) * 6);
    for (let i = 0, j = 0; i < p.length; i += 3, j += 6) {
      inter[j] = p[i];
      inter[j + 1] = p[i + 1];
      inter[j + 2] = p[i + 2];
      inter[j + 3] = n[i];
      inter[j + 4] = n[i + 1];
      inter[j + 5] = n[i + 2];
    }
    this.vbuf = this.device.createBuffer({ size: Math.max(16, inter.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.vbuf, 0, inter);
    this.vcount = p.length / 3;
    this.destroySmoke();
  }

  private destroySmoke() {
    if (this.smoke) {
      this.smoke.parts.destroy();
      this.smoke.hist.destroy();
      this.smoke = null;
    }
  }

  /** Where the smoke comes from and how many lines, from the look settings. */
  private rake(look: Look) {
    const s = this.setup!;
    const min = s.modelMin;
    const max = s.modelMax;
    const L = max[0] - min[0];
    const W = max[1] - min[1];
    const H = max[2] - min[2];
    const cy = (min[1] + max[1]) / 2;
    const x0 = Math.max(2, min[0] - Math.max(3, 0.15 * L));
    const yAt = cy + look.rakeY * (W / 2) * 1.15;
    const floor = s.ground === "free" ? 0 : 0.6;
    if (look.rake === "vertical") {
      const zLo = Math.max(floor, min[2] - 0.08 * H);
      const zHi = max[2] + 0.25 * H;
      return { origin: [x0, yAt, (zLo + zHi) / 2], u: [0, 0, zHi - zLo], v: [0, 0, 0], lu: Math.round(Math.min(160, Math.max(24, (zHi - zLo) / 1.1))), lv: 1 };
    }
    if (look.rake === "horizontal") {
      const z = Math.max(floor, min[2] + look.rakeZ * H * 1.2);
      const span = W * 1.5;
      return { origin: [x0, cy + look.rakeY * W * 0.4, z], u: [0, span, 0], v: [0, 0, 0], lu: Math.round(Math.min(200, Math.max(24, span / 1.1))), lv: 1 };
    }
    const zLo = Math.max(floor, min[2] - 0.05 * H);
    const zHi = max[2] + 0.2 * H;
    const span = W * 1.35;
    return {
      origin: [x0, cy, (zLo + zHi) / 2],
      u: [0, span, 0],
      v: [0, 0, zHi - zLo],
      lu: Math.round(Math.min(48, Math.max(8, span / 3))),
      lv: Math.round(Math.min(32, Math.max(6, (zHi - zLo) / 3))),
    };
  }

  private ensureSmoke(look: Look) {
    const lbm = this.lbm!;
    const rk = this.rake(look);
    const lanes = rk.lu * rk.lv;
    const perLane = Math.max(1, Math.round((look.density * 1000) / lanes));
    const count = lanes * perLane;
    const trail = Math.max(4, Math.round(look.trail));
    const key = `${count}|${trail}|${lbm.n}`;
    if (this.smoke?.key === key) {
      this.smoke.lanesU = rk.lu;
      this.smoke.lanesV = rk.lv;
      return;
    }
    this.destroySmoke();
    const parts = this.device.createBuffer({ size: 16 * count, usage: GPUBufferUsage.STORAGE });
    const hist = this.device.createBuffer({ size: 16 * count * trail, usage: GPUBufferUsage.STORAGE });
    const advectBind = this.device.createBindGroup({
      layout: this.advectPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.advectBuf } },
        { binding: 1, resource: { buffer: lbm.macro } },
        { binding: 2, resource: { buffer: lbm.solid } },
        { binding: 3, resource: { buffer: parts } },
        { binding: 4, resource: { buffer: hist } },
      ],
    });
    const trailBind = this.device.createBindGroup({
      layout: this.layoutB,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: lbm.macro } },
        { binding: 2, resource: { buffer: lbm.solid } },
        { binding: 3, resource: { buffer: hist } },
      ],
    });
    this.smoke = { count, trail, parts, hist, advectBind, trailBind, lanesU: rk.lu, lanesV: rk.lv, key, reset: true };
    this.head = 0;
  }

  /** Start the smoke over at the rake (after a restart, or when the rake moves). */
  resetSmoke() {
    if (this.smoke) this.smoke.reset = true;
  }

  private targetsFor(key: string, width: number, height: number): Targets {
    const t = this.targets.get(key);
    if (t && t.width === width && t.height === height) return t;
    t?.color.destroy();
    t?.depth.destroy();
    const color = this.device.createTexture({ size: [width, height], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const depth = this.device.createTexture({ size: [width, height], sampleCount: SAMPLES, format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const n = { width, height, color, depth };
    this.targets.set(key, n);
    return n;
  }

  /**
   * Moves the smoke by `steps` solver steps (0 when paused) and draws a frame into `view`.
   * `frameScale` widens the view for the passe-partout around the video frame.
   */
  draw(opts: {
    encoder: GPUCommandEncoder;
    view: GPUTextureView;
    targetKey: string;
    width: number;
    height: number;
    orbit: Orbit;
    frameScale: number;
    look: Look;
    theme: Theme;
    steps: number;
    time: number;
    pixelRatio: number;
  }) {
    const { encoder, width, height, look, theme } = opts;
    const lbm = this.lbm;
    const setup = this.setup;
    if (!lbm || !setup || !this.bindA || lbm.destroyed) return;
    const tg = this.targetsFor(opts.targetKey, width, height);

    // ---- smoke
    let smoke: Smoke | null = null;
    if (look.smoke) {
      this.ensureSmoke(look);
      smoke = this.smoke!;
      const rk = this.rake(look);
      const reset = smoke.reset;
      const moving = opts.steps > 0 || reset;
      if (moving) {
        if (!reset) this.head = (this.head + 1) % smoke.trail;
        const transit = (setup.nx - rk.origin[0]) / Math.max(0.01, setup.uLattice * Math.max(1, opts.steps));
        const perLane = smoke.count / (rk.lu * rk.lv);
        const spacing = Math.max(1, Math.min(smoke.trail * 0.7, transit / perLane));
        const buf = new ArrayBuffer(ADVECT_SIZE);
        const u = new Uint32Array(buf);
        const f = new Float32Array(buf);
        u[0] = setup.nx;
        u[1] = setup.ny;
        u[2] = setup.nz;
        u[3] = smoke.count;
        f.set([rk.origin[0], rk.origin[1], rk.origin[2], rk.lv > 1 ? 1 : 0], 4);
        f.set([rk.u[0], rk.u[1], rk.u[2], rk.lu], 8);
        f.set([rk.v[0], rk.v[1], rk.v[2], rk.lv], 12);
        f.set([opts.steps, this.frameNo++, Math.max(200, transit * 2.5), spacing], 16);
        u[20] = this.head;
        u[21] = smoke.trail;
        u[22] = reset ? 1 : 0;
        this.device.queue.writeBuffer(this.advectBuf, 0, buf);
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.advectPipe);
        pass.setBindGroup(0, smoke.advectBind);
        pass.dispatchWorkgroups(Math.ceil(smoke.count / ADVECT_WG));
        pass.end();
        smoke.reset = false;
      }
    }

    // ---- frame uniforms
    const vp = viewProjection(opts.orbit, width / height, opts.frameScale);
    const buf = new ArrayBuffer(FRAME_SIZE);
    const fl = new Float32Array(buf);
    const ui = new Uint32Array(buf);
    fl.set(vp.m, 0);
    fl.set([vp.eye[0], vp.eye[1], vp.eye[2], 1], 16);
    const ld = [0.45, -0.55, 0.75];
    fl.set([ld[0], ld[1], ld[2], theme.dark ? 1 : 0], 20);
    ui.set([setup.nx, setup.ny, setup.nz, lbm.n], 24);
    const cpScale = 1 / (3 * 0.5 * setup.uLattice * setup.uLattice);
    const axis = look.sliceAxis === "side" ? 0 : look.sliceAxis === "top" ? 1 : 2;
    const dimAlong = axis === 0 ? setup.ny : axis === 1 ? setup.nz : setup.nx;
    let slicePos = -0.5 + look.slicePos * dimAlong;
    if (axis === 1 && setup.ground !== "free") slicePos = Math.max(0.3, slicePos);
    fl.set([setup.uLattice, cpScale, slicePos, look.sliceOpacity], 28);
    ui.set([look.surface === "pressure" ? 1 : 0, look.slice === "speed" ? 1 : look.slice === "pressure" ? 2 : 3, axis, look.smokeColor === "speed" ? 0 : look.smokeColor === "white" ? 1 : 2], 32);
    fl.set([width, height, Math.max(1, 1.6 * opts.pixelRatio), opts.time], 36);
    ui.set([this.head, smoke?.trail ?? 2, smoke?.count ?? 0, setup.ground === "free" ? 0 : 1], 40);
    fl.set([theme.bg[0], theme.bg[1], theme.bg[2], 1], 44);
    // floor grid: 1 m lines, or 10 m when cells are big; minor lines a fifth of that
    let major = 1 / setup.dx;
    while (major < 6) major *= 10;
    while (major > setup.nx / 3) major /= 10;
    const mc = setup.modelMin.map((v, i) => (v + setup.modelMax[i]) / 2);
    fl.set([look.floorGrid ? major : 1e6, look.floorGrid ? major / 5 : 1e6, mc[0], mc[1]], 48);
    const ms = setup.modelMin.map((v, i) => setup.modelMax[i] - v);
    fl.set([ms[0], ms[1], ms[2], 6.0], 52);
    const base = theme.dark ? hex("#8f9294") : hex("#a7aaad");
    fl.set([base[0], base[1], base[2], 1], 56);
    ui.set([lbm.refIdx, 0, 0, 0], 60);
    this.device.queue.writeBuffer(this.frameBuf, 0, buf);

    // ---- draw
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: tg.color.createView(),
          resolveTarget: opts.view,
          clearValue: { r: theme.bg[0], g: theme.bg[1], b: theme.bg[2], a: 1 },
          loadOp: "clear",
          storeOp: "discard",
        },
      ],
      depthStencilAttachment: { view: tg.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    });
    pass.setBindGroup(0, this.bindA);
    if (setup.ground !== "free") {
      pass.setPipeline(this.floorPipe);
      pass.draw(6);
    }
    if (this.vbuf && this.vcount) {
      pass.setPipeline(this.modelPipe);
      pass.setVertexBuffer(0, this.vbuf);
      pass.draw(this.vcount);
    }
    if (look.slice !== "off") {
      pass.setPipeline(this.slicePipe);
      pass.draw(6);
    }
    if (smoke) {
      pass.setPipeline(this.trailPipe);
      pass.setBindGroup(0, smoke.trailBind);
      pass.draw(6, smoke.count * (smoke.trail - 1));
      pass.setBindGroup(0, this.bindA);
    }
    pass.setPipeline(this.outlinePipe);
    pass.draw(30);
    pass.end();
  }

  /** Drops the GPU resources of a canvas size that's no longer used (an export, say). */
  releaseTargets(key: string) {
    const t = this.targets.get(key);
    if (!t) return;
    t.color.destroy();
    t.depth.destroy();
    this.targets.delete(key);
  }

  destroy() {
    this.destroySmoke();
    for (const k of [...this.targets.keys()]) this.releaseTargets(k);
    this.vbuf?.destroy();
    this.frameBuf.destroy();
    this.advectBuf.destroy();
  }
}
