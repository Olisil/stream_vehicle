import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadBlob, downloadProjectFile, duplicateProject, getFile, getProject, importProjectFile, saveProject, slug, storeFile } from "../lib/db";
import { Engine, getGpu, type GpuContext, type RunStats } from "../lib/engine";
import { exampleMesh, voxelizeMesh } from "../lib/geometry/client";
import type { ExampleId } from "../lib/geometry/examples";
import { defaultUp, MODEL_EXT, ModelError, readModel } from "../lib/geometry/formats";
import { boundsOf, canonicalMesh, guessOrientation, sizeOf, type TriMesh } from "../lib/geometry/mesh";
import type { VoxelResult } from "../lib/geometry/voxelize";
import { FOV, type Orbit } from "../lib/render/camera";
import { planTunnel, poseMesh, type TunnelSetup } from "../lib/sim/setup";
import { ExportUnsupportedError, renderVideo, takeStill } from "../lib/exporter";
import { navigate } from "../router";
import { ThemeToggle } from "../theme";
import { ASPECTS, EXAMPLE_SETUPS, outputSize, VEHICLES, type Aspect, type CameraView, type Project } from "../lib/types";
import { Floating } from "./Floating";
import { HeaderNav } from "./HeaderNav";
import { Legend } from "./Legend";
import { AppLogo, APP_NAME } from "./Logo";
import { Sparkline } from "./Charts";
import { Viewport } from "./Viewport";
import { ModelPanel } from "./panels/ModelPanel";
import { TunnelPanel } from "./panels/TunnelPanel";
import { RunPanel, runStatus } from "./panels/RunPanel";
import { LookPanel } from "./panels/LookPanel";
import { ResultsPanel, type RenderState } from "./panels/ResultsPanel";

type Step = "model" | "tunnel" | "run" | "look" | "results";
const STEPS: { id: Step; label: string; next: string }[] = [
  { id: "model", label: "Model", next: "Next: set up the tunnel" },
  { id: "tunnel", label: "Tunnel", next: "Next: run the wind" },
  { id: "run", label: "Run", next: "Next: choose the look" },
  { id: "look", label: "Look", next: "Next: results & export" },
  { id: "results", label: "Results & export", next: "" },
];

const VIEWS: { id: string; label: string; yaw: number; pitch: number }[] = [
  { id: "3d", label: "3D", yaw: -140, pitch: 20 },
  { id: "side", label: "Side", yaw: -90, pitch: 2 },
  { id: "top", label: "Top", yaw: -90, pitch: 89 },
  { id: "front", label: "Front", yaw: 180, pitch: 6 },
  { id: "rear", label: "Behind", yaw: -35, pitch: 18 },
];

