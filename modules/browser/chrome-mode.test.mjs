// node --test modules/browser/chrome-mode.test.mjs
// install.sh, chrome-launch.sh and chrome-mode.sh against a fake launchctl, curl and Chrome, a throwaway
// HOME, harness.env and state folder. Nothing here calls the real launchctl or starts Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(MOD, 'install.sh'), LAUNCH = join(MOD, 'chrome-launch.sh'), MODE = join(MOD, 'chrome-mode.sh');

// Fake launchctl: a label is loaded while $FAKE/loaded-<label> exists; bootstrap also opens the debug
// port named in the plist (fake curl answers on ports with $FAKE/up-<port>), and bootout closes it.
// Like launchd, bootout returns while the old job is still exiting: for the next $FAKE_EXIT_CALLS
// launchctl calls (default 0) the label stays loaded and bootstrap fails with launchd's error 5.
// $FAKE_BOOTSTRAP_FAIL=<label> makes every bootstrap of that label fail.
const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$*" >> "$FAKE/launchctl.log"
for f in "$FAKE"/exiting-*; do
  [ -f "$f" ] || continue
  n=$(cat "$f"); if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$f"; else rm -f "$f" "$FAKE/loaded-\${f##*/exiting-}"; fi
done
case "$1" in
  print) [ -f "$FAKE/loaded-\${2##*/}" ] ;;
  bootout)
    label=\${2##*/}; [ -f "$FAKE/loaded-$label" ] || exit 3
    port=$(grep -Eo '<string>[0-9]+</string>' "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null | tr -dc 0-9); rm -f "$FAKE/up-$port"
    if [ "\${FAKE_EXIT_CALLS:-0}" -gt 0 ]; then echo "$FAKE_EXIT_CALLS" > "$FAKE/exiting-$label"; else rm -f "$FAKE/loaded-$label"; fi ;;
  bootstrap)
    label=$(basename "$3" .plist)
    if [ -f "$FAKE/loaded-$label" ] || [ "$FAKE_BOOTSTRAP_FAIL" = "$label" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    touch "$FAKE/loaded-$label"
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
  const agents = join(home, 'Library/LaunchAgents');
  // An agent loaded from the plist before the launcher existed (Chrome run directly), serving its port.
  const oldAgent = (id, port) => {
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, `com.test.chrome-${id}.plist`), `<plist><dict><key>Label</key><string>com.test.chrome-${id}</string>` +
      `<key>ProgramArguments</key><array><string>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</string>` +
      `<string>--remote-debugging-port=${port}</string></array><key>KeepAlive</key><true/></dict></plist>\n`);
    writeFileSync(join(fake, `loaded-com.test.chrome-${id}`), ''); writeFileSync(join(fake, `up-${port}`), '');
  };
  const lines = f => existsSync(join(fake, f)) ? readFileSync(join(fake, f), 'utf8').trim().split('\n') : [];
  const touch = f => writeFileSync(join(fake, f), '');
  const legacy = (mode, fields = { intent: mode, switching: false }) => {
    mkdirSync(join(home, '.local/state/job-hunt'), { recursive: true });
    writeFileSync(join(home, '.local/state/job-hunt/chrome-mode.json'), JSON.stringify({ mode, ...fields }, null, 2));
  };
  return {
    d, home, state, fake, zsh, touch, legacy, oldAgent,
    install: (args = [], extra) => zsh(INSTALL, args, extra),
    loaded: id => existsSync(join(fake, `loaded-com.test.chrome-${id}`)),
    up: port => existsSync(join(fake, `up-${port}`)),
    // launchctl calls that stop the agent (bootout) or load it (bootstrap), oldest first.
    cycle: id => lines('launchctl.log').filter(c => /^(bootout|bootstrap)/.test(c) && c.includes(`com.test.chrome-${id}`)).map(c => c.split(' ')[0]),
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
  const conv = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(s.home, 'Library/LaunchAgents/com.test.chrome-personal.plist')], { encoding: 'utf8' });
  assert.equal(conv.status, 0, conv.stderr);
  const plist = JSON.parse(conv.stdout);
  assert.deepEqual(plist.ProgramArguments, ['/bin/zsh', LAUNCH, 'personal', '9333']);
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
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

