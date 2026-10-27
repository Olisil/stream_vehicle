import { Lbm } from "../src/lib/sim/lbm";
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += s + "\n"; console.log(s); };
(async () => {
  const q = new URLSearchParams(location.search);
  const nx = +(q.get("nx") ?? 96), ny = +(q.get("ny") ?? 48), nz = +(q.get("nz") ?? 48);
  const D = +(q.get("d") ?? 12), Re = +(q.get("re") ?? 100), u = +(q.get("u") ?? 0.1);
  const steps = +(q.get("steps") ?? 2000), cs = +(q.get("cs") ?? 0), sides = (q.get("sides") ?? "open") as "open" | "stream";
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize } });
  device.addEventListener("uncapturederror", (e) => log("GPU error: " + (e as GPUUncapturedErrorEvent).error.message));
  const solid = new Uint8Array(nx * ny * nz);
  const cx = nx / 4, cy = ny / 2 - 0.5, cz = nz / 2 - 0.5, r = D / 2;
  let area = 0; const proj = new Set<number>();
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r) { solid[x + nx * (y + ny * z)] = 1; proj.add(y + ny * z); }
  }
  area = proj.size;
  const nu = (u * D) / Re;
  const b = Math.ceil(r) + 3;
  const lbm = await Lbm.create(device, { nx, ny, nz, solid, uLattice: u, nu, cs, ground: "free", sides,
    forceBox: [Math.floor(cx - b), Math.floor(cy - b), Math.floor(cz - b), Math.ceil(cx + b), Math.ceil(cy + b), Math.ceil(cz + b)] });
  log(`grid ${nx}x${ny}x${nz} D=${D} Re=${Re} tau=${(0.5 + 3 * nu).toFixed(4)} cs=${cs} area=${area}`);
  const t0 = performance.now();
  let done = 0; const hist: number[] = [];
  while (done < steps) {
    lbm.step(100); done += 100;
    const f = await lbm.readForce();
    if (f) { const cd = f.fx / (0.5 * u * u * area); hist.push(cd); log(`step ${f.step} Cd=${cd.toFixed(4)} Fy=${f.fy.toExponential(2)} Fz=${f.fz.toExponential(2)}  ${((performance.now() - t0) / 1000).toFixed(1)}s`); }
  }
  const mlups = (nx * ny * nz * steps) / ((performance.now() - t0) / 1000) / 1e6;
  const m = await lbm.readMacro();
  let bad = 0; for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i])) bad++;
  log(`MLUPS=${mlups.toFixed(1)} nonfinite=${bad} finalCd=${hist[hist.length - 1].toFixed(4)}`);
  (window as any).__done = { cd: hist[hist.length - 1], mlups };
})().catch((e) => { log("ERR " + e.message); (window as any).__done = { err: String(e) }; });
