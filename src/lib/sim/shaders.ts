/*
  WGSL for the wind tunnel: a D3Q19 lattice Boltzmann solver.

  Layout: the grid is nx × ny × nz cells. x runs with the wind (inlet at x = 0, outlet at
  x = nx − 1), y across, z up. Cell index = x + nx·(y + ny·z). Distributions are stored as
  structure-of-arrays, f[i·n + cell], in two buffers that swap every step ("pull" streaming).

  One kernel does a whole step for a cell: pull the 19 populations from the neighbours, then
  collide with BGK plus a Smagorinsky eddy viscosity, which keeps the run stable at the very low
  viscosities real vehicles need. Boundaries: free-stream inlet; open (zero-gradient) outlet,
  sides and top, with a weak pull towards atmospheric pressure at the outlet; a sponge band of
  extra viscosity along them that soaks up pressure waves; a fixed or moving floor (held still
  right under the body), or none; bounce-back on the model. The stored values are post-collision,
  which is what the momentum-exchange force sum needs.
*/

export const WORKGROUP = 64;

const common = /* wgsl */ `
struct Params {
  nx: u32, ny: u32, nz: u32, n: u32,
  uIn: f32,        // inlet velocity, lattice units (ramped up at the start)
  tau0: f32,       // relaxation time from the molecular viscosity
  smag: f32,       // Smagorinsky constant squared × 18√2, premultiplied
  ground: u32,     // 0 free air, 1 fixed floor, 2 moving floor
  groundU: f32,    // floor speed along x (lattice units)
  rowStride: u32,  // threads per dispatch row (for 2D dispatch)
  bx0: u32, by0: u32, bz0: u32,   // force box origin
  bx1: u32, by1: u32, bz1: u32,   // force box end (exclusive)
  side: u32,       // sides and top: 0 free stream, 1 open (zero gradient)
  refIdx: u32,     // a cell out in the free stream: the reference pressure for forces
  pad1: u32, pad2: u32,
};

const CX = array<i32, 19>(0, 1,-1, 0, 0, 0, 0, 1,-1, 1,-1, 0, 0, 1,-1, 1,-1, 0, 0);
const CY = array<i32, 19>(0, 0, 0, 1,-1, 0, 0, 1,-1, 0, 0, 1,-1,-1, 1, 0, 0, 1,-1);
const CZ = array<i32, 19>(0, 0, 0, 0, 0, 1,-1, 0, 0, 1,-1, 1,-1, 0, 0,-1, 1,-1, 1);
const OPP = array<u32, 19>(0u, 2u, 1u, 4u, 3u, 6u, 5u, 8u, 7u, 10u, 9u, 12u, 11u, 14u, 13u, 16u, 15u, 18u, 17u);
const W = array<f32, 19>(
  1.0/3.0,
  1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0);

fn feq(i: u32, rho: f32, u: vec3<f32>) -> f32 {
  let c = vec3<f32>(f32(CX[i]), f32(CY[i]), f32(CZ[i]));
  let cu = dot(c, u);
  return W[i] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * dot(u, u));
}
`;

