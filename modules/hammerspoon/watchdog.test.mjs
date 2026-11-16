// node --test modules/hammerspoon/watchdog.test.mjs
// The Hammerspoon watchdog, offline: a throwaway HOME, a fake `pgrep` (Hammerspoon "runs" while
// $d/running exists), fake `open` and `sleep` that only record their calls, and a notify stub (or the
// real tg-notify.py into the sandbox's master-alerts.log). It never starts, quits or asks the real
// Hammerspoon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WD = fileURLToPath(new URL('./watchdog.sh', import.meta.url));
const exe = (f, body) => { writeFileSync(f, body); chmodSync(f, 0o755); };

// notify: 'stub' (records the message; fails while $d/notify-fails exists) or 'real' (tg-notify.py
// with the master session "up", so it appends to the sandbox's master-alerts.log).
function sandbox(t, { notify = 'stub', grace = '0' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hs-wd-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const bin = join(d, 'bin'), prof = join(d, 'profile'), calls = join(d, 'calls.txt');
  mkdirSync(bin);
  mkdirSync(join(prof, 'telegram'), { recursive: true });
  exe(join(bin, 'pgrep'), `#!/bin/sh\necho "pgrep $*" >> ${calls}\n[ -e "${d}/running" ]\n`);
  for (const name of ['open']) exe(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n[ ! -e "${d}/${name}-fails" ]\n`);
  // A restart in progress: Hammerspoon comes back during the grace sleep while $d/come-back exists.
  exe(join(bin, 'sleep'), `#!/bin/sh\necho "sleep $*" >> ${calls}\n[ -e "${d}/come-back" ] && : > "${d}/running"\nexit 0\n`);
  exe(join(bin, 'notify'), `#!/bin/sh\n[ -e "${d}/notify-fails" ] && exit 1\nprintf '%s\\n' "$*" >> ${d}/notified\n`);
  exe(join(bin, 'screen'), `#!/bin/sh\necho "1.claude-tg (Detached)"\n`);   // tg-notify.py: master up
  writeFileSync(join(prof, 'telegram', 'ALERTS_TO_MASTER'), '');
  writeFileSync(join(d, 'harness.env'), `PROFILE_DIR="${prof}"\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: d, HARNESS_ENV: join(d, 'harness.env'), HS_WATCHDOG_GRACE: grace,
    ...(notify === 'stub' && { HS_WATCHDOG_NOTIFY: join(bin, 'notify') }) };
  const flag = (name, on) => { const f = join(d, name); if (on) writeFileSync(f, ''); else if (existsSync(f)) unlinkSync(f); };
  const read = f => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  const s = {
    running: on => flag('running', on), comeBack: on => flag('come-back', on), openFails: on => flag('open-fails', on), notifyFails: on => flag('notify-fails', on),
    run() { const r = spawnSync('/bin/zsh', [WD], { env, encoding: 'utf8', timeout: 30000 }); assert.equal(r.status, 0, r.stderr); return r; },
    opens: () => read(calls).filter(l => l.startsWith('open ')),
    sleeps: () => read(calls).filter(l => l.startsWith('sleep ')),
    notified: () => read(join(d, 'notified')),
    alerts: () => read(join(prof, 'logs', 'master-alerts.log')).map(l => l.replace(/^\S+Z /, '')),
    state: join(d, '.local', 'state', 'harness', 'hammerspoon-watchdog.state'),
  };
  return s;
}

test('running: no start, no alert, no state', t => {
  const s = sandbox(t);
  s.running(true);
  s.run(); s.run();
  assert.deepEqual(s.opens(), []);
  assert.deepEqual(s.notified(), []);
  assert.ok(!existsSync(s.state));
});

test('not running: one start and one alert; still down next minute: start again, no second alert', t => {
  const s = sandbox(t);
  s.running(false);
  s.run();
  assert.deepEqual(s.opens(), ['open -a Hammerspoon']);
  assert.equal(s.notified().length, 1);
  assert.match(s.notified()[0], /^Hammerspoon watchdog: Hammerspoon was not running \(crash or quit\); started it again\./);
  assert.equal(readFileSync(s.state, 'utf8'), 'down\n');

  s.run();
  assert.deepEqual(s.opens(), ['open -a Hammerspoon', 'open -a Hammerspoon'], 'it keeps trying to start it');
  assert.equal(s.notified().length, 1, 'one alert per outage, not one per minute');
});

test('up again ends the outage, so the next crash alerts again', t => {
  const s = sandbox(t);
  s.running(false); s.run();
  s.running(true); s.run();
  assert.ok(!existsSync(s.state), 'the outage is over');
  assert.equal(s.notified().length, 1, 'coming back is not an alert');
  s.running(false); s.run();
  assert.equal(s.notified().length, 2, 'a new outage alerts once more');
  assert.equal(s.opens().length, 2);
});

test('an alert that did not get through is tried again next minute', t => {
  const s = sandbox(t);
  s.running(false); s.notifyFails(true);
  s.run();
  assert.ok(!existsSync(s.state), 'not recorded as reported');
  s.notifyFails(false);
  s.run();
  assert.equal(s.notified().length, 1);
  assert.equal(s.opens().length, 2);
});

test('a failed start is said in the alert, and the run still exits 0 (no hcron failure every minute)', t => {
  const s = sandbox(t);
  s.running(false); s.openFails(true);
  s.run();
  assert.match(s.notified()[0], /could not start it \(open -a Hammerspoon failed; is it installed\?\)/);
});

test('the grace period: it waits, checks again, and leaves a Hammerspoon that came back alone', t => {
  const s = sandbox(t, { grace: '5' });
  s.running(true);
  s.run();
  assert.deepEqual(s.sleeps(), [], 'no wait while it runs');
  s.running(false);
  s.run();
  assert.deepEqual(s.sleeps(), ['sleep 5']);
  assert.equal(s.opens().length, 1);

  const r = sandbox(t, { grace: '5' });
  r.running(false); r.comeBack(true);   // install.sh --restart: quit, sleep 2, open
  r.run();
  assert.deepEqual(r.sleeps(), ['sleep 5']);
  assert.deepEqual(r.opens(), [], 'it came back by itself: nothing to start');
  assert.deepEqual(r.notified(), []);
});

test('the real tg-notify.py: the alert lands in the master-alerts.log, once', t => {
  const s = sandbox(t, { notify: 'real' });
  s.running(false);
  s.run(); s.run();
  assert.equal(s.alerts().length, 1);
  assert.match(s.alerts()[0], /^Hammerspoon watchdog: Hammerspoon was not running/);
});
