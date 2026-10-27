import type { RunStats } from "../../lib/engine";
import type { TunnelSetup } from "../../lib/sim/setup";
import { Section } from "../Controls";
import { CoefficientChart } from "../Charts";

export function runStatus(stats: RunStats | null, building: string | null): { label: string; tone: "busy" | "ok" | "warn" } {
  if (building) return { label: building, tone: "busy" };
  if (!stats) return { label: "Waiting for the model", tone: "busy" };
  if (stats.unstable) return { label: "The flow went unstable", tone: "warn" };
  if (stats.flowThroughs < 1) return { label: "Air filling the tunnel", tone: "busy" };
  if (!stats.settled) return { label: "Settling", tone: "busy" };
  return { label: "Settled", tone: "ok" };
}

function fmtTime(s: number) {
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function RunPanel(props: {
  stats: RunStats | null;
  setup: TunnelSetup | null;
  playing: boolean;
  building: string | null;
  onPlay: (v: boolean) => void;
  onRestart: () => void;
  liftWord: string;
}) {
  const { stats, setup } = props;
  const status = runStatus(stats, props.building);
  return (
    <>
      <header className="panel-intro">
        <h2>Run</h2>
        <p>The air needs to pass the model a couple of times before the numbers settle. Leave it running and watch the drag line flatten.</p>
      </header>

      <div className="run-controls">
        <button type="button" className="btn btn-primary" disabled={!stats || !!props.building} onClick={() => props.onPlay(!props.playing)}>
          {props.playing ? "Pause" : stats && stats.steps > 0 ? "Carry on" : "Start the wind"}
        </button>
        <button type="button" className="btn" disabled={!stats || !!props.building} onClick={props.onRestart}>
          Start over
        </button>
      </div>
      <p className={`status-line tone-${status.tone}`} role="status">
        <span className="status-dot" aria-hidden />
        {status.label}
      </p>

      {stats && setup && (
        <>
          <Section title="Drag and lift over time">
            <CoefficientChart history={stats.history} settleStep={(1.0 * setup.nx) / setup.uLattice} liftWord={props.liftWord} />
          </Section>
          <Section title="Progress">
            <dl className="facts">
              <dt>Steps</dt>
              <dd>{stats.steps.toLocaleString("en")}</dd>
              <dt>Times through the tunnel</dt>
              <dd>{stats.flowThroughs.toFixed(1)}</dd>
              <dt>Real time simulated</dt>
              <dd>{fmtTime(stats.seconds)}</dd>
              <dt>Speed</dt>
              <dd>{props.playing ? `${Math.round(stats.stepsPerSecond).toLocaleString("en")} steps a second` : "Paused"}</dd>
            </dl>
          </Section>
          {stats.unstable && (
            <p className="error" role="alert">
              The numbers blew up. Try a lower speed or more detail, then start over.
            </p>
          )}
        </>
      )}
    </>
  );
}
