import type { ExampleId } from "./geometry/examples";
import type { Orientation, UpAxis } from "./geometry/mesh";
import type { Ground } from "./sim/lbm";

export type VehicleKind = "car" | "truck" | "bike" | "train" | "plane" | "airship" | "other";
export type Quality = "draft" | "standard" | "fine" | "max";
export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export type Resolution = 1080 | 1440 | 2160;
export type Fps = 24 | 25 | 30 | 60;
export type SliceField = "off" | "speed" | "pressure" | "vorticity";
export type SliceAxis = "side" | "top" | "front";
export type RakeKind = "vertical" | "horizontal" | "grid";
export type SmokeColor = "speed" | "white" | "green";
export type Surface = "plain" | "pressure";

export type ModelSource =
  | { kind: "example"; example: ExampleId }
  | { kind: "file"; fileId: string; fileName: string };

export interface Tunnel {
  /** wind speed, km/h */
  speed: number;
  ground: Ground;
  /** crosswind angle, degrees: the model turns, the wind keeps blowing along the tunnel */
  yaw: number;
  /** nose up, degrees (angle of attack for aircraft) */
  pitch: number;
  quality: Quality;
}

export interface Look {
  smoke: boolean;
  rake: RakeKind;
  /** rake position across the tunnel, −1 … 1 of the model's half width */
  rakeY: number;
  /** rake height, 0 … 1 of the model's height (a little beyond, too) */
  rakeZ: number;
  /** smoke lines, thousands */
  density: number;
  /** trail length, frames */
  trail: number;
  smokeColor: SmokeColor;
  slice: SliceField;
  sliceAxis: SliceAxis;
  /** 0 … 1 through the tunnel along the slice's axis */
  slicePos: number;
  sliceOpacity: number;
  surface: Surface;
  floorGrid: boolean;
}

export interface CameraView {
  yaw: number;
  pitch: number;
  /** distance in model lengths */
  distance: number;
  /** look-at offset from the model centre, in model lengths */
  target: [number, number, number];
}

export interface Results {
  cd: number;
  cl: number;
  cs: number;
  refArea: number;
  refKind: "front" | "top";
  step: number;
  flowThroughs: number;
  speed: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  model: ModelSource;
  orientation: Orientation;
  vehicle: VehicleKind;
  /** real length of the model along the wind, metres */
  length: number;
  tunnel: Tunnel;
  look: Look;
  view: CameraView | null;
  output: { aspect: Aspect; resolution: Resolution; fps: Fps; seconds: number; orbit: boolean; overlay: boolean };
  results: Results | null;
  /** a small picture of the last view, for the home page */
  thumb?: string;
}

export interface VehicleInfo {
  label: string;
  ground: Ground;
  speed: number;
  maxSpeed: number;
  length: number;
  /** the area drag and lift coefficients are based on */
  ref: "front" | "top";
  /** pitch is offered for these (angle of attack) */
  pitch: boolean;
}

export const VEHICLES: Record<VehicleKind, VehicleInfo> = {
  car: { label: "Car", ground: "fixed", speed: 100, maxSpeed: 350, length: 4.5, ref: "front", pitch: false },
  truck: { label: "Truck or bus", ground: "fixed", speed: 90, maxSpeed: 160, length: 12, ref: "front", pitch: false },
  bike: { label: "Bike or motorbike", ground: "fixed", speed: 45, maxSpeed: 350, length: 1.9, ref: "front", pitch: false },
  train: { label: "Train", ground: "fixed", speed: 200, maxSpeed: 400, length: 25, ref: "front", pitch: false },
  plane: { label: "Aeroplane", ground: "free", speed: 200, maxSpeed: 600, length: 8, ref: "top", pitch: true },
  airship: { label: "Airship", ground: "free", speed: 60, maxSpeed: 150, length: 75, ref: "front", pitch: true },
  other: { label: "Something else", ground: "free", speed: 50, maxSpeed: 600, length: 1, ref: "front", pitch: true },
};

export const VEHICLE_KINDS = Object.keys(VEHICLES) as VehicleKind[];

