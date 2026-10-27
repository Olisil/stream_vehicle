import { EXAMPLES } from "../src/lib/geometry/examples";
import { meshExample } from "../src/lib/geometry/mesher";
import { voxelize } from "../src/lib/geometry/voxelize";
import { canonicalMesh, boundsOf, sizeOf } from "../src/lib/geometry/mesh";
import { planTunnel, poseMesh } from "../src/lib/sim/setup";
import { newProject, EXAMPLE_SETUPS } from "../src/lib/types";
for (const ex of EXAMPLES) {
  let t = performance.now();
  const m = meshExample(ex);
  const tm = performance.now() - t;
  const s = EXAMPLE_SETUPS[ex.id];
  const p = newProject(ex.id);
  const can = canonicalMesh(m, { up: "+z", turn: 0 }, s.length);
  const posed = poseMesh(can.mesh, 0, s.pitch ?? 0, s.ground);
  const setup = planTunnel(p, posed, { maxBuffer: 1 << 30 });
  t = performance.now();
  const v = voxelize(setup.mesh.positions, setup.nx, setup.ny, setup.nz, setup.ground !== "free");
  const tv = performance.now() - t;
  const sz = sizeOf(boundsOf(can.mesh.positions)).map((x) => x.toFixed(2)).join("×");
  console.log(`${ex.id.padEnd(8)} tris=${(m.positions.length / 9) | 0} mesh=${tm.toFixed(0)}ms size=${sz}m grid=${setup.nx}x${setup.ny}x${setup.nz} dx=${(setup.dx * 100).toFixed(1)}cm along=${setup.cellsAlong.toFixed(0)} vox=${tv.toFixed(0)}ms solid=${v.solidCells} front=${v.frontCells} top=${v.topCells} Re=${setup.reynolds.toExponential(1)} ReGrid=${setup.reynoldsGrid.toExponential(1)} box=${v.min}..${v.max}`);
}
