import { Renderer } from "../src/lib/render/renderer";
const out = document.getElementById("out")!;
const log = (s: string) => { out.textContent += s + "\n"; console.log(s); };
(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  device.pushErrorScope("validation");
  new Renderer(device, navigator.gpu.getPreferredCanvasFormat());
  const err = await device.popErrorScope();
  log(err ? "ERR " + err.message : "pipelines ok");
  for (const m of [] as string[]) log(m);
  (window as any).__done = { ok: !err };
})().catch((e) => { log("ERR " + e.message); (window as any).__done = { err: String(e) }; });
