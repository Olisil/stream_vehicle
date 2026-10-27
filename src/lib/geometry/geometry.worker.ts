/// <reference lib="webworker" />
import { exampleById } from "./examples";
import { meshExample } from "./mesher";
import { voxelize } from "./voxelize";

export type GeometryRequest =
  | { id: number; kind: "example"; example: string }
  | { id: number; kind: "voxelize"; positions: Float32Array; nx: number; ny: number; nz: number; groundSeal: boolean };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<GeometryRequest>) => {
  const req = e.data;
  try {
    if (req.kind === "example") {
      const ex = exampleById(req.example);
      if (!ex) throw new Error(`No example "${req.example}"`);
      const m = meshExample(ex);
      ctx.postMessage({ id: req.id, ok: true, result: m }, [m.positions.buffer, m.normals.buffer]);
    } else {
      const r = voxelize(req.positions, req.nx, req.ny, req.nz, req.groundSeal);
      ctx.postMessage({ id: req.id, ok: true, result: r }, [r.solid.buffer]);
    }
  } catch (err) {
    ctx.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
