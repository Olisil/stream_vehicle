import { FORCE_GROUPS, forceShader, initShader, stepShader, WORKGROUP } from "./shaders";

/** Bytes the solver needs per cell: two sets of 19 distributions, the solid flag and the macro field. */
export const BYTES_PER_CELL = 19 * 4 * 2 + 4 + 16;

export type Ground = "free" | "fixed" | "moving";

export interface LbmSetup {
  nx: number;
  ny: number;
  nz: number;
  /** 1 where the model is, per cell (x fastest, then y, then z) */
  solid: Uint8Array;
  /** wind speed in lattice units (≈ 0.05–0.1) */
  uLattice: number;
  /** molecular viscosity in lattice units */
  nu: number;
  /** Smagorinsky constant */
  cs: number;
  ground: Ground;
  /** box around the model where the force is summed [x0, y0, z0, x1, y1, z1) */
  forceBox: [number, number, number, number, number, number];
  /** sides and top: "open" lets the air leave (closest to open air), "stream" holds it at the wind speed */
  sides?: "open" | "stream";
}

export interface ForceSample {
  step: number;
  /** force on the model in lattice units (x along the wind, z up) */
  fx: number;
  fy: number;
  fz: number;
  /** cells the solver has had to reset because they blew up, since the start */
  bad: number;
}

/**
 * The wind tunnel on the GPU. Owns the buffers for one grid; `step()` advances it and
 * `readForce()` sums the force on the model. Rendering reads `macro` (ρ, ux, uy, uz per cell)
 * and `solid` directly.
 */
export class Lbm {
  readonly device: GPUDevice;
  readonly setup: LbmSetup;
  readonly n: number;
  readonly params: GPUBuffer;
  readonly fA: GPUBuffer;
  readonly fB: GPUBuffer;
  readonly solid: GPUBuffer;
  readonly macro: GPUBuffer;
  private partial: GPUBuffer;
  private partialRead: GPUBuffer;
  private bad: GPUBuffer;
  private stepPipe: GPUComputePipeline;
  private forcePipe: GPUComputePipeline;
  private bindAB: GPUBindGroup;
  private bindBA: GPUBindGroup;
  private forceA: GPUBindGroup;
  private forceB: GPUBindGroup;
  private parity = 0;
  private dispatch: [number, number];
  private rowStride: number;
  private reading = false;
  steps = 0;
  /** a cell upstream near the top corner, in the free stream: the reference pressure */
  readonly refIdx: number;
  /** inlet speed ramps up over the first steps so the start is gentle */
  rampSteps = 400;
  destroyed = false;

  static async create(device: GPUDevice, setup: LbmSetup): Promise<Lbm> {
    const lbm = new Lbm(device, setup);
    await lbm.init();
    return lbm;
  }

