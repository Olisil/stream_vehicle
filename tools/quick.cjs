const { chromium } = require('playwright');
(async()=>{
  const b = await chromium.launch({ executablePath:'/opt/google/chrome/chrome', args:['--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader','--enable-features=Vulkan','--use-angle=swiftshader','--use-vulkan=swiftshader'], headless:true });
  for (const url of process.argv.slice(2)) {
    const p = await b.newPage();
    let last = '';
    p.on('console', m => { if (/final|grid|ERR|step|Cp|ux/.test(m.text())) last += '\n  ' + m.text(); });
    await p.goto(url); await p.waitForFunction(() => window.__done, null, { timeout: 1500000 });
    console.log(url.split('?')[1], '=>', last); await p.close();
  }
  await b.close();
})();
