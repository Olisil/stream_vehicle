import { exampleById } from "../src/lib/geometry/examples";
import { meshExample } from "../src/lib/geometry/mesher";
import { voxelize } from "../src/lib/geometry/voxelize";
import { canonicalMesh } from "../src/lib/geometry/mesh";
import { planTunnel, poseMesh } from "../src/lib/sim/setup";
import { newProject } from "../src/lib/types";
const cells = +(process.argv[2] ?? 40000);
const ex = exampleById("car")!;
const p = newProject("car");
const can = canonicalMesh(meshExample({ ...ex, detail: 60 }), { up: "+z", turn: 0 }, 4.25);
const posed = poseMesh(can.mesh, 0, 0, "moving");
const s = planTunnel(p, posed, { maxBuffer: cells * 76 });
const v = voxelize(s.mesh.positions, s.nx, s.ny, s.nz, true);
console.log(`grid ${s.nx}x${s.ny}x${s.nz} dx=${s.dx.toFixed(3)} solid=${v.solidCells} front=${v.frontCells} top=${v.topCells} min=${v.min} max=${v.max}`);
const y = Math.round((v.min[1] + v.max[1]) / 2);
for (let z = v.max[2] + 1; z >= 0; z--) {
  let row = "";
  for (let x = v.min[0] - 2; x <= v.max[0] + 2; x++) row += v.solid[x + s.nx * (y + s.ny * z)] ? "#" : ".";
  console.log(String(z).padStart(2), row);
}
