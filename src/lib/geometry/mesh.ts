/** A triangle soup: 9 floats per triangle in `positions`, matching normals per vertex. */
export interface TriMesh {
  positions: Float32Array;
  normals: Float32Array;
}

export type Vec3 = [number, number, number];

export interface Box3 {
  min: Vec3;
  max: Vec3;
}

export function boundsOf(pos: Float32Array): Box3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

export function sizeOf(b: Box3): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** Row-major 3×3 matrix applied to points and normals. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function rotZ(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function rotY(deg: number): Mat3 {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Transforms points by m, then scales and offsets: out = m·p·scale + offset. */
export function transformMesh(src: TriMesh, m: Mat3, scale = 1, offset: Vec3 = [0, 0, 0]): TriMesh {
  const p = src.positions;
  const nrm = src.normals;
  const op = new Float32Array(p.length);
  const on = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    op[i] = (m[0] * x + m[1] * y + m[2] * z) * scale + offset[0];
    op[i + 1] = (m[3] * x + m[4] * y + m[5] * z) * scale + offset[1];
    op[i + 2] = (m[6] * x + m[7] * y + m[8] * z) * scale + offset[2];
    const a = nrm[i];
    const b = nrm[i + 1];
    const c = nrm[i + 2];
    on[i] = m[0] * a + m[1] * b + m[2] * c;
    on[i + 1] = m[3] * a + m[4] * b + m[5] * c;
    on[i + 2] = m[6] * a + m[7] * b + m[8] * c;
  }
  return { positions: op, normals: on };
}

/** Flat normals for a triangle soup (used when a file gives none). */
export function flatNormals(pos: Float32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i];
    const ay = pos[i + 4] - pos[i + 1];
    const az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i];
    const by = pos[i + 7] - pos[i + 1];
    const bz = pos[i + 8] - pos[i + 2];
    let x = ay * bz - az * by;
    let y = az * bx - ax * bz;
    let z = ax * by - ay * bx;
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    for (let k = 0; k < 3; k++) {
      n[i + k * 3] = x;
      n[i + k * 3 + 1] = y;
      n[i + k * 3 + 2] = z;
    }
  }
  return n;
}

// ---------- orientation ----------

/** Which way is up in the file, and how the model is turned about the vertical afterwards. */
export type UpAxis = "+y" | "+z" | "-y" | "-z" | "+x" | "-x";

export interface Orientation {
  up: UpAxis;
  /** turn about the vertical, in 90° steps, so the nose points into the wind */
  turn: 0 | 90 | 180 | 270;
}

/** Rotation that takes the file's up axis to +Z (the tunnel's up). */
export function upMatrix(up: UpAxis): Mat3 {
  switch (up) {
    case "+z":
      return IDENTITY;
    case "-z":
      return [1, 0, 0, 0, -1, 0, 0, 0, -1];
    case "+y":
      // y → z, z → −y (keeps glTF's −z forward as +y… then turn fixes the heading)
      return [1, 0, 0, 0, 0, -1, 0, 1, 0];
    case "-y":
      return [1, 0, 0, 0, 0, 1, 0, -1, 0];
    case "+x":
      return [0, 0, -1, 0, 1, 0, 1, 0, 0];
    case "-x":
      return [0, 0, 1, 0, 1, 0, -1, 0, 0];
  }
}

export function orientationMatrix(o: Orientation): Mat3 {
  return mul3(rotZ(o.turn), upMatrix(o.up));
}

/**
 * The model in the tunnel's frame, in metres: oriented, scaled to its real length, nose towards
 * −x (into the wind), centred across, standing on z = 0. Yaw and pitch are applied afterwards.
 */
export function canonicalMesh(raw: TriMesh, o: Orientation, realLength: number): { mesh: TriMesh; scale: number } {
  const oriented = transformMesh(raw, orientationMatrix(o));
  const b = boundsOf(oriented.positions);
  const len = Math.max(1e-9, b.max[0] - b.min[0]);
  const scale = realLength / len;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const mesh = transformMesh(oriented, IDENTITY, scale, [-cx * scale, -cy * scale, -b.min[2] * scale]);
  return { mesh, scale };
}

/** A sensible starting orientation: the file format's usual up axis, longest side along the wind. */
export function guessOrientation(raw: TriMesh, up: UpAxis): Orientation {
  const m = upMatrix(up);
  const b = boundsOf(transformMesh(raw, m).positions);
  const s = sizeOf(b);
  return { up, turn: s[1] > s[0] * 1.05 ? 90 : 0 };
}
