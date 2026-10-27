import { Lbm, type ForceSample } from "./sim/lbm";
import type { TunnelSetup } from "./sim/setup";
import type { VoxelResult } from "./geometry/voxelize";
import { Renderer, type Theme } from "./render/renderer";
import type { Orbit } from "./render/camera";
import type { Look } from "./types";

export class GpuUnavailableError extends Error {}

export interface GpuContext {
  device: GPUDevice;
  format: GPUTextureFormat;
  maxBuffer: number;
  adapterName: string;
}

let gpuPromise: Promise<GpuContext> | null = null;
// Held for the life of the page: if the adapter is garbage-collected, Chrome can drop the device with it.
let keepAdapter: GPUAdapter | null = null;

/** One WebGPU device for the whole app, asking for the largest buffers the GPU allows. */
export function getGpu(): Promise<GpuContext> {
  if (gpuPromise) return gpuPromise;
  gpuPromise = (async () => {
    if (!("gpu" in navigator) || !navigator.gpu) {
      throw new GpuUnavailableError("This browser can't run the wind tunnel: it needs WebGPU. Use a recent Chrome or Edge on a computer, or Safari 26 on a Mac.");
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new GpuUnavailableError("No graphics card is available to this browser for WebGPU. Check that hardware acceleration is on in the browser's settings.");
    keepAdapter = adapter;
    void keepAdapter;
    const lim = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
        maxBufferSize: lim.maxBufferSize,
        maxStorageBuffersPerShaderStage: Math.min(8, lim.maxStorageBuffersPerShaderStage),
      },
    });
    device.lost.then((info) => {
      console.warn("WebGPU device lost:", info.message);
      gpuPromise = null;
    });
    const info = adapter.info;
    return {
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      maxBuffer: Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize),
      adapterName: [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "GPU",
    };
  })();
  gpuPromise.catch(() => (gpuPromise = null));
  return gpuPromise;
}

export interface RunStats {
  steps: number;
  flowThroughs: number;
  /** simulated seconds of real time */
  seconds: number;
  stepsPerSecond: number;
  history: { step: number; cd: number; cl: number; cs: number }[];
  /** averaged over the settled part of the run */
  cd: number | null;
  cl: number | null;
  cs: number | null;
  /** how much the average still wanders, as a fraction */
  spread: number | null;
  settled: boolean;
  unstable: boolean;
}

export interface Run {
  setup: TunnelSetup;
  voxels: VoxelResult;
  lbm: Lbm;
  refCells: number;
  samples: ForceSample[];
}

/**
 * Runs the wind tunnel on a canvas: steps the solver while playing, draws every animation frame,
 * reads the force on the model now and then and keeps the averages.
 */
export class Engine {
  readonly gpu: GpuContext;
  readonly renderer: Renderer;
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  run: Run | null = null;
  playing = false;
  look: Look;
  orbit: Orbit = { yaw: -135, pitch: 18, distance: 100, target: [0, 0, 0] };
  frameScale = 1;
  theme: Theme = { dark: true, bg: [0.055, 0.055, 0.055] };
  /** solver steps per animation frame; adapts to keep the view smooth */
  stepsPerFrame = 4;
  onStats: ((s: RunStats) => void) | null = null;
  private raf = 0;
  private lastFrame = 0;
  private frameTimes: number[] = [];
  private stepTimes: { t: number; steps: number }[] = [];
  private inflight = false;
  private frames = 0;
  private dirty = true;
  /** export in progress: the loop leaves the canvas alone */
  paused = false;

