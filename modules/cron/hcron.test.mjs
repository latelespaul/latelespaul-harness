// node --test modules/cron/hcron.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCron, cronMatches, inWindow, dueSlots, parseDuration } from './hcron.mjs';

const at = (h, m, day = 10) => new Date(2026, 10, day, h, m, 0); // Nov 2026, local time (10th = Tue)

test('cron fields: lists, ranges, steps, names', () => {
  const f = parseCron('7,37 20-23/2 * * mon-fri');
  assert.ok(cronMatches(f, at(20, 7)));
  assert.ok(cronMatches(f, at(22, 37)));
  assert.ok(!cronMatches(f, at(21, 7)));          // step skips 21
  assert.ok(!cronMatches(f, at(20, 8)));
  assert.ok(!cronMatches(f, at(20, 7, 15)));      // Sunday
  assert.ok(cronMatches(parseCron('@hourly'), at(3, 0)));
  assert.ok(cronMatches(parseCron('*/15 * * * *'), at(3, 45)));
  assert.ok(cronMatches(parseCron('0 9 * * 7'), at(9, 0, 15)));   // 7 = Sunday
});

test('cron rejects bad input', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', 'x * * * *', '*/0 * * * *'])
    assert.throws(() => parseCron(bad), bad);
});

test('day-of-month OR day-of-week when both are set', () => {
  const f = parseCron('0 0 1 * mon');
  assert.ok(cronMatches(f, at(0, 0, 1)));   // the 1st (Sunday)
  assert.ok(cronMatches(f, at(0, 0, 9)));   // a Monday
  assert.ok(!cronMatches(f, at(0, 0, 10)));
});

test('windows, including across midnight', () => {
  assert.ok(inWindow('20:00-05:00', at(23, 59)));
  assert.ok(inWindow('20:00-05:00', at(2, 0)));
  assert.ok(!inWindow('20:00-05:00', at(5, 0)));
  assert.ok(!inWindow('20:00-05:00', at(12, 0)));
  assert.ok(inWindow('09:00-17:30', at(17, 29)));
  assert.ok(!inWindow('09:00-17:30', at(17, 30)));
  assert.ok(inWindow(undefined, at(1, 1)));
  assert.throws(() => inWindow('9-5', at(1, 1)));
});

test('due slots: this minute, and missed slots after sleep', () => {
  const f = parseCron('7 * * * *');
  assert.deepEqual(dueSlots(f, at(20, 6), at(20, 7)).map(d => d.getHours()), [20]);
  assert.equal(dueSlots(f, at(20, 7), at(20, 8)).length, 0);            // already handled
  const slept = dueSlots(f, at(20, 0), at(23, 30));                     // asleep 20:00-23:30
  assert.deepEqual(slept.map(d => d.getHours()), [20, 21, 22, 23]);
  assert.equal(dueSlots(f, null, at(20, 7)).length, 1);                 // first run ever
  assert.equal(dueSlots(f, null, at(20, 8)).length, 0);
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('50m'), 3_000_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('15'), 900_000);
  assert.throws(() => parseDuration('soon'));
});

// ---------- CLI, run against a throwaway jobs file, state and log folder ----------
const HCRON = fileURLToPath(new URL('./hcron.mjs', import.meta.url));
function sandbox() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'hcron-test-')));
  const env = { ...process.env, HCRON_JOBS: join(d, 'jobs.json'), HCRON_STATE: join(d, 'state'), HCRON_LOGS: join(d, 'logs'), HCRON_NOTIFY: '' };
  const run = (...a) => spawnSync(process.execPath, [HCRON, ...a], { env, encoding: 'utf8' });
  const jobs = () => JSON.parse(readFileSync(env.HCRON_JOBS, 'utf8')).jobs;
  const state = id => JSON.parse(readFileSync(join(d, 'state', `${id}.json`), 'utf8'));
  return { d, env, run, jobs, state };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 200))) if (fn()) return;
  throw new Error('timed out waiting');
}

test('a timed-out job is stopped together with everything it started', async () => {
  const s = sandbox();
  const pidFile = join(s.d, 'grandchild.pid');
  assert.equal(s.run('add', 'slow', '--cron', '0 0 1 1 *', '--timeout', '1s', '--cmd', `sleep 60 & print $! > ${pidFile}; wait`).status, 0);
  assert.match(s.run('run', 'slow').stdout, /started/);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await until(() => s.state('slow').pid === null);
  assert.equal(s.state('slow').consecutive_failures, 1);
  await until(() => !alive(grandchild), 2000);
  assert.match(s.run('logs', 'slow').stdout, /timed out/);
});

