// node --test modules/eyeshands/planner.test.mjs   (never touches Hammerspoon, the screen or the input)
// EyesHands.spoon/planner.lua runs under a plain Lua 5.4 (test/planner-driver.lua): the planning
// rules (paths, Fitts timing, overshoot, clicks, typing, combos, scroll) and golden vectors made
// from job-hunt's plan.mjs (test/planner-golden.json; test/planner-golden-gen.mjs rebuilds it).
// Needs Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const skip = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';

// A JavaScript value as a Lua literal (strings with \u{...} escapes, objects as keyed tables).
function lua(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    return `"${[...v].map(c => (/[ -~]/.test(c) && c !== '"' && c !== '\\' ? c : `\\u{${c.codePointAt(0).toString(16)}}`)).join('')}"`;
  }
  if (Array.isArray(v)) return `{${v.map(lua).join(',')}}`;
  return `{${Object.entries(v).map(([k, x]) => `[${lua(k)}]=${lua(x)}`).join(',')}}`;
}
// One Lua chunk per line through the driver; one parsed result per chunk. ERROR lines come back as text.
function drive(chunks) {
  const r = spawnSync(LUA, [here('./test/planner-driver.lua')], {
    input: chunks.map(c => c.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n').map(l => (l.startsWith('ERROR') ? l : JSON.parse(l)));
}
const call = (fn, ...args) => `return ${fn}(${args.map(lua).join(',')})`;
const plans = list => drive(list.map(a => call('plan', ...a))).map(o => (typeof o === 'string' ? assert.fail(o) : o));

// Deterministic scenario maker for the property tests (independent of the planner's own RNG).
function scenarios(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  return { u, range: (a, b) => a + (b - a) * u(), int: (a, b) => Math.floor(a + (b - a + 1) * u()) };
}
function randomMoves(n, seed) {
  const g = scenarios(seed);
  return Array.from({ length: n }, (_, i) => {
    const rect = [g.range(-1500, 2500), g.range(0, 1400), g.range(4, 400), g.range(4, 200)];
    return ['move', { rect }, 1000 + i, { x: g.range(-1500, 2900), y: g.range(0, 1600) }];
  });
}
const geometry = (from, target) => {
  const vx = target[0] - from.x, vy = target[1] - from.y, d = Math.hypot(vx, vy);
  const ux = vx / d, uy = vy / d;
  return { d, along: e => (e.x - from.x) * ux + (e.y - from.y) * uy, perp: e => (e.x - from.x) * -uy + (e.y - from.y) * ux };
};
const EPS = 0.011; // times are rounded to 0.01 ms

test('the planner is pure: no hs, no global writes, no event posting', { skip }, () => {
  const [out] = drive([`
    local env = setmetatable({}, {
      __index = function(_, k) if k == "hs" then error("touched hs") end return _G[k] end,
      __newindex = function(_, k) error("wrote global " .. tostring(k)) end })
    local M = assert(loadfile(PLANNER, "t", env))()
    local rng = M.Rng(5)
    local n = #M.plan("click", {rect = {10, 20, 300, 40}}, {rng = rng, from = {x = 900, y = 700}}).events
    n = n + #M.plan("type", {text = "Hi, Ünïcode!"}, {rng = rng, layout = M.keys({a = 12, q = 0, h = 4})}).events
    n = n + #M.plan("type", {text = string.rep("p", 301)}, {rng = rng}).events
    n = n + #M.plan("key", {combo = "cmd+shift+g"}, {rng = rng}).events
    n = n + #M.plan("scroll", {dy = 700}, {rng = rng}).events
    return n`]);
  assert.equal(typeof out, 'number', String(out));
  assert.ok(out > 50);
});

test('SplitMix64 gives the reference sequence, and unit() stays in [0, 1)', { skip }, () => {
  const [r0, u] = drive([call('raw', 0, 3), call('unit', 42, 2000)]);
  assert.deepEqual(r0, ['e220a8397b1dcdaf', '6e789e6aa1b965f4', '06c45d188009454f']);
  assert.ok(u.every(x => x >= 0 && x < 1));
  const mean = u.reduce((a, b) => a + b, 0) / u.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean}`);
});

test('golden vectors: planner.lua equals plan.mjs for every recorded call', { skip }, () => {
  const { cases } = JSON.parse(readFileSync(here('./test/planner-golden.json'), 'utf8'));
  assert.ok(cases.length > 100);
  assert.ok(cases.some(c => c.out.overshoot === true), 'the vectors cover an overshoot');
  assert.ok(cases.some(c => c.out.paste === true), 'the vectors cover a paste');
  const outs = drive(cases.map(c => call(c.fn, ...c.args)));
  cases.forEach((c, i) => assert.deepStrictEqual(outs[i], c.out, `case ${i}: ${c.fn} ${JSON.stringify(c.args).slice(0, 120)}`));
});

test('seed replay: the same seed gives the same plan, another seed a different one', { skip }, () => {
  const args = [['move', { rect: [412, 388, 320, 32] }, 77, { x: 100, y: 200 }], ['type', { text: 'Seed, replay!' }, 77],
    ['scroll', { dx: 30, dy: 640 }, 77], ['key', { combo: 'cmd+shift+g' }, 77]];
  const a = plans(args), b = plans(args);
  assert.deepStrictEqual(a, b);
  const other = plans(args.map(([k, x, , f]) => [k, x, 78, f]));
  for (const i of [0, 1, 2, 3]) assert.notDeepStrictEqual(other[i], a[i]);
  const steps = [{ kind: 'move', args: { rect: [0, 0, 50, 50] }, from: { x: 900, y: 900 } }, { kind: 'type', args: { text: 'ab' } }];
  assert.deepStrictEqual(...drive([call('seq', 3, steps), call('seq', 3, steps)]));
});

test('paths stay in bounds: every move point lies near the line from start to end', { skip }, () => {
  const cases = randomMoves(400, 1);
  plans(cases).forEach((p, i) => {
    const from = cases[i][3];
    const { d, along, perp } = geometry(from, p.target);
    for (const e of p.events) {
      assert.ok(along(e) >= -1 && along(e) <= d + 25 + 1, `case ${i}: along ${along(e)} of ${d}`);
      assert.ok(Math.abs(perp(e)) <= 0.75 * 0.22 * d + 3 + 1, `case ${i}: off the line by ${perp(e)} (d ${d})`);
    }
  });
});

test('moves carry non-zero whole movementX/Y that add up to the path', { skip }, () => {
  const cases = randomMoves(200, 2);
  plans(cases).forEach((p, i) => {
    let x = Math.round(cases[i][3].x), y = Math.round(cases[i][3].y);
    for (const e of p.events) {
      assert.ok(Number.isInteger(e.dx) && Number.isInteger(e.dy) && (e.dx !== 0 || e.dy !== 0), `case ${i}`);
      assert.equal(e.x - x, e.dx); assert.equal(e.y - y, e.dy);
      x = e.x; y = e.y;
    }
  });
});

test('Fitts durations: longer for far or small targets, clamped to 250-900 ms', { skip }, () => {
  const mid = '{uniform = function(_, a, b) return (a + b) / 2 end}';
  const [near, far, small, big, tiny, huge] = drive([
    `return P.fittsMs(200, 40, ${mid})`, `return P.fittsMs(1200, 40, ${mid})`, `return P.fittsMs(600, 8, ${mid})`,
    `return P.fittsMs(600, 120, ${mid})`, `return P.fittsMs(1, 400, ${mid})`, `return P.fittsMs(100000, 1, ${mid})`]);
  assert.ok(far > near && small > big);
  assert.equal(tiny, 250); assert.equal(huge, 900);
  const cases = randomMoves(300, 3);
  plans(cases).forEach((p, i) => {
    if (!p.events.length) return;
    assert.ok(p.moveMs >= 250 && p.moveMs <= 900, `case ${i}: ${p.moveMs}`);
    const ts = p.events.map(e => e.t);
    assert.ok(ts.every((t, j) => j === 0 || t >= ts[j - 1]), `case ${i}: times go forward`);
    assert.ok(ts.at(-1) <= p.moveMs + EPS, `case ${i}: ends by moveMs`);
  });
});

test('ease-out: progress never goes back, and most of the way is covered in the first half', { skip }, () => {
  const cases = randomMoves(300, 4);
  let checked = 0;
  plans(cases).forEach((p, i) => {
    const main = p.events.filter(e => e.phase === 'main');
    const { d, along } = geometry(cases[i][3], p.target);
    if (d < 100) return;
    checked++;
    main.forEach((e, j) => j && assert.ok(along(e) >= along(main[j - 1]) - 1, `case ${i}: step ${j} goes back`));
    const half = main.filter(e => e.t <= main.at(-1).t / 2);
    assert.ok(half.length && along(half.at(-1)) > 0.6 * d, `case ${i}: ${half.length ? along(half.at(-1)) : 0} of ${d} by half time`);
  });
  assert.ok(checked > 200);
});

test('the end point is in the rect, and the target is centre-biased', { skip }, () => {
  const cases = randomMoves(300, 5);
  plans(cases).forEach((p, i) => {
    const [x, y, w, h] = cases[i][1].rect;
    const last = p.events.at(-1) ?? { x: Math.round(cases[i][3].x), y: Math.round(cases[i][3].y) };
    // The path ends on the target's pixel (target is rounded to 0.01, so allow that much more).
    assert.ok(Math.abs(last.x - p.target[0]) <= 0.51 && Math.abs(last.y - p.target[1]) <= 0.51, `case ${i}: ends off target`);
    assert.ok(p.target[0] >= x && p.target[0] <= x + w && p.target[1] >= y && p.target[1] <= y + h, `case ${i}: target off the rect`);
    assert.ok(last.x >= x - 0.5 && last.x <= x + w + 0.5 && last.y >= y - 0.5 && last.y <= y + h + 0.5, `case ${i}: end off the rect`);
  });
  // Centre bias: in a 1000 px square the usable half-width is 380 px; a uniform pick lands in the
  // inner half 50% of the time, the mean of three uniforms about 86% of the time.
  const [inner] = drive([`
    local n = 0
    for s = 1, 2000 do
      local t = P.targetPoint({x = 0, y = 0, w = 1000, h = 1000}, P.Rng(s))
      assert(t.x >= 120 and t.x <= 880 and t.y >= 120 and t.y <= 880)
      if math.abs(t.x - 500) < 190 then n = n + 1 end
    end
    return n / 2000`]);
  assert.ok(inner > 0.78, `inner fraction ${inner}`);
});

test('about one far move in five overshoots by 4-25 px and corrects; short moves never do', { skip }, () => {
  const [rate, short] = drive([`
    local n = 0
    for s = 1, 3000 do
      if plan("move", {rect = {1200, 700, 60, 30}}, s, {x = 100, y = 100}).overshoot then n = n + 1 end
    end
    return n / 3000`, `
    local n = 0
    for s = 1, 500 do
      if plan("move", {rect = {500, 500, 40, 20}}, s, {x = 490, y = 480}).overshoot then n = n + 1 end
    end
    return n`]);
  assert.ok(rate > 0.17 && rate < 0.23, `overshoot rate ${rate}`);
  assert.equal(short, 0);
  const cases = Array.from({ length: 300 }, (_, i) => ['move', { rect: [1200, 700, 60, 30] }, i + 1, { x: 100, y: 100 }]);
  let seen = 0;
  plans(cases).forEach((p, i) => {
    if (!p.overshoot) return assert.ok(p.events.every(e => e.phase === 'main'));
    seen++;
    const { d, along } = geometry({ x: 100, y: 100 }, p.target);
    const beyond = Math.max(...p.events.map(along)) - d;
    assert.ok(beyond >= 4 - 1.5 && beyond <= 25 + 1.5, `case ${i}: overshoot ${beyond}`);
    assert.ok(p.events.some(e => e.phase === 'correct') && p.events.at(-1).phase === 'correct', `case ${i}`);
  });
  assert.ok(seen > 30);
});

test('clicks: settle 40-120 ms, hold 60-140 ms, 1-3 clicks at the end of the move', { skip }, () => {
  const g = scenarios(6);
  const cases = Array.from({ length: 200 }, (_, i) => ['click',
    { rect: [g.range(0, 1800), g.range(0, 1000), g.range(10, 300), g.range(10, 80)], clicks: (i % 3) + 1 }, 500 + i,
    { x: g.range(0, 1900), y: g.range(0, 1100) }]);
  plans(cases).forEach((p, i) => {
    const moves = p.events.filter(e => e.type === 'move'), btn = p.events.filter(e => e.type !== 'move');
    const at = moves.at(-1) ?? { x: cases[i][3].x, y: cases[i][3].y };
    assert.equal(btn.length, 2 * cases[i][1].clicks);
    assert.ok(btn[0].t - p.moveMs >= 40 - EPS && btn[0].t - p.moveMs <= 120 + EPS, `case ${i}: settle`);
    btn.forEach((e, j) => {
      assert.equal(e.type, j % 2 ? 'up' : 'down');
      assert.equal(e.clicks, Math.floor(j / 2) + 1);
      assert.ok(Math.abs(e.x - at.x) < 0.01 && Math.abs(e.y - at.y) < 0.01, `case ${i}: clicks where the move ended`);
      if (j % 2) assert.ok(e.t - btn[j - 1].t >= 60 - EPS && e.t - btn[j - 1].t <= 140 + EPS, `case ${i}: hold`);
      else if (j) assert.ok(e.t - btn[j - 1].t >= 70 - EPS && e.t - btn[j - 1].t <= 130 + EPS, `case ${i}: between clicks`);
    });
  });
  const [here0, many, none] = plans([['click', {}, 1, { x: 40, y: 50 }], ['click', { clicks: 9 }, 1, { x: 0, y: 0 }],
    ['click', { clicks: 0 }, 1, { x: 0, y: 0 }]]);
  assert.deepEqual(here0.events.map(e => [e.type, e.x, e.y]), [['down', 40, 50], ['up', 40, 50]]);
  assert.equal(many.events.length, 6);
  assert.equal(none.events.length, 2);
});

test('typing: human gaps, longer after a space and punctuation, Unicode strings, capitals inside Shift', { skip }, () => {
  const texts = ['Hello, World! How are you?', 'Straße: Äpfel; Öl & Übung.\nNeue Zeile\tTab', 'éàü ÉÀÜ ß ç Ñ 漢字 🙂 ok',
    'ALL CAPS and lower MiXeD 123 !@#', 'a.b,c;d:e!f?g h'];
  texts.forEach((text, n) => {
    for (const seed of [1, 2, 3, 4]) {
      const p = plans([['type', { text }, seed]])[0];
      const chars = [...text];
      assert.equal(p.paste, false); assert.equal(p.chars, chars.length);
      const downs = p.events.filter(e => e.type === 'keyDown');
      assert.equal(downs.length, chars.length);
      downs.forEach((e, i) => {
        assert.equal(e.chars, chars[i] === '\n' || chars[i] === '\t' ? undefined : chars[i], `text ${n}: char ${i}`);
        if (!i) return;
        const gap = e.t - downs[i - 1].t, prev = chars[i - 1];
        const [lo, hi, after] = prev === ' ' ? [80, 340, 'space'] : ',.;:!?\n'.includes(prev) ? [130, 440, 'punct'] : [40, 180, 'char'];
        assert.ok(gap >= lo - 0.02 && gap <= hi + 0.02, `text ${n} seed ${seed}: gap ${gap} after ${JSON.stringify(prev)}`);
        assert.equal(p.gaps[i - 1].after, after);
      });
      // Sorted by time; Shift is really down for every shifted key and up for every other key.
      let shift = false;
      p.events.forEach((e, i) => {
        if (i) assert.ok(e.t >= p.events[i - 1].t);
        if (e.type === 'flagsDown') { assert.ok(!shift); assert.equal(e.key, 56); shift = true; }
        else if (e.type === 'flagsUp') { assert.ok(shift); shift = false; }
        else assert.equal(e.flags !== 0, shift, `text ${n} seed ${seed}: event ${i} flags ${e.flags} with shift ${shift}`);
      });
      assert.equal(shift, false);
    }
  });
  const [caps] = plans([['type', { text: 'aAÉ' }, 1]]);
  assert.deepEqual(caps.events.map(e => [e.type, e.key, e.flags]), [['keyDown', 0, 0], ['keyUp', 0, 0],
    ['flagsDown', 56, 0x20000], ['keyDown', 0, 0x20000], ['keyUp', 0, 0x20000], ['flagsUp', 56, 0],
    ['flagsDown', 56, 0x20000], ['keyDown', 14, 0x20000], ['keyUp', 14, 0x20000], ['flagsUp', 56, 0]]);
});

test('the 300-character paste rule counts characters, not bytes', { skip }, () => {
  const [x300, x301, e300, e301, empty] = plans([['type', { text: 'x'.repeat(300) }, 1], ['type', { text: 'x'.repeat(301) }, 1],
    ['type', { text: 'é'.repeat(300) }, 1], ['type', { text: 'é'.repeat(301) }, 1], ['type', { text: '' }, 1]]);
  for (const p of [x300, e300]) {
    assert.equal(p.paste, false); assert.equal(p.chars, 300);
    assert.equal(p.events.filter(e => e.type === 'keyDown').length, 300);
  }
  for (const [p, text] of [[x301, 'x'.repeat(301)], [e301, 'é'.repeat(301)]]) {
    assert.equal(p.paste, true); assert.equal(p.chars, 301);
    assert.deepEqual(p.events.map(e => [e.type, e.key, e.flags]), [['paste', undefined, undefined], ['flagsDown', 55, 0x100000],
      ['keyDown', 9, 0x100000], ['keyUp', 9, 0x100000], ['flagsUp', 55, 0], ['restore', undefined, undefined]]);
    assert.equal(p.events[0].text, text);
    assert.ok(p.events[1].t >= 80 - EPS && p.events[1].t <= 160 + EPS);
    const gap = p.events[5].t - p.events[4].t;
    assert.ok(gap >= 300 - EPS && gap <= 450 + EPS);
  }
  assert.deepEqual([empty.events, empty.chars], [[], 0]);
  const [dvorakPaste] = drive([`return plan("type", {text = string.rep("z", 301)}, 1, nil, {v = 47, z = 44})`]);
  assert.equal(dvorakPaste.events[2].key, 47, 'cmd+v uses the layout key of v');
  const [bad] = drive(['return plan("type", {text = "ok\\xff"}, 1)']);
  assert.match(bad, /^ERROR .*UTF-8/);
});

test('combos: modifiers down in order, the key, modifiers up in reverse; codes from the layout', { skip }, () => {
  const [g, named, spaced] = plans([['key', { combo: 'cmd+shift+g' }, 1], ['key', { combo: 'ctrl+alt+delete' }, 1],
    ['key', { combo: 'Cmd + Shift + 4' }, 1]]);
  assert.deepEqual(g.events.map(e => [e.type, e.key, e.flags]), [['flagsDown', 55, 0x100000], ['flagsDown', 56, 0x120000],
    ['keyDown', 5, 0x120000], ['keyUp', 5, 0x120000], ['flagsUp', 56, 0x100000], ['flagsUp', 55, 0]]);
  assert.ok(g.events.every((e, i) => !i || e.t > g.events[i - 1].t));
  assert.deepEqual(named.events.map(e => e.key), [59, 58, 51, 51, 58, 59]);
  assert.equal(spaced.events[2].key, 21);
  // An AZERTY-style map (hs.keycodes.map shape: characters, names and the reverse numbers).
  const azerty = { a: 12, q: 0, z: 13, w: 6, m: 41, ',': 46, '&': 18, 'é': 19, return: 36, 12: 'a', 0: 'q' };
  const [a, q, typed, keys] = drive([call('plan', 'key', { combo: 'cmd+a' }, 1, null, azerty),
    call('plan', 'key', { combo: 'cmd+q' }, 1, null, azerty), call('plan', 'type', { text: 'aAàé&!' }, 1, null, azerty),
    call('keyfor', [0x61, 0x41, 0xe0, 0xc0, 0xe9, 0x26, 0x21, 0x31], azerty)]);
  assert.equal(a.events[1].key, 12); assert.equal(q.events[1].key, 0);
  assert.deepEqual(typed.events.filter(e => e.type === 'keyDown').map(e => e.key), [12, 12, 12, 19, 18, undefined]);
  assert.deepEqual(keys, [[0x61, 12, 0], [0x41, 12, 1], [0xe0, 12, 0], [0xc0, 12, 1], [0xe9, 19, 0], [0x26, 18, 0],
    [0x21, false, 0], [0x31, false, 0]], 'no guessed key for a character the layout does not map');
  const errs = drive([call('plan', 'key', { combo: 'hyper+x' }, 1), call('plan', 'key', { combo: 'cmd+foo' }, 1),
    call('plan', 'key', { combo: 'cmd+' }, 1), call('plan', 'key', {}, 1)]);
  assert.match(errs[0], /unknown modifier "hyper"/);
  assert.match(errs[1], /unknown key "foo"/);
  assert.match(errs[2], /bad key combo/);
  assert.match(errs[3], /bad key combo/);
});

test('only the US layout gets the US shifted symbols; other layouts never guess a key code', { skip }, () => {
  const US = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
    o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24,
    9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, '[': 33, "'": 39, ';': 41, '\\': 42, ',': 43, '/': 44, '.': 47, '`': 50 };
  // British: the US keys plus §; Shift+2 is " and Shift+' is @, so the US pairs would be wrong.
  const british = { ...US, '§': 10 };
  // A British-style map whose own entries differ from US (no layout name needed to tell).
  const iso = { ...US, '`': 10, '§': 50 };
  // QWERTZ: y and z swapped, and Shift+7 is / rather than &.
  const qwertz = { ...US, z: 16, y: 6, 'ß': 27, 'ü': 33, 'ö': 41, 'ä': 39 };
  const cps = [0x40, 0x22, 0x21, 0x26, 0x32, 0x27];
  const [usPlain, usName, abc, gb, gbIso, de, deTyped, usUnmapped, gbUnmapped] = drive([call('keyfor', cps, US),
    call('keyfor', cps, US, 'U.S.'), call('keyfor', cps, null, 'ABC'), call('keyfor', cps, british, 'British'),
    call('keyfor', cps, iso), call('keyfor', cps, qwertz), call('plan', 'type', { text: 'z&' }, 1, null, qwertz),
    call('keyfor', [0x6f22], US), call('keyfor', [0x6f22], british, 'British')]);
  const usKeys = [[0x40, 19, 1], [0x22, 39, 1], [0x21, 18, 1], [0x26, 26, 1], [0x32, 19, 0], [0x27, 39, 0]];
  assert.deepEqual(usPlain, usKeys, 'a map equal to US is the US layout');
  assert.deepEqual(usName, usKeys, 'the layout name U.S.');
  assert.deepEqual(abc, usKeys, 'the layout name ABC');
  const noShifted = [[0x40, false, 0], [0x22, false, 0], [0x21, false, 0], [0x26, false, 0], [0x32, 19, 0], [0x27, 39, 0]];
  assert.deepEqual(gb, noShifted, 'British: no guessed @ or "');
  assert.deepEqual(gbIso, noShifted, 'a map that differs from US gets no US shifted symbols');
  assert.deepEqual(de.slice(3, 4), [[0x26, false, 0]], 'QWERTZ: no guessed &');
  const downs = deTyped.events.filter(e => e.type === 'keyDown' || e.type === 'keyUp');
  assert.deepEqual(downs.map(e => [e.type, e.key, e.flags, e.chars]), [['keyDown', 16, 0, 'z'], ['keyUp', 16, 0, 'z'],
    ['keyDown', undefined, 0, '&'], ['keyUp', undefined, 0, '&']]);
  assert.ok(downs.slice(2).every(e => !('key' in e)), 'Unicode-only events carry no key field');
  assert.ok(!deTyped.events.some(e => e.type === 'flagsDown'), 'no Shift for an unmapped symbol');
  assert.deepEqual([usUnmapped, gbUnmapped], [[[0x6f22, 0, 0]], [[0x6f22, false, 0]]], 'US keeps code 0, others none');
});

test('a map with an __index fallback (like hs.keycodes.map) still gives capitals their Shift key', { skip }, () => {
  const US = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
    o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46, 1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24,
    9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, '[': 33, "'": 39, ';': 41, '\\': 42, ',': 43, '/': 44, '.': 47, '`': 50 };
  // hs.keycodes.map answers map["H"] with 4 through its metatable, though rawget(map, "H") is nil.
  const fallback = `setmetatable(${lua(US)}, { __index = function(t, k)
    return type(k) == "string" and rawget(t, k:lower()) or nil end })`;
  const cps = [0x48, 0x68, 0x41, 0x40, 0x21];
  const [plain, named, typed] = drive([`return keyfor(${lua(cps)}, ${fallback})`,
    `return keyfor(${lua(cps)}, ${fallback}, "U.S.")`, `return plan("type", { text = "Hi" }, 1, nil, ${fallback})`]);
  const want = [[0x48, 4, 1], [0x68, 4, 0], [0x41, 0, 1], [0x40, 19, 1], [0x21, 18, 1]];
  assert.deepEqual(plain, want);
  assert.deepEqual(named, want);
  assert.deepEqual(typed.events.map(e => [e.type, e.key, e.flags]).slice(0, 4),
    [['flagsDown', 56, 0x20000], ['keyDown', 4, 0x20000], ['keyUp', 4, 0x20000], ['flagsUp', 56, 0]]);
});

test('scroll ticks sum exactly to the request, speed up then slow down', { skip }, () => {
  const g = scenarios(7);
  const cases = Array.from({ length: 300 }, (_, i) => ['scroll',
    { dx: i % 4 ? 0 : g.int(-900, 900), dy: i % 5 === 0 ? g.range(-3000, 3000) : g.int(-5000, 5000) }, 900 + i]);
  plans(cases).forEach((p, i) => {
    const { dx, dy } = cases[i][1];
    const total = Math.max(Math.abs(dx), Math.abs(dy));
    if (total < 1) return assert.deepEqual(p.events, []);
    assert.equal(p.events.length, Math.min(60, Math.max(1, Math.round(total / 45))), `case ${i}: ticks`);
    const sx = p.events.reduce((s, e) => s + e.dx, 0), sy = p.events.reduce((s, e) => s + e.dy, 0);
    assert.ok(Math.abs(sx + dx) < 1e-9 && Math.abs(sy + dy) < 1e-9, `case ${i}: sum ${sx},${sy} for ${dx},${dy}`);
    p.events.forEach((e, j) => j && assert.ok(e.t - p.events[j - 1].t >= 16 - EPS && e.t - p.events[j - 1].t <= 40 + EPS));
    if (p.events.length >= 10) {
      const v = p.events.map(e => Math.abs(Math.abs(dy) >= Math.abs(dx) ? e.dy : e.dx)), top = Math.max(...v);
      assert.ok(v[0] < top && v.at(-1) < top, `case ${i}: ${v.join(' ')}`);
    }
  });
  const [down, none] = plans([['scroll', { dy: 450 }, 1], ['scroll', { dx: 0.4, dy: -0.9 }, 1]]);
  assert.ok(down.events.every(e => e.dy < 0 && e.dx === 0), 'dy > 0 scrolls down: negative wheel values');
  assert.deepEqual(none.events, []);
});

test('bad input fails with a clear error', { skip }, () => {
  const errs = drive([call('plan', 'type', {}, 1), call('plan', 'wave', {}, 1), call('plan', 'move', { rect: [1, 2] }, 1),
    'return P.Rng("x")']);
  assert.match(errs[0], /type needs text/);
  assert.match(errs[1], /unknown hands action wave/);
  assert.match(errs[2], /need a rect/);
  assert.match(errs[3], /^ERROR/);
});
