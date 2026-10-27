import type { RunStats } from "../../lib/engine";
import { RHO_AIR, type TunnelSetup } from "../../lib/sim/setup";
import { outputSize, RESOLUTIONS, type Project } from "../../lib/types";
import { Field, Section, Segmented, Slider, Toggle } from "../Controls";

export type RenderState =
  | { status: "idle" }
  | { status: "rendering"; frame: number; frames: number; elapsedMs: number; paused: boolean }
  | { status: "done"; url: string; blob: Blob; width: number; height: number; codec: string }
  | { status: "error"; message: string };

function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function n(v: number, digits = 3) {
  return v.toFixed(digits);
}

function force(N: number) {
  const a = Math.abs(N);
  if (a >= 1e4) return `${(N / 1000).toFixed(1)} kN`;
  if (a >= 100) return `${Math.round(N).toLocaleString("en")} N`;
  return `${N.toFixed(1)} N`;
}

function power(W: number) {
  if (W >= 1e6) return `${(W / 1e6).toFixed(2)} MW`;
  if (W >= 1e3) return `${(W / 1e3).toFixed(1)} kW`;
  return `${Math.round(W)} W`;
}

export function ResultsPanel(props: {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  stats: RunStats | null;
  setup: TunnelSetup | null;
  refCells: number;
  liftWord: string;
  render: RenderState;
  onRender: () => void;
  onCancel: () => void;
  onDownload: () => void;
  onStill: () => void;
  stillBusy: boolean;
}) {
  const { project, stats, setup } = props;
  const out = project.output;
  const set = (o: Partial<Project["output"]>) => props.update((p) => ({ ...p, output: { ...p.output, ...o } }));
  const size = outputSize(out.aspect, out.resolution);
  const busy = props.render.status === "rendering";
  const down = props.liftWord.startsWith("Down");

  const area = setup ? props.refCells * setup.dx * setup.dx : 0;
  const q = setup ? 0.5 * RHO_AIR * setup.speed * setup.speed : 0;
  const has = !!stats && stats.cd !== null && !!setup;
  const cd = stats?.cd ?? 0;
  const cl = stats?.cl ?? 0;
  const cs = stats?.cs ?? 0;
  const drag = cd * q * area;
  const lift = cl * q * area;

  return (
    <>
      <header className="panel-intro">
        <h2>Results & export</h2>
        <p>Averaged over the settled part of the run. Best for comparing versions of a shape against each other.</p>
      </header>

      {!has ? (
        <p className="hint">{stats ? "The numbers appear once the air has passed the model once. Keep the wind running." : "Start the wind in the Run step first."}</p>
      ) : (
        <>
          <div className="results">
            <div className="result-big">
              <span className="result-label">Drag coefficient</span>
              <span className="result-value">{n(cd)}</span>
              <span className="result-sub">{stats!.settled ? "Settled" : "Still settling"}</span>
            </div>
            <div className="result-big">
              <span className="result-label">{props.liftWord}</span>
              <span className="result-value">{n(down ? -cl : cl)}</span>
              <span className="result-sub">{down ? (cl < 0 ? "Pressed onto the road" : "Lifting off the road") : cl >= 0 ? "Upwards" : "Downwards"}</span>
            </div>
          </div>
          <dl className="facts">
            <dt>{setup!.refKind === "top" ? "Area from above" : "Frontal area"}</dt>
            <dd>{area.toFixed(area < 1 ? 3 : 2)} m²</dd>
            <dt>Drag area (CdA)</dt>
            <dd>{(cd * area).toFixed(3)} m²</dd>
            <dt>Drag at {project.tunnel.speed} km/h</dt>
            <dd>{force(drag)}</dd>
            <dt>{down ? "Downforce" : "Lift"}</dt>
            <dd>{force(down ? -lift : lift)}</dd>
            <dt>Side force</dt>
            <dd>{force(cs * q * area)}</dd>
            <dt>Power against drag</dt>
            <dd>{power(drag * setup!.speed)}</dd>
          </dl>
          <details className="fold-note">
            <summary>How far to trust these numbers</summary>
            <p>
              The tunnel solves the air on a grid of cells with a lattice Boltzmann method and a turbulence model. It gets the shape of the flow right: where it leaves the body, how big
              the wake is, where the pressure piles up. Absolute numbers are rougher. The boundary layer on a real vehicle is far thinner than a cell, wheels don't turn, and the walls of
              the tunnel are closer than open air. Blunt shapes, where the air leaves at sharp edges, come out closer than smooth, streamlined ones. To see the size of the error at a
              setting, run the Ahmed body: in real wind tunnels its drag coefficient is about 0.29. Compare versions of a design against each other at the same settings; the differences
              are more reliable than the single numbers.
            </p>
          </details>
        </>
      )}

      <Section title="Picture">
        <button type="button" className="btn" disabled={!setup || busy || props.stillBusy} onClick={props.onStill}>
          {props.stillBusy ? "Saving…" : `Save a PNG (${size.width} × ${size.height})`}
        </button>
      </Section>

      <Section title="Video">
        <Slider label="Length" value={out.seconds} min={3} max={60} step={1} format={(v) => `${v} s`} onChange={(v) => set({ seconds: v })} />
        <Field label="Resolution">
          <Segmented label="Resolution" value={out.resolution} disabled={busy} options={RESOLUTIONS.map((r) => ({ value: r.value, label: r.label }))} onChange={(v) => set({ resolution: v })} />
        </Field>
        <Field label="Frame rate">
          <Segmented label="Frame rate" value={out.fps} disabled={busy} options={([24, 25, 30, 60] as const).map((v) => ({ value: v, label: `${v} fps` }))} onChange={(v) => set({ fps: v })} />
        </Field>
        <Toggle label="Turn slowly around the model" checked={out.orbit} disabled={busy} onChange={(v) => set({ orbit: v })} />
        <Toggle label="Numbers in the corner" hint="Speed, drag and lift, and a small credit" checked={out.overlay} disabled={busy} onChange={(v) => set({ overlay: v })} />
        <div className="render">
          <p className="render-summary">
            {size.width} × {size.height}, {out.seconds} s, {(out.seconds * out.fps).toLocaleString("en")} frames. The wind keeps running while it records.
          </p>
          {props.render.status === "rendering" ? (
            <>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={props.render.frames} aria-valuenow={props.render.frame}>
                <span style={{ width: `${(100 * props.render.frame) / Math.max(1, props.render.frames)}%` }} />
              </div>
              <p className="hint" aria-live="polite">
                {props.render.paused
                  ? "Paused while this tab is in the background. Come back to it to carry on."
                  : `Frame ${props.render.frame.toLocaleString("en")} of ${props.render.frames.toLocaleString("en")}${
                      props.render.frame > 5 ? `, about ${clock((props.render.elapsedMs / props.render.frame) * (props.render.frames - props.render.frame))} left` : ""
                    }.`}
              </p>
              <button type="button" className="btn" onClick={props.onCancel}>
                Stop rendering
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-big" onClick={props.onRender} disabled={!setup}>
              Render video
            </button>
          )}
          {props.render.status === "error" && (
            <p className="error" role="alert">
              {props.render.message}
            </p>
          )}
          {props.render.status === "done" && (
            <div className="result">
              <video src={props.render.url} controls playsInline muted />
              {props.render.codec !== "avc" && (
                <p className="hint">This browser can't make H.264, so the video uses {props.render.codec.toUpperCase()}. Some editors won't open it; render in Chrome or Edge for the most compatible file.</p>
              )}
              <button type="button" className="btn btn-primary" onClick={props.onDownload}>
                Download MP4
              </button>
            </div>
          )}
        </div>
      </Section>
    </>
  );
}
