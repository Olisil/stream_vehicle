import { Engine, getGpu } from "../src/lib/engine";
import { exampleById } from "../src/lib/geometry/examples";
import { meshExample } from "../src/lib/geometry/mesher";
import { voxelize } from "../src/lib/geometry/voxelize";
import { canonicalMesh } from "../src/lib/geometry/mesh";
import { planTunnel, poseMesh } from "../src/lib/sim/setup";
import { DEFAULT_LOOK, EXAMPLE_SETUPS, newProject, type ExampleId, type Look } from "../src/lib/types";
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += s + "\n"; console.log(s); };
const q = new URLSearchParams(location.search);
const id = (q.get("ex") ?? "car") as ExampleId;
const cells = +(q.get("cells") ?? 60000);
const steps = +(q.get("steps") ?? 1500);
(async () => {
  const gpu = await getGpu();
  const ex = exampleById(id)!;
  const s = EXAMPLE_SETUPS[id];
  const p = newProject(id);
  if (q.get("ground")) p.tunnel.ground = q.get("ground") as "free" | "fixed" | "moving";
  const can = canonicalMesh(meshExample({ ...ex, detail: 60 }), { up: "+z", turn: 0 }, s.length);
  const posed = poseMesh(can.mesh, 0, s.pitch ?? 0, p.tunnel.ground);
  const setup = planTunnel(p, posed, { maxBuffer: cells * 76 });
  if (q.get("nu")) setup.nu = +q.get("nu")!;
  const vox = voxelize(setup.mesh.positions, setup.nx, setup.ny, setup.nz, setup.ground !== "free");
  log(`grid ${setup.nx}x${setup.ny}x${setup.nz} solid=${vox.solidCells}`);
  const look: Look = { ...p.look, density: 3, trail: 30 };
  const e = new Engine(gpu, look);
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  e.attach(canvas);
  e.paused = true; // drive frames by hand
  await e.load(setup, vox);
  const L = setup.modelMax[0] - setup.modelMin[0];
  const c = setup.modelMin.map((v, i) => (v + setup.modelMax[i]) / 2) as [number, number, number];
  const orbit = { yaw: -140, pitch: 20, distance: L * 3.3, target: [c[0] + L * 0.12, c[1], c[2]] as [number, number, number] };
  // run the flow, moving the smoke as it goes
  const per = 10;
  for (let k = 0; k < steps; k += per) {
    canvas.width = 960; canvas.height = 540;
    await e.renderOffscreen(canvas, orbit, per, k / 30);
    if (k % 300 === 0) { const st = e.stats(); log(`step ${k} cd=${st?.history.at(-1)?.cd.toFixed(3)} avg=${st?.cd?.toFixed(3)} bad=${e.run?.samples.at(-1)?.bad}`); }
  }
  const st = e.stats()!;
  log(`final avg Cd=${st.cd?.toFixed(3)} Cl=${st.cl?.toFixed(3)} flowThroughs=${st.flowThroughs.toFixed(2)} bad=${e.run?.samples.at(-1)?.bad}`);
  (window as any).__engine = e; (window as any).__orbit = orbit; (window as any).__look = look;
  (window as any).__frame = async (patch: Partial<Look>, o?: Partial<typeof orbit>) => {
    e.setLook({ ...look, ...patch });
    await e.renderOffscreen(canvas, { ...orbit, ...(o ?? {}) }, 0, 0);
  };
  (window as any).__done = { ok: true };
})().catch((err) => { log("ERR " + err.message + "\n" + err.stack); (window as any).__done = { err: String(err) }; });
