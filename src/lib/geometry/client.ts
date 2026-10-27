import type { TriMesh } from "./mesh";
import type { VoxelResult } from "./voxelize";

/** Talks to the geometry worker: meshing the built-in shapes and voxelizing models off the main thread. */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function get(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "Geometry worker failed"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function call<T>(msg: object, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    get().postMessage({ ...msg, id }, transfer);
  });
}

const exampleCache = new Map<string, Promise<TriMesh>>();

/** The mesh of a built-in shape (made once per session). */
export function exampleMesh(id: string): Promise<TriMesh> {
  let p = exampleCache.get(id);
  if (!p) {
    p = call<TriMesh>({ kind: "example", example: id });
    exampleCache.set(id, p);
    p.catch(() => exampleCache.delete(id));
  }
  return p;
}

/** Cells of the model, from triangle positions in lattice units. The positions array is copied. */
export function voxelizeMesh(positions: Float32Array, nx: number, ny: number, nz: number, groundSeal: boolean): Promise<VoxelResult> {
  const copy = positions.slice();
  return call<VoxelResult>({ kind: "voxelize", positions: copy, nx, ny, nz, groundSeal }, [copy.buffer]);
}
