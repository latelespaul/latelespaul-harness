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

test('a skip is reported again when its reason changes', () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  const answer = join(s.d, 'hs.json');
  writeFileSync(join(bin, 'hs'), `#!/bin/sh\ncat ${answer}\n`, { mode: 0o755 });
  const env = { ...s.env, HCRON_PATH: `${bin}:/usr/bin:/bin` };
  s.run('add', 'ui', '--cron', '* * * * *', '--needs', 'gui', '--cmd', 'true');
  mkdirSync(join(s.d, 'state'));
  for (const hs of [{ screen_locked: true, accessibility: true }, { screen_locked: true, accessibility: true }, { screen_locked: false, accessibility: false }]) {
    writeFileSync(answer, JSON.stringify(hs));
    let st = {}; try { st = s.state('ui'); } catch {}
    writeFileSync(join(s.d, 'state', 'ui.json'), JSON.stringify({ ...st, last_check: new Date(Date.now() - 60_000).toISOString() }));
    spawnSync(process.execPath, [HCRON, 'tick'], { env, encoding: 'utf8' });
  }
  const log = s.run('logs').stdout;
  assert.equal(log.match(/ui skipped: screen is locked/g)?.length, 1);
  assert.equal(log.match(/ui skipped: Hammerspoon not answering/g)?.length, 1);
});

test('a job whose folder is not a folder is reported and unlocked, not crashed on', async () => {
  const s = sandbox();
  const file = join(s.d, 'afile'); writeFileSync(file, '');
  writeFileSync(s.env.HCRON_JOBS, JSON.stringify({ version: 1, paused: false, jobs: { f: { cron: '@daily', cmd: 'true', cwd: file } } }));
  const r = s.run('run', 'f');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'f: not started');
  assert.match(s.run('logs').stdout, /f not started: .*ENOTDIR/);
  assert.equal(s.state('f').pid, null);
});

test('run says "not started" when the job folder cannot be entered', () => {
  const s = sandbox();
  const dir = join(s.d, 'locked'); mkdirSync(dir, { mode: 0o000 });
  writeFileSync(s.env.HCRON_JOBS, JSON.stringify({ version: 1, paused: false, jobs: { x: { cron: '@daily', cmd: 'true', cwd: dir } } }));
  const r = s.run('run', 'x');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'x: not started');
  assert.equal(s.state('x').pid, null);
});

test('an --awake job holds awake mode while it runs and releases it with a lock when it ends', async () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  const calls = join(s.d, 'hs-calls.txt');
  // A fake `hs` that records each Lua call and answers like Hammerspoon.
  writeFileSync(join(bin, 'hs'), `#!/bin/sh\nprintf '%s\\n' "$4" >> ${calls}\necho '{"on":true}'\n`, { mode: 0o755 });
  s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  assert.equal(s.run('add', 'aw', '--cron', '@daily', '--awake', '--timeout', '30m', '--cmd', 'true').status, 0);
  assert.equal(s.jobs().aw.awake, true);
  assert.match(s.run('list').stdout, /aw .* awake/);
  s.run('run', 'aw');
  await until(() => s.state('aw').pid === null && existsSync(calls) && readFileSync(calls, 'utf8').split('\n').length > 2);
  const [on, off] = readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(on, /harness\.awake\(true, \{owner="aw", minutes=31, pid=\d+\}\)/);
  assert.match(off, /harness\.awake\(false, \{owner="aw", lock=true/);
  assert.match(s.run('logs', 'aw').stdout, /awake on: \{"on":true\}/);
});

test('an --awake job still runs when Hammerspoon does not answer', async () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'caffeinate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });   // never the real one
  s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;   // no hs on PATH
  s.run('add', 'aw2', '--cron', '@daily', '--awake', '--cmd', 'exit 0');
  s.run('run', 'aw2');
  await until(() => s.state('aw2').pid === null);
  assert.equal(s.state('aw2').last_exit, 0);
  assert.match(s.run('logs', 'aw2').stdout, /awake on failed: Hammerspoon not answering/);
});

test('a --needs gui job holds awake mode by itself, tied to its process', async () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  const calls = join(s.d, 'hs-calls.txt');
  writeFileSync(join(bin, 'hs'), `#!/bin/sh\nprintf '%s\\n' "$4" >> ${calls}\necho '{"on":true}'\n`, { mode: 0o755 });
  s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  s.run('add', 'gui', '--cron', '@daily', '--needs', 'gui', '--cmd', 'true');
  s.run('add', 'plain', '--cron', '@daily', '--cmd', 'true');
  assert.equal(s.jobs().gui.awake, undefined);
  const list = s.run('list').stdout;
  assert.match(list, /gui .* awake/);
  assert.doesNotMatch(list, /plain .* awake/);
  s.run('run', 'plain');
  await until(() => s.state('plain').pid === null);
  assert.ok(!existsSync(calls), 'a job without --awake or --needs gui must not call Hammerspoon');
  s.run('run', 'gui');
  await until(() => s.state('gui').pid === null && existsSync(calls) && readFileSync(calls, 'utf8').split('\n').length > 2);
  assert.match(readFileSync(calls, 'utf8').split('\n')[0], /harness\.awake\(true, \{owner="gui", minutes=\d+, pid=\d+\}\)/);
});

