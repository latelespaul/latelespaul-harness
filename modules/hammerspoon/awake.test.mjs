// node --test modules/hammerspoon/awake.test.mjs   (uses a fake `hs` and `caffeinate`; never touches
// the real screen). The hold-restore tests load the real init.lua under a stub `hs` (test/init-smoke.lua)
// and need Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); they skip without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const AWAKE = here('./awake.sh');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A fake `hs`: logs each Lua expression; answers awakeInfo() with status.json and anything else with
// `answer`; fails (Hammerspoon not answering) while the file `down` exists or when answer is null.
// A fake `caffeinate` logs "<its pid> <args>" and, like the real one, ends when the -w pid exits.
function sandbox(answer = '{"on":true}', env = {}) {
  const d = mkdtempSync(join(tmpdir(), 'awake-test-'));
  const calls = join(d, 'calls.txt'), caff = join(d, 'caffeinate.txt');
  writeFileSync(join(d, 'status.json'), '{"on":false,"owners":{}}');
  writeFileSync(join(d, 'hs'), `#!/bin/sh\nprintf '%s\\n' "$4" >> ${calls}\n[ -f ${d}/down ] && exit 1\n`
    + (answer ? `case "$4" in *awakeInfo*) cat ${d}/status.json; exit 0 ;; esac\necho '${answer}'\n` : 'exit 1\n'), { mode: 0o755 });
  writeFileSync(join(d, 'caffeinate'), `#!/bin/sh\necho "$$ $*" >> ${caff}\nwhile kill -0 "$5" 2>/dev/null; do sleep 0.1; done\n`, { mode: 0o755 });
  const opts = { env: { ...process.env, PATH: `${d}:/usr/bin:/bin`, HSX_PORT: 'awake-test-none', ...env }, encoding: 'utf8', timeout: 20000 };
  const run = (...a) => spawnSync('/bin/zsh', [AWAKE, ...a], opts);
  const read = f => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []);
  const lines = () => read(calls);
  const ons = () => lines().filter(l => l.includes('harness.awake(true'));
  return { d, run, lines, ons, caffeinated: () => read(caff) };
}

