// node --test modules/hammerspoon/install.test.mjs   (stub pgrep, hs, osascript, open and sleep; a
// throwaway HOME; never quits, opens or calls the real Hammerspoon)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('./install.sh', import.meta.url));
const skip = process.platform === 'darwin' ? false : 'macOS only (shasum)';

// running: is Hammerspoon "running" (stub pgrep); status: what `hs` answers (an object, or null
// for not answering).
// modules: MODULES in the sandbox's harness.env; hcron writes only to the sandbox's jobs file.
function sandbox({ running = true, status = null, modules = '' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hs-install-'));
  const bin = join(d, 'bin'), home = join(d, 'home'), calls = join(d, 'calls.txt');
  mkdirSync(bin);
  mkdirSync(join(home, '.hammerspoon'), { recursive: true });
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`, { mode: 0o755 });
  stub('pgrep', running ? 'exit 0' : 'exit 1');
  stub('hs', status ? `cat ${join(d, 'status.json')}` : 'exit 1');
  if (status) writeFileSync(join(d, 'status.json'), JSON.stringify(status));
  for (const name of ['osascript', 'open', 'sleep', 'killall']) stub(name, 'exit 0');
  writeFileSync(join(d, 'harness.env'), `PROFILE_DIR="${join(d, 'profile')}"\nMODULES="${modules}"\n`);
  // HSX_PORT: the hsx fallback asks a port nobody holds, never the live "harness" one.
  const env = { ...process.env, HOME: home, HARNESS_ENV: join(d, 'harness.env'), HS_APP: d,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HSX_PORT: 'install-test-none',
    HCRON_JOBS: join(d, 'jobs.json'), HCRON_STATE: join(d, 'hcron-state'), HCRON_LOGS: join(d, 'hcron-logs') };
  const run = (...a) => spawnSync('/bin/zsh', [INSTALL, ...a], { env, encoding: 'utf8', timeout: 30000 });
  const lines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const acted = () => lines().filter(l => /^(osascript|open|killall) /.test(l));
  const hash = () => run('--config-hash').stdout.trim();
  const jobs = () => (existsSync(join(d, 'jobs.json')) ? JSON.parse(readFileSync(join(d, 'jobs.json'), 'utf8')).jobs : {});
  return { d, home, run, lines, acted, hash, jobs };
}
const QUIT = 'osascript -e tell application "Hammerspoon" to quit';
const OPEN = 'open -a Hammerspoon';

test('not running: links the config and starts Hammerspoon, nothing to quit', () => {
  const s = sandbox({ running: false });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [OPEN]);
  assert.match(r.stdout, /Hammerspoon started/);
});

test('running the same config: no restart', { skip }, () => {
  const s = sandbox({ status: {} });
  // Held and armed too: an unchanged config needs no restart, so nothing is deferred either.
  writeFileSync(join(s.d, 'status.json'), JSON.stringify({ config: s.hash(), awake: { on: true, owners: ['job'] } }));
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), []);
  assert.match(r.stdout, /already runs this config \(unchanged\); not restarting/);
});

test('a changed config with nobody holding it: restarts, and says why', { skip }, () => {
  const s = sandbox({ status: { config: '0'.repeat(64), awake: { on: false, owners: {} }, port: { owners: { runner: { armed: false } } } } });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [QUIT, OPEN]);
  assert.match(r.stdout, /restarting Hammerspoon: the config changed/);
});

test('a running config without a fingerprint (older than this check) counts as changed', { skip }, () => {
  const s = sandbox({ status: { awake: { on: false, owners: [] } } });
  const r = s.run();
  assert.deepEqual(s.acted(), [QUIT, OPEN]);
  assert.match(r.stdout, /restarting Hammerspoon: the running config does not report its fingerprint/);
});

test('a changed config while awake mode is held: restart deferred', { skip }, () => {
  const s = sandbox({ status: { config: 'old', awake: { on: true, owners: ['night-ship', 'job'] } } });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [], 'never quits Hammerspoon under a hold');
  assert.match(r.stdout, /restart deferred: the config changed, but awake mode is held by night-ship, job\. Run .* again once they finish\./);
});

test('a changed config while a port owner is armed: restart deferred (a restart would drop the arm)', { skip }, () => {
  const s = sandbox({ status: { awake: { on: false, owners: [] }, port: { owners: { runner: { armed: true }, idle: { armed: false } } } } });
  const r = s.run();
  assert.deepEqual(s.acted(), []);
  assert.match(r.stdout, /restart deferred: .*, but armed: runner\./);
});

test('holds and arms together are both named', { skip }, () => {
  const s = sandbox({ status: { config: 'old', awake: { owners: ['a'] }, port: { owners: { r: { armed: true } } } } });
  assert.match(s.run().stdout, /but awake mode is held by a and armed: r\./);
});

test('not answering: the saved holds decide, live ones defer the restart', { skip }, () => {
  const live = spawn('sleep', ['30']);
  try {
    const s = sandbox();   // `hs` fails, hsx finds no port
    const file = join(s.home, '.hammerspoon', 'harness-awake.json');
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(file, JSON.stringify({ holds: { night: { pid: live.pid, until: now + 600 } } }));
    let r = s.run();
    assert.deepEqual(s.acted(), []);
    assert.match(r.stdout, /restart deferred: Hammerspoon does not answer, but awake mode is held by night\./);
    // Dead pid, passed deadline, unreadable file: nothing to protect, so it restarts.
    const dead = spawnSync('true').pid;
    for (const text of [JSON.stringify({ holds: { a: { pid: dead, until: now + 600 }, b: { until: now - 5 } } }), '{oops']) {
      const t = sandbox();
      writeFileSync(join(t.home, '.hammerspoon', 'harness-awake.json'), text);
      r = t.run();
      assert.deepEqual(t.acted(), [QUIT, OPEN], text);
      assert.match(r.stdout, /restarting Hammerspoon: Hammerspoon does not answer/);
    }
  } finally { live.kill(); }
});

test('the fingerprint changes with the harness.env values init.lua reads', { skip }, () => {
  const s = sandbox();
  const a = s.hash();
  writeFileSync(join(s.d, 'harness.env'), `PROFILE_DIR="${join(s.d, 'profile')}"\nHS_IPC_GENERIC=0\n`);
  const b = s.hash();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('--dry-run never quits or opens anything', { skip }, () => {
  const s = sandbox({ status: { config: 'old', awake: { owners: [] } } });
  const r = s.run('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), []);
  assert.match(r.stdout, /would: osascript/);
});

test('--restart: restarts an unchanged config too, links nothing, and keeps the deferral', () => {
  const s = sandbox({ status: {} });
  writeFileSync(join(s.d, 'status.json'), JSON.stringify({ config: s.hash(), awake: { owners: [] } }));
  let r = s.run('--restart', 'the eyeshands loader is new');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [QUIT, OPEN]);
  assert.match(r.stdout, /restarting Hammerspoon: the eyeshands loader is new/);
  assert.ok(!existsSync(join(s.home, '.hammerspoon', 'init.lua')), '--restart links nothing');

  const t = sandbox({ status: { config: 'x', awake: { owners: ['job'] }, port: { owners: { r: { armed: true } } } } });
  r = t.run('--restart', 'the eyeshands loader is new', 'modules/eyeshands/install.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.acted(), []);
  assert.match(r.stdout, /restart deferred: the eyeshands loader is new, but awake mode is held by job and armed: r\. Run modules\/eyeshands\/install\.sh again/);

  const u = sandbox({ running: false });
  r = u.run('--restart');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(u.acted(), [], 'never starts a Hammerspoon that is not running');
  assert.match(r.stdout, /not running; nothing to restart/);
});

test('watchdog: with the cron module it adds the hcron job every minute, idempotently; --status reports it', () => {
  const s = sandbox({ running: false, modules: 'hammerspoon cron' });
  let r = s.run('--status');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /watchdog: hcron job hammerspoon-watchdog is not registered/);
  r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const job = s.jobs()['hammerspoon-watchdog'];
  assert.equal(job.cron, '* * * * *');
  assert.match(job.cmd, /^\/bin\/zsh \S+\/modules\/hammerspoon\/watchdog\.sh$/);
  assert.equal(job.timeout, '2m');
  assert.equal(s.run().status, 0, 'a second install updates the same job');
  assert.deepEqual(Object.keys(s.jobs()), ['hammerspoon-watchdog']);
  r = s.run('--status');
  assert.match(r.stdout, /watchdog: hcron job hammerspoon-watchdog starts Hammerspoon within a minute/);
});

test('watchdog: without the cron module the shared jobs file is left alone', () => {
  const s = sandbox({ running: false });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the watchdog needs the cron module/);
  assert.ok(!existsSync(join(s.d, 'jobs.json')));
  assert.match(s.run('--status').stdout, /watchdog: off \(needs the cron module/);
});