test('with the generic hs port closed (HS_IPC_GENERIC=0), awake mode goes through the harness port', async () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  const calls = join(s.d, 'hsx-calls.txt');
  writeFileSync(join(bin, 'hs'), '#!/bin/sh\nexit 69\n', { mode: 0o755 });
  writeFileSync(join(bin, 'hsx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\necho '{"on":true}'\n`, { mode: 0o755 });
  s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  s.run('add', 'px', '--cron', '@daily', '--awake', '--timeout', '30m', '--cmd', 'true');
  s.run('run', 'px');
  await until(() => s.state('px').pid === null && existsSync(calls) && readFileSync(calls, 'utf8').split('\n').length > 2);
  const [on, off] = readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(on, /^--timeout 5 call awake\.on \{"owner":"px","minutes":31,"pid":\d+\}$/);
  assert.match(off, /^--timeout 5 call awake\.off \{"owner":"px","lock":true,"reason":"job ended"\}$/);
  assert.match(s.run('logs', 'px').stdout, /awake on: \{"on":true\}/);
});

// ---------- regression: no screen-driving job runs without an awake hold ----------
test('a --needs gui (or --awake) job holds awake mode before its command starts and until it ends', async () => {
  for (const flag of [['--needs', 'gui'], ['--awake']]) {
    const s = sandbox();
    const bin = join(s.d, 'bin'); mkdirSync(bin);
    const calls = join(s.d, 'calls.txt');
    writeFileSync(join(bin, 'hs'), `#!/bin/sh\nprintf 'hs %s\\n' "$4" >> ${calls}\necho '{"on":true}'\n`, { mode: 0o755 });
    s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    s.run('add', 'drive', '--cron', '@daily', ...flag, '--cmd', `echo command >> ${calls}`);
    s.run('run', 'drive');
    await until(() => s.state('drive').pid === null && existsSync(calls) && readFileSync(calls, 'utf8').trim().split('\n').length >= 3);
    const order = readFileSync(calls, 'utf8').trim().split('\n').map(l => (/awake\(true/.test(l) ? 'on' : /awake\(false/.test(l) ? 'off' : l));
    assert.deepEqual(order, ['on', 'command', 'off'], `${flag.join(' ')}: hold, then command, then release`);
  }
});

test('an awake job that gets no hold is reported once per reason and kept awake with caffeinate -d -i -u', async () => {
  const s = sandbox();
  const bin = join(s.d, 'bin'); mkdirSync(bin);
  const answer = join(s.d, 'answer.json'), caff = join(s.d, 'caffeinate.txt');
  writeFileSync(join(bin, 'hs'), `#!/bin/sh\n[ -s ${answer} ] || exit 1\ncat ${answer}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'caffeinate'), `#!/bin/sh\necho "$*" >> ${caff}\n`, { mode: 0o755 });
  s.env.HCRON_PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  s.env.HCRON_NOTIFY = 'true';
  s.run('add', 'drive', '--cron', '@daily', '--needs', 'gui', '--cmd', 'true');
  const runOnce = async n => { s.run('run', 'drive'); await until(() => s.state('drive').pid === null && existsSync(caff) && readFileSync(caff, 'utf8').trim().split('\n').length >= n); };
  writeFileSync(answer, '');                     // Hammerspoon not answering
  await runOnce(1); await runOnce(2);
  writeFileSync(answer, '{"ended":{"drive":{"reason":"job ended"}},"on":false,"reason":"screen already locked"}');
  await runOnce(3);
  writeFileSync(answer, '{"on":true}');
  await runOnce(4);
  const told = s.run('logs').stdout.match(/drive runs without awake mode \([^)]*\)[^\n]*/g);
  assert.deepEqual(told, ['drive runs without awake mode (Hammerspoon not answering); it runs on the caffeinate fallback (no dim, no lock on touch)',
    'drive runs without awake mode (screen already locked)']);
  assert.deepEqual(readFileSync(caff, 'utf8').trim().split('\n').map(l => l.replace(/\d+$/, 'PID')),
    ['-d -i -u -w PID', '-d -i -u -w PID', '-i -w PID', '-i -w PID'], 'the display is kept awake only while it can help');
  assert.equal(s.state('drive').awake_notified, null, 'a granted hold resets the reason');
  assert.match(s.run('logs', 'drive').stdout, /no awake hold: caffeinate -d -i -u -w \d+ keeps the display awake/);
});

test('doctor flags a job that looks like it drives the screen but holds no awake mode; add warns', () => {
  const s = sandbox();
  const added = s.run('add', 'shots', '--cron', '@daily', '--cmd', 'node tools/desktop/apply.mjs');
  assert.equal(added.status, 0);
  assert.match(added.stderr, /warning: shots looks like it drives the screen but holds no awake mode/);
  s.run('add', 'gui', '--cron', '@daily', '--needs', 'gui', '--cmd', 'hsx call x');
  s.run('add', 'wrapped', '--cron', '@daily', '--cmd', 'awake run w -- node hands.mjs');
  s.run('add', 'night', '--cron', '@daily', '--awake', '--cmd', 'sleep 1');
  s.run('add', 'plain', '--cron', '@daily', '--cmd', 'scripts/backup.sh');
  const r = s.run('doctor');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^PROBLEM shots: looks like it drives the screen/m);
  assert.match(r.stdout, /^ok +gui$/m);
  assert.match(r.stdout, /^ok +wrapped$/m);
  assert.match(r.stdout, /^note +night: --awake without --needs gui/m);
  assert.match(r.stdout, /^ok +plain$/m);
  s.run('rm', 'shots');
  assert.equal(s.run('doctor').status, 0);
});