test('run holds awake mode around the command, passes its exit code, then releases with a lock', () => {
  const s = sandbox();
  const r = s.run('run', 'apply', '--minutes', '30', '--', 'sh', '-c', 'exit 7');
  assert.equal(r.status, 7);
  const [on, off] = s.lines();
  assert.match(on, /harness\.awake\(true, \{owner='apply', minutes=30, pid=\d+\}\)/);
  assert.match(off, /harness\.awake\(false, \{owner='apply', lock=true/);
});

test('the command still runs when Hammerspoon does not answer', () => {
  const s = sandbox(null, { AWAKE_CAFFEINATE: '0' });
  const r = s.run('run', 'x', '--', 'sh', '-c', 'echo ran');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran');
  assert.match(r.stderr, /running without awake mode/);
});

test('names that could inject Lua are refused', () => {
  const s = sandbox();
  assert.equal(s.run('on', "x'}) os.execute('id") .status, 2);
  assert.equal(s.lines().length, 0);
});

test('on, off and status call Hammerspoon and print its answer', () => {
  const s = sandbox();
  assert.match(s.run('on', 'job', '--pid', '42').stdout, /"on":true/);
  assert.match(s.lines()[0], /pid=42/);
  assert.equal(s.run('off', 'job').status, 0);
  assert.equal(s.run('status').status, 0);
  assert.equal(s.run('bogus').status, 2);
});

test('on without --pid ties the hold to the caller, not to the short-lived awake process', () => {
  const s = sandbox();
  const r = spawnSync('/bin/zsh', ['-c', `${AWAKE} on job; print -r -- $$`], { env: { ...process.env, PATH: `${s.d}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const callerPid = r.stdout.trim().split('\n').pop();
  assert.match(s.lines()[0], new RegExp(`pid=${callerPid}\\}`));
});

test('run warns when Hammerspoon refuses awake mode, and still runs the command', () => {
  const s = sandbox('{"on":false,"reason":"screen already locked"}');
  const r = s.run('run', 'x', '--', 'sh', '-c', 'echo ran');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran');
  assert.match(r.stderr, /refused \(screen already locked\)/);
});

test('run stays quiet when awake mode is granted', () => {
  const s = sandbox();
  assert.equal(s.run('run', 'x', '--', 'true').stderr, '');
});

test('with the generic hs port closed, awake talks to the harness port through hsx', () => {
  const s = sandbox(null);   // `hs` fails, as it does with HS_IPC_GENERIC=0
  const calls = join(s.d, 'hsx-calls.txt');
  writeFileSync(join(s.d, 'hsx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\necho '{"on":true,"owners":["x"]}'\n`, { mode: 0o755 });
  const r = s.run('run', 'x', '--minutes', '9', '--', 'true');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const [on, off] = readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(on, /^--timeout 5 call awake\.on \{"owner":"x","minutes":9,"pid":\d+\}$/);
  assert.match(off, /^--timeout 5 call awake\.off \{"owner":"x","lock":true,"reason":"x finished"\}$/);
  assert.equal(s.run('status').status, 0);
  assert.match(readFileSync(calls, 'utf8'), /call awake\.status\n$/);
});

// ---------- run keeps its hold while the command runs ----------
const FAST = { AWAKE_RECHECK_SECS: '0.3' };

test('run takes its hold again after Hammerspoon lost it, as the same owner and pid', () => {
  const s = sandbox('{"on":true}', FAST);   // status.json: a fresh Hammerspoon that holds nothing
  const r = s.run('run', 'night', '--minutes', '30', '--', 'sleep', '1.3');
  assert.equal(r.status, 0, r.stderr);
  const ons = s.ons();
  assert.ok(ons.length >= 3, `the first hold plus re-takes: ${ons}`);
  const pid = ons[0].match(/pid=(\d+)/)[1];
  for (const on of ons) assert.match(on, new RegExp(`harness\\.awake\\(true, \\{owner='night', minutes=(30|29), pid=${pid}\\}\\)`));
  assert.match(s.lines().at(-1), /harness\.awake\(false, \{owner='night', lock=true/, 'released last, after the keeper stopped');
  assert.match(r.stderr, /Hammerspoon lost the hold; taking it again/);
});

test('run leaves a hold that Hammerspoon still has alone', () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'status.json'), '{"on":true,"owners":["other","night"]}');
  const r = s.run('run', 'night', '--', 'sleep', '1');
  assert.equal(r.status, 0);
  assert.equal(s.ons().length, 1);
  assert.ok(s.lines().filter(l => l.includes('awakeInfo')).length >= 2, 'it kept checking');
  assert.equal(r.stderr, '');
});

test('run does not take back a hold that ended on purpose after it took it', () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'status.json'), '{"on":false,"owners":{},"last_end":{"reason":"person at the Mac","at":"2999-01-01T00:00:00Z"}}');
  const r = s.run('run', 'night', '--', 'sleep', '1');
  assert.equal(r.status, 0);
  assert.equal(s.ons().length, 1, 'no second hold');
  assert.equal(s.lines().filter(l => l.includes('awakeInfo')).length, 1, 'and it stopped checking');
});

test('an end from before run started does not count: the hold is taken again', () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'status.json'), '{"on":false,"owners":{},"last_end":{"reason":"deadline","at":"2000-01-01T00:00:00Z"}}');
  assert.equal(s.run('run', 'night', '--', 'sleep', '1').status, 0);
  assert.ok(s.ons().length >= 2);
});

