import { useEffect, useRef, useState } from "react";
import { deleteProject, downloadProjectFile, duplicateProject, importProjectFile, listProjects, saveProject, storeFile } from "../lib/db";
import { EXAMPLES, type ExampleId } from "../lib/geometry/examples";
import { ACCEPT, defaultUp, MODEL_EXT, readModel } from "../lib/geometry/formats";
import { boundsOf, guessOrientation, sizeOf } from "../lib/geometry/mesh";
import { EXAMPLE_SETUPS, newProject, VEHICLES, type Project } from "../lib/types";
import { navigate } from "../router";
import { ThemeToggle } from "../theme";
import { HeaderNav } from "./HeaderNav";
import { AppLogo, APP_NAME } from "./Logo";

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const SHAPES = import.meta.glob("../assets/shapes/*.png", { eager: true, import: "default" }) as Record<string, string>;

function ExampleThumb({ id }: { id: ExampleId }) {
  const url = SHAPES[`../assets/shapes/${id}.png`];
  return url ? <img className="thumb thumb-shape" src={url} alt="" /> : <div className="thumb thumb-empty" />;
}

export function Home() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const gpuOk = typeof navigator !== "undefined" && "gpu" in navigator;

  const refresh = () =>
    listProjects()
      .then(setProjects)
      .catch(() => {
        setProjects([]);
        setError("This browser won't let the app save tests. Private windows often block it; try a normal window.");
      });
  useEffect(() => {
    refresh();
  }, []);

  const create = async (example: ExampleId = "car") => {
    const p = newProject(example);
    const ex = EXAMPLES.find((e) => e.id === example);
    if (ex) p.name = ex.name;
    await saveProject(p);
    navigate(`/p/${p.id}`);
  };

  const openModel = async (f: File) => {
    setError(null);
    setBusy(`Reading ${f.name}…`);
    try {
      const data = await f.arrayBuffer();
      const mesh = await readModel(f.name, data);
      const fileId = await storeFile(f.name, data);
      const p = newProject("car");
      const longest = Math.max(...sizeOf(boundsOf(mesh.positions)));
      p.name = f.name.replace(/\.[^.]+$/, "");
      p.model = { kind: "file", fileId, fileName: f.name };
      p.orientation = guessOrientation(mesh, defaultUp(f.name));
      p.length = Math.round((longest >= 0.2 && longest <= 120 ? longest : longest > 120 && longest <= 30000 ? longest / 1000 : VEHICLES.car.length) * 1000) / 1000;
      await saveProject(p);
      navigate(`/p/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be opened.");
    } finally {
      setBusy(null);
    }
  };

  const open = async (f: File) => {
    if (MODEL_EXT.test(f.name)) return openModel(f);
    try {
      const p = await importProjectFile(f);
      navigate(`/p/${p.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be opened.");
    }
  };

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => e.relatedTarget === null && setDragOver(false);
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) open(f);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  });

  return (
    <div className="home">
      <header className="topbar app-header home-header">
        <div className="app-header-start">
          <a className="app-logo" href="#/" aria-label={APP_NAME}>
            <AppLogo />
          </a>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <span className="crumb-current">Tests</span>
          </nav>
        </div>
        <div className="topbar-end">
          <HeaderNav />
          <ThemeToggle />
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <h1>A wind tunnel in your browser</h1>
          <p className="lead">
            Drop in a 3D model of a car, a bike, a plane or an airship and watch the air flow around it: smoke lines, pressure on the body, the wake behind it, and the drag and lift it
            makes. It runs on your own graphics card, and you can render the result as a video.
          </p>
          {!gpuOk && (
            <p className="error" role="alert">
              This browser can't run the tunnel: it needs WebGPU. Use a recent Chrome or Edge on a computer, or Safari 26 on a Mac.
            </p>
          )}
          <div className="button-group">
            <button type="button" className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              Open a 3D model
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={`${ACCEPT},.json`}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) open(f);
              }}
            />
            <button type="button" className="btn btn-secondary" onClick={() => create("car")}>
              Try it with a car
            </button>
          </div>
          <p className="hint">Free, no account. GLB, glTF, STL, OBJ, PLY or FBX. Tests are saved in this browser; download a project file to move one to another computer.</p>
          {busy && <p className="hint">{busy}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="home-projects" aria-labelledby="projects-title">
          <div className="home-projects-head">
            <h2 id="projects-title">Your tests</h2>
            {projects && projects.length > 0 && (
              <span className="pill">
                {projects.length} {projects.length === 1 ? "test" : "tests"}
              </span>
            )}
          </div>
          {projects === null ? null : projects.length === 0 ? (
            <div className="empty">
              <p>No tests yet. Open a 3D model, or start from one of the shapes below.</p>
            </div>
          ) : (
            <ul className="cards">
              {projects.map((p) => (
                <li key={p.id} className="card">
                  <a className="card-open" href={`#/p/${p.id}`}>
                    {p.thumb ? <img className="thumb" src={p.thumb} alt="" /> : <div className="thumb thumb-empty">No run yet</div>}
                    <span className="card-name">{p.name || "Untitled test"}</span>
                  </a>
                  <div className="card-meta">
                    <span className="pill">{p.results ? `Cd ${p.results.cd.toFixed(2)}` : VEHICLES[p.vehicle].label}</span>
                    <span className="card-time">
                      {p.tunnel.speed} km/h · Edited {ago(p.updatedAt)}
                    </span>
                  </div>
                  <div className="card-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={async () => {
                        await duplicateProject(p);
                        refresh();
                      }}
                    >
                      Duplicate
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => downloadProjectFile(p)}>
                      Download file
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-quiet btn-danger"
                      onClick={async () => {
                        if (!confirm(`Delete ${p.name}? It's removed from this browser. Download the project file first if you want to keep it.`)) return;
                        await deleteProject(p.id);
                        refresh();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="home-projects home-history" aria-labelledby="shapes-title">
          <div className="home-projects-head">
            <h2 id="shapes-title">Start from a shape</h2>
            <span className="pill">{EXAMPLES.length} shapes</span>
          </div>
          <p className="hint">Each opens as a new test with the usual setup for that kind of vehicle.</p>
          <ul className="cards">
            {EXAMPLES.map((ex) => (
              <li key={ex.id} className="card">
                <button type="button" className="card-open" onClick={() => create(ex.id)}>
                  <ExampleThumb id={ex.id} />
                  <span className="card-name">{ex.name}</span>
                </button>
                <div className="card-meta">
                  <span className="pill">{VEHICLES[EXAMPLE_SETUPS[ex.id].vehicle].label}</span>
                  <span className="card-time">{ex.blurb}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="home-foot">
        <span>Lattice Boltzmann solver running on your graphics card with WebGPU</span>
        <a href="/">nassau.se</a>
      </footer>
      {dragOver && <div className="drop-veil">Drop a 3D model or a project file</div>}
    </div>
  );
}