export const stepShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fin: array<f32>;
@group(0) @binding(2) var<storage, read_write> fout: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> bad: atomic<u32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * P.rowStride;
  if (idx >= P.n) { return; }
  let nx = P.nx; let ny = P.ny; let n = P.n;
  let x = i32(idx % nx);
  let y = i32((idx / nx) % ny);
  let z = i32(idx / (nx * ny));
  let uInf = vec3<f32>(P.uIn, 0.0, 0.0);

  if (solid[idx] != 0u) {
    for (var i = 0u; i < 19u; i++) { fout[i * n + idx] = W[i]; }
    mac[idx] = vec4<f32>(1.0, 0.0, 0.0, 0.0);
    return;
  }

  // The road moves, except in the strip right under the body: there the gap is too thin for the
  // grid, and a moving floor one cell below a still body would drag on it like a conveyor belt.
  var roadU = P.groundU;
  if (z == 0 && P.nz > 1u && solid[idx + nx * ny] != 0u) { roadU = 0.0; }

  var f: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    let sx = x - CX[i];
    let sy = y - CY[i];
    let sz = z - CZ[i];
    if (sx < 0) {
      f[i] = feq(i, 1.0, uInf);                       // inlet: free stream
      continue;
    }
    if (sz < 0 && P.ground != 0u) {
      // floor: bounce-back, moving with the road when the ground moves
      f[i] = fin[OPP[i] * n + idx] + 6.0 * W[i] * f32(CX[i]) * roadU;
      continue;
    }
    let lateral = sy < 0 || sy >= i32(ny) || sz < 0 || sz >= i32(P.nz);
    if (lateral && P.side == 0u) {
      f[i] = feq(i, 1.0, uInf);                        // far field held at the free stream
      continue;
    }
    if (sx >= i32(nx)) {
      // outlet: zero gradient (the population comes from the nearest cell inside), nudged gently
      // towards atmospheric pressure so the tunnel's pressure level can't wander off
      let s = u32(nx - 1) + nx * (u32(clamp(sy, 0, i32(ny) - 1)) + ny * u32(clamp(sz, 0, i32(P.nz) - 1)));
      let m0 = mac[idx];
      f[i] = select(fin[i * n + s], feq(i, 1.0, uInf), solid[s] != 0u) + 0.001 * (1.0 - m0.x) * feq(i, 1.0, m0.yzw);
      continue;
    }
    if (lateral) {
      // open sides: zero gradient, the population comes from the nearest cell inside
      let cx = clamp(sx, 0, i32(nx) - 1);
      let cy = clamp(sy, 0, i32(ny) - 1);
      let cz = clamp(sz, 0, i32(P.nz) - 1);
      let s = u32(cx) + nx * (u32(cy) + ny * u32(cz));
      f[i] = select(fin[i * n + s], feq(i, 1.0, uInf), solid[s] != 0u);
      continue;
    }
    let s = u32(sx) + nx * (u32(sy) + ny * u32(sz));
    if (solid[s] != 0u) {
      f[i] = fin[OPP[i] * n + idx];                    // the model: bounce back
    } else {
      f[i] = fin[i * n + s];
    }
  }

  var rho = 0.0;
  var m = vec3<f32>(0.0);
  for (var i = 0u; i < 19u; i++) {
    rho += f[i];
    m += f[i] * vec3<f32>(f32(CX[i]), f32(CY[i]), f32(CZ[i]));
  }
  // A cell that has gone bad (NaN, or far off) is put back to the free stream.
  if (!(rho > 0.3 && rho < 3.0)) {
    atomicAdd(&bad, 1u);
    for (var i = 0u; i < 19u; i++) { fout[i * n + idx] = feq(i, 1.0, uInf); }
    mac[idx] = vec4<f32>(1.0, uInf);
    return;
  }
  var u = m / rho;
  let sp = length(u);
  if (sp > 0.3) { u = u * (0.3 / sp); }

  // Smagorinsky: eddy viscosity from the non-equilibrium momentum flux.
  var pxx = 0.0; var pyy = 0.0; var pzz = 0.0; var pxy = 0.0; var pxz = 0.0; var pyz = 0.0;
  var fe: array<f32, 19>;
  for (var i = 0u; i < 19u; i++) {
    fe[i] = feq(i, rho, u);
    let d = f[i] - fe[i];
    let cx = f32(CX[i]); let cy = f32(CY[i]); let cz = f32(CZ[i]);
    pxx += cx * cx * d; pyy += cy * cy * d; pzz += cz * cz * d;
    pxy += cx * cy * d; pxz += cx * cz * d; pyz += cy * cz * d;
  }
  let q = sqrt(pxx * pxx + pyy * pyy + pzz * pzz + 2.0 * (pxy * pxy + pxz * pxz + pyz * pyz));
  // Sponge: extra viscosity in a band along the inlet, the outlet and the far sides, so pressure
  // waves are soaked up there instead of bouncing round the tunnel. The model never sits in it.
  let rx = f32(x) / f32(nx - 1u);
  let ry = abs(f32(y) / f32(ny - 1u) - 0.5) * 2.0;
  let rz = f32(z) / f32(P.nz - 1u);
  var sponge = smoothstep(0.88, 1.0, rx) + (1.0 - smoothstep(0.0, 0.06, rx)) + smoothstep(0.82, 1.0, ry) + smoothstep(0.85, 1.0, rz);
  if (P.ground == 0u) { sponge += 1.0 - smoothstep(0.0, 0.15, rz); }
  let t0 = P.tau0 + 0.35 * min(sponge, 1.0);
  let tau = 0.5 * (t0 + sqrt(t0 * t0 + P.smag * q / rho));
  let om = 1.0 / tau;

  for (var i = 0u; i < 19u; i++) {
    fout[i * n + idx] = f[i] - om * (f[i] - fe[i]);
  }
  mac[idx] = vec4<f32>(rho, u);
}
`;

/** Fills both distribution buffers with the free stream (or rest, inside the model). */
export const initShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> fa: array<f32>;
@group(0) @binding(2) var<storage, read_write> fb: array<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<vec4<f32>>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x + gid.y * P.rowStride;
  if (idx >= P.n) { return; }
  let s = solid[idx] != 0u;
  let u = select(vec3<f32>(P.uIn, 0.0, 0.0), vec3<f32>(0.0), s);
  for (var i = 0u; i < 19u; i++) {
    let v = feq(i, 1.0, u);
    fa[i * P.n + idx] = v;
    fb[i * P.n + idx] = v;
  }
  mac[idx] = vec4<f32>(1.0, u);
}
`;

