import type { RunStats } from "../lib/engine";

type Hist = RunStats["history"];

function path(pts: [number, number][]) {
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
}

function thin(h: Hist, max: number): Hist {
  if (h.length <= max) return h;
  const step = h.length / max;
  const out: Hist = [];
  for (let i = 0; i < max; i++) out.push(h[Math.floor(i * step)]);
  out.push(h[h.length - 1]);
  return out;
}

/** Drag (and lift) coefficient against steps, with the start-up part shaded. */
export function CoefficientChart({ history, settleStep, liftWord }: { history: Hist; settleStep: number; liftWord: string }) {
  const W = 300;
  const H = 150;
  const pad = { l: 34, r: 8, t: 10, b: 20 };
  if (history.length < 2)
    return (
      <div className="chart chart-empty" style={{ aspectRatio: `${W} / ${H}` }}>
        The line appears once the wind is running.
      </div>
    );
  const h = thin(history, 300);
  const x1 = h[h.length - 1].step;
  // y range from the settled part when there is one, so the start-up spike doesn't flatten everything
  const settled = h.filter((p) => p.step >= settleStep);
  const src = settled.length > 4 ? settled : h;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of src) {
    lo = Math.min(lo, p.cd, p.cl);
    hi = Math.max(hi, p.cd, p.cl);
  }
  if (!Number.isFinite(lo)) return null;
  const span = Math.max(0.1, hi - lo);
  lo -= span * 0.15;
  hi += span * 0.15;
  const X = (s: number) => pad.l + ((W - pad.l - pad.r) * s) / Math.max(1, x1);
  const Y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
  const ticks = [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];
  const shade = Math.min(x1, settleStep);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Drag and lift coefficients over the run">
        <rect x={pad.l} y={pad.t} width={X(shade) - pad.l} height={H - pad.t - pad.b} className="chart-warmup" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={Y(t) + 4} className="chart-tick" textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        {lo < 0 && hi > 0 && <line x1={pad.l} x2={W - pad.r} y1={Y(0)} y2={Y(0)} className="chart-zero" />}
        <path d={path(h.map((p) => [X(p.step), Y(p.cl)]))} className="chart-cl" />
        <path d={path(h.map((p) => [X(p.step), Y(p.cd)]))} className="chart-cd" />
        <text x={pad.l} y={H - 5} className="chart-tick">
          0
        </text>
        <text x={W - pad.r} y={H - 5} className="chart-tick" textAnchor="end">
          {x1.toLocaleString("en")} steps
        </text>
      </svg>
      <figcaption className="chart-legend">
        <span className="key key-cd" /> Drag (Cd) <span className="key key-cl" /> {liftWord}
      </figcaption>
    </figure>
  );
}

/** Small drag line for the bottom bar. */
export function Sparkline({ history }: { history: Hist }) {
  const W = 120;
  const H = 24;
  if (history.length < 2) return <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden />;
  const h = thin(history.slice(-200), 120);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of h.slice(Math.floor(h.length / 3))) {
    lo = Math.min(lo, p.cd);
    hi = Math.max(hi, p.cd);
  }
  const span = Math.max(1e-3, hi - lo);
  const x0 = h[0].step;
  const x1 = h[h.length - 1].step;
  const d = path(h.map((p) => [((p.step - x0) / Math.max(1, x1 - x0)) * W, H - 2 - ((Math.min(hi, Math.max(lo, p.cd)) - lo) / span) * (H - 4)]));
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <path d={d} />
    </svg>
  );
}
