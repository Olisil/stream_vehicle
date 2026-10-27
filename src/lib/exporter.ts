import type { VideoCodec } from "mediabunny";
import type { Engine, RunStats } from "./engine";
import type { Orbit } from "./render/camera";
import { outputSize, type Project } from "./types";

export class ExportUnsupportedError extends Error {}

export interface ExportProgress {
  frame: number;
  frames: number;
  elapsedMs: number;
  paused: boolean;
}

const bitrateFor = (w: number, h: number, fps: number) => Math.round(w * h * fps * 0.15);

async function pickCodec(width: number, height: number, fps: number): Promise<VideoCodec> {
  if (typeof VideoEncoder === "undefined") throw new ExportUnsupportedError("This browser can't make videos. Use a recent Chrome, Edge or Safari on a computer to render.");
  const { canEncodeVideo } = await import("mediabunny");
  const bitrate = bitrateFor(width, height, fps);
  for (const codec of ["avc", "hevc", "vp9", "av1"] as VideoCodec[]) {
    if (await canEncodeVideo(codec, { width, height, bitrate })) return codec;
  }
  throw new ExportUnsupportedError(`This computer can't make ${width}×${height} video in this browser. Pick a lower resolution, or try Chrome.`);
}

function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (!document.hidden) {
        document.removeEventListener("visibilitychange", on);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", on);
  });
}

/** The small caption in the corner: speed, drag and lift, and where it was made. */
function drawOverlay(g: CanvasRenderingContext2D, w: number, h: number, project: Project, stats: RunStats | null, liftWord: string, dark: boolean) {
  const s = h / 1080;
  const pad = 44 * s;
  g.save();
  g.textBaseline = "alphabetic";
  const text = dark ? "rgba(230,230,230,0.92)" : "rgba(14,14,14,0.9)";
  const dim = dark ? "rgba(230,230,230,0.55)" : "rgba(14,14,14,0.55)";
  g.fillStyle = text;
  g.font = `500 ${Math.round(30 * s)}px Neugrotypeface, "Raleway Variablefont Wght", sans-serif`;
  const lines: string[] = [`${project.tunnel.speed} km/h`];
  if (stats?.cd !== null && stats?.cd !== undefined) lines.push(`Cd ${stats.cd.toFixed(3)}`);
  if (stats?.cl !== null && stats?.cl !== undefined) {
    const v = liftWord.startsWith("Down") ? -stats.cl : stats.cl;
    lines.push(`${liftWord.split(" ")[0]} ${v.toFixed(3)}`);
  }
  let y = h - pad;
  for (const line of lines.reverse()) {
    g.fillText(line, pad, y);
    y -= 40 * s;
  }
  g.fillStyle = dim;
  g.font = `500 ${Math.round(18 * s)}px "Raleway Variablefont Wght", sans-serif`;
  g.textAlign = "right";
  g.fillText("Stream Vehicle · nassau.se", w - pad, h - pad);
  g.restore();
}

async function ensureFonts() {
  try {
    await Promise.all([document.fonts.load('500 30px Neugrotypeface'), document.fonts.load('500 18px "Raleway Variablefont Wght"')]);
  } catch {
    /* fall back to the system font */
  }
}

/** A still of the current view at the output size, as PNG. */
export async function takeStill(opts: { engine: Engine; project: Project; orbit: Orbit; stats: RunStats | null; liftWord: string }): Promise<Blob> {
  const { engine, project } = opts;
  const { width, height } = outputSize(project.output.aspect, project.output.resolution);
  await ensureFonts();
  const gpuCanvas = document.createElement("canvas");
  gpuCanvas.width = width;
  gpuCanvas.height = height;
  engine.paused = true;
  try {
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const g = out.getContext("2d")!;
    await engine.renderOffscreen(gpuCanvas, opts.orbit, 0, 0, () => g.drawImage(gpuCanvas, 0, 0));
    if (project.output.overlay) drawOverlay(g, width, height, project, opts.stats, opts.liftWord, engine.theme.dark);
    return await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture came out empty."))), "image/png"));
  } finally {
    engine.paused = false;
    engine.endOffscreen();
  }
}

/**
 * Renders the running tunnel to MP4: the solver keeps stepping at a fixed pace per frame, the
 * camera can turn slowly around the model, and the caption is drawn on top.
 */
export async function renderVideo(opts: {
  engine: Engine;
  project: Project;
  orbit: Orbit;
  liftWord: string;
  signal: AbortSignal;
  onProgress: (p: ExportProgress) => void;
}): Promise<{ blob: Blob; width: number; height: number; codec: VideoCodec }> {
  const { engine, project, signal, onProgress } = opts;
  const out = project.output;
  const { width, height } = outputSize(out.aspect, out.resolution);
  const fps = out.fps;
  const codec = await pickCodec(width, height, fps);
  await ensureFonts();

  const gpuCanvas = document.createElement("canvas");
  gpuCanvas.width = width;
  gpuCanvas.height = height;
  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = width;
  frameCanvas.height = height;
  const g = frameCanvas.getContext("2d", { alpha: false })!;

  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output } = await import("mediabunny");
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const source = new CanvasSource(frameCanvas, { codec, bitrate: bitrateFor(width, height, fps), keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });

  const frames = Math.max(1, Math.round(out.seconds * fps));
  // The air moves at the same pace whatever the frame rate: about 5 solver steps per 1/30 s.
  const stepsPerFrame = Math.max(1, Math.round((5 * 30) / fps));
  const started = performance.now();
  const wasPlaying = engine.playing;
  engine.setPlaying(false);
  engine.paused = true;
  try {
    await output.start();
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException("Render cancelled", "AbortError");
      if (document.hidden) {
        onProgress({ frame: i, frames, elapsedMs: performance.now() - started, paused: true });
        await whenVisible();
      }
      const t = i / fps;
      const k = frames > 1 ? i / (frames - 1) : 0;
      const orbit: Orbit = out.orbit ? { ...opts.orbit, yaw: opts.orbit.yaw + 70 * (0.5 - 0.5 * Math.cos(Math.PI * k)) } : opts.orbit;
      await engine.renderOffscreen(gpuCanvas, orbit, stepsPerFrame, t, () => g.drawImage(gpuCanvas, 0, 0));
      if (out.overlay) drawOverlay(g, width, height, project, engine.stats(), opts.liftWord, engine.theme.dark);
      await source.add(t, 1 / fps);
      onProgress({ frame: i + 1, frames, elapsedMs: performance.now() - started, paused: false });
    }
    await output.finalize();
  } catch (err) {
    if (output.state !== "finalized") await output.cancel().catch(() => {});
    throw err;
  } finally {
    engine.paused = false;
    engine.endOffscreen();
    engine.setPlaying(wasPlaying);
  }
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("The video came out empty. Try rendering again.");
  return { blob: new Blob([buffer], { type: "video/mp4" }), width, height, codec };
}
