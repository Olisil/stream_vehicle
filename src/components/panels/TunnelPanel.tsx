import { formatBytes, formatRe, type TunnelSetup } from "../../lib/sim/setup";
import { QUALITIES, ROAD_GROUNDS, VEHICLES, type Project, type Quality } from "../../lib/types";
import { Section, Segmented, Slider } from "../Controls";
import { BYTES_PER_CELL } from "../../lib/sim/lbm";

function fmtCell(m: number) {
  if (m >= 1) return `${m.toFixed(2)} m`;
  if (m >= 0.01) return `${(m * 100).toFixed(m >= 0.1 ? 0 : 1)} cm`;
  return `${(m * 1000).toFixed(1)} mm`;
}

export function TunnelPanel(props: { project: Project; update: (fn: (p: Project) => Project) => void; setup: TunnelSetup | null; maxBuffer: number }) {
  const { project, update, setup } = props;
  const t = project.tunnel;
  const v = VEHICLES[project.vehicle];
  const set = (o: Partial<Project["tunnel"]>) => update((p) => ({ ...p, tunnel: { ...p.tunnel, ...o } }));
  const maxCells = Math.floor(props.maxBuffer / 76);
  const mach = t.speed / 3.6 / 340;

  return (
    <>
      <header className="panel-intro">
        <h2>Tunnel</h2>
        <p>How fast the air comes, what's underneath, and how finely the tunnel is divided into cells.</p>
      </header>

      <Section title="Wind">
        <Slider
          label="Speed"
          value={t.speed}
          min={5}
          max={v.maxSpeed}
          step={5}
          format={(s) => `${s} km/h · ${(s / 3.6).toFixed(0)} m/s`}
          onChange={(s) => set({ speed: s })}
        />
        {mach > 0.3 && <p className="hint warn">Over about 370 km/h air starts to compress. This tunnel treats it as incompressible, so expect the numbers to drift.</p>}
      </Section>

      <Section title="Underneath">
        <Segmented label="Ground" stacked value={t.ground} options={ROAD_GROUNDS} onChange={(g) => update((p) => ({ ...p, tunnel: { ...p.tunnel, ground: g }, look: { ...p.look, floorGrid: g !== "free" } }))} />
      </Section>

      <Section title="Angles">
        <Slider label="Crosswind (yaw)" value={t.yaw} min={-30} max={30} step={1} format={(a) => `${a > 0 ? "+" : ""}${a}°`} ends={["Wind from the left", "from the right"]} onChange={(a) => set({ yaw: a })} />
        {(v.pitch || t.pitch !== 0) && (
          <Slider label="Nose up (angle of attack)" value={t.pitch} min={-10} max={20} step={0.5} format={(a) => `${a > 0 ? "+" : ""}${a}°`} onChange={(a) => set({ pitch: a })} />
        )}
      </Section>

      <Section title="Detail" hint="More cells show finer detail and take longer. The tunnel uses your graphics card's memory.">
        <Segmented
          label="Detail"
          stacked
          value={t.quality}
          options={QUALITIES.map((q) => ({
            value: q.value,
            label: q.label,
            hint: q.cells > maxCells ? `Too big for this graphics card: ${(maxCells / 1e6).toFixed(1)} million cells at most` : `${(q.cells / 1e6).toFixed(1)} million cells`,
          }))}
          onChange={(q: Quality) => set({ quality: q })}
        />
      </Section>

      {setup && (
        <Section title="The grid">
          <dl className="facts">
            <dt>Cells</dt>
            <dd>
              {setup.nx} × {setup.ny} × {setup.nz} = {((setup.nx * setup.ny * setup.nz) / 1e6).toFixed(2)} million
            </dd>
            <dt>Cell size</dt>
            <dd>{fmtCell(setup.dx)}</dd>
            <dt>Along the model</dt>
            <dd>{Math.round(setup.cellsAlong)} cells</dd>
            <dt>Graphics memory</dt>
            <dd>{formatBytes(setup.nx * setup.ny * setup.nz * BYTES_PER_CELL)}</dd>
            <dt>Reynolds number</dt>
            <dd>
              {formatRe(setup.reynolds)}
              {setup.reynoldsGrid < setup.reynolds * 0.98 && <span className="facts-sub">the grid resolves about {formatRe(setup.reynoldsGrid)}</span>}
            </dd>
          </dl>
          <p className="hint">
            Details smaller than a cell ({fmtCell(setup.dx)}) are lost: mirrors, wipers and thin edges may vanish or thicken. A real {VEHICLES[project.vehicle].label.toLowerCase()} at this speed
            has a much thinner boundary layer than the grid can show, so treat the numbers as a comparison between shapes rather than a measurement.
          </p>
        </Section>
      )}
    </>
  );
}