test('while Hammerspoon does not answer, caffeinate keeps the display awake, tied to the run', () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'down'), '');
  const r = s.run('run', 'night', '--', 'sh', '-c', 'echo ran; sleep 1');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran');
  const caff = s.caffeinated();
  assert.equal(caff.length, 1, 'started once, not on every check');
  const [cpid, ...args] = caff[0].split(' ');
  const pid = s.ons()[0].match(/pid=(\d+)/)[1];
  assert.deepEqual(args, ['-d', '-i', '-u', '-w', pid], 'waits on the awake process itself');
  assert.equal(alive(Number(cpid)), false, 'gone when the run ends');
  assert.match(r.stderr, /keeping the display awake with caffeinate/);
});

test('once Hammerspoon answers again, caffeinate stops and the hold is taken', () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'down'), '');
  const r = s.run('run', 'night', '--', 'sh', '-c', `sleep 0.8; rm ${join(s.d, 'down')}; sleep 1.2`);
  assert.equal(r.status, 0, r.stderr);
  const cpid = Number(s.caffeinated()[0].split(' ')[0]);
  assert.equal(alive(cpid), false);
  // Calls logged after Hammerspoon came back: a status check, then a fresh hold.
  const back = s.lines().slice(s.lines().findIndex(l => l.includes('awakeInfo')));
  assert.ok(back.some(l => l.includes('harness.awake(true')), back.join('\n'));
  assert.match(r.stderr, /taking it again/);
});

test('AWAKE_CAFFEINATE=0 turns the caffeinate fallback off', () => {
  const s = sandbox(null, { ...FAST, AWAKE_CAFFEINATE: '0' });
  assert.equal(s.run('run', 'night', '--', 'sleep', '0.7').status, 0);
  assert.deepEqual(s.caffeinated(), []);
});

test('a run killed with SIGKILL leaves no keeper or caffeinate behind', async () => {
  const s = sandbox('{"on":true}', FAST);
  writeFileSync(join(s.d, 'down'), '');
  const child = spawn('/bin/zsh', [AWAKE, 'run', 'night', '--', 'sleep', '30'],
    { env: { ...process.env, PATH: `${s.d}:/usr/bin:/bin`, HSX_PORT: 'awake-test-none', ...FAST }, stdio: 'ignore', detached: true });
  const wait = ms => new Promise(res => setTimeout(res, ms));
  for (let i = 0; i < 50 && !s.caffeinated().length; i++) await wait(100);
  const cpid = Number(s.caffeinated()[0].split(' ')[0]);
  child.kill('SIGKILL');
  await wait(1200);
  assert.equal(alive(cpid), false, 'caffeinate -w ended with the run');
  const n = s.lines().length;
  await wait(900);
  assert.equal(s.lines().length, n, 'the keeper stopped calling Hammerspoon');
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
});

// ---------- init.lua: holds survive a Hammerspoon restart ----------
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const skipLua = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';
const BOOT = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }).stdout.match(/sec = (\d+)/)[1];
const now = () => Math.floor(Date.now() / 1000);
const names = v => (Array.isArray(v) ? v : Object.keys(v));   // the stub JSON writes an empty list as {}

