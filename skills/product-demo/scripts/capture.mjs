#!/usr/bin/env node
// Record a click path through a web app with Playwright, for a product demo.
//   node capture.mjs <path.json> <out-dir> [--width 1920 --height 1080] [--headed]
// Run it from a scratch folder that has Playwright (npm i -D playwright && npx playwright install chromium);
// Playwright is resolved from the current folder, never from the harness.
// path.json is a list of steps, each one of:
//   {"goto": "https://..."}  {"click": "<selector>"}  {"fill": "<selector>", "text": "..."}
//   {"fill": "<selector>", "textEnv": "DEMO_PASSWORD"}  (types the value of that environment variable)
//   {"press": "Enter"}  {"wait": 800}  {"shot": "name"}
// Any step may add "caption": "..." and "hold": <ms after the step, default 600>.
// Writes <out-dir>/raw.webm (the video), <out-dir>/<name>.png and <out-dir>/timeline.json:
// one entry per step with its start time in seconds and, for click and fill, the target's box,
// so the edit can zoom on the action and place the cursor highlight.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args.splice(i, 2)[1]; };
const width = Number(opt('--width', 1920)), height = Number(opt('--height', 1080));
const headed = args.includes('--headed') && args.splice(args.indexOf('--headed'), 1);
if (args.length !== 2) { console.error('usage: capture.mjs <path.json> <out-dir> [--width W --height H] [--headed]'); process.exit(2); }
const [pathFile, outDir] = args.map((a) => resolve(a));
const steps = JSON.parse(readFileSync(pathFile, 'utf8'));
if (!Array.isArray(steps) || !steps.length) { console.error('capture: path.json must be a non-empty list'); process.exit(2); }

let chromium;
try { ({ chromium } = createRequire(join(process.cwd(), 'x.js'))('playwright')); }
catch { console.error('capture: Playwright not found here; run: npm i -D playwright && npx playwright install chromium'); process.exit(1); }

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  viewport: { width, height }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width, height } },
});
const page = await context.newPage();
const t0 = Date.now();
const timeline = [];
try {
  for (const step of steps) {
    const entry = { ...step };
    const target = step.click ?? step.fill;
    const loc = target && page.locator(target).first();
    if (loc) {
      await loc.waitFor({ state: 'visible', timeout: 15000 });
      await loc.scrollIntoViewIfNeeded();
      entry.box = await loc.boundingBox();
    }
    const text = step.textEnv ? process.env[step.textEnv] : step.text;
    if (step.textEnv && text === undefined) throw new Error(`capture: environment variable ${step.textEnv} is not set`);
    entry.t = (Date.now() - t0) / 1000;
    if (step.goto) await page.goto(step.goto, { waitUntil: 'load' });
    else if (step.click) await loc.click();
    else if (step.fill) await loc.pressSequentially(text ?? '', { delay: 60 });
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.wait) await page.waitForTimeout(step.wait);
    if (step.shot) await page.screenshot({ path: join(outDir, `${step.shot}.png`) });
    timeline.push(entry);
    await page.waitForTimeout(step.hold ?? 600);
  }
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) renameSync(await video.path(), join(outDir, 'raw.webm'));
  writeFileSync(join(outDir, 'timeline.json'), JSON.stringify({ width, height, steps: timeline }, null, 2));
}
console.log(`${join(outDir, 'raw.webm')} (${timeline.length} steps, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