  private constructor(device: GPUDevice, setup: LbmSetup) {
    this.device = device;
    this.setup = setup;
    const n = setup.nx * setup.ny * setup.nz;
    this.n = n;
    const groups = Math.ceil(n / WORKGROUP);
    const gx = Math.min(groups, 32768);
    const gy = Math.ceil(groups / gx);
    this.dispatch = [gx, gy];
    this.rowStride = gx * WORKGROUP;
    const rx = Math.max(1, Math.round(setup.nx * 0.12));
    this.refIdx = rx + setup.nx * (1 + setup.ny * (setup.nz - 2));

    const S = GPUBufferUsage.STORAGE;
    this.params = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fA = device.createBuffer({ size: 19 * 4 * n, usage: S });
    this.fB = device.createBuffer({ size: 19 * 4 * n, usage: S });
    this.solid = device.createBuffer({ size: 4 * n, usage: S | GPUBufferUsage.COPY_DST });
    this.macro = device.createBuffer({ size: 16 * n, usage: S | GPUBufferUsage.COPY_SRC });
    this.partial = device.createBuffer({ size: 16 * FORCE_GROUPS, usage: S | GPUBufferUsage.COPY_SRC });
    this.partialRead = device.createBuffer({ size: 16 * FORCE_GROUPS + 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bad = device.createBuffer({ size: 16, usage: S | GPUBufferUsage.COPY_SRC });

    // solid flags as u32
    const flags = new Uint32Array(n);
    for (let i = 0; i < n; i++) flags[i] = setup.solid[i];
    device.queue.writeBuffer(this.solid, 0, flags);

    this.stepPipe = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: stepShader, label: "lbm step" }), entryPoint: "main" },
    });
    this.forcePipe = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: forceShader, label: "lbm force" }), entryPoint: "main" },
    });
    const sl = this.stepPipe.getBindGroupLayout(0);
    const mk = (src: GPUBuffer, dst: GPUBuffer) =>
      device.createBindGroup({
        layout: sl,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: src } },
          { binding: 2, resource: { buffer: dst } },
          { binding: 3, resource: { buffer: this.solid } },
          { binding: 4, resource: { buffer: this.macro } },
          { binding: 5, resource: { buffer: this.bad, size: 4 } },
        ],
      });
    this.bindAB = mk(this.fA, this.fB);
    this.bindBA = mk(this.fB, this.fA);
    const fl = this.forcePipe.getBindGroupLayout(0);
    const mf = (post: GPUBuffer) =>
      device.createBindGroup({
        layout: fl,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: post } },
          { binding: 2, resource: { buffer: this.solid } },
          { binding: 3, resource: { buffer: this.partial } },
        ],
      });
    this.forceA = mf(this.fA);
    this.forceB = mf(this.fB);
  }

  private async init() {
    this.writeParams();
    const pipe = this.device.createComputePipeline({
      layout: "auto",
      compute: { module: this.device.createShaderModule({ code: initShader, label: "lbm init" }), entryPoint: "main" },
    });
    const bind = this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.fA } },
        { binding: 2, resource: { buffer: this.fB } },
        { binding: 3, resource: { buffer: this.solid } },
        { binding: 4, resource: { buffer: this.macro } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(this.dispatch[0], this.dispatch[1]);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    await this.device.queue.onSubmittedWorkDone();
  }

  /** Current inlet speed (lattice units), following the start-up ramp. */
  get uIn() {
    const r = Math.min(1, (this.steps + 1) / this.rampSteps);
    return this.setup.uLattice * (r * r * (3 - 2 * r));
  }

  private writeParams() {
    const s = this.setup;
    const buf = new ArrayBuffer(80);
    const u = new Uint32Array(buf);
    const f = new Float32Array(buf);
    const uIn = this.uIn;
    u[0] = s.nx;
    u[1] = s.ny;
    u[2] = s.nz;
    u[3] = this.n;
    f[4] = uIn;
    f[5] = 0.5 + 3 * s.nu;
    f[6] = 18 * Math.SQRT2 * s.cs * s.cs;
    u[7] = s.ground === "free" ? 0 : s.ground === "fixed" ? 1 : 2;
    f[8] = s.ground === "moving" ? uIn : 0;
    u[9] = this.rowStride;
    const b = s.forceBox;
    u[10] = b[0];
    u[11] = b[1];
    u[12] = b[2];
    u[13] = b[3];
    u[14] = b[4];
    u[15] = b[5];
    u[16] = s.sides === "open" ? 1 : 0;
    u[17] = this.refIdx;
    this.device.queue.writeBuffer(this.params, 0, buf);
  }

  /** Advance `count` steps. Parameters change during the ramp, so each step gets its own submit then. */
  step(count: number) {
    if (this.destroyed || count <= 0) return;
    let left = count;
    while (left > 0) {
      const ramping = this.steps < this.rampSteps;
      const batch = ramping ? 1 : left;
      this.writeParams();
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.stepPipe);
      for (let k = 0; k < batch; k++) {
        pass.setBindGroup(0, this.parity === 0 ? this.bindAB : this.bindBA);
        pass.dispatchWorkgroups(this.dispatch[0], this.dispatch[1]);
        this.parity ^= 1;
      }
      pass.end();
      this.device.queue.submit([enc.finish()]);
      this.steps += batch;
      left -= batch;
    }
  }

  /** The buffer holding the latest post-collision distributions. */
  private get current(): "A" | "B" {
    return this.parity === 0 ? "A" : "B";
  }

  /**
   * Sum the force on the model from the latest step. Resolves to null if a read is already in
   * flight (the caller just tries again next frame).
   */
  async readForce(): Promise<ForceSample | null> {
    if (this.reading || this.destroyed) return null;
    this.reading = true;
    try {
      const step = this.steps;
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.forcePipe);
      pass.setBindGroup(0, this.current === "A" ? this.forceA : this.forceB);
      pass.dispatchWorkgroups(FORCE_GROUPS);
      pass.end();
      enc.copyBufferToBuffer(this.partial, 0, this.partialRead, 0, 16 * FORCE_GROUPS);
      enc.copyBufferToBuffer(this.bad, 0, this.partialRead, 16 * FORCE_GROUPS, 16);
      this.device.queue.submit([enc.finish()]);
      await this.partialRead.mapAsync(GPUMapMode.READ);
      if (this.destroyed) return null;
      const raw = this.partialRead.getMappedRange().slice(0);
      this.partialRead.unmap();
      const a = new Float32Array(raw);
      const bad = new Uint32Array(raw, 16 * FORCE_GROUPS, 1)[0];
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let i = 0; i < FORCE_GROUPS; i++) {
        fx += a[i * 4];
        fy += a[i * 4 + 1];
        fz += a[i * 4 + 2];
      }
      return { step, fx, fy, fz, bad };
    } finally {
      this.reading = false;
    }
  }

  /** Copies the macro field (ρ, u) to the CPU, for tests and probes. */
  async readMacro(): Promise<Float32Array> {
    const read = this.device.createBuffer({ size: 16 * this.n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.macro, 0, read, 0, 16 * this.n);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return out;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const b of [this.params, this.fA, this.fB, this.solid, this.macro, this.partial, this.partialRead, this.bad]) b.destroy();
  }
}