export function Editor({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    getProject(projectId)
      .then((p) => {
        if (!live) return;
        if (p) setProject(p);
        else setMissing(true);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (missing)
    return (
      <div className="empty-page">
        <h1>This test isn't in this browser</h1>
        <p>Tests are saved in the browser they were made in. Open the project file instead, or start a new one.</p>
        <a className="btn btn-primary" href="#/">
          Go to your tests
        </a>
      </div>
    );
  if (!project) return <div className="empty-page" aria-busy="true" />;
  return <EditorLoaded key={project.id} initial={project} />;
}

function readDark() {
  return document.documentElement.classList.contains("dark-mode");
}

function bgFor(dark: boolean): [number, number, number] {
  // the stage background: almost black in dark mode, the page grey in light mode
  return dark ? [0.055, 0.055, 0.055] : [0.86, 0.86, 0.86];
}

function viewFor(id: string, setup: TunnelSetup, base?: Orbit): Orbit {
  const v = VIEWS.find((x) => x.id === id) ?? VIEWS[0];
  const min = setup.modelMin;
  const max = setup.modelMax;
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const centre: [number, number, number] = [(min[0] + max[0]) / 2 + size[0] * 0.12, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.max(size[0] * 0.75, size[1] * 0.75, size[2] * 1.2);
  const distance = (r / Math.tan(FOV / 2)) * 1.05;
  return { yaw: v.yaw, pitch: v.pitch, distance: base ? base.distance : distance, target: centre };
}

function toView(o: Orbit, setup: TunnelSetup): CameraView {
  const L = Math.max(1, setup.modelMax[0] - setup.modelMin[0]);
  const c = setup.modelMin.map((v, i) => (v + setup.modelMax[i]) / 2);
  return { yaw: o.yaw, pitch: o.pitch, distance: o.distance / L, target: [(o.target[0] - c[0]) / L, (o.target[1] - c[1]) / L, (o.target[2] - c[2]) / L] };
}

function fromView(v: CameraView, setup: TunnelSetup): Orbit {
  const L = Math.max(1, setup.modelMax[0] - setup.modelMin[0]);
  const c = setup.modelMin.map((x, i) => (x + setup.modelMax[i]) / 2);
  return { yaw: v.yaw, pitch: v.pitch, distance: v.distance * L, target: [c[0] + v.target[0] * L, c[1] + v.target[1] * L, c[2] + v.target[2] * L] };
}

function EditorLoaded({ initial }: { initial: Project }) {
  const [project, setProject] = useState<Project>(initial);
  const [step, setStep] = useState<Step>("model");
  const [gpu, setGpu] = useState<GpuContext | null>(null);
  const [gpuError, setGpuError] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [raw, setRaw] = useState<{ key: string; mesh: TriMesh } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [loadingModel, setLoadingModel] = useState(false);
  const [building, setBuilding] = useState<string | null>("Reading the model…");
  const [stats, setStats] = useState<RunStats | null>(null);
  const [playing, setPlaying] = useState(false);
  const [orbit, setOrbit] = useState<Orbit | null>(null);
  const [dark, setDark] = useState(readDark);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [render, setRender] = useState<RenderState>({ status: "idle" });
  const [stillBusy, setStillBusy] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ top: number; right: number } | null>(null);
  const [refCells, setRefCells] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;

  const update = useCallback((fn: (p: Project) => Project) => setProject(fn), []);

  // ---- page chrome
  useEffect(() => {
    document.documentElement.classList.add("editor-open");
    return () => document.documentElement.classList.remove("editor-open");
  }, []);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(readDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  // ---- autosave
  useEffect(() => {
    const id = setTimeout(() => {
      saveProject({ ...project, updatedAt: Date.now() }).catch(() => setNotice("Couldn't save to this browser. Download the project file to keep your work."));
    }, 500);
    return () => clearTimeout(id);
  }, [project]);

  // ---- the GPU and the engine
  useEffect(() => {
    let live = true;
    getGpu()
      .then((g) => live && setGpu(g))
      .catch((e) => live && setGpuError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!gpu) return;
    const e = new Engine(gpu, projectRef.current.look);
    let last = 0;
    e.onStats = (s) => {
      const now = performance.now();
      if (now - last > 180) {
        last = now;
        setStats(s);
      }
    };
    setEngine(e);
    return () => {
      e.destroy();
      setEngine(null);
    };
  }, [gpu]);

  // ---- the model's triangles
  const modelKey = project.model.kind === "example" ? `ex:${project.model.example}` : `file:${project.model.fileId}`;
  useEffect(() => {
    let live = true;
    const m = project.model;
    setLoadingModel(true);
    setModelError(null);
    setBuilding("Reading the model…");
    (async () => {
      if (m.kind === "example") return exampleMesh(m.example);
      const f = await getFile(m.fileId);
      if (!f) throw new ModelError("The 3D file for this test isn't in this browser any more. Open it again.");
      return readModel(f.name, f.data);
    })()
      .then((mesh) => {
        if (!live) return;
        setRaw({ key: modelKey, mesh });
      })
      .catch((e) => {
        if (!live) return;
        setModelError(e instanceof Error ? e.message : String(e));
        setBuilding(null);
      })
      .finally(() => live && setLoadingModel(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  // ---- from the file to the tunnel
  const canonical = useMemo(() => (raw && raw.key === modelKey ? canonicalMesh(raw.mesh, project.orientation, project.length) : null), [raw, modelKey, project.orientation, project.length]);
  const t = project.tunnel;
  const posed = useMemo(() => (canonical ? poseMesh(canonical.mesh, t.yaw, t.pitch, t.ground) : null), [canonical, t.yaw, t.pitch, t.ground]);
  const setup = useMemo(
    () => (posed && gpu ? planTunnel(project, posed, { maxBuffer: gpu.maxBuffer }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [posed, gpu, t.quality, t.speed, t.ground, project.length, project.vehicle],
  );
  const sizeM = useMemo(() => (posed ? (sizeOf(boundsOf(posed.positions)) as [number, number, number]) : null), [posed]);

  // ---- voxelize and (re)start the run when the setup changes
  const voxCache = useRef<{ key: string; vox: VoxelResult } | null>(null);
  const loadSeq = useRef(0);
  const firstView = useRef(true);
  const orbitSetup = useRef<TunnelSetup | null>(null);
  useEffect(() => {
    if (!setup || !engine) return;
    const seq = ++loadSeq.current;
    const geomKey = `${modelKey}|${JSON.stringify(project.orientation)}|${t.yaw}|${t.pitch}|${t.ground}|${setup.nx}x${setup.ny}x${setup.nz}`;
    const timer = setTimeout(async () => {
      try {
        let vox = voxCache.current?.key === geomKey ? voxCache.current.vox : null;
        if (!vox) {
          setBuilding("Shaping the model into cells…");
          engine.setPlaying(false);
          vox = await voxelizeMesh(setup.mesh.positions, setup.nx, setup.ny, setup.nz, setup.ground !== "free");
          if (seq !== loadSeq.current) return;
          if (vox.solidCells === 0) throw new Error("The model came out empty in the tunnel. Check its size and which way is up.");
          voxCache.current = { key: geomKey, vox };
        }
        setBuilding("Starting the wind…");
        await engine.load(setup, vox);
        if (seq !== loadSeq.current) return;
        setRefCells(setup.refKind === "top" ? vox.topCells : vox.frontCells);
        if (firstView.current || !orbitRef.current || !orbitSetup.current) {
          firstView.current = false;
          const v = projectRef.current.view;
          setOrbit(v ? fromView(v, setup) : viewFor("3d", setup));
        } else if (orbitSetup.current !== setup) {
          // Same view on the new grid: cells change size when the detail or the model changes.
          setOrbit(fromView(toView(orbitRef.current, orbitSetup.current), setup));
        }
        orbitSetup.current = setup;
        setBuilding(null);
        engine.setPlaying(true);
        setPlaying(true);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setBuilding(null);
        setNotice(e instanceof Error ? e.message : String(e));
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, engine]);

  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;

  // ---- keep the engine in step with the view settings
  useEffect(() => {
    engine?.setLook(project.look);
  }, [engine, project.look]);
  useEffect(() => {
    if (engine && orbit) engine.setOrbit(orbit);
  }, [engine, orbit]);
  useEffect(() => {
    engine?.setTheme({ dark, bg: bgFor(dark) });
  }, [engine, dark]);

  // ---- stage and video frame sizing (the frame is a window in a grey passe-partout)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ratio = ASPECTS[project.output.aspect].ratio;
    const fit = () => {
      const small = window.innerWidth < 820;
      const padX = small ? 12 : 48;
      const padY = small ? 84 : 80;
      const aw = Math.max(100, el.clientWidth - padX * 2);
      const ah = Math.max(100, el.clientHeight - padY * 2);
      const w = Math.min(aw, ah * ratio);
      setStage({ w: el.clientWidth, h: el.clientHeight });
      setFrame({ w: Math.floor(w), h: Math.floor(w / ratio) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.output.aspect]);
  useEffect(() => {
    if (engine && frame.h > 0 && stage.h > 0) {
      engine.frameScale = stage.h / frame.h;
      engine.invalidate();
    }
  }, [engine, frame.h, stage.h]);

  // ---- play / restart
  const play = useCallback(
    (v: boolean) => {
      if (!engine) return;
      engine.setPlaying(v);
      setPlaying(engine.playing);
    },
    [engine],
  );
  const restart = useCallback(async () => {
    if (!engine) return;
    await engine.restart();
    setPlaying(engine.playing);
  }, [engine]);

  // ---- keyboard: space plays and pauses
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
      if (e.code === "Space") {
        e.preventDefault();
        play(!playing);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, playing]);

  // ---- project menu closing
  useEffect(() => {
    if (!projectMenu) return;
    const outside = (e: PointerEvent) => {
      if (!(e.target as Element).closest(".project-menu, .project-menu-button")) setProjectMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setProjectMenu(null);
    const away = () => setProjectMenu(null);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  // ---- model choice
  const openFile = useCallback(async (f: File) => {
    setModelError(null);
    try {
      const data = await f.arrayBuffer();
      const mesh = await readModel(f.name, data);
      const fileId = await storeFile(f.name, data);
      const up = defaultUp(f.name);
      const orientation = guessOrientation(mesh, up);
      // A size that looks like metres stays; millimetres are converted; otherwise keep the vehicle's usual length.
      const longest = Math.max(...sizeOf(boundsOf(mesh.positions)));
      const p0 = projectRef.current;
      const guess = longest >= 0.2 && longest <= 120 ? longest : longest > 120 && longest <= 30000 ? longest / 1000 : VEHICLES[p0.vehicle].length;
      firstView.current = true;
      update((p) => ({
        ...p,
        name: p.name === "Untitled test" ? f.name.replace(/\.[^.]+$/, "") : p.name,
        model: { kind: "file", fileId, fileName: f.name },
        orientation,
        length: Math.round(guess * 1000) / 1000,
        view: null,
        results: null,
      }));
      setRaw({ key: `file:${fileId}`, mesh });
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e));
    }
  }, [update]);

  const chooseExample = useCallback(
    (id: ExampleId) => {
      const ex = EXAMPLE_SETUPS[id];
      const v = VEHICLES[ex.vehicle];
      firstView.current = true;
      update((p) => ({
        ...p,
        model: { kind: "example", example: id },
        orientation: { up: ex.up, turn: 0 },
        vehicle: ex.vehicle,
        length: ex.length,
        tunnel: { ...p.tunnel, speed: ex.speed, ground: ex.ground, pitch: ex.pitch ?? 0, yaw: 0 },
        look: { ...p.look, rake: v.ref === "top" ? "horizontal" : "vertical", rakeZ: ex.rakeZ ?? 0.45, rakeY: 0, floorGrid: ex.ground !== "free" },
        view: null,
        results: null,
      }));
    },
    [update],
  );

  // ---- files dropped on the page
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragOver(true);
    };
    const leave = (e: DragEvent) => e.relatedTarget === null && setDragOver(false);
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      if (MODEL_EXT.test(f.name)) {
        setStep("model");
        openFile(f);
      } else if (/\.json$/i.test(f.name)) {
        try {
          const p = await importProjectFile(f);
          navigate(`/p/${p.id}`);
        } catch (err) {
          setNotice(err instanceof Error ? err.message : "That file couldn't be opened.");
        }
      } else setNotice("Drop a 3D file (GLB, STL, OBJ, PLY or FBX) or a project file.");
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  // ---- keep the latest numbers and a small picture with the project, for the home page
  useEffect(() => {
    if (!stats || stats.cd === null || !setup) return;
    const r = { cd: stats.cd, cl: stats.cl ?? 0, cs: stats.cs ?? 0, refArea: refCells * setup.dx * setup.dx, refKind: setup.refKind, step: stats.steps, flowThroughs: stats.flowThroughs, speed: project.tunnel.speed };
    const id = setTimeout(() => update((p) => ({ ...p, results: r })), 1500);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats?.cd, stats?.settled]);
  useEffect(() => {
    if (!engine) return;
    const grab = async () => {
      if (!engine.run || engine.paused || render.status === "rendering" || !orbitRef.current) return;
      try {
        const c = document.createElement("canvas");
        c.width = 480;
        c.height = 270;
        engine.paused = true;
        const out = document.createElement("canvas");
        out.width = 480;
        out.height = 270;
        const g = out.getContext("2d")!;
        await engine.renderOffscreen(c, orbitRef.current, 0, 0, () => g.drawImage(c, 0, 0));
        const url = out.toDataURL("image/jpeg", 0.78);
        update((p) => ({ ...p, thumb: url }));
      } catch {
        /* a thumbnail is a nicety */
      } finally {
        engine.paused = false;
        engine.endOffscreen();
      }
    };
    const first = setTimeout(grab, 8000);
    const every = setInterval(grab, 30000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [engine, render.status, update]);

  // ---- export
  const liftWord = VEHICLES[project.vehicle].ground !== "free" ? "Downforce coefficient" : "Lift coefficient";
  const startRender = async () => {
    if (!engine || !orbit) return;
    const ac = new AbortController();
    abortRef.current = ac;
    if (render.status === "done") URL.revokeObjectURL(render.url);
    setRender({ status: "rendering", frame: 0, frames: 1, elapsedMs: 0, paused: false });
    let lock: WakeLockSentinel | null = null;
    try {
      lock = (await navigator.wakeLock?.request("screen").catch(() => null)) ?? null;
      const res = await renderVideo({ engine, project, orbit, liftWord, signal: ac.signal, onProgress: (p) => setRender({ status: "rendering", ...p }) });
      setRender({ status: "done", url: URL.createObjectURL(res.blob), blob: res.blob, width: res.width, height: res.height, codec: res.codec });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") setRender({ status: "idle" });
      else setRender({ status: "error", message: err instanceof ExportUnsupportedError ? err.message : `Rendering stopped: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      lock?.release().catch(() => {});
      abortRef.current = null;
      setPlaying(engine.playing);
    }
  };
  const saveStill = async () => {
    if (!engine || !orbit) return;
    setStillBusy(true);
    try {
      const blob = await takeStill({ engine, project, orbit, stats, liftWord });
      const { width, height } = outputSize(project.output.aspect, project.output.resolution);
      downloadBlob(blob, `${slug(project.name)}-${width}x${height}.png`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setStillBusy(false);
    }
  };

  // ---- layout
  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const rendering = render.status === "rendering";
  const fx = Math.round((stage.w - frame.w) / 2);
  const fy = Math.round((stage.h - frame.h) / 2);
  const out = outputSize(project.output.aspect, project.output.resolution);
  const status = runStatus(stats, building);
  const setView = (id: string) => {
    if (!setup) return;
    const o = viewFor(id, setup, id === "3d" ? undefined : (orbit ?? undefined));
    setOrbit(o);
    update((p) => ({ ...p, view: toView(o, setup) }));
  };

  return (
    <div className={`editor${dragOver ? " is-dragover" : ""}`}>
      <header className="topbar app-header">
        <div className="app-header-start">
          <a className="app-logo" href="#/" aria-label={`${APP_NAME}, all tests`}>
            <AppLogo />
          </a>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <a className="crumb-link" href="#/">
              Tests
            </a>
            <span className="crumb-sep" aria-hidden>
              /
            </span>
            <input className="project-name" aria-label="Test name" value={project.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
          </nav>
        </div>
        <div className="topbar-end">
          <HeaderNav />
          <ThemeToggle />
        </div>
      </header>

      <div className="app-version">Version {__APP_VERSION__}</div>

      <nav className="steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <button key={s.id} type="button" className={`step${step === s.id ? " on" : ""}${i < stepIdx ? " past" : ""}`} aria-current={step === s.id ? "step" : undefined} disabled={rendering} onClick={() => setStep(s.id)}>
            <span className="step-num">{i + 1}</span>
            {s.label}
          </button>
        ))}
        <div className="steps-end">
          <button
            type="button"
            className={`icon-button project-menu-button${projectMenu ? " is-active" : ""}`}
            aria-label="Project: download or duplicate"
            title="Project"
            aria-haspopup="menu"
            aria-expanded={!!projectMenu}
            onClick={(e) => {
              if (projectMenu) return setProjectMenu(null);
              const r = e.currentTarget.getBoundingClientRect();
              const vw = document.documentElement.clientWidth;
              setProjectMenu({ top: r.bottom + 4, right: Math.max(8, Math.min(vw - r.right, vw - 198)) });
            }}
          >
            <svg viewBox="0 0 18 16" width="24" height="22" aria-hidden>
              <path
                fill="currentColor"
                d="M12.5 7.98V6.5c0-.28-.23-.5-.5-.5H9.05C7.46 6 6.11 7.05 5.66 8.49 5.56 8.19 5.5 7.87 5.5 7.5 5.5 5.57 7.07 4 9 4h3c.28 0 .5-.22.5-.5V2.02L15.81 5 12.5 7.98ZM10.5 7.5H11V9c0 .55.45 1 1 1h.12c.25 0 .48-.09.67-.26l4.34-3.91c.24-.21.37-.51.37-.83s-.13-.62-.37-.83L12.81.28A1.08 1.08 0 0 0 11 1.08V2.5H9C6.24 2.5 4 4.74 4 7.5c0 1.89 1.08 3.1 2 3.78.18.14.36.25.52.35.14.08.27.15.37.21.1.05.19.09.26.12.07.03.14.04.22.04h.08c.31 0 .56-.25.56-.56 0-.24-.17-.46-.36-.61l-.04-.03a1.4 1.4 0 0 1-.31-.3 1.97 1.97 0 0 1-.43-1.26c0-1.13.92-2.05 2.05-2.05h1.45L10.5 7.5ZM2.25 1A2.25 2.25 0 0 0 0 3.25v10.5C0 14.99 1.01 16 2.25 16h10.5c1.24 0 2.25-1.01 2.25-2.25v-2a.75.75 0 0 0-1.5 0v2c0 .42-.33.75-.75.75H2.25a.75.75 0 0 1-.75-.75V3.25c0-.42.33-.75.75-.75h2a.75.75 0 0 0 0-1.5h-2Z"
              />
            </svg>
          </button>
          {projectMenu && (
            <div className="menu project-menu" role="menu" style={{ top: projectMenu.top, right: projectMenu.right }} onMouseLeave={() => setProjectMenu(null)}>
              <button type="button" role="menuitem" onClick={() => (setProjectMenu(null), downloadProjectFile(project))}>
                Download project file
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={async () => {
                  setProjectMenu(null);
                  const copy = await duplicateProject(project);
                  navigate(`/p/${copy.id}`);
                }}
              >
                Duplicate test
              </button>
            </div>
          )}
          <select
            className="aspect-select"
            aria-label="Video shape"
            value={project.output.aspect}
            disabled={rendering}
            onChange={(e) => update((p) => ({ ...p, output: { ...p.output, aspect: e.target.value as Aspect } }))}
          >
            {(Object.keys(ASPECTS) as Aspect[]).map((a) => (
              <option key={a} value={a}>
                {ASPECTS[a].label}
              </option>
            ))}
          </select>
        </div>
      </nav>

      <aside className="panel">
        <div className="panel-body">
          {step === "model" && (
            <ModelPanel
              project={project}
              update={update}
              onFile={openFile}
              onExample={chooseExample}
              size={sizeM}
              triangles={raw ? raw.mesh.positions.length / 9 : 0}
              loading={loadingModel}
              error={modelError}
            />
          )}
          {step === "tunnel" && <TunnelPanel project={project} update={update} setup={setup} maxBuffer={gpu?.maxBuffer ?? 128 * 2 ** 20} />}
          {step === "run" && <RunPanel stats={stats} setup={setup} playing={playing} building={building} onPlay={play} onRestart={restart} liftWord="Lift (Cl)" />}
          {step === "look" && <LookPanel project={project} update={update} ground={project.tunnel.ground} />}
          {step === "results" && (
            <ResultsPanel
              project={project}
              update={update}
              stats={stats}
              setup={setup}
              refCells={refCells}
              liftWord={liftWord}
              render={render}
              onRender={startRender}
              onCancel={() => abortRef.current?.abort()}
              onDownload={() => render.status === "done" && downloadBlob(render.blob, `${slug(project.name)}-${render.height}p.mp4`)}
              onStill={saveStill}
              stillBusy={stillBusy}
            />
          )}
        </div>
        {STEPS[stepIdx].next && (
          <footer className="panel-foot">
            <button type="button" className="btn btn-primary btn-wide" disabled={rendering} onClick={() => setStep(STEPS[stepIdx + 1].id)}>
              {STEPS[stepIdx].next}
            </button>
          </footer>
        )}
      </aside>

      <main className="stage">
        <div className="stage-area" ref={stageRef}>
          {gpuError ? (
            <div className="gpu-missing" role="alert">
              <strong>The wind tunnel needs WebGPU</strong>
              <span>{gpuError}</span>
            </div>
          ) : (
            <div className="map-layer" style={{ left: 0, top: 0, width: stage.w, height: stage.h }}>
              {orbit ? (
                <Viewport
                  engine={engine}
                  orbit={orbit}
                  onOrbit={(o, done) => {
                    setOrbit(o);
                    if (done && setup) update((p) => ({ ...p, view: toView(o, setup) }));
                  }}
                  onReset={() => setView("3d")}
                />
              ) : (
                <Viewport engine={engine} orbit={{ yaw: -140, pitch: 20, distance: 100, target: [0, 0, 0] }} onOrbit={() => {}} onReset={() => {}} />
              )}
            </div>
          )}

          {frame.w > 0 && (
            <div className={`frame${rendering ? " is-rendering" : ""}`} style={{ left: fx, top: fy, width: frame.w, height: frame.h }}>
              <div className="frame-size" aria-label={`Video size ${project.output.aspect}, ${out.width} by ${out.height} pixels`}>
                {project.output.aspect} · {out.width}×{out.height}
              </div>
              {building && !gpuError && (
                <div className="getting-started building" role="status">
                  <span className="spinner" aria-hidden />
                  <strong>{building}</strong>
                </div>
              )}
              {modelError && !building && (
                <div className="getting-started no-data" role="alert">
                  <strong>The model couldn't be used</strong>
                  <span>{modelError}</span>
                </div>
              )}
            </div>
          )}

          {!gpuError && setup && (
            <Floating id="views" className="pos-toolbar" bounds={stage}>
              <div className="map-toolbar">
                <div className="segmented" role="group" aria-label="View">
                  {VIEWS.map((v) => (
                    <button key={v.id} type="button" onClick={() => setView(v.id)}>
                      <span className="seg-label">{v.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </Floating>
          )}
          {!gpuError && setup && (
            <Floating id="legend" className="pos-legend" bounds={stage}>
              <Legend look={project.look} speed={project.tunnel.speed} dark={dark} />
            </Floating>
          )}
          {dragOver && <div className="drop-veil">Drop a 3D file or a project file</div>}
        </div>

        <div className="timeline">
          <button type="button" className="play" onClick={() => play(!playing)} disabled={!stats || !!building || rendering} aria-label={playing ? "Pause the wind" : "Start the wind"}>
            {playing ? (
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
                <rect x="4" y="3" width="4" height="14" rx="1" fill="currentColor" />
                <rect x="12" y="3" width="4" height="14" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
                <path d="M5 3.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 5 3.5Z" fill="currentColor" />
              </svg>
            )}
          </button>
          <span className={`run-chip tone-${status.tone}`}>
            <span className="status-dot" aria-hidden />
            {status.label}
          </span>
          <span className="time">
            {stats ? (
              <>
                {stats.flowThroughs.toFixed(1)}× <span className="time-total">through the tunnel</span>
              </>
            ) : (
              <span className="time-total">—</span>
            )}
          </span>
          <div className="timeline-cd">
            {stats && <Sparkline history={stats.history} />}
            <span className="cd-value">{stats?.cd !== null && stats?.cd !== undefined ? `Cd ${stats.cd.toFixed(3)}` : stats && stats.history.length ? `Cd ${stats.history[stats.history.length - 1].cd.toFixed(2)}…` : ""}</span>
          </div>
          <button type="button" className="btn btn-small" disabled={!stats || !!building || rendering} onClick={restart}>
            Start over
          </button>
        </div>
      </main>

      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