test('legacy job-hunt state file mid-switch: its intent decides, not the stale mode', () => {
  const s = sandbox();
  s.legacy('desktop', { intent: 'cdp', switching: true });
  s.install();
  assert.equal(s.loadsOf('personal').length, 1);
  assert.equal(s.launch('personal', '9333').status, 1);
  assert.equal(s.chrome().length, 1);

  const t = sandbox();
  t.legacy('cdp', { intent: 'desktop', switching: true });
  const r = t.install();
  assert.deepEqual(t.loadsOf('personal'), []);
  assert.match(r.stdout, /chrome-personal: desktop mode: agent left stopped/);
  assert.equal(t.launch('personal', '9333').status, 0);
  assert.deepEqual(t.chrome(), []);

  // A legacy file without intent falls back to mode.
  const u = sandbox();
  u.legacy('desktop', {});
  assert.equal(u.mode(['personal']).stdout.trim(), 'desktop');
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
    // Agent mode: Chrome is not started on the open profile, but the exit is non-zero so launchd
    // tries again in 30 s and the agent comes back once that Chrome quits (exit 0 would leave it stopped).
    assert.equal(r.status, 1);
    assert.match(r.stdout, /already open in another Chrome \(pid \d+\): not started, trying again later/);
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

// The failure after #21: its new plist made the installer reload the running work Chrome's agent,
// which stopped the work Chrome. Now install never stops a running agent-mode profile, even when its
// plist changed: the new plist waits for the next login or the restart command it prints.
test('regression: a running agent from an old plist is left alone, and the restart line is printed', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.oldAgent('claude', 9332);
  const r = s.install([], { FAKE_EXIT_CALLS: '3' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.cycle('claude'), []);   // no bootout, no bootstrap
  assert.ok(s.loaded('claude'), 'work agent left unloaded');
  assert.ok(s.up(9332), 'work Chrome left down');
  const line = `${INSTALL} --id claude --restart`;
  assert.ok(r.stdout.includes(`chrome-claude is running; left it alone. Its new settings apply at the next login, or now with: ${line}`), r.stdout);
  assert.match(readFileSync(join(s.home, 'Library/LaunchAgents/com.test.chrome-claude.plist'), 'utf8'), /chrome-launch\.sh/);   // new plist written
  assert.match(r.stdout, /chrome-personal: desktop mode: agent left stopped/);

  // The printed command restarts it on the new plist, even while the old job is slow to exit.
  const x = s.install(['--id', 'claude', '--restart'], { FAKE_EXIT_CALLS: '3' });
  assert.equal(x.status, 0, x.stdout + x.stderr);
  assert.deepEqual(s.cycle('claude'), ['bootout', 'bootstrap']);
  assert.ok(s.loaded('claude') && s.up(9332));
  assert.match(x.stdout, /chrome-claude restarted on 127\.0\.0\.1:9332/);
});

test('--restart refuses a desktop-mode profile, an unknown id, and a profile not installed yet', () => {
  const s = sandbox();
  s.install();
  s.mode(['personal', 'desktop']);
  const before = s.launchctl().filter(c => !c.startsWith('print')).length;
  let r = s.install(['--id', 'personal', '--restart']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /chrome-personal is in desktop mode: not restarted/);
  r = s.install(['--id', 'nope', '--restart']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no browser with id nope/);
  assert.equal(s.launchctl().filter(c => !c.startsWith('print')).length, before);

  const t = sandbox();
  r = t.install(['--id', 'claude', '--restart']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /chrome-claude is not installed/);
  assert.deepEqual(t.cycle('claude'), []);
});

// The race behind #21's failure: bootout returned while the old Chrome still quit, the immediate
// bootstrap failed with error 5, and set -e ended the run with the agent not loaded.
test('regression: reloading a loaded agent that is not running, while its old job still exits, leaves it loaded', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.oldAgent('claude', 9332);
  rmSync(join(s.fake, 'up-9332'));             // loaded, but its port does not answer
  const r = s.install([], { FAKE_EXIT_CALLS: '3' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(s.loaded('claude'), 'work agent left unloaded');
  assert.ok(s.up(9332), 'work Chrome left down');
  assert.deepEqual(s.cycle('claude'), ['bootout', 'bootstrap']);   // one stop, then one load that worked
  assert.match(r.stdout, /chrome-claude is running on 127\.0\.0\.1:9332/);
});

test('two profiles, one desktop and one with no record: the agent profile is loaded and never stopped', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.legacy('desktop');                           // the job-hunt file describes personal only
  s.touch('loaded-com.test.chrome-personal');    // personal's old agent still relaunching
  let r = s.install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(s.loaded('claude') && s.up(9332));
  assert.deepEqual(s.cycle('claude'), ['bootstrap']);   // fresh: nothing to stop, one load
  assert.deepEqual(s.cycle('personal'), ['bootout']);
  // Running and unchanged: the next runs never touch it.
  r = s.install();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /chrome-claude already running; left it alone/);
  assert.deepEqual(s.cycle('claude'), ['bootstrap']);
});

test('repeated install runs never stop a running agent-mode profile', () => {
  const s = sandbox();
  s.mode(['personal', 'desktop']);
  s.oldAgent('claude', 9332);
  const out = [];
  for (let i = 0; i < 3; i++) { const r = s.install([], { FAKE_EXIT_CALLS: '2' }); assert.equal(r.status, 0); out.push(r.stdout); }
  assert.deepEqual(s.cycle('claude'), []);
  assert.deepEqual(s.cycle('personal'), []);
  assert.match(out[0], /chrome-claude is running; left it alone\. Its new settings apply/);
  assert.match(out[1], /chrome-claude already running; left it alone/);
  assert.ok(s.loaded('claude') && s.up(9332));
  assert.equal(s.loaded('personal'), false);
});

test('a running agent-mode profile is never stopped, whatever else the state says', () => {
  // An unreadable or unknown record means agent, and a legacy desktop file does not apply to claude.
  for (const rec of ['not json', '{"mode": "sideways"}', '{"mode": "agent"}', null]) {
    const s = sandbox();
    s.legacy('desktop');
    if (rec !== null) { mkdirSync(s.state, { recursive: true }); writeFileSync(join(s.state, 'claude.json'), rec); }
    s.touch('loaded-com.test.chrome-claude'); s.touch('up-9332');
    s.install();                                 // first run writes the plist: still left alone
    s.install();
    assert.deepEqual(s.cycle('claude'), [], String(rec));
    assert.ok(s.loaded('claude') && s.up(9332), String(rec));
  }
});

test('a profile whose agent cannot be loaded is reported, and the next profile is still installed', () => {
  const s = sandbox();
  const r = s.install([], { FAKE_BOOTSTRAP_FAIL: 'com.test.chrome-claude' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /chrome-claude: could not load its agent; re-run this installer/);
  assert.equal(s.loadsOf('personal').length, 1);
  assert.ok(s.loaded('personal'));
});
