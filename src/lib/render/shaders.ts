/*
  WGSL for drawing the tunnel. Everything is in lattice coordinates (cell centres at integers,
  x with the wind, z up), so the shaders read the solver's macro field (ρ, u) and solid flags
  directly, with no copies.
*/

export const FRAME_SIZE = 256;

const frame = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,
  light: vec4<f32>,        // key light direction (to the light), w: 1 in dark mode
  dims: vec4<u32>,         // nx, ny, nz, n
  a: vec4<f32>,            // uLattice, Cp scale, slice position (cells), slice opacity
  b: vec4<u32>,            // surface mode, slice field, slice axis, smoke colour
  c: vec4<f32>,            // viewport w, h (px), trail width (px), time
  d: vec4<u32>,            // head slot, trail length, particles, has floor
  bg: vec4<f32>,           // background colour
  grid: vec4<f32>,         // grid spacing (cells), minor spacing, model centre x, y
  e: vec4<f32>,            // model size (cells) x, y, z, vorticity scale
  base: vec4<f32>,         // model colour
  refCell: vec4<u32>,      // x: the free-stream reference cell for pressure
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> mac: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;

fn cellIndex(i: vec3<u32>) -> u32 { return i.x + F.dims.x * (i.y + F.dims.y * i.z); }

/** Trilinear sample of (ρ, u) that only blends fluid cells, so walls don't smear into it. */
fn fluidSample(p: vec3<f32>) -> vec4<f32> {
  let hi = vec3<f32>(F.dims.xyz) - vec3<f32>(1.0);
  let q = clamp(p, vec3<f32>(0.0), hi);
  let b = floor(q);
  let fr = q - b;
  let i0 = vec3<u32>(b);
  var sum = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let o = vec3<u32>(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
    let ii = min(i0 + o, F.dims.xyz - vec3<u32>(1u));
    let idx = cellIndex(ii);
    let wv = mix(vec3<f32>(1.0) - fr, fr, vec3<f32>(o));
    let w = wv.x * wv.y * wv.z;
    if (solid[idx] == 0u) {
      sum += w * mac[idx];
      wsum += w;
    }
  }
  if (wsum < 1e-4) { return vec4<f32>(1.0, 0.0, 0.0, 0.0); }
  return sum / wsum;
}

fn isSolid(p: vec3<f32>) -> bool {
  let hi = vec3<f32>(F.dims.xyz) - vec3<f32>(1.0);
  let q = clamp(round(p), vec3<f32>(0.0), hi);
  return solid[cellIndex(vec3<u32>(q))] != 0u;
}

fn srgb(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }

/** Wind speed: deep teal, bluegreen, signal green, signal on, white. */
fn speedMap(t: f32) -> vec3<f32> {
  let s = clamp(t, 0.0, 1.0);
  let c0 = vec3<f32>(0.03, 0.13, 0.20);
  let c1 = vec3<f32>(0.039, 0.745, 0.843);
  let c2 = vec3<f32>(0.729, 0.843, 0.039);
  let c3 = vec3<f32>(0.902, 1.0, 0.298);
  let c4 = vec3<f32>(1.0, 1.0, 1.0);
  if (s < 0.4) { return mix(c0, c1, s / 0.4); }
  if (s < 0.7) { return mix(c1, c2, (s - 0.4) / 0.3); }
  if (s < 0.88) { return mix(c2, c3, (s - 0.7) / 0.18); }
  return mix(c3, c4, (s - 0.88) / 0.12);
}

