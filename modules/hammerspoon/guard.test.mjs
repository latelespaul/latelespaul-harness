// node --test modules/hammerspoon/guard.test.mjs   (never touches the real Hammerspoon or the screen)
// Regression tests for the awake guard: no screen driver (an armed port owner, a hands call, a
// module that reports armed or busy, tagged input) may run without an awake hold. guard.lua and
// port.lua run under a plain Lua 5.4 over a fake awake mode (test/guard-driver.lua); the last tests
// load the real init.lua under a stub `hs` (test/init-smoke.lua). Needs Lua 5.4; skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const skip = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';

// One Lua chunk per line through the guard driver; one parsed result per line.
function drive(lines) {
  const r = spawnSync(LUA, [here('./test/guard-driver.lua')], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n').map(l => (l.startsWith('ERROR') ? assert.fail(l) : JSON.parse(l)));
}
const list = v => (Array.isArray(v) ? v : []);   // the fake JSON writes an empty list as {}
const ARM = 'return port.arm("runner", KEY, {pid = 4242, minutes = 60})';

test('arming with no awake hold makes the harness take one, tied to the arm, with one alert', { skip }, () => {
  const [armed, holds, hold, alerts, again, log] = drive([ARM, 'return owners()', 'return HOLDS["guard.runner"]',
    'return ALERTS', 'call("hands.click"); call("hands.click"); return #ALERTS', 'return table.concat(LOG, "\\n")']);
  assert.equal(armed, true);
  assert.deepEqual(holds, ['guard.runner']);
  assert.deepEqual(hold, { pid: 4242, minutes: 60 }, 'same pid and deadline as the arm');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /awake guard: runner used eyes\/hands without an awake hold; harness took one/);
  assert.equal(again, 1, 'one alert per arm, not per call');
  assert.match(log, /guard hold owner=guard\.runner source=port gap=yes/);
  assert.match(log, /ok owner=runner cmd=hands\.click/);
});

test('an owner already covered by another awake hold gets a guard hold but no alert', { skip }, () => {
  const [, holds, alerts] = drive(['HOLDS["night-job"] = {}; return ' + ARM.slice(7), 'return owners()', 'return #ALERTS']);
  assert.deepEqual(holds, ['guard.runner', 'night-job']);
  assert.equal(alerts, 0);
});

test('a hands call is refused, with one alert, when no awake hold can be taken', { skip }, () => {
  const [, c1, c2, alerts] = drive(['LOCKED = true; return ' + ARM.slice(7), 'return call("hands.click", "{\\"x\\":1}")',
    'return call("hands.click")', 'return ALERTS']);
  assert.deepEqual(c1, { ok: false, error: 'no awake hold (screen already locked)' });
  assert.deepEqual(c2, { ok: false, error: 'no awake hold (screen already locked)' });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /runner is using eyes\/hands with no awake hold, and none could be taken \(screen already locked\)/);
});

test('a hold lost to a person at the Mac (screen locked) refuses the next call without another alert', { skip }, () => {
  const [, ok, refused, alerts] = drive([ARM, 'return call("hands.click")',
    'HOLDS = {}; LOCKED = true; return call("hands.click")', 'return #ALERTS']);
  assert.equal(ok.ok, true);
  assert.deepEqual(refused, { ok: false, error: 'no awake hold (screen already locked)' });
  assert.equal(alerts, 1, 'only the first "took a hold" alert');
});

test('a hold lost while the screen is unlocked is taken again, by the next call or the next tick', { skip }, () => {
  const [, byCall, byTick, alerts] = drive([ARM, 'HOLDS = {}; call("hands.click"); return owners()',
    'HOLDS = {}; guard.tick({}); return owners()', 'return #ALERTS']);
  assert.deepEqual(byCall, ['guard.runner']);
  assert.deepEqual(byTick, ['guard.runner']);
  assert.equal(alerts, 1);
});