  constructor(gpu: GpuContext, look: Look) {
    this.gpu = gpu;
    this.look = look;
    this.renderer = new Renderer(gpu.device, gpu.format);
  }

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new GpuUnavailableError("The view couldn't start WebGPU.");
    ctx.configure({ device: this.gpu.device, format: this.gpu.format, alphaMode: "opaque" });
    this.context = ctx;
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.context?.unconfigure();
    this.context = null;
    this.canvas = null;
  }

  /** Swap in a new run (new grid). The old solver's memory is freed. */
  async load(setup: TunnelSetup, voxels: VoxelResult): Promise<void> {
    this.stopRun();
    const device = this.gpu.device;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    const pad = 2;
    const lbm = await Lbm.create(device, {
      nx: setup.nx,
      ny: setup.ny,
      nz: setup.nz,
      solid: voxels.solid,
      uLattice: setup.uLattice,
      nu: setup.nu,
      cs: setup.cs,
      ground: setup.ground,
      sides: "open",
      forceBox: [
        Math.max(0, voxels.min[0] - pad),
        Math.max(0, voxels.min[1] - pad),
        Math.max(0, voxels.min[2] - pad),
        Math.min(setup.nx, voxels.max[0] + pad + 1),
        Math.min(setup.ny, voxels.max[1] + pad + 1),
        Math.min(setup.nz, voxels.max[2] + pad + 1),
      ],
    });
    const validation = await device.popErrorScope();
    const oom = await device.popErrorScope();
    if (oom || validation) {
      lbm.destroy();
      throw new Error(
        oom
          ? "The graphics card ran out of memory for this many cells. Pick a lower quality."
          : `The wind tunnel couldn't start on this graphics card (${validation!.message.split("\n")[0]}).`,
      );
    }
    const refCells = setup.refKind === "top" ? voxels.topCells : voxels.frontCells;
    this.run = { setup, voxels, lbm, refCells: Math.max(1, refCells), samples: [] };
    this.renderer.setRun(lbm, setup);
    this.stepTimes = [];
    this.dirty = true;
    this.emit();
  }

  stopRun() {
    this.playing = false;
    if (this.run) {
      this.run.lbm.destroy();
      this.run = null;
    }
  }

  /** Back to the start with the same grid. */
  async restart() {
    const r = this.run;
    if (!r) return;
    const playing = this.playing;
    await this.load(r.setup, r.voxels);
    this.playing = playing;
    this.renderer.resetSmoke();
  }

  setLook(look: Look) {
    const prev = this.look;
    this.look = look;
    if (prev.rake !== look.rake || prev.rakeY !== look.rakeY || prev.rakeZ !== look.rakeZ) this.renderer.resetSmoke();
    this.dirty = true;
  }

  setOrbit(o: Orbit) {
    this.orbit = o;
    this.dirty = true;
  }

  setTheme(t: Theme) {
    this.theme = t;
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (this.paused || !this.canvas || !this.context) return;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    const run = this.run;
    const stepping = !!run && this.playing && !this.inflight;
    if (!stepping && !this.dirty) return;
    this.dirty = false;

    const canvas = this.canvas;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    let steps = 0;
    if (stepping && run) {
      // Adapt the work per frame: keep frames under ~30 ms, but get on with it when there's room.
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 20) this.frameTimes.shift();
      if (this.frameTimes.length >= 10) {
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
        if (avg > 34 && this.stepsPerFrame > 1) this.stepsPerFrame = Math.max(1, Math.floor(this.stepsPerFrame * 0.8));
        else if (avg < 20 && this.stepsPerFrame < 40) this.stepsPerFrame = Math.ceil(this.stepsPerFrame * 1.15);
        this.frameTimes = [];
      }
      steps = this.stepsPerFrame;
      run.lbm.step(steps);
      this.stepTimes.push({ t: now, steps });
      while (this.stepTimes.length > 1 && now - this.stepTimes[0].t > 2000) this.stepTimes.shift();
    }
    if (!run) {
      // nothing loaded yet: just clear
      const enc = this.gpu.device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: this.theme.bg[0], g: this.theme.bg[1], b: this.theme.bg[2], a: 1 }, loadOp: "clear", storeOp: "store" }],
      });
      pass.end();
      this.gpu.device.queue.submit([enc.finish()]);
      return;
    }
    const enc = this.gpu.device.createCommandEncoder();
    this.renderer.draw({
      encoder: enc,
      view: this.context.getCurrentTexture().createView(),
      targetKey: "live",
      width: w,
      height: h,
      orbit: this.orbit,
      frameScale: this.frameScale,
      look: this.look,
      theme: this.theme,
      steps,
      time: now / 1000,
      pixelRatio: ratio,
    });
    this.gpu.device.queue.submit([enc.finish()]);
    if (steps > 0) {
      // Don't let the GPU fall behind: wait for this frame's work before queueing more steps.
      this.inflight = true;
      this.gpu.device.queue.onSubmittedWorkDone().then(() => (this.inflight = false));
      this.frames++;
      if (this.frames % 6 === 0) this.sample();
    }
  };

  private async sample() {
    const run = this.run;
    if (!run) return;
    const f = await run.lbm.readForce();
    if (!f || this.run !== run) return;
    run.samples.push(f);
    if (run.samples.length > 4000) run.samples.splice(0, run.samples.length - 4000);
    this.emit();
  }

  /** The averages and history the panels show. */
  stats(): RunStats | null {
    const run = this.run;
    if (!run) return null;
    const s = run.setup;
    const steps = run.lbm.steps;
    const q = 0.5 * s.uLattice * s.uLattice * run.refCells;
    const history = run.samples.map((f) => ({ step: f.step, cd: f.fx / q, cl: f.fz / q, cs: f.fy / q }));
    const flowThroughs = (steps * s.uLattice) / s.nx;
    // average over the last half of the run once the start-up has passed (one flow-through)
    const startStep = Math.max((1.0 * s.nx) / s.uLattice, steps * 0.5);
    const tail = history.filter((h) => h.step >= startStep);
    let cd: number | null = null;
    let cl: number | null = null;
    let cs: number | null = null;
    let spread: number | null = null;
    let liftSpread = Infinity;
    if (tail.length >= 8) {
      const mean = (k: "cd" | "cl" | "cs") => tail.reduce((a, h) => a + h[k], 0) / tail.length;
      cd = mean("cd");
      cl = mean("cl");
      cs = mean("cs");
      // compare the two halves of the window: how much the average is still moving
      const half = Math.floor(tail.length / 2);
      const m1 = tail.slice(0, half).reduce((a, h) => a + h.cd, 0) / half;
      const m2 = tail.slice(half).reduce((a, h) => a + h.cd, 0) / (tail.length - half);
      spread = Math.abs(m2 - m1) / Math.max(1e-6, Math.abs(cd));
      // lift too: measured against drag, since lift can sit near zero
      const l1 = tail.slice(0, half).reduce((a, h) => a + h.cl, 0) / half;
      const l2 = tail.slice(half).reduce((a, h) => a + h.cl, 0) / (tail.length - half);
      liftSpread = Math.abs(l2 - l1) / Math.max(Math.abs(cl), 0.25 * Math.abs(cd), 1e-6);
    }
    const last = history[history.length - 1];
    const lastSample = run.samples[run.samples.length - 1];
    // Unstable: the force has run away, or the solver keeps having to reset cells that blew up.
    const unstable = !!last && (!Number.isFinite(last.cd) || Math.abs(last.cd) > 50 || (lastSample?.bad ?? 0) > run.lbm.n * 0.002);
    let sps = 0;
    if (this.stepTimes.length > 1) {
      const span = this.stepTimes[this.stepTimes.length - 1].t - this.stepTimes[0].t;
      const n = this.stepTimes.slice(1).reduce((a, b) => a + b.steps, 0);
      sps = span > 0 ? (n * 1000) / span : 0;
    }
    return {
      steps,
      flowThroughs,
      seconds: steps * s.dt,
      stepsPerSecond: this.playing ? sps : 0,
      history,
      cd,
      cl,
      cs,
      spread,
      settled: flowThroughs >= 2 && spread !== null && spread < 0.03 && liftSpread < 0.06,
      unstable,
    };
  }

  private emit() {
    const s = this.stats();
    if (s && this.onStats) this.onStats(s);
  }

  setPlaying(v: boolean) {
    this.playing = v && !!this.run;
    this.frameTimes = [];
    this.stepTimes = [];
    this.dirty = true;
    this.emit();
  }

  /**
   * Draws one frame (with `steps` solver steps) into an offscreen canvas of the given size.
   * `capture` runs straight after the frame is submitted, while the canvas still holds it: copy
   * it out there (drawImage), not after awaiting.
   */
  async renderOffscreen(canvas: HTMLCanvasElement, orbit: Orbit, steps: number, time: number, capture?: () => void): Promise<void> {
    const run = this.run;
    if (!run) throw new Error("Nothing to render yet.");
    const ctx = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (!ctx) throw new Error("Couldn't draw the frame.");
    if (!(canvas as HTMLCanvasElement & { __configured?: boolean }).__configured) {
      ctx.configure({ device: this.gpu.device, format: this.gpu.format, alphaMode: "opaque" });
      (canvas as HTMLCanvasElement & { __configured?: boolean }).__configured = true;
    }
    if (steps > 0) run.lbm.step(steps);
    const enc = this.gpu.device.createCommandEncoder();
    this.renderer.draw({
      encoder: enc,
      view: ctx.getCurrentTexture().createView(),
      targetKey: "export",
      width: canvas.width,
      height: canvas.height,
      orbit,
      frameScale: 1,
      look: this.look,
      theme: this.theme,
      steps,
      time,
      pixelRatio: canvas.height / 900,
    });
    this.gpu.device.queue.submit([enc.finish()]);
    capture?.();
    await this.gpu.device.queue.onSubmittedWorkDone();
    if (steps > 0 && Math.round(time * 30) % 6 === 0) await this.sample();
  }

  endOffscreen() {
    this.renderer.releaseTargets("export");
    this.dirty = true;
  }

  destroy() {
    this.detach();
    this.stopRun();
    this.renderer.destroy();
  }
}