/** Pressure coefficient: suction in blues, stagnation in orange, neutral grey at Cp = 0. */
fn cpMap(cp: f32, neutral: vec3<f32>) -> vec3<f32> {
  let deep = vec3<f32>(0.02, 0.22, 0.42);
  let blue = vec3<f32>(0.039, 0.745, 0.843);
  let warm = vec3<f32>(0.94, 0.63, 0.17);
  let hot = vec3<f32>(0.94, 0.35, 0.17);
  if (cp < 0.0) {
    let t = clamp(-cp / 1.2, 0.0, 1.0);
    if (t < 0.5) { return mix(neutral, blue, t * 2.0); }
    return mix(blue, deep, (t - 0.5) * 2.0);
  }
  let t = clamp(cp, 0.0, 1.0);
  if (t < 0.5) { return mix(neutral, warm, t * 2.0); }
  return mix(warm, hot, (t - 0.5) * 2.0);
}
`;

export const modelShader = /* wgsl */ `
${frame}
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
  @location(1) normal: vec3<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>) -> VOut {
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  o.normal = n;
  return o;
}

@fragment
fn fs(v: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  var n = normalize(v.normal);
  if (!front) { n = -n; }
  let view = normalize(F.eye.xyz - v.world);
  let l = normalize(F.light.xyz);
  var albedo = F.base.rgb;
  if (F.b.x == 1u) {
    // Surface pressure, read just outside the wall.
    let s = fluidSample(v.world + n * 1.25);
    let cp = (s.x - mac[F.refCell.x].x) * F.a.y;
    albedo = cpMap(cp, F.base.rgb);
  }
  let diff = max(dot(n, l), 0.0);
  let fill = max(dot(n, normalize(vec3<f32>(-0.4, 0.6, 0.3))), 0.0);
  let sky = 0.5 + 0.5 * n.z;
  let h = normalize(l + view);
  let spec = pow(max(dot(n, h), 0.0), 60.0) * 0.35;
  let rim = pow(1.0 - max(dot(n, view), 0.0), 3.0) * 0.25;
  var c = albedo * (0.22 + 0.25 * sky + 0.62 * diff + 0.18 * fill) + vec3<f32>(spec + rim);
  return vec4<f32>(c, 1.0);
}
`;

export const floorShader = /* wgsl */ `
${frame}
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  let c = corners[vi];
  let size = vec2<f32>(F.dims.xy);
  let p = vec3<f32>(-0.5 + c.x * size.x, -0.5 + c.y * size.y, -0.5);
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  return o;
}

