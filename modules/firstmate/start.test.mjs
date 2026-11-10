// node --test modules/firstmate/start.test.mjs
// start.sh against a fake tmux and launchctl, a throwaway harness.env, HOME and hcron jobs file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = fileURLToPath(new URL('./start.sh', import.meta.url));
const HARNESS = dirname(dirname(dirname(START)));

// The fake tmux keeps one "running" session name in a file; has-session matches the -t target exactly.
const FAKE_TMUX = `#!/bin/sh
echo "$* HCRON_CMD=\${HCRON_CMD-}" >> "$FAKE/tmux.log"
case "$1" in
  has-session) [ -f "$FAKE/running" ] && [ "$3" = "=$(cat "$FAKE/running")" ] && exit 0; exit 1 ;;
  new)
    if [ -f "$FAKE/new-fails" ]; then [ -f "$FAKE/race" ] && printf %s "$4" > "$FAKE/running"; exit 1; fi
    printf %s "$4" > "$FAKE/running"; exit 0 ;;
esac
exit 0
`;

function sandbox({ modules = 'firstmate cron', autostart = 1, installed = true } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fm-start-test-')));
  const bin = join(d, 'bin'), fake = join(d, 'fake'), home = join(d, 'home');
  for (const p of [bin, fake, home]) mkdirSync(p, { recursive: true });
  writeFileSync(join(bin, 'tmux'), FAKE_TMUX); chmodSync(join(bin, 'tmux'), 0o755);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "$*" >> "$FAKE/launchctl.log"\n'); chmodSync(join(bin, 'launchctl'), 0o755);
  const fm = join(d, 'firstmate');
  if (installed) mkdirSync(join(fm, '.git'), { recursive: true });
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `FIRSTMATE_DIR="${fm}"\nFIRSTMATE_SESSION="fm-test"\nMODULES="${modules}"\nFIRSTMATE_AUTOSTART=${autostart}\nLABEL_PREFIX="test"\nPROFILE_DIR="${d}/profile"\n`);
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, FAKE: fake,
    HARNESS_ENV: envFile, HCRON_JOBS: join(d, 'jobs.json'), HCRON_STATE: join(d, 'state'), HCRON_LOGS: join(d, 'logs'), HCRON_NOTIFY: '',
  };
  const run = (args = [], extra = {}) => spawnSync('/bin/zsh', [START, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const tmuxCalls = () => existsSync(join(fake, 'tmux.log')) ? readFileSync(join(fake, 'tmux.log'), 'utf8').trim().split('\n') : [];
  const jobs = () => existsSync(env.HCRON_JOBS) ? JSON.parse(readFileSync(env.HCRON_JOBS, 'utf8')).jobs : {};
  const setRunning = name => writeFileSync(join(fake, 'running'), name);
  return { d, fake, home, fm, run, tmuxCalls, jobs, setRunning };
}

test('starts the session with the launch command when it is missing', () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = s.tmuxCalls();
  assert.match(calls[0], /^has-session -t =fm-test /);   // exact match, not a prefix
  assert.equal(calls[1].split(' HCRON_CMD=')[0], `new -d -s fm-test ${HARNESS}/modules/firstmate/run-firstmate.sh`);
  assert.match(r.stdout, /started firstmate/);
});

test('already running: exits 0 and never starts, stops or restarts anything', () => {
  const s = sandbox();
  s.setRunning('fm-test');
  const r = s.run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already running/);
  assert.deepEqual(s.tmuxCalls().map(c => c.split(' ')[0]), ['has-session']);
});

test('a session whose name only starts with the session name does not count', () => {
  const s = sandbox();
  s.setRunning('fm-test-other');
  assert.equal(s.run().status, 0);
  assert.ok(s.tmuxCalls().some(c => c.startsWith('new -d -s fm-test ')));
});

test('running it twice starts one copy', () => {
  const s = sandbox();
  s.run(); s.run();
  assert.equal(s.tmuxCalls().filter(c => c.startsWith('new ')).length, 1);
});

