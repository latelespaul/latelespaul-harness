// node --test modules/telegram/heartbeat.test.mjs
// The master-session heartbeat, offline: a throwaway HOME and profile, fake `tmux` and `screen` (they say
// a session is up while $d/up-<name> exists; the fakes come first on PATH and TMUX is unset, so no real
// tmux server is reached) and a stub for mac-node (link up while $d/link-up exists; it records pulls).
// tg-notify.py is the real one: it appends to the sandbox's master-alerts.log; with the master down it
// would also send one outage note to Telegram, and HOME has no bot token, so nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HB = fileURLToPath(new URL('./heartbeat.sh', import.meta.url));
const exe = (f, body) => { writeFileSync(f, body); chmodSync(f, 0o755); };

function sandbox(t, { modules = 'telegram macnode' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hb-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const prof = join(d, 'profile'), bin = join(d, 'bin');
  mkdirSync(join(prof, 'telegram'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(prof, 'telegram', 'ALERTS_TO_MASTER'), '');
  exe(join(bin, 'tmux'), `#!/bin/sh
[ "$1" = has-session ] && [ "$2" = -t ] || exit 2
[ -e "${d}/up-\${3#=}" ]
`);
  exe(join(bin, 'screen'), `#!/bin/sh\n[ -e "${d}/up-claude-tg" ] && echo "1.claude-tg (Detached)"\nexit 0\n`);
  exe(join(bin, 'mac-node'), `#!/bin/sh
case "$1" in
  status) [ -e "${d}/link-up" ] ;;
  pull-alerts) echo pull >> "${d}/pulls" ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(join(d, 'harness.env'), `PROFILE_DIR="${prof}"\nMODULES="${modules}"\nMACNODE_ROLE=vm\nFIRSTMATE_SESSION=firstmate\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: d, HARNESS_ENV: join(d, 'harness.env'), HEARTBEAT_MACNODE: join(bin, 'mac-node') };
  const set = (name, on) => { const f = join(d, name); if (on) writeFileSync(f, ''); else if (existsSync(f)) unlinkSync(f); };
  const s = {
    master: on => set('up-claude-tg', on), firstmate: on => set('up-firstmate', on), link: on => set('link-up', on),
    run() { const r = spawnSync('/bin/zsh', [HB], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r; },
    alerts: () => existsSync(join(prof, 'logs', 'master-alerts.log'))
      ? readFileSync(join(prof, 'logs', 'master-alerts.log'), 'utf8').split('\n').filter(Boolean).map(l => l.replace(/^\S+Z /, '')) : [],
    state: () => readFileSync(join(prof, 'logs', 'master-heartbeat.state'), 'utf8'),
    pulls: () => existsSync(join(d, 'pulls')) ? readFileSync(join(d, 'pulls'), 'utf8').split('\n').filter(Boolean).length : 0,
  };
  s.master(true); s.firstmate(true); s.link(true);
  return s;
}

test('all up: silent, state recorded, and the Mac alerts are pulled', t => {
  const s = sandbox(t);
  s.run();
  assert.deepEqual(s.alerts(), []);
  assert.equal(s.state(), 'master up\nfirstmate up\nmac-node up\n');
  assert.equal(s.pulls(), 1);
});

test('a change is reported once, not every minute, and again when it comes back', t => {
  const s = sandbox(t);
  s.run();
  s.firstmate(false);
  s.run(); s.run(); s.run();
  assert.deepEqual(s.alerts(), ["Heartbeat: firstmate's tmux session (firstmate) is down"]);
  s.firstmate(true);
  s.run(); s.run();
  assert.deepEqual(s.alerts(), ["Heartbeat: firstmate's tmux session (firstmate) is down",
    "Heartbeat: firstmate's tmux session (firstmate) is up again"]);
});

test('mac-node link down: reported once, and no pull until it is back; then a pull catches up', t => {
  const s = sandbox(t);
  s.link(false);
  s.run(); s.run();
  assert.deepEqual(s.alerts(), ['Heartbeat: the mac-node link to the Mac is down (asleep, offline or its service stopped); Mac alerts wait there until it returns']);
  assert.equal(s.pulls(), 0);
  s.link(true);
  s.run();
  assert.equal(s.alerts().pop(), 'Heartbeat: the mac-node link to the Mac is up again');
  assert.equal(s.pulls(), 1);
});

test('master session down: logged, no pull; an unsent outage note means the change is retried once', t => {
  const s = sandbox(t);
  s.run();
  s.master(false);
  s.run();
  const down = 'Heartbeat: the master session (claude-tg) is down';
  assert.deepEqual(s.alerts(), [down]);
  assert.match(s.state(), /^master up$/m, 'the outage note could not be sent (no token): tried again next run');
  s.run();
  assert.deepEqual(s.alerts(), [down, down], 'the retry logs the change a second time');
  assert.match(s.state(), /^master down$/m, 'no note due on the retry, so the change is recorded');
  assert.equal(s.pulls(), 1, 'no pull while the master is down');
  s.master(true);
  s.run();
  assert.deepEqual(s.alerts(), [down, down, 'Heartbeat: the master session (claude-tg) is up again']);
  assert.equal(s.pulls(), 2);
});

test('without the macnode module there is no link check and no pull', t => {
  const s = sandbox(t, { modules: 'telegram' });
  s.link(false);
  s.run();
  assert.equal(s.state(), 'master up\nfirstmate up\n');
  assert.deepEqual(s.alerts(), []);
  assert.equal(s.pulls(), 0);
});

test('a session that is down at the first run is reported', t => {
  const s = sandbox(t);
  s.firstmate(false);
  s.run();
  assert.deepEqual(s.alerts(), ["Heartbeat: firstmate's tmux session (firstmate) is down"]);
});