fn gridLine(coord: vec2<f32>, spacing: f32, width: f32) -> f32 {
  let g = abs(fract(coord / spacing - 0.5) - 0.5) * spacing;
  let w = fwidth(coord) * width;
  let l = 1.0 - min(smoothstep(vec2<f32>(0.0), w, g).x, smoothstep(vec2<f32>(0.0), w, g).y);
  return l;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let dark = F.light.w > 0.5;
  let floorCol = select(vec3<f32>(0.80, 0.80, 0.80), vec3<f32>(0.075, 0.075, 0.075), dark);
  let lineCol = select(vec3<f32>(0.62, 0.62, 0.62), vec3<f32>(0.20, 0.20, 0.20), dark);
  let major = gridLine(v.world.xy, F.grid.x, 1.2);
  let minor = gridLine(v.world.xy, F.grid.y, 1.0) * 0.45;
  var c = mix(floorCol, lineCol, max(major, minor));
  // soft contact shadow under the model
  let d = (v.world.xy - F.grid.zw) / max(F.e.xy * 0.62, vec2<f32>(1.0));
  let shade = exp(-dot(d, d) * 1.6) * 0.45;
  c = c * (1.0 - shade);
  // fade towards the tunnel's edges, into the background
  let size = vec2<f32>(F.dims.xy);
  let uv = (v.world.xy + 0.5) / size;
  let edge = min(min(uv.x, 1.0 - uv.x) * 6.0, min(uv.y, 1.0 - uv.y) * 4.0);
  c = mix(F.bg.rgb, c, clamp(edge, 0.0, 1.0));
  return vec4<f32>(c, 1.0);
}
`;

export const sliceShader = /* wgsl */ `
${frame}
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  let c = corners[vi];
  let lo = vec3<f32>(-0.5);
  let hi = vec3<f32>(F.dims.xyz) - vec3<f32>(0.5);
  let s = F.a.z;
  var p: vec3<f32>;
  if (F.b.z == 0u) {        // side: x–z plane
    p = vec3<f32>(mix(lo.x, hi.x, c.x), s, mix(lo.z, hi.z, c.y));
  } else if (F.b.z == 1u) { // top: x–y plane
    p = vec3<f32>(mix(lo.x, hi.x, c.x), mix(lo.y, hi.y, c.y), s);
  } else {                  // front: y–z plane
    p = vec3<f32>(s, mix(lo.y, hi.y, c.x), mix(lo.z, hi.z, c.y));
  }
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(p, 1.0);
  o.world = p;
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  if (isSolid(v.world)) { discard; }
  let m = fluidSample(v.world);
  let u0 = max(F.a.x, 1e-6);
  var col: vec3<f32>;
  var alpha = F.a.w;
  if (F.b.y == 1u) {
    col = speedMap(length(m.yzw) / (u0 * 1.35));
  } else if (F.b.y == 2u) {
    let cp = (m.x - mac[F.refCell.x].x) * F.a.y;
    col = cpMap(cp, select(vec3<f32>(0.78), vec3<f32>(0.16), F.light.w > 0.5));
  } else {
    let h = 1.0;
    let dx = fluidSample(v.world + vec3<f32>(h, 0.0, 0.0)).yzw - fluidSample(v.world - vec3<f32>(h, 0.0, 0.0)).yzw;
    let dy = fluidSample(v.world + vec3<f32>(0.0, h, 0.0)).yzw - fluidSample(v.world - vec3<f32>(0.0, h, 0.0)).yzw;
    let dz = fluidSample(v.world + vec3<f32>(0.0, 0.0, h)).yzw - fluidSample(v.world - vec3<f32>(0.0, 0.0, h)).yzw;
    let curl = vec3<f32>(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x) * 0.5;
    let w = length(curl) * F.e.w / u0;
    let t = clamp(w, 0.0, 1.0);
    col = speedMap(0.35 + 0.65 * t);
    alpha = alpha * smoothstep(0.03, 0.5, t);
  }
  return vec4<f32>(col * alpha, alpha);
}
`;

export const trailShader = /* wgsl */ `
${frame}
@group(0) @binding(3) var<storage, read> hist: array<vec4<f32>>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) across: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let T = F.d.y;
  let segs = T - 1u;
  let p = ii / segs;
  let k = ii % segs;
  let head = F.d.x;
  let sNew = (head + T - k) % T;
  let sOld = (head + T - k - 1u) % T;
  let a = hist[p * T + sNew];
  let b = hist[p * T + sOld];
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.color = vec4<f32>(0.0);
  o.across = 0.0;
  // a: newer point must be a living point; b: older one may be where this life started.
  if (a.w < -0.5 || b.w < -1e5) { return o; }

  let ca = F.viewProj * vec4<f32>(a.xyz, 1.0);
  let cb = F.viewProj * vec4<f32>(b.xyz, 1.0);
  if (ca.w <= 0.01 || cb.w <= 0.01) { return o; }
  let vp = F.c.xy;
  let sa = ca.xy / ca.w * vp * 0.5;
  let sb = cb.xy / cb.w * vp * 0.5;
  var dir = sb - sa;
  let len = length(dir);
  if (len < 1e-4) { dir = vec2<f32>(1.0, 0.0); } else { dir = dir / len; }
  let nrm = vec2<f32>(-dir.y, dir.x);
  // 6 vertices: two triangles of a quad from a to b
  let ends = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  let sides = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let e = ends[vi];
  let sd = sides[vi];
  let c = select(ca, cb, e > 0.5);
  let w = F.c.z * 0.5;
  let off = nrm * sd * w / (vp * 0.5) * c.w;
  o.pos = vec4<f32>(c.xy + off, c.z, c.w);

  let age = (f32(k) + e) / f32(T);
  let fade = pow(1.0 - age, 1.4);
  let u0 = max(F.a.x, 1e-6);
  let dark = F.light.w > 0.5;
  var col: vec3<f32>;
  if (F.b.w == 0u) {
    col = speedMap(a.w / (u0 * 1.35));
  } else if (F.b.w == 1u) {
    col = select(vec3<f32>(0.12, 0.12, 0.12), vec3<f32>(0.95, 0.95, 0.95), dark);
  } else {
    col = select(vec3<f32>(0.0, 0.353, 0.353), vec3<f32>(0.729, 0.843, 0.039), dark);
  }
  let alpha = fade * 0.85;
  o.color = vec4<f32>(col * alpha, alpha);
  o.across = sd;
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let soft = 1.0 - smoothstep(0.55, 1.0, abs(v.across));
  return v.color * soft;
}
`;

export const outlineShader = /* wgsl */ `
${frame}
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  // 12 edges of the tunnel box, then an arrow in front of the inlet showing the wind
  let e = array<vec3<f32>, 24>(
    vec3(0.0,0.0,0.0), vec3(1.0,0.0,0.0), vec3(0.0,1.0,0.0), vec3(1.0,1.0,0.0),
    vec3(0.0,0.0,1.0), vec3(1.0,0.0,1.0), vec3(0.0,1.0,1.0), vec3(1.0,1.0,1.0),
    vec3(0.0,0.0,0.0), vec3(0.0,1.0,0.0), vec3(1.0,0.0,0.0), vec3(1.0,1.0,0.0),
    vec3(0.0,0.0,1.0), vec3(0.0,1.0,1.0), vec3(1.0,0.0,1.0), vec3(1.0,1.0,1.0),
    vec3(0.0,0.0,0.0), vec3(0.0,0.0,1.0), vec3(1.0,0.0,0.0), vec3(1.0,0.0,1.0),
    vec3(0.0,1.0,0.0), vec3(0.0,1.0,1.0), vec3(1.0,1.0,0.0), vec3(1.0,1.0,1.0));
  let dims = vec3<f32>(F.dims.xyz);
  if (vi < 24u) {
    let p = vec3<f32>(-0.5) + e[vi] * dims;
    return F.viewProj * vec4<f32>(p, 1.0);
  }
  let len = max(6.0, dims.x * 0.1);
  let head = len * 0.3;
  let zc = select(dims.z * 0.5, F.e.z * 0.5, F.d.w == 1u);
  let c = vec3<f32>(-0.5 - len * 0.25, dims.y * 0.5 - 0.5, zc);
  let a = array<vec3<f32>, 6>(
    vec3(-len, 0.0, 0.0), vec3(0.0, 0.0, 0.0),
    vec3(0.0, 0.0, 0.0), vec3(-head, head * 0.6, 0.0),
    vec3(0.0, 0.0, 0.0), vec3(-head, -head * 0.6, 0.0));
  return F.viewProj * vec4<f32>(c + a[vi - 24u], 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  let dark = F.light.w > 0.5;
  let a = 0.45;
  let c = select(vec3<f32>(0.25), vec3<f32>(0.5), dark);
  return vec4<f32>(c * a, a);
}
`;

export const ADVECT_SIZE = 96;
export const ADVECT_WG = 64;

/** Moves the smoke particles with the flow and writes one trail point per frame. */
export const advectShader = /* wgsl */ `
struct Advect {
  dims: vec4<u32>,       // nx, ny, nz, particles
  rake0: vec4<f32>,      // rake origin (cells), w: kind (0 line, 1 grid)
  rakeU: vec4<f32>,      // lane axis, w: lanes along it
  rakeV: vec4<f32>,      // second axis (grid), w: lanes along it
  e: vec4<f32>,          // steps this frame, frame number, max age (frames), spacing (frames)
  f: vec4<u32>,          // head slot, trail length, reset flag, unused
};
@group(0) @binding(0) var<uniform> A: Advect;
@group(0) @binding(1) var<storage, read> mac: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> parts: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> hist: array<vec4<f32>>;