test('another starter winning the race is not an error', () => {
  const s = sandbox();
  writeFileSync(join(s.fake, 'new-fails'), ''); writeFileSync(join(s.fake, 'race'), '');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /another starter/);
});

test('tmux failing to start is an error', () => {
  const s = sandbox();
  writeFileSync(join(s.fake, 'new-fails'), '');
  assert.equal(s.run().status, 1);
});

test('not installed: exits 1 without starting', () => {
  const s = sandbox({ installed: false });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not installed/);
  assert.ok(!s.tmuxCalls().some(c => c.startsWith('new ')));
});

test("hcron's own variables stay out of firstmate's environment", () => {
  const s = sandbox();
  s.run([], { HCRON_CMD: '/bin/zsh start.sh' });
  assert.ok(s.tmuxCalls().find(c => c.startsWith('new ')).endsWith('HCRON_CMD='));
});

test('--dry-run only prints the start', () => {
  const s = sandbox();
  const r = s.run(['--dry-run']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /would: tmux new -d -s fm-test/);
  assert.ok(!s.tmuxCalls().some(c => c.startsWith('new ')));
});

test('--register adds one hcron job, idempotently, and keeps a pause', () => {
  const s = sandbox();
  assert.equal(s.run(['--register']).status, 0);
  const first = s.jobs()['firstmate-start'];
  assert.equal(first.cron, '*/5 * * * *');
  assert.equal(first.cmd, `/bin/zsh ${START}`);
  assert.equal(first.catchup, true);
  assert.equal(first.project, 'firstmate');
  const jobs = JSON.parse(readFileSync(join(s.d, 'jobs.json'), 'utf8'));
  jobs.jobs['firstmate-start'].paused = true;
  writeFileSync(join(s.d, 'jobs.json'), JSON.stringify(jobs));
  assert.equal(s.run(['--register']).status, 0);
  const again = s.jobs();
  assert.deepEqual(Object.keys(again), ['firstmate-start']);
  assert.equal(again['firstmate-start'].added, first.added);
  assert.equal(again['firstmate-start'].paused, true);
  assert.deepEqual(s.tmuxCalls(), []);   // registering never touches tmux
});

test('--register removes an old LaunchAgent file without booting it out', () => {
  const s = sandbox();
  const plist = join(s.home, 'Library/LaunchAgents/com.test.firstmate.plist');
  mkdirSync(dirname(plist), { recursive: true }); writeFileSync(plist, '<plist/>');
  const r = s.run(['--register']);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(plist));
  assert.ok(!existsSync(join(s.fake, 'launchctl.log')));
});

test('--register with FIRSTMATE_AUTOSTART=0 removes the job, and is fine when there is none', () => {
  const s = sandbox();
  s.run(['--register']);
  writeFileSync(join(s.d, 'harness.env'), readFileSync(join(s.d, 'harness.env'), 'utf8').replace('FIRSTMATE_AUTOSTART=1', 'FIRSTMATE_AUTOSTART=0'));
  assert.equal(s.run(['--register']).status, 0);
  assert.deepEqual(s.jobs(), {});
  assert.equal(s.run(['--register']).status, 0);
});

test('--register without the cron module still registers, with a note', () => {
  const s = sandbox({ modules: 'firstmate' });
  const r = s.run(['--register']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cron module/);
  assert.ok(s.jobs()['firstmate-start']);
});

test('--status reports the autostart job', () => {
  const s = sandbox();
  let r = s.run(['--status']);
  assert.equal(r.status, 1); assert.match(r.stdout, /not registered/);
  s.run(['--register']);
  r = s.run(['--status']);
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /hcron job firstmate-start/);
  assert.equal(sandbox({ autostart: 0 }).run(['--status']).status, 0);
  const noCron = sandbox({ modules: 'firstmate' });
  noCron.run(['--register']);
  r = noCron.run(['--status']);
  assert.equal(r.status, 1); assert.match(r.stdout, /cron module is off/);
});
