import { Lbm } from "../src/lib/sim/lbm";
import { exampleById } from "../src/lib/geometry/examples";
import { meshExample } from "../src/lib/geometry/mesher";
import { voxelize } from "../src/lib/geometry/voxelize";
import { canonicalMesh } from "../src/lib/geometry/mesh";
import { planTunnel, poseMesh } from "../src/lib/sim/setup";
import { newProject, type ExampleId } from "../src/lib/types";
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += s + "\n"; console.log(s); };
const q = new URLSearchParams(location.search);
(async () => {
  const id = (q.get("ex") ?? "car") as ExampleId;
  const ground = (q.get("ground") ?? "moving") as "free" | "fixed" | "moving";
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize } });
  const p = newProject(id); p.tunnel.ground = ground;
  const can = canonicalMesh(meshExample({ ...exampleById(id)!, detail: 60 }), { up: "+z", turn: 0 }, p.length);
  const s = planTunnel(p, poseMesh(can.mesh, 0, 0, ground), { maxBuffer: +(q.get("cells") ?? 40000) * 76 });
  const v = voxelize(s.mesh.positions, s.nx, s.ny, s.nz, ground !== "free");
  const lbm = await Lbm.create(device, { nx: s.nx, ny: s.ny, nz: s.nz, solid: v.solid, uLattice: s.uLattice, nu: +(q.get("nu") ?? s.nu), cs: s.cs, ground, sides: (q.get("sides") ?? "stream") as "open" | "stream",
    forceBox: [Math.max(0, v.min[0] - 2), Math.max(0, v.min[1] - 2), Math.max(0, v.min[2] - 2), Math.min(s.nx, v.max[0] + 3), Math.min(s.ny, v.max[1] + 3), Math.min(s.nz, v.max[2] + 3)] });
  const qd = 0.5 * s.uLattice * s.uLattice;
  log(`grid ${s.nx}x${s.ny}x${s.nz} model x ${v.min[0]}..${v.max[0]} z ${v.min[2]}..${v.max[2]} front=${v.frontCells}`);
  const steps = +(q.get("steps") ?? 1000);
  for (let k = 0; k < steps; k += 100) { lbm.step(100); const f = await lbm.readForce(); log(`step ${f!.step} Cd=${(f!.fx / (qd * v.frontCells)).toFixed(3)} Cl=${(f!.fz / (qd * v.frontCells)).toFixed(3)} bad=${f!.bad}`); }
  const m = await lbm.readMacro();
  const at = (x: number, y: number, z: number) => m[4 * (x + s.nx * (y + s.ny * z))];
  const cp = (r: number) => ((r - 1) / 3 / qd).toFixed(2);
  const yc = Math.round((v.min[1] + v.max[1]) / 2), zt = Math.min(s.nz - 2, v.max[2] + 3);
  let row = "Cp along x above the car: ";
  for (let x = 0; x < s.nx; x += 4) row += cp(at(x, yc, zt)) + " ";
  log(row);
  row = "Cp along x at the side (y=1, mid height): ";
  for (let x = 0; x < s.nx; x += 4) row += cp(at(x, 1, Math.round(s.nz / 2))) + " ";
  log(row);
  // pressure just in front of and behind the car, centreline
  const zm = Math.round((v.min[2] + v.max[2]) / 2);
  log(`front Cp (x=${v.min[0] - 1}): ${cp(at(v.min[0] - 1, yc, zm))}  rear Cp (x=${v.max[0] + 1}): ${cp(at(v.max[0] + 1, yc, zm))}`);
  let col = "Cp column in front of car z=0..: ";
  for (let z = 0; z < s.nz; z++) col += cp(at(v.min[0] - 1, yc, z)) + " ";
  log(col);
  col = "ux/u0 under the car (x mid) z=0..3: ";
  const xm = Math.round((v.min[0] + v.max[0]) / 2);
  for (let z = 0; z < 4; z++) col += (m[4 * (xm + s.nx * (yc + s.ny * z)) + 1] / s.uLattice).toFixed(2) + " ";
  log(col);
  (window as any).__done = 1;
})().catch((e) => { log("ERR " + e.message); (window as any).__done = 1; });