test('a job runs in its folder and records its exit code', async () => {
  const s = sandbox();
  const dir = join(s.d, 'proj'); mkdirSync(dir);
  assert.equal(s.run('add', 'pwd', '--cron', '@daily', '--cwd', dir, '--cmd', 'pwd > out.txt; exit 3').status, 0);
  s.run('run', 'pwd');
  await until(() => s.state('pwd').pid === null);
  assert.equal(s.state('pwd').last_exit, 3);
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf8').trim(), execFileSync('/bin/pwd', { cwd: dir, encoding: 'utf8' }).trim());
});

test('a job whose folder is gone is reported, not crashed on', () => {
  const s = sandbox();
  const dir = join(s.d, 'gone'); mkdirSync(dir);
  s.run('add', 'g', '--cron', '@daily', '--cwd', dir, '--cmd', 'true');
  execFileSync('rmdir', [dir]);
  const r = s.run('run', 'g');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /missing cwd/);
  assert.match(s.run('logs').stdout, /g not started: folder .*gone is gone/);
});

test('add: resolves --cwd, checks --needs, and re-adding replaces the job but keeps it paused', () => {
  const s = sandbox();
  const r = spawnSync(process.execPath, [HCRON, 'add', 'a', '--cron', '@daily', '--cmd', 'true', '--cwd', '.'], { env: s.env, cwd: s.d, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(s.jobs().a.cwd, s.d);
  assert.notEqual(s.run('add', 'b', '--cron', '@daily', '--cmd', 'true', '--cwd', join(s.d, 'nope')).status, 0);
  assert.notEqual(s.run('add', 'b', '--cron', '@daily', '--cmd', 'true', '--needs', 'GUI').status, 0);
  assert.equal(s.jobs().b, undefined);
  s.run('add', 'c', '--cron', '@daily', '--cmd', 'true', '--needs', 'gui,unlocked', '--window', '20:00-05:00', '--catchup', '--timeout', '5m');
  s.run('pause', 'c');
  const added = s.jobs().c.added;
  s.run('add', 'c', '--cron', '@hourly', '--cmd', 'echo hi');
  assert.deepEqual(s.jobs().c, { cron: '@hourly', cmd: 'echo hi', paused: true, added });
});

test('a gui job skipped for missing GUI access is reported once, not every minute', () => {
  const s = sandbox();
  const notes = join(s.d, 'notes.txt');
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'hs'), '#!/bin/sh\necho \'{"screen_locked":false,"accessibility":false}\'\n', { mode: 0o755 });
  const env = { ...s.env, HCRON_PATH: `${bin}:/usr/bin:/bin`, HCRON_NOTIFY: `echo >> ${notes}` };
  s.run('add', 'ui', '--cron', '* * * * *', '--needs', 'gui', '--cmd', 'true');
  mkdirSync(join(s.d, 'state'));
  for (let i = 0; i < 2; i++) {
    writeFileSync(join(s.d, 'state', 'ui.json'), JSON.stringify({ ...(i ? s.state('ui') : {}), last_check: new Date(Date.now() - 60_000).toISOString() }));
    spawnSync(process.execPath, [HCRON, 'tick'], { env, encoding: 'utf8' });
  }
  assert.equal(s.run('logs').stdout.match(/ui skipped: Hammerspoon not answering/g)?.length, 1);
});

test('without PROFILE_DIR the jobs file comes from harness.env', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'hcron-env-')));
  writeFileSync(join(d, 'harness.env'), `PROFILE_DIR="${d}/my-profile"\n`);
  const env = { ...process.env, HARNESS_ENV: join(d, 'harness.env'), HCRON_STATE: join(d, 'state'), HCRON_LOGS: join(d, 'logs') };
  delete env.HCRON_JOBS; delete env.PROFILE_DIR;
  const r = spawnSync(process.execPath, [HCRON, 'list'], { env, encoding: 'utf8' });
  assert.match(r.stdout, new RegExp(`jobs: ${d}/my-profile/cron/jobs\\.json`));
});