fn idx3(i: vec3<u32>) -> u32 { return i.x + A.dims.x * (i.y + A.dims.y * i.z); }

fn vel(p: vec3<f32>) -> vec3<f32> {
  let hi = vec3<f32>(A.dims.xyz) - vec3<f32>(1.0);
  let q = clamp(p, vec3<f32>(0.0), hi);
  let b = floor(q);
  let fr = q - b;
  let i0 = vec3<u32>(b);
  var sum = vec3<f32>(0.0);
  for (var k = 0u; k < 8u; k++) {
    let o = vec3<u32>(k & 1u, (k >> 1u) & 1u, (k >> 2u) & 1u);
    let ii = min(i0 + o, A.dims.xyz - vec3<u32>(1u));
    let wv = mix(vec3<f32>(1.0) - fr, fr, vec3<f32>(o));
    sum += wv.x * wv.y * wv.z * mac[idx3(ii)].yzw;
  }
  return sum;
}

fn hash(x: u32) -> f32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return f32(h) / 4294967295.0;
}

fn spawnPos(i: u32, salt: u32) -> vec3<f32> {
  let lu = u32(A.rakeU.w);
  let lv = max(1u, u32(A.rakeV.w));
  let lanes = lu * lv;
  let lane = i % lanes;
  let a = (f32(lane % lu) + 0.5) / f32(lu) - 0.5;
  let b = (f32(lane / lu) + 0.5) / f32(lv) - 0.5;
  let j = vec3<f32>(hash(i * 3u + salt) - 0.5, hash(i * 7u + salt * 13u) - 0.5, hash(i * 11u + salt * 29u) - 0.5);
  return A.rake0.xyz + A.rakeU.xyz * a + A.rakeV.xyz * b + j * vec3<f32>(1.2, 0.25, 0.25);
}