test('a hold that a person at the Mac or a lock ended stays ended until the owner arms again', { skip }, () => {
  for (const reason of ['person at the Mac', 'screen locked']) {
    const [, , refused, afterTick, again, awakes, alerts, rearmed, ok, log] = drive([ARM, 'return #AWAKE',
      `endAll("${reason}"); return call("hands.click")`, 'guard.tick({}); return owners()',
      'return call("hands.click")', 'return #AWAKE', 'return #ALERTS',
      'T = T + 700; call("disarm"); port.arm("runner", KEY, {pid = 4242, minutes = 60}); return owners()',
      'return call("hands.click")', 'return table.concat(LOG, "\\n")']);
    const error = `awake hold ended (${reason}); re-arm to take a new one`;
    assert.deepEqual(refused, { ok: false, error });
    assert.deepEqual(list(afterTick), [], 'the 30 s check does not take it again');
    assert.deepEqual(again, { ok: false, error });
    assert.equal(awakes, 1, 'no new hold is asked for after the end');
    assert.equal(alerts, 1, 'only the first "took a hold" alert');
    assert.deepEqual(rearmed, ['guard.runner'], 'a fresh arm takes a new hold');
    assert.equal(ok.ok, true);
    assert.match(log, /guard stopped owner=guard\.runner reason=/);
  }
});

test('a hold suspended by a person or a lock (no end record) refuses calls while locked, then works after the unlock', { skip }, () => {
  const [, refused, afterTick, back, alerts] = drive([ARM, 'suspendAll(); return call("hands.click")',
    'guard.tick({}); return owners()', 'LOCKED = false; return call("hands.click")', 'return #ALERTS']);
  assert.deepEqual(refused, { ok: false, error: 'no awake hold (screen already locked)' });
  assert.deepEqual(list(afterTick), [], 'nothing can be held on a locked screen');
  assert.equal(back.ok, true, 'not stopped: the hold comes back once the screen is unlocked');
  assert.equal(alerts, 1, 'only the first "took a hold" alert');
});

test('a disarm (signed, or the arm expiring) releases the guard hold with a lock', { skip }, () => {
  const [, signed, , expired, last] = drive([ARM, 'call("disarm"); return owners()',
    'T = T + 700; ' + ARM.slice(7), 'T = T + 3601; port.sweep(); return owners()', 'return AWAKE[#AWAKE]']);
  assert.deepEqual(list(signed), []);
  assert.deepEqual(list(expired), []);
  assert.equal(last.on, false);
  assert.equal(last.lock, true);
  assert.equal(last.owner, 'guard.runner');
});

test('each new arm may alert again, but at most one alert every 10 minutes', { skip }, () => {
  const [, , , soon, , later] = drive([ARM, 'call("disarm")', 'T = T + 60; port.arm("runner", KEY, {pid = 1})', 'return #ALERTS',
    'call("disarm"); T = T + 600; port.arm("runner", KEY, {pid = 1})', 'return #ALERTS']);
  assert.equal(soon, 1);
  assert.equal(later, 2);
});

test('a module that reports armed or busy is held while it does, then released with a lock', { skip }, () => {
  const [held, hold, alerts, still, released, last] = drive(['guard.tick({jobs = true}); return owners()', 'return HOLDS["guard.jobs"]',
    'return ALERTS', 'T = T + 30; guard.tick({jobs = true}); return #AWAKE', 'guard.tick({jobs = false}); return owners()', 'return AWAKE[#AWAKE]']);
  assert.deepEqual(held, ['guard.jobs']);
  assert.equal(hold.minutes, 10);
  assert.match(alerts[0], /jobs used eyes\/hands without an awake hold/);
  assert.equal(still, 1, 'an active hold is not taken again every tick');
  assert.deepEqual(list(released), []);
  assert.deepEqual(last, { on: false, owner: 'guard.jobs', lock: true });
});

test('a module hold is renewed before it runs out', { skip }, () => {
  const [ons] = drive(['guard.tick({jobs = true}); T = T + 301; guard.tick({jobs = true}); local n = 0; for _, a in ipairs(AWAKE) do if a.on then n = n + 1 end end; return n']);
  assert.equal(ons, 2);
});

