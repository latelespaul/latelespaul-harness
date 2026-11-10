// node --test modules/browser/chrome-mode.test.mjs
// install.sh, chrome-launch.sh and chrome-mode.sh against a fake launchctl, curl and Chrome, a throwaway
// HOME, harness.env and state folder. Nothing here calls the real launchctl or starts Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(MOD, 'install.sh'), LAUNCH = join(MOD, 'chrome-launch.sh'), MODE = join(MOD, 'chrome-mode.sh');

// Fake launchctl: a label is loaded while $FAKE/loaded-<label> exists; bootstrap also opens the debug
// port named in the plist (fake curl answers on ports with $FAKE/up-<port>).
const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$*" >> "$FAKE/launchctl.log"
case "$1" in
  print) [ -f "$FAKE/loaded-\${2##*/}" ] ;;
  bootout) rm -f "$FAKE/loaded-\${2##*/}"; exit 0 ;;
  bootstrap)
    label=$(basename "$3" .plist); touch "$FAKE/loaded-$label"
    port=$(grep -Eo '<string>[0-9]+</string>' "$3" | tr -dc 0-9); touch "$FAKE/up-$port" ;;
esac
`;
const FAKE_CURL = `#!/bin/sh
for a; do url=$a; done
port=\${url#http://127.0.0.1:}; port=\${port%%/*}
[ -f "$FAKE/up-$port" ] && echo '{"Browser": "Fake/1"}'
exit 0
`;
// Fake Chrome: logs its arguments; sleeps while $FAKE/chrome-sleep exists.
const FAKE_CHROME = `#!/bin/sh
echo "$*" >> "$FAKE/chrome.log"
echo $$ > "$FAKE/chrome.pid"
[ -f "$FAKE/chrome-sleep" ] && exec sleep 30
exit 0
`;

function sandbox() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'browser-mode-test-')));
  const bin = join(d, 'bin'), fake = join(d, 'fake'), home = join(d, 'home'), state = join(d, 'state');
  for (const p of [bin, fake, home]) mkdirSync(p, { recursive: true });
  const stub = (name, body) => { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); };
  stub('launchctl', FAKE_LAUNCHCTL); stub('curl', FAKE_CURL); stub('chrome', FAKE_CHROME);
  stub('chrome-devtools-axi', '#!/bin/sh\nexit 0\n');
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `LABEL_PREFIX="test"\nBROWSER_PORT=9332\nBROWSER_EXTRA="personal:9333"\nPROFILE_DIR="${d}/profile"\n`);
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, FAKE: fake, HARNESS_ENV: envFile,
    CHROME_BIN: join(bin, 'chrome'), CHROME_MODE_DIR: state,
  };
  const zsh = (script, args = [], extra = {}) => spawnSync('/bin/zsh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const lines = f => existsSync(join(fake, f)) ? readFileSync(join(fake, f), 'utf8').trim().split('\n') : [];
  const touch = f => writeFileSync(join(fake, f), '');
  const legacy = mode => {
    mkdirSync(join(home, '.local/state/job-hunt'), { recursive: true });
    writeFileSync(join(home, '.local/state/job-hunt/chrome-mode.json'), JSON.stringify({ intent: mode, mode, switching: false }, null, 2));
  };
  return {
    d, home, state, fake, zsh, touch, legacy,
    install: (args = []) => zsh(INSTALL, args),
    launch: (id, port, extra) => zsh(LAUNCH, [id, port], extra),
    mode: (args, extra) => zsh(MODE, args, extra),
    launchctl: () => lines('launchctl.log'),
    chrome: () => lines('chrome.log'),
    loadsOf: id => lines('launchctl.log').filter(c => /^(bootstrap|kickstart)/.test(c) && c.includes(`com.test.chrome-${id}`)),
  };
}

test('agent mode: install writes the guarded plist and loads every browser', () => {
  const s = sandbox();
  const r = s.install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.loadsOf('claude').length, 1);
  assert.equal(s.loadsOf('personal').length, 1);
  const plist = readFileSync(join(s.home, 'Library/LaunchAgents/com.test.chrome-personal.plist'), 'utf8');
  assert.match(plist, /modules\/browser\/chrome-launch\.sh<\/string>\s*<string>personal<\/string>\s*<string>9333<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  const lint = spawnSync('/usr/bin/plutil', ['-lint', join(s.home, 'Library/LaunchAgents/com.test.chrome-personal.plist')], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stdout);
  assert.doesNotMatch(r.stderr, /unfilled placeholder/);
  assert.match(r.stdout, /chrome-personal is running on 127\.0\.0\.1:9333/);
  assert.deepEqual(s.chrome(), []);   // install never starts Chrome itself
});

test('desktop mode: install leaves that agent stopped and still loads the others', () => {
  const s = sandbox();
  assert.equal(s.mode(['personal', 'desktop', '--writer', 'test-tool']).status, 0);
  const r = s.install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.loadsOf('personal'), []);
  assert.equal(s.launchctl().filter(c => c.includes('chrome-personal')).some(c => !c.startsWith('print')), false);
  assert.equal(s.loadsOf('claude').length, 1);
  assert.match(r.stdout, /chrome-personal: desktop mode: agent left stopped/);
  // The plist is still refreshed, so the guarded launcher is what launchd runs at the next login.
  assert.ok(existsSync(join(s.home, 'Library/LaunchAgents/com.test.chrome-personal.plist')));
  // A re-run (what a user does after every pull) still never loads it.
  s.install();
  assert.deepEqual(s.loadsOf('personal'), []);
});

test('desktop mode: an agent still loaded from an old plist is booted out, unless it serves its port', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.touch('loaded-com.test.chrome-personal');
  s.install();
  assert.ok(s.launchctl().some(c => /^bootout gui\/\d+\/com\.test\.chrome-personal$/.test(c)));
  assert.deepEqual(s.loadsOf('personal'), []);

  const t = sandbox();
  t.mode(['personal', 'desktop']);
  t.touch('loaded-com.test.chrome-personal'); t.touch('up-9333');
  t.install();
  assert.equal(t.launchctl().some(c => c.startsWith('bootout') && c.includes('chrome-personal')), false);
});

test('legacy job-hunt state file is read only when the harness file is missing, and only for personal', () => {
  const s = sandbox();
  s.legacy('desktop');
  let r = s.install();
  assert.deepEqual(s.loadsOf('personal'), []);
  assert.equal(s.loadsOf('claude').length, 1);
  assert.match(r.stdout, /chrome-personal: desktop mode: agent left stopped/);
  assert.equal(s.mode(['personal']).stdout.trim(), 'desktop');
  assert.equal(s.mode(['claude']).stdout.trim(), 'agent');

  // The harness file wins over the legacy one.
  s.mode(['personal', 'agent']);
  r = s.install();
  assert.equal(s.loadsOf('personal').length, 1, r.stdout);

  const t = sandbox();
  t.legacy('agent');
  t.install();
  assert.equal(t.loadsOf('personal').length, 1);
});

test('--status reports desktop mode without failing', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.touch('up-9332');
  const r = s.install(['--status']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /chrome-personal is in desktop mode: agent left stopped/);
  s.mode(['personal', 'agent']);
  assert.equal(s.install(['--status']).status, 1);
});

test('launcher: desktop mode exits 0 without starting Chrome', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  const r = s.launch('personal', '9333');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /desktop mode: agent left stopped/);
  assert.deepEqual(s.chrome(), []);

  const t = sandbox();
  t.legacy('desktop');
  assert.equal(t.launch('personal', '9333').status, 0);
  assert.deepEqual(t.chrome(), []);
});

test('launcher: agent mode starts Chrome on the profile with its debug port, exit 1 when it quits', () => {
  const s = sandbox();
  const r = s.launch('personal', '9333');
  assert.equal(r.status, 1, r.stdout + r.stderr);   // non-zero, so KeepAlive restarts it after ThrottleInterval
  assert.deepEqual(s.chrome(), [`--user-data-dir=${s.home}/.chrome-personal --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check`]);
  assert.match(r.stdout, /Chrome exited \(0\)/);
});

test('launcher: switched to desktop mode while Chrome ran, it stays stopped after Chrome quits', () => {
  const s = sandbox();
  writeFileSync(join(s.d, 'bin/chrome'), `#!/bin/sh\necho "$*" >> "$FAKE/chrome.log"\nCHROME_MODE_DIR="$CHROME_MODE_DIR" HOME="$HOME" /bin/zsh ${MODE} personal desktop >/dev/null\nexit 0\n`);
  const r = s.launch('personal', '9333');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Chrome exited \(0\); desktop mode: agent left stopped/);
});

