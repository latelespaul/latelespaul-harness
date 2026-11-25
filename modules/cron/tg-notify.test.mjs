// node --test modules/cron/tg-notify.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TG = fileURLToPath(new URL('./tg-notify.py', import.meta.url));

// Offline sandbox: alerts go to the master log while the master is up (fake `screen` on macOS, fake
// `tmux` elsewhere; both say so while $d/master-up exists), and HOME has no bot token, so nothing
// reaches Telegram. No real screen or tmux is reached: the fakes come first on PATH and TMUX is unset.
function sandbox({ up = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'tgn-'));
  const prof = join(d, 'profile'), bin = join(d, 'bin'), mn = join(d, 'mac-node'), calls = join(d, 'calls');
  mkdirSync(join(prof, 'telegram'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(prof, 'telegram', 'ALERTS_TO_MASTER'), '');
  if (up) writeFileSync(join(d, 'master-up'), '');
  writeFileSync(join(bin, 'screen'), `#!/bin/sh\necho "screen $*" >> "${calls}"\n[ -e "${d}/master-up" ] && echo "123.claude-tg (Detached)"\nexit 0\n`);
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "tmux $*" >> "${calls}"\n[ "$*" = "has-session -t =claude-tg" ] && [ -e "${d}/master-up" ]\n`);
  chmodSync(join(bin, 'screen'), 0o755);
  chmodSync(join(bin, 'tmux'), 0o755);
  const env = { ...process.env, HOME: d, PROFILE_DIR: prof, MACNODE_DIR: mn, PATH: `${bin}:${process.env.PATH}` };
  delete env.TG_NOTIFY_DIRECT;
  delete env.TMUX;
  const log = join(prof, 'logs', 'master-alerts.log');
  const run = (...a) => {
    const extra = typeof a.at(-1) === 'object' ? a.pop() : {};
    return spawnSync('python3', [TG, ...a], { env: { ...env, ...extra }, encoding: 'utf8' });
  };
  const pulled = ageSec => {
    mkdirSync(mn, { recursive: true });
    const f = join(mn, 'alerts-pulled'), t = Date.now() / 1000 - ageSec;
    writeFileSync(f, '');
    utimesSync(f, t, t);
  };
  const down = join(d, '.claude', 'channels', 'telegram', 'master-down.json');
  const masterUp = () => writeFileSync(join(d, 'master-up'), '');
  return { run, log, down, masterUp, pulled, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

test('--help, -h and no text print usage and exit 2 without logging', () => {
  const s = sandbox();
  for (const a of [['--help'], ['-h'], [], ['   '], ['job failed', '--help']]) {
    const r = s.run(...a);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.match(r.stderr, /usage: tg-notify\.py/);
    assert.equal(r.stdout, '');
  }
  assert.ok(!existsSync(s.log));
});

test('a normal alert is still queued for the master session', () => {
  const s = sandbox();
  const r = s.run('job', 'x', 'failed');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(s.log, 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ job x failed\n$/);
});

test('the master session is found the way this OS runs it: screen on macOS, tmux claude-tg elsewhere', () => {
  const s = sandbox();
  assert.equal(s.run('job', 'y', 'failed').status, 0);
  assert.match(readFileSync(s.log, 'utf8'), /Z job y failed\n$/);
  if (process.platform === 'darwin') assert.match(s.calls(), /^screen -ls$/m);
  else assert.match(s.calls(), /^tmux has-session -t =claude-tg$/m);
});

test('master down: every alert is still logged, and Telegram gets one note per outage, then one every 6 h', () => {
  const s = sandbox({ up: false });
  // No token here, so a note that is due exits 1 (it could not be sent); a note that is not due exits 0.
  assert.equal(s.run('job', 'z', 'failed').status, 1);
  assert.equal(s.run('job', 'w', 'failed').status, 0);
  assert.equal(s.run('job', 'v', 'failed').status, 0);
  assert.match(readFileSync(s.log, 'utf8'), /Z job z failed\n.*Z job w failed\n.*Z job v failed\n$/s);
  const st = JSON.parse(readFileSync(s.down, 'utf8'));
  assert.equal(st.count, 3);
  writeFileSync(s.down, JSON.stringify({ ...st, sent: st.sent - 7 * 3600 }));
  assert.equal(s.run('job', 'u', 'failed').status, 1, 'reminder due after 6 h');
  assert.equal(s.run('job', 't', 'failed').status, 0);
  s.masterUp();
  assert.equal(s.run('job', 's', 'failed').status, 0);
  assert.ok(!existsSync(s.down), 'the outage ends once the master is back');
});

test('TG_NOTIFY_DIRECT=1 sends the alert itself and never logs it', () => {
  const s = sandbox({ up: false });
  assert.equal(s.run('job', 'r', 'failed', { TG_NOTIFY_DIRECT: '1' }).status, 1);
  assert.ok(!existsSync(s.log));
  assert.ok(!existsSync(s.down));
});

test('a VM master pulled this Mac\'s alerts in the last 10 min: queued for it; an older pull counts as down', () => {
  const s = sandbox({ up: false });
  s.pulled(60);
  assert.equal(s.run('mac', 'job', 'failed').status, 0);
  assert.match(readFileSync(s.log, 'utf8'), /Z mac job failed\n$/);
  const t = sandbox({ up: false });
  t.pulled(11 * 60);
  assert.equal(t.run('mac', 'job', 'failed').status, 1);
  assert.ok(existsSync(t.down), 'an older pull counts as master down');
});

test('a VM pull after an outage\'s last alert ends it: the next outage gets its own note', () => {
  const s = sandbox({ up: false });
  s.pulled(2 * 3600);
  assert.equal(s.run('mac', 'a', 'failed').status, 1);
  assert.equal(s.run('mac', 'b', 'failed').status, 0);
  const st = JSON.parse(readFileSync(s.down, 'utf8'));
  writeFileSync(s.down, JSON.stringify({ ...st, since: st.since - 3 * 3600, sent: st.sent - 3 * 3600, last: st.last - 3 * 3600 }));
  assert.equal(s.run('mac', 'c', 'failed').status, 1, 'a new outage: its note is due at once');
  assert.equal(JSON.parse(readFileSync(s.down, 'utf8')).count, 1, 'counts only the new outage');
});
