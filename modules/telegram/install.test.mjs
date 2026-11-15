// node --test modules/telegram/install.test.mjs
// The telegram module against a throwaway HOME and profile: the Linux path (no launchd: tmux session
// plus a crontab hint), polling off (TELEGRAM_POLLING=0: no poller, no Telegram call, ACTIVE_HOST
// left alone), and the macOS path (launchd agents, plugin on) unchanged.
// tmux, claude, bun, screen, curl and launchctl are stubs that only log their arguments. The real
// tmux is never on PATH and TMUX is never passed in, so no test can reach a real tmux server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync, chmodSync, existsSync,
  realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(MOD, 'install.sh');
const STUBBED = ['tmux', 'claude', 'bun', 'screen', 'curl', 'launchctl'];

// launchd: put a launchctl stub on PATH (macOS path). polling: TELEGRAM_POLLING. tmuxUp: the stub
// tmux reports a claude-tg session. owner: the profile's ACTIVE_HOST. token: write a clean .env.
function sandbox({ launchd = false, polling = 1, tmuxUp = false, owner = '', token = false } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'tg-install-test-')));
  const bin = join(d, 'bin'), home = join(d, 'home'), profile = join(d, 'profile'), log = join(d, 'calls.log');
  for (const p of [bin, home, join(profile, 'memory'), join(home, '.claude/plugins/cache/claude-plugins-official/telegram')]) {
    mkdirSync(p, { recursive: true });
  }
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (STUBBED.includes(name) || existsSync(join(bin, name))) continue;
      symlinkSync(join(dir, name), join(bin, name));
    }
  }
  const stub = (name, body = '') => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}`);
    chmodSync(join(bin, name), 0o755);
  };
  // has-session / list-panes succeed only when the session is "up"; everything else succeeds.
  stub('tmux', tmuxUp
    ? 'case "$1" in list-panes) echo 4242 ;; esac\nexit 0\n'
    : 'case "$1" in has-session|list-panes|capture-pane) exit 1 ;; esac\nexit 0\n');
  for (const t of ['claude', 'bun', 'screen', 'curl']) stub(t, 'exit 0\n');
  if (launchd) stub('launchctl', 'exit 1\n');   // nothing is loaded
  execFileSync('git', ['init', '-q', profile]);
  execFileSync('git', ['-C', profile, 'commit', '-q', '--allow-empty', '-m', 'init'],
    { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (owner) { mkdirSync(join(profile, 'telegram')); writeFileSync(join(profile, 'telegram/ACTIVE_HOST'), owner + '\n'); }
  if (token) {
    mkdirSync(join(home, '.claude/channels/telegram'), { recursive: true });
    writeFileSync(join(home, '.claude/channels/telegram/.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n', { mode: 0o600 });
  }
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `PROJECTS_DIR="${d}"\nPROFILE_DIR="${profile}"\nTELEGRAM_WORKDIR="${d}/work"\n`
    + `LABEL_PREFIX="test"\nMODULES="telegram"\nTELEGRAM_POLLING=${polling}\n`);
  const env = { PATH: `${bin}:${dirname(process.execPath)}`, HOME: home, HARNESS_ENV: envFile, TMPDIR: d,
    HARNESS_SKIP_LAUNCHD: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const run = (args = [], script = INSTALL) => spawnSync('/bin/zsh', [script, ...args], { env, encoding: 'utf8', input: '' });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { d, home, profile, env, run, calls };
}

const settingsOf = (s) => JSON.parse(readFileSync(join(s.home, '.claude/telegram-settings.json'), 'utf8'));

test('Linux, polling off: tmux session with the plugin off, no poller, no Telegram call, ACTIVE_HOST untouched', () => {
  const s = sandbox({ polling: 0, owner: 'the-mac' });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /polling off/);
  assert.equal(settingsOf(s).enabledPlugins['telegram@claude-plugins-official'], false);
  const calls = s.calls();
  assert.match(calls, new RegExp(`^tmux new -d -s claude-tg ${MOD}/run\\.sh$`, 'm'), calls);
  assert.doesNotMatch(calls, /^curl /m, 'never calls the Telegram API');
  assert.doesNotMatch(calls, /^launchctl /m);
  assert.equal(readFileSync(join(s.profile, 'telegram/ACTIVE_HOST'), 'utf8'), 'the-mac\n');
  assert.match(r.stdout, /crontab/);
  assert.match(r.stdout, /watchdog\.py/);
  assert.doesNotMatch(r.stdout, /morning-brief\.py/);
  assert.ok(!existsSync(join(s.home, 'Library')), 'no launchd plists on Linux');
});

test('Linux, polling off: --take-over is refused', () => {
  const r = sandbox({ polling: 0 }).run(['--take-over']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Polling is off here/);
});

test('Linux, polling off: --status is healthy with the session up and no poller', () => {
  const s = sandbox({ polling: 0, tmuxUp: true, owner: 'the-mac' });
  const r = s.run(['--status']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /polling: off/);
  assert.match(r.stdout, /tmux session claude-tg\s+running/);
  assert.match(r.stdout, /bot process: not running/);
  assert.doesNotMatch(s.calls(), /^curl /m);
});

test('Linux, polling on: another machine owns the bot, so nothing is installed', () => {
  const s = sandbox({ owner: 'the-mac', token: true });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /The bot runs on the-mac/);
  assert.doesNotMatch(s.calls(), /^tmux new/m);
});

test('macOS path unchanged: launchd plists, plugin on, no tmux', () => {
  const s = sandbox({ launchd: true, token: true });
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(settingsOf(s).enabledPlugins['telegram@claude-plugins-official'], true);
  for (const n of ['telegram', 'keep-awake', 'telegram-watchdog']) {
    assert.ok(existsSync(join(s.home, `Library/LaunchAgents/com.test.${n}.plist`)), n);
  }
  assert.doesNotMatch(s.calls(), /^tmux /m);
  assert.doesNotMatch(r.stdout, /crontab/);
});

test('run.sh, polling off: refuses settings that turn the plugin on', () => {
  const s = sandbox({ polling: 0 });
  mkdirSync(join(s.home, '.claude/channels/telegram/logs'), { recursive: true });
  writeFileSync(join(s.home, '.claude/telegram-settings.json'), '{"enabledPlugins": {"telegram@claude-plugins-official": true}}');
  const r = s.run([], join(MOD, 'run.sh'));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /polling is off/);
  assert.doesNotMatch(s.calls(), /^claude /m);
});

test('run.sh, polling off: starts claude without the Telegram channel', () => {
  const s = sandbox({ polling: 0 });
  mkdirSync(join(s.home, '.claude/channels/telegram/logs'), { recursive: true });
  writeFileSync(join(s.home, '.claude/telegram-settings.json'), '{"enabledPlugins": {"telegram@claude-plugins-official": false}}');
  // The claude stub stops run.sh's restart loop after the first start.
  writeFileSync(join(s.env.PATH.split(':')[0], 'claude'),
    `#!/bin/sh\necho "claude $*" >> "${s.d}/calls.log"\nkill -TERM $PPID\n`);
  s.run([], join(MOD, 'run.sh'));
  const calls = s.calls();
  assert.match(calls, /^claude .*--settings /m, calls);
  assert.doesNotMatch(calls, /--channels/);
});

test('watchdog, polling off: restarts a missing session and never calls Telegram', { skip: process.platform === 'darwin' && 'Linux path' }, () => {
  const s = sandbox({ polling: 0 });
  const r = spawnSync('/usr/bin/python3', ['-I', join(MOD, 'watchdog.py')], { env: s.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = s.calls();
  assert.match(calls, new RegExp(`^tmux new -d -s claude-tg ${MOD}/run\\.sh$`, 'm'), calls);
  assert.doesNotMatch(calls, /^curl /m);
  assert.match(readFileSync(join(s.home, '.claude/channels/telegram/logs/watchdog.log'), 'utf8'), /polling off/);
});