export const FORCE_GROUPS = 256;
export const FORCE_WG = 256;

/**
 * Momentum exchange: every link from a fluid cell into the model carries 2·c·f of momentum per
 * step (the population goes in and comes straight back). The rest state is subtracted, which
 * measures gauge pressure and keeps a model that touches the floor honest. Summed over the box around the model,
 * in a fixed number of workgroups so the result is a small array to read back and add up.
 */
export const forceShader = /* wgsl */ `
${common}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> fpost: array<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> partial: array<vec4<f32>>;

var<workgroup> acc: array<vec4<f32>, ${FORCE_WG}>;

@compute @workgroup_size(${FORCE_WG})
fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let bw = P.bx1 - P.bx0; let bh = P.by1 - P.by0; let bd = P.bz1 - P.bz0;
  let total = bw * bh * bd;
  let stride = ${FORCE_GROUPS}u * ${FORCE_WG}u;
  var sum = vec4<f32>(0.0);
  // pressure relative to the free stream, not absolute, so a uniform drift adds no force
  var rhoRef = 0.0;
  for (var i = 0u; i < 19u; i++) { rhoRef += fpost[i * P.n + P.refIdx]; }
  var k = wg.x * ${FORCE_WG}u + li;
  loop {
    if (k >= total) { break; }
    let x = P.bx0 + k % bw;
    let y = P.by0 + (k / bw) % bh;
    let z = P.bz0 + k / (bw * bh);
    let idx = x + P.nx * (y + P.ny * z);
    if (solid[idx] == 0u) {
      for (var i = 1u; i < 19u; i++) {
        let tx = i32(x) + CX[i]; let ty = i32(y) + CY[i]; let tz = i32(z) + CZ[i];
        if (tx >= 0 && ty >= 0 && tz >= 0 && tx < i32(P.nx) && ty < i32(P.ny) && tz < i32(P.nz)) {
          let t = u32(tx) + P.nx * (u32(ty) + P.ny * u32(tz));
          if (solid[t] != 0u) {
            let c = vec3<f32>(f32(CX[i]), f32(CY[i]), f32(CZ[i]));
            // gauge, not absolute: minus the free stream at rest, so a model standing on the
            // floor isn't pressed down by the atmosphere on top of its contact patches
            sum += vec4<f32>(2.0 * c * (fpost[i * P.n + idx] - W[i] * rhoRef), 0.0);
          }
        }
      }
    }
    k += stride;
  }
  acc[li] = sum;
  workgroupBarrier();
  var s = ${FORCE_WG / 2}u;
  loop {
    if (s == 0u) { break; }
    if (li < s) { acc[li] += acc[li + s]; }
    workgroupBarrier();
    s = s / 2u;
  }
  if (li == 0u) { partial[wg.x] = acc[0]; }
}
`;
