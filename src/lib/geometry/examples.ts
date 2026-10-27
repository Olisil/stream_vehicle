import type { Vec3 } from "./mesh";

/*
  The built-in models, as signed distance functions in metres (negative inside). They're
  meshed in the geometry worker. Frame: x along the length with the nose at the small-x end,
  y across, z up. Each comes with the setup it is usually tested in.
*/

export type ExampleId = "ahmed" | "car" | "truck" | "sphere" | "airship" | "plane";

type Sdf = (x: number, y: number, z: number) => number;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function box(x: number, y: number, z: number, bx: number, by: number, bz: number) {
  const qx = Math.abs(x) - bx;
  const qy = Math.abs(y) - by;
  const qz = Math.abs(z) - bz;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return out + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
function roundBox(x: number, y: number, z: number, bx: number, by: number, bz: number, r: number) {
  return box(x, y, z, bx - r, by - r, bz - r) - r;
}
/** Approximate ellipsoid distance (exact sign). */
function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
/** Cylinder along y, centred at the origin. */
function cylY(x: number, y: number, z: number, r: number, h: number) {
  const dx = Math.hypot(x, z) - r;
  const dy = Math.abs(y) - h;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
/** Cylinder along z. */
function cylZ(x: number, y: number, z: number, r: number, h: number) {
  return cylY(x, z, y, r, h);
}
function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
}

// Ahmed body, 25° slant (Ahmed, Ramm & Faltin 1984): 1044 × 389 × 288 mm, 100 mm front radius,
// 50 mm above the floor on four stilts.
const ahmed: Sdf = (x, y, z) => {
  const L = 1.044;
  const W = 0.389;
  const H = 0.288;
  const R = 0.1;
  const c = 0.05;
  const zc = c + H / 2;
  const sharp = box(x - L / 2, y, z - zc, L / 2, W / 2, H / 2);
  const round = roundBox(x - (L + 2 * R) / 2, y, z - zc, (L + 2 * R) / 2, W / 2, H / 2, R);
  let d = Math.max(sharp, round);
  // slant: 222 mm long at 25°
  const sl = 0.222;
  const ang = (25 * Math.PI) / 180;
  const nx = Math.sin(ang);
  const nz = Math.cos(ang);
  d = Math.max(d, (x - (L - sl)) * nx + (z - (c + H)) * nz);
  for (const lx of [0.2, 0.67]) for (const ly of [-0.1175, 0.1175]) d = Math.min(d, cylZ(x - lx, y - ly, z - (c + 0.01) / 2, 0.015, (c + 0.01) / 2));
  return d;
};

/** Signed distance to a closed 2D polygon (points in order). */
function polygon(px: number, py: number, pts: number[][]) {
  let d = (px - pts[0][0]) ** 2 + (py - pts[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
    const ex = pts[j][0] - pts[i][0];
    const ey = pts[j][1] - pts[i][1];
    const wx = px - pts[i][0];
    const wy = py - pts[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= pts[i][1];
    const c2 = py < pts[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
/** A side profile (x, z) extruded across ±w and rounded by r. */
function profile(x: number, y: number, z: number, pts: number[][], w: number, r: number) {
  const d = polygon(x, z, pts) + r;
  const e = Math.abs(y) - w + r;
  return Math.min(Math.max(d, e), 0) + Math.hypot(Math.max(d, 0), Math.max(e, 0)) - r;
}

// A compact hatchback: 4.25 × 1.78 × 1.45 m.
const CAR_BODY = [
  [0.0, 0.44], [0.04, 0.68], [0.3, 0.86], [1.3, 0.98], [3.95, 1.02], [4.25, 0.96], [4.25, 0.46], [4.1, 0.3], [0.18, 0.3],
];
const CAR_CABIN = [
  [1.2, 0.9], [2.08, 1.43], [3.25, 1.45], [4.07, 1.08], [4.07, 0.9],
];
const car: Sdf = (x, y, z) => {
  const body = profile(x, y, z, CAR_BODY, 0.89, 0.09);
  const cabin = profile(x, y, z, CAR_CABIN, 0.74, 0.12);
  let d = smin(body, cabin, 0.06);
  for (const wx of [0.86, 3.36]) for (const wy of [-0.76, 0.76]) d = Math.min(d, cylY(x - wx, y - wy, z - 0.31, 0.31, 0.11));
  return d;
};

// A box truck: 7.5 × 2.5 × 3.6 m.
const truck: Sdf = (x, y, z) => {
  const cab = roundBox(x - 0.95, y, z - 1.75, 0.95, 1.2, 1.2, 0.2);
  const body = roundBox(x - 4.8, y, z - 2.25, 2.7, 1.25, 1.35, 0.05);
  const chassis = box(x - 3.8, y, z - 0.8, 3.5, 0.5, 0.22);
  let d = Math.min(cab, body, chassis);
  for (const wx of [1.15, 5.6, 6.65]) for (const wy of [-1.08, 1.08]) d = Math.min(d, cylY(x - wx, y - wy, z - 0.5, 0.5, 0.15));
  return d;
};

// A sphere, 0.5 m across: the textbook case.
const sphere: Sdf = (x, y, z) => Math.hypot(x - 0.25, y, z - 0.25) - 0.25;

// An airship, 75 × 15 m, with four tail fins and a gondola.
const airship: Sdf = (x, y, z) => {
  let d = ellipsoid(x - 37.5, y, z, 37.5, 7.5, 7.5);
  // fins: four thin swept plates in a cross at the tail
  const fx = x - 66;
  // a: across the fin (its thickness), b: outward from the hull's axis
  const fin = (a: number, b: number) => Math.max(box(fx, a, b, 6, 0.35, 11.5), (Math.abs(b) - 4 - (fx + 6) * 1.2) * 0.64);
  d = Math.min(d, fin(y, z), fin(z, y));
  d = smin(d, roundBox(x - 30, y, z + 7.6, 5.5, 1.4, 0.9, 0.6), 0.6);
  return d;
};

// A light aircraft: 7.5 m long, 10 m span, low elliptical wing.
const plane: Sdf = (x, y, z) => {
  const nose = ellipsoid(x - 2.6, y, z, 2.6, 0.62, 0.72);
  const tail = ellipsoid(x - 5.0, y, z - 0.12, 2.6, 0.32, 0.38);
  let d = smin(nose, tail, 0.4);
  d = Math.min(d, ellipsoid(x - 2.4, y, z + 0.32, 0.85, 5.0, 0.11));
  d = Math.min(d, ellipsoid(x - 6.95, y, z - 0.22, 0.5, 1.75, 0.06));
  d = Math.min(d, Math.max(ellipsoid(x - 6.9, y, z - 0.6, 0.62, 0.06, 0.8), 0.15 - z));
  return d;
};

export interface Example {
  id: ExampleId;
  name: string;
  blurb: string;
  sdf: Sdf;
  /** box that holds the shape, metres */
  min: Vec3;
  max: Vec3;
  /** cells along the longest side when meshing */
  detail: number;
}

export const EXAMPLES: Example[] = [
  {
    id: "car",
    name: "Hatchback",
    blurb: "A compact car on a moving road, 4.25 m long.",
    sdf: car,
    min: [-0.1, -1.0, -0.05],
    max: [4.4, 1.0, 1.6],
    detail: 120,
  },
  {
    id: "ahmed",
    name: "Ahmed body",
    blurb: "The classic car-aerodynamics test shape, 25° rear slant. Wind-tunnel drag is about 0.29.",
    sdf: ahmed,
    min: [-0.05, -0.25, -0.02],
    max: [1.1, 0.25, 0.4],
    detail: 130,
  },
  {
    id: "truck",
    name: "Box truck",
    blurb: "A 7.5 m delivery truck: blunt, with a big wake.",
    sdf: truck,
    min: [-0.1, -1.4, -0.05],
    max: [7.6, 1.4, 3.7],
    detail: 110,
  },
  {
    id: "plane",
    name: "Light aircraft",
    blurb: "A small plane with an elliptical wing, 10 m span, flying in free air.",
    sdf: plane,
    min: [-0.1, -5.2, -0.9],
    max: [7.6, 5.2, 1.5],
    detail: 220,
  },
  {
    id: "airship",
    name: "Airship",
    blurb: "A 75 m airship with tail fins and a gondola.",
    sdf: airship,
    min: [-1, -14, -14],
    max: [76, 14, 14],
    detail: 140,
  },
  {
    id: "sphere",
    name: "Sphere",
    blurb: "The textbook shape, 0.5 m across, in free air at 18 km/h. Measured drag is about 0.47.",
    sdf: sphere,
    min: [-0.05, -0.3, -0.05],
    max: [0.55, 0.3, 0.55],
    detail: 72,
  },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