test('tagged input takes a hold that ends 30 minutes after the last input', { skip }, () => {
  const [held, kept, gone] = drive(['guard.input(); return owners()', 'T = T + 1700; guard.input(); T = T + 1700; guard.tick({}); return owners()',
    'T = T + 101; guard.tick({}); return owners()']);
  assert.deepEqual(held, ['guard.input']);
  assert.deepEqual(kept, ['guard.input']);
  assert.deepEqual(list(gone), []);
});

test('the status view lists what the guard covers', { skip }, () => {
  const [info] = drive([ARM.slice(7) + '; guard.tick({jobs = true}); return guard.info()']);
  assert.deepEqual(info, { 'guard.jobs': { held: true, source: 'driver' }, 'guard.runner': { held: true, source: 'port' } });
});

// ---------- the real init.lua, under a stub `hs` ----------
function load(then) {
  const d = mkdtempSync(join(tmpdir(), 'hs-guard-'));
  const cfg = join(d, 'config');
  mkdirSync(join(cfg, 'local'), { recursive: true });
  mkdirSync(join(d, 'Library', 'Logs'), { recursive: true });
  symlinkSync(here('./init.lua'), join(cfg, 'init.lua'));
  const access = join(d, 'access.json');
  writeFileSync(access, '{"owners":{"runner":{"enabled":true,"capabilities":["hands"]}}}');
  writeFileSync(join(d, 'harness.env'), `HS_ACCESS_FILE="${access}"\n`);
  const r = spawnSync(LUA, [here('./test/init-smoke.lua'), cfg, 'awake'], { encoding: 'utf8',
    env: { ...process.env, HOME: d, HARNESS_ENV: join(d, 'harness.env'), SMOKE_THEN: then } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('init.lua: an owner armed on the harness port holds awake mode until it disarms', { skip }, () => {
  const live = spawn('sleep', ['30']);
  try {
    const out = load(`harness.arm("runner", string.rep("ab", 32), {pid = ${live.pid}})
      local held = harness.awakeInfo().owners
      harness.disarm("runner")
      return hs.json.encode({ held = held, status = hs.json.decode(harness.status()).guard })`);
    const res = JSON.parse(out.result);
    assert.deepEqual(res.held, ['guard.runner']);
    assert.deepEqual(list(out.after.owners), []);
    assert.equal(out.after.ended['guard.runner'].reason, 'runner disarmed (released)');
  } finally { live.kill(); }
});

test('init.lua: a module whose hands.status() says armed is found by the 30 s probe and held', { skip }, () => {
  const out = load(`jobs = { hands = { status = function() return '{"ok":true,"armed":true,"busy":false}' end } }
    idle = { hands = { status = function() return { armed = false, busy = false } end } }
    broken = { hands = { status = function() error("boom") end } }
    harness.guardTick()
    return hs.json.encode(hs.json.decode(harness.status()).guard)`);
  assert.deepEqual(JSON.parse(out.result), { 'guard.jobs': { held: true, source: 'driver' } });
  assert.deepEqual(out.after.owners, ['guard.jobs']);
});

test('init.lua: input with a tag registered by harness.addEventTag takes the input hold; other tags do not', { skip }, () => {
  const out = load(`local tap = SMOKE.taps[#SMOKE.taps]   -- the guard's tagged-input tap
    harness.addEventTag(0x4548)
    tap.fn(SMOKE.event("keyDown", 0x1234))
    tap.fn(SMOKE.event("leftMouseDown", 0))
    local before = hs.json.decode(harness.status()).guard
    tap.fn(SMOKE.event("keyDown", 0x4548))
    return hs.json.encode({ before = before, after = hs.json.decode(harness.status()).guard })`);
  const res = JSON.parse(out.result);
  assert.deepEqual(Object.keys(res.before ?? {}), [], 'an unregistered tag and an untagged click are a person, not machine input');
  assert.deepEqual(res.after, { 'guard.input': { held: true, source: 'input' } });
  assert.deepEqual(out.after.owners, ['guard.input']);
});
