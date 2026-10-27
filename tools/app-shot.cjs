// Opens the app in headless Chrome (software WebGPU), makes a car test, steps through, takes screenshots.
const { chromium } = require('playwright');
const OUT = process.env.OUT;
(async()=>{
  const base = process.argv[2];
  const b = await chromium.launch({ executablePath:'/opt/google/chrome/chrome', args:['--enable-unsafe-webgpu','--use-webgpu-adapter=swiftshader','--enable-features=Vulkan','--use-angle=swiftshader','--use-vulkan=swiftshader'], headless:true });
  const ctx = await b.newContext({ viewport:{ width: +(process.env.W||1440), height: +(process.env.H||900) } });
  if (process.env.LIGHT) await ctx.addInitScript(() => localStorage.setItem('dark-mode','false'));
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => { if (m.type()==='error' || m.type()==='warning') errs.push(m.type()+': '+m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR '+e.message));
  await p.goto(base);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: OUT+'/home.png' });
  if (process.env.HOME_ONLY) { console.log(errs.join('\n')); await b.close(); return; }
  await p.click(process.env.EXAMPLE ? `.home-history .card-open:has-text("${process.env.EXAMPLE}")` : 'text=Try it with a car');
  // lower the detail so the software GPU keeps up
  await p.waitForSelector('.steps');
  await p.click('.step:has-text("Tunnel")');
  await p.click('.segmented button:has-text("Draft")');
  await p.click('.step:has-text("Model")');
  const t0 = Date.now();
  await p.waitForFunction(() => !document.querySelector('.getting-started.building'), null, { timeout: 240000 }).catch(()=>errs.push('still building after 240s'));
  console.log('built after', ((Date.now()-t0)/1000).toFixed(0), 's');
  await p.waitForTimeout(+(process.env.WAIT||20000));
  await p.screenshot({ path: OUT+'/editor-model.png' });
  for (const s of (process.env.STEPS||'Run,Look,Results').split(',')) {
    await p.click(`.step:has-text("${s}")`);
    await p.waitForTimeout(+(process.env.STEPWAIT||4000));
    await p.screenshot({ path: OUT+`/editor-${s.toLowerCase()}.png` });
  }
  console.log(errs.slice(0,30).join('\n'));
  await b.close();
})();