test('launcher: a profile already open in another Chrome is left alone; a stale lock is not', () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.chrome-personal'), { recursive: true });
  // A live process that has the profile open (its arguments name the profile folder).
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${s.home}/.chrome-personal`]);
  try {
    symlinkSync(`somehost-${other.pid}`, join(s.home, '.chrome-personal/SingletonLock'));
    const r = s.launch('personal', '9333');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already open in another Chrome/);
    assert.deepEqual(s.chrome(), []);
  } finally { other.kill(); }

  // A lock left by a crash (or a pid now used by something else) does not block the launch.
  const t = sandbox();
  mkdirSync(join(t.home, '.chrome-personal'), { recursive: true });
  symlinkSync(`somehost-${process.pid}`, join(t.home, '.chrome-personal/SingletonLock'));
  assert.equal(t.launch('personal', '9333').status, 1);
  assert.equal(t.chrome().length, 1);
});

test('launcher: stopped by launchd, it stops Chrome and exits 0', async () => {
  const s = sandbox();
  s.touch('chrome-sleep');
  const p = spawn('/bin/zsh', [LAUNCH, 'personal', '9333'], { env: { PATH: `${s.d}/bin:/usr/bin:/bin`, HOME: s.home, FAKE: s.fake, CHROME_BIN: join(s.d, 'bin/chrome'), CHROME_MODE_DIR: s.state } });
  for (let i = 0; i < 50 && s.chrome().length === 0; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(s.chrome().length, 1);
  const code = await new Promise(resolve => { p.on('exit', resolve); p.kill('SIGTERM'); });
  assert.equal(code, 0);
  const chromePid = Number(readFileSync(join(s.fake, 'chrome.pid'), 'utf8'));
  assert.throws(() => process.kill(chromePid, 0));   // Chrome was stopped with it
});

test('chrome-mode.sh writes the state file whole and reads it back', () => {
  const s = sandbox();
  assert.equal(s.mode(['personal']).stdout.trim(), 'agent');
  const r = s.mode(['personal', 'desktop', '--writer', 'job-hunt']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(s.state, 'personal.json'), 'utf8'));
  assert.equal(j.mode, 'desktop');
  assert.equal(j.writer, 'job-hunt');
  assert.match(j.updated, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(s.mode(['personal']).stdout.trim(), 'desktop');
  assert.equal(s.mode(['personal', 'agent']).status, 0);
  assert.equal(s.mode(['personal']).stdout.trim(), 'agent');
  // Defaults to ~/.local/state/harness/chrome-mode without CHROME_MODE_DIR.
  s.mode(['claude', 'desktop'], { CHROME_MODE_DIR: '' });
  assert.ok(existsSync(join(s.home, '.local/state/harness/chrome-mode/claude.json')));
});

test('chrome-mode.sh refuses bad input and honours dry run', () => {
  const s = sandbox();
  for (const a of [[], ['../x'], ['personal', 'sideways'], ['personal', 'desktop', '--writer', 'a"b'], ['personal', 'desktop', '--other', 'x']]) {
    assert.equal(s.mode(a).status, 1, a.join(' '));
  }
  const r = s.mode(['personal', 'desktop'], { HARNESS_DRY_RUN: '1' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^would write /);
  assert.equal(existsSync(join(s.state, 'personal.json')), false);
});

test('sync.sh re-renders without the module installers and without launchctl', () => {
  // sync.sh is not a trigger: after a framework pull it runs install.sh like this, which never
  // reaches modules/browser/install.sh. This guards that line.
  const sync = readFileSync(join(MOD, '../../scripts/sync.sh'), 'utf8');
  assert.match(sync, /HARNESS_SKIP_LAUNCHD=1 \$HARNESS_DIR\/install\.sh --yes --no-modules/);
});
