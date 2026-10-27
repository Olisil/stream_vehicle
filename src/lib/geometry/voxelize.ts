/*
  Turning the model into tunnel cells.

  1. Surface: every cell a triangle touches is marked (triangle–box overlap, Akenine-Möller),
     so the surface is watertight at cell scale even where the mesh has small gaps.
  2. Outside: a flood fill from the open sides of the tunnel reaches every cell the wind can
     get to without crossing the surface.
  3. Solid = everything the flood didn't reach. Hollow models, loose interior parts and
     overlapping pieces all come out as one solid; openings larger than a cell let air in.

  Positions are given in lattice units: cell (i, j, k) is centred on (i, j, k) and spans ±0.5.
*/

export interface VoxelResult {
  solid: Uint8Array;
  solidCells: number;
  /** cells in the shadow seen from the front (y–z), from above (x–y) and from the side (x–z) */
  frontCells: number;
  topCells: number;
  sideCells: number;
  /** bounds of the solid, inclusive cell indices */
  min: [number, number, number];
  max: [number, number, number];
}

function axisTest(
  a: number,
  b: number,
  fa: number,
  fb: number,
  v0a: number,
  v0b: number,
  v2a: number,
  v2b: number,
  h: number,
): boolean {
  const p0 = a * v0a - b * v0b;
  const p2 = a * v2a - b * v2b;
  const mn = Math.min(p0, p2);
  const mx = Math.max(p0, p2);
  const rad = (fa + fb) * h;
  return !(mn > rad || mx < -rad);
}

/** Does the triangle (already relative to the box centre) overlap a cube of half-size h? */
function triBox(v: Float64Array, h: number): boolean {
  const v0x = v[0], v0y = v[1], v0z = v[2];
  const v1x = v[3], v1y = v[4], v1z = v[5];
  const v2x = v[6], v2y = v[7], v2z = v[8];
  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

  // nine edge cross-axis tests
  let fex = Math.abs(e0x), fey = Math.abs(e0y), fez = Math.abs(e0z);
  if (!axisTest(e0z, e0y, fez, fey, v0y, v0z, v2y, v2z, h)) return false; // X01
  if (!axisTest(-e0z, -e0x, fez, fex, v0x, v0z, v2x, v2z, h)) return false; // Y02 (sign-handled)
  if (!axisTest(e0y, e0x, fey, fex, v1x, v1y, v2x, v2y, h)) return false; // Z12
  fex = Math.abs(e1x); fey = Math.abs(e1y); fez = Math.abs(e1z);
  if (!axisTest(e1z, e1y, fez, fey, v0y, v0z, v2y, v2z, h)) return false;
  if (!axisTest(-e1z, -e1x, fez, fex, v0x, v0z, v2x, v2z, h)) return false;
  if (!axisTest(e1y, e1x, fey, fex, v0x, v0y, v1x, v1y, h)) return false;
  fex = Math.abs(e2x); fey = Math.abs(e2y); fez = Math.abs(e2z);
  if (!axisTest(e2z, e2y, fez, fey, v0y, v0z, v1y, v1z, h)) return false;
  if (!axisTest(-e2z, -e2x, fez, fex, v0x, v0z, v1x, v1z, h)) return false;
  if (!axisTest(e2y, e2x, fey, fex, v1x, v1y, v2x, v2y, h)) return false;

  // the box's own axes
  if (Math.min(v0x, v1x, v2x) > h || Math.max(v0x, v1x, v2x) < -h) return false;
  if (Math.min(v0y, v1y, v2y) > h || Math.max(v0y, v1y, v2y) < -h) return false;
  if (Math.min(v0z, v1z, v2z) > h || Math.max(v0z, v1z, v2z) < -h) return false;

  // the triangle's plane
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const d = -(nx * v0x + ny * v0y + nz * v0z);
  const r = h * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
  return Math.abs(d) <= r;
}

export function voxelize(pos: Float32Array, nx: number, ny: number, nz: number, groundSeal: boolean): VoxelResult {
  const n = nx * ny * nz;
  // 0 open, 1 surface, 2 reached from outside
  const cell = new Uint8Array(n);
  const v = new Float64Array(9);
  const h = 0.5 + 1e-6;
  for (let t = 0; t < pos.length; t += 9) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 9; k += 3) {
      const x = pos[t + k], y = pos[t + k + 1], z = pos[t + k + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const i0 = Math.max(0, Math.round(x0)), i1 = Math.min(nx - 1, Math.round(x1));
    const j0 = Math.max(0, Math.round(y0)), j1 = Math.min(ny - 1, Math.round(y1));
    const k0 = Math.max(0, Math.round(z0)), k1 = Math.min(nz - 1, Math.round(z1));
    if (i0 > i1 || j0 > j1 || k0 > k1) continue;
    const single = i0 === i1 && j0 === j1 && k0 === k1;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const idx = i + nx * (j + ny * k);
          if (cell[idx]) continue;
          if (!single) {
            for (let q = 0; q < 9; q += 3) {
              v[q] = pos[t + q] - i;
              v[q + 1] = pos[t + q + 1] - j;
              v[q + 2] = pos[t + q + 2] - k;
            }
            if (!triBox(v, h)) continue;
          }
          cell[idx] = 1;
        }
  }

  // Flood the outside, 6-connected, from the open sides of the tunnel. With a floor the bottom
  // face is not a way in: a model standing on the road is closed off by it.
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (idx: number) => {
    if (cell[idx] === 0) {
      cell[idx] = 2;
      stack[sp++] = idx;
    }
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      seed(0 + nx * (j + ny * k));
      seed(nx - 1 + nx * (j + ny * k));
    }
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      seed(i + nx * (0 + ny * k));
      seed(i + nx * (ny - 1 + ny * k));
    }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      seed(i + nx * (j + ny * (nz - 1)));
      if (!groundSeal) seed(i + nx * j);
    }
  const sxy = nx * ny;
  while (sp > 0) {
    const idx = stack[--sp];
    const i = idx % nx;
    const j = ((idx / nx) | 0) % ny;
    const k = (idx / sxy) | 0;
    if (i > 0) seed(idx - 1);
    if (i < nx - 1) seed(idx + 1);
    if (j > 0) seed(idx - nx);
    if (j < ny - 1) seed(idx + nx);
    if (k > 0) seed(idx - sxy);
    if (k < nz - 1) seed(idx + sxy);
  }

  const solid = new Uint8Array(n);
  const front = new Uint8Array(ny * nz);
  const top = new Uint8Array(nx * ny);
  const side = new Uint8Array(nx * nz);
  const min: [number, number, number] = [nx, ny, nz];
  const max: [number, number, number] = [-1, -1, -1];
  let count = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * (j + ny * k);
        if (cell[idx] === 2) continue;
        solid[idx] = 1;
        count++;
        front[j + ny * k] = 1;
        top[i + nx * j] = 1;
        side[i + nx * k] = 1;
        if (i < min[0]) min[0] = i;
        if (j < min[1]) min[1] = j;
        if (k < min[2]) min[2] = k;
        if (i > max[0]) max[0] = i;
        if (j > max[1]) max[1] = j;
        if (k > max[2]) max[2] = k;
      }
  const sum = (a: Uint8Array) => a.reduce((s, x) => s + x, 0);
  return { solid, solidCells: count, frontCells: sum(front), topCells: sum(top), sideCells: sum(side), min, max };
}