/** Setups for the built-in shapes: what they are and how they're usually tested. */
export const EXAMPLE_SETUPS: Record<ExampleId, { vehicle: VehicleKind; length: number; speed: number; ground: Ground; pitch?: number; up: UpAxis; rakeZ?: number }> = {
  car: { vehicle: "car", length: 4.25, speed: 100, ground: "fixed", up: "+z" },
  ahmed: { vehicle: "car", length: 1.044, speed: 144, ground: "fixed", up: "+z" },
  truck: { vehicle: "truck", length: 7.5, speed: 90, ground: "fixed", up: "+z" },
  plane: { vehicle: "plane", length: 7.5, speed: 200, ground: "free", pitch: 3, up: "+z", rakeZ: 0.17 },
  airship: { vehicle: "airship", length: 75, speed: 60, ground: "free", up: "+z" },
  sphere: { vehicle: "other", length: 0.5, speed: 18, ground: "free", up: "+z" },
};

export const QUALITIES: { value: Quality; label: string; cells: number }[] = [
  { value: "draft", label: "Draft", cells: 600_000 },
  { value: "standard", label: "Standard", cells: 1_500_000 },
  { value: "fine", label: "Fine", cells: 3_000_000 },
  { value: "max", label: "Max", cells: 6_000_000 },
];

export const ASPECTS: Record<Aspect, { ratio: number; label: string }> = {
  "16:9": { ratio: 16 / 9, label: "16:9 Landscape" },
  "9:16": { ratio: 9 / 16, label: "9:16 Story" },
  "1:1": { ratio: 1, label: "1:1 Square" },
  "4:5": { ratio: 4 / 5, label: "4:5 Portrait" },
};

export const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: 1080, label: "1080p" },
  { value: 1440, label: "2K" },
  { value: 2160, label: "4K" },
];

/** Output pixel size; the short side equals the chosen resolution. Always even. */
export function outputSize(aspect: Aspect, res: Resolution): { width: number; height: number } {
  const r = ASPECTS[aspect].ratio;
  const even = (n: number) => Math.round(n / 2) * 2;
  return r >= 1 ? { width: even(res * r), height: res } : { width: res, height: even(res / r) };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export const DEFAULT_LOOK: Look = {
  smoke: true,
  rake: "vertical",
  rakeY: 0,
  rakeZ: 0.5,
  density: 6,
  trail: 28,
  smokeColor: "speed",
  slice: "off",
  sliceAxis: "side",
  slicePos: 0.5,
  sliceOpacity: 0.85,
  surface: "pressure",
  floorGrid: true,
};

export function newProject(example: ExampleId = "car"): Project {
  const now = Date.now();
  const ex = EXAMPLE_SETUPS[example];
  const v = VEHICLES[ex.vehicle];
  return {
    id: uid(),
    name: "Untitled test",
    createdAt: now,
    updatedAt: now,
    model: { kind: "example", example },
    orientation: { up: ex.up, turn: 0 },
    vehicle: ex.vehicle,
    length: ex.length,
    tunnel: { speed: ex.speed, ground: ex.ground, yaw: 0, pitch: ex.pitch ?? 0, quality: "standard" },
    look: { ...DEFAULT_LOOK, rake: v.ref === "top" ? "horizontal" : "vertical", rakeZ: ex.rakeZ ?? 0.45, floorGrid: ex.ground !== "free" },
    view: null,
    output: { aspect: "16:9", resolution: 1080, fps: 30, seconds: 10, orbit: true, overlay: true },
    results: null,
  };
}

/** Fills in anything missing from an older or hand-edited project. */
export function coerceProject(raw: unknown): Project {
  const src = (raw && typeof raw === "object" && "project" in (raw as object) ? (raw as { project: unknown }).project : raw) as Partial<Project> | null;
  if (!src || typeof src !== "object" || !src.model) throw new Error("That file isn't a project from this app.");
  const base = newProject(src.model.kind === "example" ? src.model.example : "car");
  return {
    ...base,
    ...src,
    id: typeof src.id === "string" ? src.id : base.id,
    name: typeof src.name === "string" ? src.name : base.name,
    tunnel: { ...base.tunnel, ...(src.tunnel ?? {}) },
    look: { ...base.look, ...(src.look ?? {}) },
    output: { ...base.output, ...(src.output ?? {}) },
    orientation: { ...base.orientation, ...(src.orientation ?? {}) },
    results: src.results ?? null,
    view: src.view ?? null,
  };
}

export const ROAD_GROUNDS: { value: Ground; label: string; hint: string }[] = [
  { value: "fixed", label: "Fixed floor", hint: "Like a classic wind tunnel" },
  { value: "moving", label: "Moving road", hint: "Like driving. Needs Fine or Max detail, so the gap under the vehicle is a few cells high" },
  { value: "free", label: "Free air", hint: "No ground: flying" },
];
