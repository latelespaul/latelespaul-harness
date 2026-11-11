// Writes the golden vectors for planner.lua from job-hunt's plan.mjs (the planner it ports):
//   node modules/eyeshands/test/planner-golden-gen.mjs <path to plan.mjs> > modules/eyeshands/test/planner-golden.json
// Each case is a call (fn plus its inputs, all synthetic) and plan.mjs's output for it;
// planner.test.mjs replays every call through planner.lua and expects the same output, number for number.
import { pathToFileURL } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('usage: planner-golden-gen.mjs <plan.mjs>'); process.exit(2); }
const { Rng, planAction, keyFor } = await import(pathToFileURL(src).href);

const fns = {
  plan: (kind, args, seed, from) => planAction(kind, args, { rng: new Rng(seed), from }),
  seq: (seed, steps) => { const rng = new Rng(seed); return steps.map(s => planAction(s.kind, s.args, { rng, from: s.from })); },
  raw: (seed, n) => { const rng = new Rng(seed); return Array.from({ length: n }, () => rng.next().toString(16).padStart(16, '0')); },
  unit: (seed, n) => { const rng = new Rng(seed); return Array.from({ length: n }, () => rng.unit()); },
  keyfor: cps => cps.map(cp => { const [code, shift] = keyFor(String.fromCodePoint(cp)); return [cp, code, shift ? 1 : 0]; }),
};

const calls = [];
const add = (fn, ...args) => calls.push({ fn, args });

for (const seed of [0, 1, 42, -7, 1794350000000]) { add('raw', seed, 8); add('unit', seed, 8); }

// Moves: far (some overshoot), short (no overshoot), under a pixel (no events), points, other displays.
for (let seed = 1; seed <= 24; seed++) add('plan', 'move', { rect: [412, 388, 320, 32] }, seed, { x: 100, y: 200 });
for (const seed of [3, 11, 2024]) {
  add('plan', 'move', { rect: [20, 30, 40, 20] }, seed, { x: 1500, y: 900 });
  add('plan', 'move', { x: 530, y: 510 }, seed, { x: 500, y: 500 });
  add('plan', 'move', { rect: [9.6, 9.6, 1, 1] }, seed, { x: 10, y: 10 });
  add('plan', 'move', { rect: [0, 0, 2000, 1200] }, seed, { x: 1999, y: 5 });
  add('plan', 'move', { rect: [-1400, 100, 200, 50] }, seed, { x: -800, y: 300.5 });
  add('plan', 'move', { x: 640.25, y: 480.75 }, seed, { x: 12.5, y: 700 });
}

// Clicks: on a rect, on a point, where the cursor is, double and triple, clamped counts.
for (const seed of [5, 6, 77]) {
  add('plan', 'click', { rect: [412, 388, 320, 32] }, seed, { x: 100, y: 200 });
  add('plan', 'click', { rect: [412, 388, 320, 32], clicks: 2 }, seed, { x: 900, y: 50 });
  add('plan', 'click', { x: 300, y: 300, clicks: 3 }, seed, { x: 280, y: 290 });
  add('plan', 'click', { clicks: 2 }, seed, { x: 51.5, y: 60 });
  add('plan', 'click', { clicks: 7 }, seed, { x: 0, y: 0 });
  add('plan', 'click', { clicks: '2.5' }, seed, { x: 10, y: 10 });
}

// Typing: punctuation, capitals, accents, characters with no key, tabs and newlines, the paste rule.
const texts = [
  '', 'a', 'Hello, World!', 'test@example.com',
  'Straße: Äpfel, Öl & Übung?\nNeue Zeile\tTab',
  'éàü ÉÀÜ ß ç Ñ ≠ ≮ ẞ K 漢字 🙂',
  'The quick brown fox jumps over the lazy dog. 1234567890 !@#$%^&*()_+{}|:"<>?~`-=[]\\;\',./',
];
for (const seed of [9, 314]) for (const text of texts) add('plan', 'type', { text }, seed);
for (const text of ['x'.repeat(300), 'y'.repeat(301), 'é'.repeat(300), 'é'.repeat(301)]) add('plan', 'type', { text }, 9);

// Key combos.
for (const combo of ['cmd+shift+g', 'ctrl+alt+delete', 'enter', 'shift+tab', 'cmd+v', 'Cmd + Shift + 4', 'alt+left', 'cmd+`', 'opt+!'])
  add('plan', 'key', { combo }, 13);

// Scrolls: down, up, both axes, under a pixel (no events), the 60-tick cap, fractional pixels.
for (const seed of [21, 22]) for (const [dx, dy] of [[0, 600], [0, -300], [120, -45], [0, 0.4], [10, 3000], [-250.5, 80], [0, 44]])
  add('plan', 'scroll', { dx, dy }, seed);

// One RNG across a whole session of actions (the order of draws must match too).
add('seq', 7, [
  { kind: 'move', args: { rect: [412, 388, 320, 32] }, from: { x: 100, y: 200 } },
  { kind: 'click', args: { rect: [412, 388, 320, 32] }, from: { x: 560, y: 400 } },
  { kind: 'type', args: { text: 'Grüße, Welt!' } },
  { kind: 'key', args: { combo: 'cmd+a' } },
  { kind: 'scroll', args: { dx: 0, dy: 900 } },
  { kind: 'click', args: { x: 20, y: 20 }, from: { x: 1200, y: 800 } },
]);

// Key codes: every US key, every character plan.mjs maps through its base letter, and some with no key.
const cps = [];
for (let cp = 0x20; cp < 0x7f; cp++) cps.push(cp);
cps.push(0x09, 0x0a);
for (let cp = 0x80; cp <= 0x2fff; cp++) {
  const c = String.fromCodePoint(cp);
  const [code, shift] = keyFor(c);
  if (code || shift) cps.push(cp);
}
cps.push(0xdf, 0x1e9e, 0x3b1, 0x6f22, 0x1f642);
add('keyfor', cps);

const cases = calls.map(c => ({ ...c, out: fns[c.fn](...c.args) }));
// One case per line, so a change to the planner shows up as a readable diff.
process.stdout.write(`{"source":"plan.mjs","cases":[\n${cases.map(c => JSON.stringify(c)).join(',\n')}\n]}\n`);