fn inside(p: vec3<f32>) -> bool {
  let hi = vec3<f32>(A.dims.xyz) - vec3<f32>(1.0);
  return all(p >= vec3<f32>(0.0)) && all(p <= hi);
}

fn solidAt(p: vec3<f32>) -> bool {
  let hi = vec3<f32>(A.dims.xyz) - vec3<f32>(1.0);
  return solid[idx3(vec3<u32>(clamp(round(p), vec3<f32>(0.0), hi)))] != 0u;
}

@compute @workgroup_size(${ADVECT_WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= A.dims.w) { return; }
  let T = A.f.y;
  let lanes = u32(A.rakeU.w) * max(1u, u32(A.rakeV.w));
  var s = parts[i];
  if (A.f.z == 1u) {
    // start over: wait in turn at the rake
    let turn = f32(i / lanes);
    s = vec4<f32>(spawnPos(i, 1u), -turn * A.e.w);
    for (var k = 0u; k < T; k++) { hist[i * T + k] = vec4<f32>(s.xyz, -1e6); }
    parts[i] = s;
    return;
  }
  let steps = A.e.x;
  var w = -1e6;
  if (s.w < 0.0) {
    // still waiting for its turn
    s.w = s.w + 1.0;
    if (s.w >= 0.0) {
      s = vec4<f32>(spawnPos(i, u32(A.e.y)), 0.0);
      w = -1.0 - length(vel(s.xyz));
    }
  } else {
    // midpoint step through the flow; the particle moves as far as the air does in these steps
    let v1 = vel(s.xyz);
    let mid = s.xyz + v1 * steps * 0.5;
    let v2 = vel(mid);
    let np = s.xyz + v2 * steps;
    let age = s.w + 1.0;
    if (!inside(np) || solidAt(np) || age > A.e.z || np.x > f32(A.dims.x) - 2.0) {
      s = vec4<f32>(spawnPos(i, u32(A.e.y) + i), 0.0);
      w = -1.0 - length(vel(s.xyz));
    } else {
      s = vec4<f32>(np, age);
      w = length(v2);
    }
  }
  parts[i] = s;
  hist[i * T + A.f.x] = vec4<f32>(s.xyz, w);
}
`;
