import type { Ground } from "../../lib/sim/lbm";
import type { Look, Project } from "../../lib/types";
import { Section, Segmented, Slider, Toggle } from "../Controls";

export function LookPanel(props: { project: Project; update: (fn: (p: Project) => Project) => void; ground: Ground }) {
  const l = props.project.look;
  const set = (o: Partial<Look>) => props.update((p) => ({ ...p, look: { ...p.look, ...o } }));
  return (
    <>
      <header className="panel-intro">
        <h2>Look</h2>
        <p>Smoke shows where the air goes, a slice shows what it does inside the flow, and the model's colour shows the pressure on it.</p>
      </header>

      <Section title="Smoke">
        <Toggle label="Smoke lines" checked={l.smoke} onChange={(v) => set({ smoke: v })} />
        {l.smoke && (
          <>
            <Segmented
              label="Where the smoke comes from"
              value={l.rake}
              options={[
                { value: "vertical", label: "Upright" },
                { value: "horizontal", label: "Flat" },
                { value: "grid", label: "Grid" },
              ]}
              onChange={(v) => set({ rake: v })}
            />
            {l.rake !== "grid" && (
              <Slider
                label="Across"
                value={l.rakeY}
                min={-1}
                max={1}
                step={0.02}
                format={(v) => (Math.abs(v) < 0.01 ? "Centre" : `${Math.round(Math.abs(v) * 100)}% to the ${v < 0 ? "left" : "right"}`)}
                onChange={(v) => set({ rakeY: v })}
              />
            )}
            {l.rake === "horizontal" && (
              <Slider label="Height" value={l.rakeZ} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}% of the model's height`} onChange={(v) => set({ rakeZ: v })} />
            )}
            <Slider label="Amount" value={l.density} min={1} max={30} step={1} format={(v) => `${v} thousand`} onChange={(v) => set({ density: v })} />
            <Slider label="Trail length" value={l.trail} min={6} max={64} step={2} format={(v) => `${v} frames`} onChange={(v) => set({ trail: v })} />
            <Segmented
              label="Smoke colour"
              value={l.smokeColor}
              options={[
                { value: "speed", label: "By speed" },
                { value: "white", label: "Plain" },
                { value: "green", label: "Signal" },
              ]}
              onChange={(v) => set({ smokeColor: v })}
            />
          </>
        )}
      </Section>

      <Section title="Slice through the flow">
        <Segmented
          label="Slice shows"
          value={l.slice}
          options={[
            { value: "off", label: "Off" },
            { value: "speed", label: "Speed" },
            { value: "pressure", label: "Pressure" },
            { value: "vorticity", label: "Swirl" },
          ]}
          onChange={(v) => set({ slice: v })}
        />
        {l.slice !== "off" && (
          <>
            <Segmented
              label="Slice direction"
              value={l.sliceAxis}
              options={[
                { value: "side", label: "Lengthways" },
                { value: "top", label: "Level" },
                { value: "front", label: "Across" },
              ]}
              onChange={(v) => set({ sliceAxis: v })}
            />
            <Slider label="Position" value={l.slicePos} min={0} max={1} step={0.005} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ slicePos: v })} />
            <Slider label="Opacity" value={l.sliceOpacity} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ sliceOpacity: v })} />
          </>
        )}
      </Section>

      <Section title="The model">
        <Segmented
          label="Model colour"
          value={l.surface}
          options={[
            { value: "pressure", label: "Pressure" },
            { value: "plain", label: "Plain" },
          ]}
          onChange={(v) => set({ surface: v })}
        />
        {props.ground !== "free" && <Toggle label="Grid on the floor" hint="Lines every metre (or ten)" checked={l.floorGrid} onChange={(v) => set({ floorGrid: v })} />}
      </Section>
    </>
  );
}
