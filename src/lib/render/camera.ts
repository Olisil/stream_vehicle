/** Column-major 4×4 matrices (what WGSL expects), WebGPU clip space with depth 0…1. */
export type Mat4 = Float32Array;

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far / (near - far);
  m[11] = -1;
  m[14] = (near * far) / (near - far);
  return m;
}

export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l;
  zy /= l;
  zz /= l;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l;
  xy /= l;
  xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx;
  m[1] = yx;
  m[2] = zx;
  m[4] = xy;
  m[5] = yy;
  m[6] = zy;
  m[8] = xz;
  m[9] = yz;
  m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function mul4(a: Mat4, b: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      r[c * 4 + rr] = s;
    }
  return r;
}

/**
 * An orbit around a point, z up. Angles in degrees; distance and target in cells.
 * `fov` is the vertical field of view of the video frame; the live view widens it to show the
 * passe-partout around the frame.
 */
export interface Orbit {
  yaw: number;
  pitch: number;
  distance: number;
  target: [number, number, number];
}

export const FOV = (32 * Math.PI) / 180;

export function eyeOf(o: Orbit): [number, number, number] {
  const y = (o.yaw * Math.PI) / 180;
  const p = (o.pitch * Math.PI) / 180;
  return [o.target[0] + o.distance * Math.cos(p) * Math.cos(y), o.target[1] + o.distance * Math.cos(p) * Math.sin(y), o.target[2] + o.distance * Math.sin(p)];
}

/**
 * View-projection for a viewport. `frameScale` is how much taller the viewport is than the
 * video frame inside it (1 when rendering the frame itself).
 */
export function viewProjection(o: Orbit, aspect: number, frameScale = 1, far = 1e5): { m: Mat4; eye: [number, number, number] } {
  const eye = eyeOf(o);
  const fov = 2 * Math.atan(Math.tan(FOV / 2) * frameScale);
  const near = Math.max(0.05, o.distance * 0.01);
  const v = lookAt(eye, o.target, [0, 0, 1]);
  const p = perspective(fov, aspect, near, far);
  return { m: mul4(p, v), eye };
}