// Loads init.lua (stub hs) with `holds` (text, or an object saved as this boot's) in the holds
// file; then runs `then` (Lua) and returns what init-smoke.lua reported plus the file afterwards.
function load(holds, then) {
  const d = mkdtempSync(join(tmpdir(), 'awake-restore-'));
  const cfg = join(d, 'config');
  mkdirSync(join(cfg, 'local'), { recursive: true });
  mkdirSync(join(d, 'Library', 'Logs'), { recursive: true });
  symlinkSync(here('./init.lua'), join(cfg, 'init.lua'));
  const file = join(cfg, 'harness-awake.json');
  if (holds !== undefined) writeFileSync(file, typeof holds === 'string' ? holds : JSON.stringify({ boot: BOOT, holds }));
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `HS_ACCESS_FILE="${join(d, 'access.json')}"\n`);
  const env = { ...process.env, HOME: d, HARNESS_ENV: envFile, ...(then ? { SMOKE_THEN: then } : {}) };
  const r = spawnSync(LUA, [here('./test/init-smoke.lua'), cfg, 'awake'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  return { ...JSON.parse(r.stdout), log: r.stderr, saved, mode: existsSync(file) ? statSync(file).mode & 0o777 : null, env };
}

test('a restart restores live holds and drops dead-pid, expired and unreadable ones', { skip: skipLua }, () => {
  const live = spawn('sleep', ['30']);
  const dead = spawnSync('true').pid;
  const t = now() + 600;
  try {
    const out = load({ live: { pid: live.pid, until: t, dim: false }, nopid: { until: t + 60, dim: true },
      dead: { pid: dead, until: t }, expired: { pid: live.pid, until: now() - 5 }, 'bad name!': { until: t } });
    assert.deepEqual(out.loaded.owners, ['live', 'nopid']);
    assert.equal(out.loaded.on, true);
    assert.equal(out.loaded.until, t + 60);
    assert.deepEqual(out.caffeinate, { displayIdle: true, systemIdle: true }, 'the power assertions are back');
    assert.match(out.log, /hold dead not restored \(process gone\)/);
    assert.match(out.log, /hold expired not restored \(deadline passed\)/);
    assert.deepEqual(out.saved, { boot: BOOT, holds: { live: { pid: live.pid, until: t, dim: false }, nopid: { until: t + 60, dim: true } } },
      'the file keeps only what was restored, with the same deadlines');
    assert.equal(out.mode, 0o600);
  } finally { live.kill(); }
});

test('holds from an earlier boot are not restored', { skip: skipLua }, () => {
  const out = load(JSON.stringify({ boot: '1', holds: { old: { until: now() + 600 } } }));
  assert.deepEqual(names(out.loaded.owners), []);
  assert.match(out.log, /hold old not restored \(earlier boot\)/);
  assert.deepEqual(out.saved.holds, {});
});

test('a corrupt or missing holds file is tolerated, and the next hold writes a good one', { skip: skipLua }, () => {
  const live = spawn('sleep', ['30']);
  try {
    for (const holds of ['{not json', undefined]) {
      const out = load(holds, `return harness.awake(true, {owner="job", minutes=5, pid=${live.pid}})`);
      assert.deepEqual(names(out.loaded.owners), []);
      assert.deepEqual(out.after.owners, ['job']);
      const h = out.saved.holds.job;
      assert.equal(h.pid, live.pid);
      assert.equal(h.dim, true);
      assert.ok(Math.abs(h.until - (now() + 300)) <= 5);
      assert.deepEqual(Object.keys(out.saved).sort(), ['boot', 'holds'], 'nothing else (no secret) in the file');
      assert.equal(out.mode, 0o600);
    }
  } finally { live.kill(); }
});

test('releasing a hold removes it from the file; the last release empties it', { skip: skipLua }, () => {
  const t = now() + 600;
  const out = load({ a: { until: t }, b: { until: t } },
    'harness.awake(false, {owner="a"}); local f = io.open(hs.configdir .. "/harness-awake.json"); local s = f:read("a"); f:close(); harness.awake(false, {owner="b"}); return s');
  assert.deepEqual(Object.keys(JSON.parse(out.result).holds), ['b']);
  assert.deepEqual(names(out.after.owners), []);
  assert.deepEqual(out.saved.holds, {});
  assert.deepEqual(out.caffeinate, { displayIdle: false, systemIdle: false });
});

test('init.lua reports the same config fingerprint that install.sh computes', { skip: skipLua }, () => {
  const out = load(undefined);
  assert.match(out.config, /^[0-9a-f]{64}$/);
  const r = spawnSync('/bin/zsh', [here('./install.sh'), '--config-hash'], { encoding: 'utf8', env: out.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), out.config);
});
