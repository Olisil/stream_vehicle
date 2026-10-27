const { chromium } = require('playwright');
(async()=>{
  const b = await chromium.launch({ executablePath:'/opt/google/chrome/chrome', args:['--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader','--enable-features=Vulkan','--use-angle=swiftshader','--use-vulkan=swiftshader'], headless:true });
  const ctx = await b.newContext({ viewport:{ width: 960, height: 700 } });
  if (process.env.LIGHT) await ctx.addInitScript(() => document.documentElement.classList.remove('dark-mode'));
  const p = await ctx.newPage();
  p.on('console', m => { if (!/vite|ERR_TUNNEL|404/.test(m.text())) console.log(m.text()); });
  p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(process.argv[2]);
  await p.waitForFunction(() => window.__done, null, { timeout: 1500000 });
  const out = process.env.OUT, tag = process.env.TAG || 'v';
  const shot = async (name, patch, orbit) => { await p.evaluate(([a, o]) => window.__frame(a, o), [patch, orbit]); await p.locator('#c').screenshot({ path: `${out}/${tag}-${name}.png` }); };
  await shot('smoke', {});
  await shot('slice-speed', { slice: 'speed', smoke: false });
  await shot('slice-pressure', { slice: 'pressure', smoke: false, sliceAxis: 'side' });
  await shot('swirl', { slice: 'vorticity', smoke: false, sliceAxis: 'front', slicePos: 0.55 });
  await shot('side', { smoke: true, smokeColor: 'white' }, { yaw: -90, pitch: 2 });
  await b.close();
})();
