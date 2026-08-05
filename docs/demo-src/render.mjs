import { chromium } from 'playwright-core';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FPS = 15;
// any Chromium works: set CHROMIUM=/path/to/chrome, or install one via `npx playwright-core install chromium`
const exe = process.env.CHROMIUM || chromium.executablePath();

const preview = process.argv.includes('--preview');

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 720, height: 720 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.join(dir, 'demo.html'));
await page.waitForTimeout(300); // let fonts settle

const total = await page.evaluate(() => window.TOTAL_MS);

if (preview) {
  for (const t of [1500, 3100, 5600, 8500, 12000, 15000, 17000, 20000]) {
    await page.evaluate(ms => window.seek(ms), t);
    await page.screenshot({ path: path.join(dir, 'frames', `preview_${t}.png`) });
  }
} else {
  // frame 0 = full transcript, so the loop/poster never shows a blank screen
  await page.evaluate(() => window.seek(window.FULL_MS));
  await page.screenshot({ path: path.join(dir, 'frames', 'f0000.png') });
  const n = Math.ceil(total / 1000 * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(ms => window.seek(ms), i * 1000 / FPS);
    await page.screenshot({ path: path.join(dir, 'frames', `f${String(i + 1).padStart(4, '0')}.png`) });
    if (i % 50 === 0) console.log(`frame ${i}/${n}`);
  }
  console.log(`rendered ${n} frames`);
}
await browser.close();
