// Renders the built-in shapes' silhouettes to small PNGs for the home page (run once: npx tsx tools/make-thumbs.ts).
import { EXAMPLES } from "../src/lib/geometry/examples";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP ?? "sharp");
const W = 640, H = 360;
(async () => {
  for (const ex of EXAMPLES.filter((e) => !process.env.ONLY || e.id === process.env.ONLY)) {
    const top = ex.id === "plane";
    const [a0, a1] = [ex.min[0], ex.max[0]];
    const [b0, b1] = top ? [ex.min[1], ex.max[1]] : [ex.min[2], ex.max[2]];
    const [c0, c1] = top ? [ex.min[2], ex.max[2]] : [ex.min[1], ex.max[1]];
    const k = Math.min((W * 0.8) / (a1 - a0), (H * 0.66) / (b1 - b0));
    const ox = (W - (a1 - a0) * k) / 2;
    const oy = (H - (b1 - b0) * k) / 2;
    const img = Buffer.alloc(W * H * 4);
    const N = 48;
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        // 2×2 supersampling for soft edges
        let hit = 0;
        for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const a = a0 + (px + sx - ox) / k;
          const b = b0 + (H - (py + sy) - oy) / k;
          if (a < a0 || a > a1 || b < b0 || b > b1) continue;
          for (let i = 0; i <= N; i++) {
            const c = c0 + ((c1 - c0) * i) / N;
            const d = top ? ex.sdf(a, b, c) : ex.sdf(a, c, b);
            if (d < 0) { hit++; break; }
          }
        }
        const o = (py * W + px) * 4;
        img[o] = 0xba; img[o + 1] = 0xd7; img[o + 2] = 0x0a; img[o + 3] = Math.round((hit / 4) * 255);
      }
    await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9 }).toFile(`src/assets/shapes/${ex.id}.png`);
    console.log(ex.id, "done");
  }
})();
