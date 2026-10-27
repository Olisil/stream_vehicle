import type { Example } from "./examples";
import type { TriMesh } from "./mesh";

/*
  Marching tetrahedra over a signed distance function: each grid cube is split into six
  tetrahedra along its main diagonal, so no lookup tables are needed. Only cubes whose corners
  change sign are visited. Normals come from the gradient of the distance function, which also
  decides which way each triangle faces.
*/

const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const TETS = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
];

export function meshExample(ex: Example): TriMesh {
  const f = ex.sdf;
  const size = [ex.max[0] - ex.min[0], ex.max[1] - ex.min[1], ex.max[2] - ex.min[2]];
  const h = Math.max(...size) / ex.detail;
  const nx = Math.ceil(size[0] / h) + 1;
  const ny = Math.ceil(size[1] / h) + 1;
  const nz = Math.ceil(size[2] / h) + 1;
  const vals = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) vals[i + nx * (j + ny * k)] = f(ex.min[0] + i * h, ex.min[1] + j * h, ex.min[2] + k * h);

  const pos: number[] = [];
  const nrm: number[] = [];
  const e = h * 0.25;
  const grad = (x: number, y: number, z: number): [number, number, number] => {
    const gx = f(x + e, y, z) - f(x - e, y, z);
    const gy = f(x, y + e, z) - f(x, y - e, z);
    const gz = f(x, y, z + e) - f(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  };
  const cp = new Float64Array(8 * 3);
  const cv = new Float64Array(8);
  const tri = (a: number[], b: number[], c: number[]) => {
    // Face outwards: along the distance function's gradient at the corners.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    if (fx * fx + fy * fy + fz * fz < 1e-20) return;
    const na = grad(a[0], a[1], a[2]);
    const nb = grad(b[0], b[1], b[2]);
    const nc = grad(c[0], c[1], c[2]);
    const out = fx * (na[0] + nb[0] + nc[0]) + fy * (na[1] + nb[1] + nc[1]) + fz * (na[2] + nb[2] + nc[2]) >= 0;
    const pts = out ? [a, b, c] : [a, c, b];
    const ns = out ? [na, nb, nc] : [na, nc, nb];
    for (let q = 0; q < 3; q++) {
      pos.push(pts[q][0], pts[q][1], pts[q][2]);
      nrm.push(ns[q][0], ns[q][1], ns[q][2]);
    }
  };
  const lerp = (a: number, b: number) => {
    const va = cv[a];
    const vb = cv[b];
    const t = va / (va - vb);
    return [cp[a * 3] + (cp[b * 3] - cp[a * 3]) * t, cp[a * 3 + 1] + (cp[b * 3 + 1] - cp[a * 3 + 1]) * t, cp[a * 3 + 2] + (cp[b * 3 + 2] - cp[a * 3 + 2]) * t];
  };

  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CORNERS[c];
          const v = vals[i + di + nx * (j + dj + ny * (k + dk))];
          cv[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        for (let c = 0; c < 8; c++) {
          cp[c * 3] = ex.min[0] + (i + CORNERS[c][0]) * h;
          cp[c * 3 + 1] = ex.min[1] + (j + CORNERS[c][1]) * h;
          cp[c * 3 + 2] = ex.min[2] + (k + CORNERS[c][2]) * h;
        }
        for (const t of TETS) {
          const ins = t.filter((c) => cv[c] < 0);
          const outs = t.filter((c) => cv[c] >= 0);
          if (ins.length === 1 || ins.length === 3) {
            const lone = ins.length === 1 ? ins[0] : outs[0];
            const rest = ins.length === 1 ? outs : ins;
            tri(lerp(lone, rest[0]), lerp(lone, rest[1]), lerp(lone, rest[2]));
          } else if (ins.length === 2) {
            const p0 = lerp(ins[0], outs[0]);
            const p1 = lerp(ins[0], outs[1]);
            const p2 = lerp(ins[1], outs[0]);
            const p3 = lerp(ins[1], outs[1]);
            tri(p0, p1, p3);
            tri(p0, p3, p2);
          }
        }
      }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm) };
}
