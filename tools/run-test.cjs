const { chromium } = require('playwright');
(async()=>{
  const url = process.argv[2];
  const b = await chromium.launch({ executablePath:'/opt/google/chrome/chrome', args:['--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader','--enable-features=Vulkan','--use-angle=swiftshader','--use-vulkan=swiftshader'], headless:true });
  const p = await b.newPage();
  p.on('console', m => console.log(m.text()));
  p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(url);
  await p.waitForFunction(() => window.__done, null, { timeout: +(process.argv[3]||600000) });
  await b.close();
})();
