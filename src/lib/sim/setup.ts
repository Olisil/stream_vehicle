import { boundsOf, mul3, rotY, rotZ, sizeOf, transformMesh, type TriMesh, type Vec3 } from "../geometry/mesh";
import { BYTES_PER_CELL, type Ground } from "./lbm";
import { QUALITIES, VEHICLES, type Project } from "../types";

/** Kinematic viscosity of air at about 15 °C, m²/s. */
export const NU_AIR = 1.48e-5;
/** Density of air at sea level, kg/m³. */
export const RHO_AIR = 1.225;
/** Wind speed inside the solver, in cells per step. Low enough to stay incompressible. */
export const U_LATTICE = 0.08;
/** The lowest molecular viscosity the grid is given (cells²/step). Below this the solver relies on the eddy viscosity alone. */
const NU_FLOOR = 6e-5;
const SMAGORINSKY = 0.16;

export interface TunnelSetup {
  nx: number;
  ny: number;
  nz: number;
  /** cell size, metres */
  dx: number;
  /** the model in lattice coordinates (cells), posed and placed */
  mesh: TriMesh;
  /** model bounds in lattice coordinates */
  modelMin: Vec3;
  modelMax: Vec3;
  ground: Ground;
  uLattice: number;
  nu: number;
  cs: number;
  /** wind speed, m/s */
  speed: number;
  /** seconds of real time per solver step */
  dt: number;
  /** the real flow's Reynolds number, on the model's length */
  reynolds: number;
  /** what the grid can resolve: the Reynolds number the molecular viscosity floor corresponds to */
  reynoldsGrid: number;
  /** cells along the model's length */
  cellsAlong: number;
  refKind: "front" | "top";
  /** bytes the solver will allocate */
  bytes: number;
}

export interface GpuBudget {
  /** largest storage buffer the device allows, bytes */
  maxBuffer: number;
}

/** The model posed for the run: yaw about the vertical, pitch nose-up, then put back on the ground. */
export function poseMesh(canonical: TriMesh, yaw: number, pitch: number, ground: Ground): TriMesh {
  const b0 = boundsOf(canonical.positions);
  const c: Vec3 = [(b0.min[0] + b0.max[0]) / 2, (b0.min[1] + b0.max[1]) / 2, (b0.min[2] + b0.max[2]) / 2];
  const centred = transformMesh(canonical, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, [-c[0], -c[1], -c[2]]);
  const m = mul3(rotZ(yaw), rotY(pitch));
  const posed = transformMesh(centred, m);
  const b = boundsOf(posed.positions);
  const lift = ground === "free" ? -(b.min[2] + b.max[2]) / 2 : -b.min[2];
  return transformMesh(posed, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, [-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, lift]);
}

export function maxCellsFor(budget: GpuBudget): number {
  return Math.floor(budget.maxBuffer / (19 * 4));
}

/**
 * Sizes the tunnel around the posed model (metres) and works out the solver's numbers. The
 * tunnel is about one length of clear air in front of the model and two and a bit behind it,
 * with room to the sides and above so the walls don't squeeze the flow too much.
 */
export function planTunnel(project: Project, posed: TriMesh, budget: GpuBudget): TunnelSetup {
  const b = boundsOf(posed.positions);
  const [L, W, H] = sizeOf(b);
  const ground = project.tunnel.ground;
  const Lc = Math.max(L, 0.6 * W, H);
  const up = 1.0 * Lc;
  const down = 2.2 * Lc;
  const Dx = up + L + down;
  const my = Math.max(0.6 * Math.max(W, H), 0.55 * Lc);
  const Dy = W + 2 * my;
  let Dz: number;
  let zBase: number; // world z of the model's lowest point
  if (ground === "free") {
    const mz = Math.max(0.8 * H, 0.45 * Lc, 0.25 * W);
    Dz = H + 2 * mz;
    zBase = mz;
  } else {
    Dz = H + Math.max(1.6 * H, 0.55 * Lc);
    zBase = 0;
  }

  const target = QUALITIES.find((q) => q.value === project.tunnel.quality)?.cells ?? 1_500_000;
  const cells = Math.min(target, maxCellsFor(budget));
  const dx = Math.cbrt((Dx * Dy * Dz) / cells);
  const nx = Math.max(16, Math.round(Dx / dx));
  const ny = Math.max(8, Math.round(Dy / dx));
  const nz = Math.max(8, Math.round(Dz / dx));

  // world → lattice: cell i is centred on world (i + 0.5)·dx, so the floor (world 0) sits at −0.5.
  const ox = up - b.min[0];
  const oy = Dy / 2 - (b.min[1] + b.max[1]) / 2;
  const oz = zBase - b.min[2];
  const p = posed.positions;
  const lp = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    lp[i] = (p[i] + ox) / dx - 0.5;
    lp[i + 1] = (p[i + 1] + oy) / dx - 0.5;
    lp[i + 2] = (p[i + 2] + oz) / dx - 0.5;
  }
  const lb = boundsOf(lp);

  const speed = Math.max(0.1, project.tunnel.speed / 3.6);
  const length = project.length;
  const cellsAlong = L / dx;
  const reynolds = (speed * length) / NU_AIR;
  const nuReal = (U_LATTICE * cellsAlong) / reynolds;
  const nu = Math.max(NU_FLOOR, nuReal);
  return {
    nx,
    ny,
    nz,
    dx,
    mesh: { positions: lp, normals: posed.normals },
    modelMin: lb.min,
    modelMax: lb.max,
    ground,
    uLattice: U_LATTICE,
    nu,
    cs: SMAGORINSKY,
    speed,
    dt: (U_LATTICE * dx) / speed,
    reynolds,
    reynoldsGrid: (U_LATTICE * cellsAlong) / nu,
    cellsAlong,
    refKind: VEHICLES[project.vehicle].ref,
    bytes: nx * ny * nz * BYTES_PER_CELL,
  };
}

export function formatBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  return `${Math.round(b / 1e6)} MB`;
}

export function formatRe(re: number) {
  if (re >= 1e6) return `${(re / 1e6).toFixed(re >= 1e7 ? 0 : 1)} million`;
  if (re >= 1e3) return `${Math.round(re / 1e3).toLocaleString("en")} thousand`;
  return Math.round(re).toLocaleString("en");
}
