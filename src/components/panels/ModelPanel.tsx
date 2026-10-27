import { useRef } from "react";
import { EXAMPLES, type ExampleId } from "../../lib/geometry/examples";
import { ACCEPT, FORMATS } from "../../lib/geometry/formats";
import type { UpAxis } from "../../lib/geometry/mesh";
import { VEHICLE_KINDS, VEHICLES, type Project, type VehicleKind } from "../../lib/types";
import { Field, Section, Segmented } from "../Controls";

const UPS: { value: UpAxis; label: string }[] = [
  { value: "+z", label: "Z up" },
  { value: "+y", label: "Y up" },
  { value: "-y", label: "−Y up" },
  { value: "+x", label: "X up" },
];

function fmtLen(m: number) {
  if (m >= 10) return `${m.toFixed(1)} m`;
  if (m >= 1) return `${m.toFixed(2)} m`;
  return `${Math.round(m * 1000)} mm`;
}

export function ModelPanel(props: {
  project: Project;
  update: (fn: (p: Project) => Project) => void;
  onFile: (f: File) => void;
  onExample: (id: ExampleId) => void;
  size: [number, number, number] | null;
  triangles: number;
  loading: boolean;
  error: string | null;
}) {
  const { project, update } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const o = project.orientation;
  const setTurn = (d: number) => update((p) => ({ ...p, orientation: { ...p.orientation, turn: ((((p.orientation.turn + d) % 360) + 360) % 360) as 0 | 90 | 180 | 270 } }));

  return (
    <>
      <header className="panel-intro">
        <h2>Model</h2>
        <p>Drop in a 3D file of your vehicle, or start from one of the shapes below. Turn it so the nose points into the wind.</p>
      </header>

      <Section title="3D file">
        <div className="file-row">
          <div className="file-name">
            {project.model.kind === "file" ? project.model.fileName : (EXAMPLES.find((e) => e.id === (project.model as { example: string }).example)?.name ?? "Example")}
            {props.triangles > 0 && <span className="file-meta">{props.triangles.toLocaleString("en")} triangles</span>}
          </div>
          <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()}>
            Open a 3D file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) props.onFile(f);
            }}
          />
        </div>
        <p className="hint">{FORMATS}. One closed shape works best; small gaps are sealed automatically. Or drop the file on the page.</p>
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
      </Section>

      <Section title="Or start from a shape">
        <div className="example-grid">
          {EXAMPLES.map((ex) => {
            const on = project.model.kind === "example" && project.model.example === ex.id;
            return (
              <button key={ex.id} type="button" className={`example${on ? " on" : ""}`} aria-pressed={on} onClick={() => props.onExample(ex.id)} title={ex.blurb}>
                {ex.name}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Which way is up" hint="Blender exports glTF, OBJ and FBX with Y up, STL with Z up.">
        <Segmented label="Up axis" value={o.up} options={UPS} onChange={(up) => update((p) => ({ ...p, orientation: { ...p.orientation, up } }))} />
      </Section>

      <Section title="Into the wind" hint="The wind blows in along the arrow at the front of the tunnel. Turn the model until its nose faces the arrow.">
        <div className="button-row">
          <button type="button" className="btn btn-small" onClick={() => setTurn(90)}>
            Turn left
          </button>
          <button type="button" className="btn btn-small" onClick={() => setTurn(180)}>
            Turn around
          </button>
          <button type="button" className="btn btn-small" onClick={() => setTurn(-90)}>
            Turn right
          </button>
        </div>
      </Section>

      <Section title="What is it">
        <select
          className="vehicle-select"
          aria-label="Vehicle type"
          value={project.vehicle}
          onChange={(e) => {
            const v = e.target.value as VehicleKind;
            const info = VEHICLES[v];
            update((p) => ({
              ...p,
              vehicle: v,
              tunnel: { ...p.tunnel, ground: info.ground, speed: Math.min(info.maxSpeed, p.tunnel.speed), pitch: info.pitch ? p.tunnel.pitch : 0 },
              look: { ...p.look, floorGrid: info.ground !== "free" },
            }));
          }}
        >
          {VEHICLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {VEHICLES[k].label}
            </option>
          ))}
        </select>
        <p className="hint">Sets the ground and the usual speeds. {VEHICLES[project.vehicle].ref === "top" ? "Coefficients use the area seen from above (the wing)." : "Coefficients use the area seen from the front."}</p>
      </Section>

      <Section title="Real length" hint="Along the wind, nose to tail. The file's own units don't matter.">
        <Field label="Length in metres">
          <input
            className="input"
            type="number"
            min={0.01}
            max={2000}
            step={0.01}
            value={project.length}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) update((p) => ({ ...p, length: v }));
            }}
          />
        </Field>
        {props.size && (
          <p className="hint">
            {fmtLen(props.size[0])} long, {fmtLen(props.size[1])} wide, {fmtLen(props.size[2])} high.
          </p>
        )}
      </Section>
      {props.loading && <p className="hint">Reading the model…</p>}
    </>
  );
}
