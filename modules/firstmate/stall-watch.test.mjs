// node --test modules/firstmate/stall-watch.test.mjs
// stall-watch.sh's freeze watch against a fake tmux and pgrep, a throwaway harness.env and firstmate home.
// The "claude" it stops is a real child process of the test that ignores SIGTERM, so SIGKILL is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCH = fileURLToPath(new URL('./stall-watch.sh', import.meta.url));
const T0 = 1_800_000_000;
const PROMPT = '────────\n❯ \n────────\n';

// Windows come from $FAKE/windows ("index name" lines); a pane's text from $FAKE/pane-<index or name>.
const FAKE_TMUX = `#!/bin/sh
echo "$*" >> "$FAKE/tmux.log"
case "$1" in
  list-windows) case "$*" in *window_index*) cat "$FAKE/windows" ;; *) awk '{print $2}' "$FAKE/windows" ;; esac ;;
  capture-pane) w=\${4#*:}; cat "$FAKE/pane-$w" 2>/dev/null ;;
  display-message) echo 4242 ;;
esac
exit 0
`;
// The claude child: the pid in $FAKE/claude-pid while it lives, then the restarted one in $FAKE/new-pid.
// A killed child stays a zombie until node reaps it (spawnSync blocks the loop), so a zombie counts as gone.
const FAKE_PGREP = `#!/bin/sh
[ -f "$FAKE/claude-pid" ] || exit 1
p=$(cat "$FAKE/claude-pid")
case "$(ps -o stat= -p "$p" 2>/dev/null)" in ""|Z*) alive= ;; *) alive=1 ;; esac
if [ -n "$alive" ]; then echo "$p"; elif [ -f "$FAKE/new-pid" ]; then cat "$FAKE/new-pid"; else exit 1; fi
`;

function sandbox() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fm-stall-test-')));
  const bin = join(d, 'bin'), fake = join(d, 'fake'), fm = join(d, 'firstmate'), prof = join(d, 'profile');
  for (const p of [bin, fake, join(fm, 'state/inbox'), join(fm, 'bin'), prof]) mkdirSync(p, { recursive: true });
  for (const [n, s] of [['tmux', FAKE_TMUX], ['pgrep', FAKE_PGREP], [join(fm, 'bin/fm-inbox.sh'), '#!/bin/sh\necho "$*" >> "$FAKE/inbox.log"\n']]) {
    const p = n.includes('/') ? n : join(bin, n); writeFileSync(p, s); chmodSync(p, 0o755);
  }
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `FIRSTMATE_DIR="${fm}"\nFIRSTMATE_SESSION="firstmate"\nPROFILE_DIR="${prof}"\n`);
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: d, FAKE: fake, HARNESS_ENV: envFile,
    PING_MIN: '9999', TERM_WAIT: '1', READY_WAIT: '4' };
  const children = [];
  const s = {
    d, fm, fake,
    windows: lines => writeFileSync(join(fake, 'windows'), lines.join('\n') + '\n'),
    pane: (w, text) => writeFileSync(join(fake, `pane-${w}`), text),
    note: n => writeFileSync(join(fm, 'state/inbox', `${n}.note`), 'x'),
    drop: n => rmSync(join(fm, 'state/inbox', `${n}.note`)),
    run: min => spawnSync('/bin/zsh', [WATCH], { env: { ...env, NOW: String(T0 + min * 60) }, encoding: 'utf8' }),
    tmux: () => existsSync(join(fake, 'tmux.log')) ? readFileSync(join(fake, 'tmux.log'), 'utf8').trim().split('\n') : [],
    keys: () => s.tmux().filter(l => l.startsWith('send-keys')),
    master: () => existsSync(join(prof, 'logs/master-alerts.log')) ? readFileSync(join(prof, 'logs/master-alerts.log'), 'utf8') : '',
    // A stand-in claude that ignores SIGTERM, like the frozen one in the incident.
    claude: () => {
      const c = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' });
      children.push(c); writeFileSync(join(fake, 'claude-pid'), String(c.pid)); return c;
    },
    done: () => { for (const c of children) try { c.kill('SIGKILL'); } catch {} },
  };
  return s;
}

test('frozen firstmate with notes waiting: Enter, then SIGTERM, SIGKILL, restart and "check inbox"', async () => {
  const s = sandbox();
  try {
    s.windows(['0 2.1.332']); s.pane('0', `⏺ working\n${PROMPT}`); s.note('a'); s.note('b');
    const c = s.claude();
    let r = s.run(0); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.keys(), []);
    s.run(10); assert.deepEqual(s.keys(), [], 'not yet 15 min');
    s.run(16);
    assert.deepEqual(s.keys(), ['send-keys -t firstmate:0 C-m']);
    assert.match(s.master(), /step a: firstmate looks frozen \(2 inbox note\(s\) waiting, no progress for 16 min\)/);
    s.run(17); assert.equal(s.keys().length, 1, 'waits 3 min after Enter');
    writeFileSync(join(s.fake, 'new-pid'), '99999');
    const exited = new Promise(res => c.on('exit', (code, sig) => res(sig)));
    r = s.run(19); assert.equal(r.status, 0, r.stderr);
    assert.equal(await exited, 'SIGKILL');
    const m = s.master();
    assert.match(m, /step b: Enter did not help; sent SIGTERM to firstmate claude pid \d+/);
    assert.match(m, /ignored SIGTERM for 1s; sent SIGKILL/);
    assert.match(m, /step c: firstmate restarted as pid 99999; typed "check inbox"/);
    assert.equal(m.match(/Freeze watch: firstmate was frozen/g).length, 1, 'one summary line');
    assert.deepEqual(s.keys().slice(1), ['send-keys -t firstmate:0 -l -- check inbox', 'send-keys -t firstmate:0 C-m']);
    s.run(24); assert.equal(s.keys().length, 3, 'ladder starts over after the restart');
  } finally { s.done(); }
});

test('a busy firstmate whose spinner still redraws is not frozen', () => {
  const s = sandbox();
  s.windows(['0 2.1.332']); s.note('a');
  for (const [i, min] of [0, 16, 20, 25].entries()) {
    s.pane('0', `⏺ Bash(sleep)\n✽ Thinking… (${i}m ${i}s)\n${PROMPT}  esc to interrupt\n`);
    s.run(min);
  }
  assert.deepEqual(s.keys(), []);
  assert.equal(s.master(), '');
});

test('a drained note counts as progress', () => {
  const s = sandbox();
  s.windows(['0 2.1.332']); s.pane('0', PROMPT); s.note('a'); s.note('b');
  s.run(0); s.run(10); s.drop('a'); s.run(16); s.run(20);
  assert.deepEqual(s.keys(), []);
});

test('API Error with an idle prompt and no notes: Enter after 5 min', () => {
  const s = sandbox();
  s.windows(['0 2.1.332']); s.pane('0', `⎿ API Error: The response stopped arriving\n${PROMPT}`);
  s.run(0); s.run(3); assert.deepEqual(s.keys(), []);
  s.run(6);
  assert.deepEqual(s.keys(), ['send-keys -t firstmate:0 C-m']);
  assert.match(s.master(), /API Error with an idle prompt for 6 min/);
});

test('no claude child under run-firstmate.sh: one line for the master, no repeat', () => {
  const s = sandbox();
  s.windows(['0 2.1.332']); s.pane('0', PROMPT); s.note('a');
  s.run(0); s.run(16); s.run(20); s.run(25); s.run(30);
  assert.equal(s.master().match(/has no claude child/g).length, 1);
  assert.equal(s.keys().length, 1);
});

test('second mate: API Error, idle prompt, inbox message: Enter, then one nudge and one master line, never killed', () => {
  const s = sandbox();
  try {
    s.windows(['0 2.1.332', '1 fm-mate']); s.pane('0', `⏺ fine\n${PROMPT}`);
    s.pane('fm-mate', `⎿ API Error: The response stopped arriving\n${PROMPT}`);
    writeFileSync(join(s.fm, 'state/mate.meta'), 'window=firstmate:fm-mate\n');
    mkdirSync(join(s.fm, 'state/mate.inbox/handled'), { recursive: true });
    writeFileSync(join(s.fm, 'state/mate.inbox/0001.msg'), 'do it');
    const c = s.claude();
    s.run(0); s.run(6);
    assert.deepEqual(s.keys(), ['send-keys -t firstmate:fm-mate C-m']);
    s.run(11); s.run(16);
    const keys = s.keys();
    assert.equal(keys.length, 3);
    assert.match(keys[1], /^send-keys -t firstmate:fm-mate -l -- Firstmate instruction waiting: .*mate\.inbox/);
    assert.equal(s.master().match(/Freeze watch: second mate fm-mate stuck/g).length, 1);
    assert.equal(c.exitCode, null, 'second mate not killed');
    assert.equal(c.signalCode, null);
  } finally { s.done(); }
});

test('second mate with an empty inbox is left alone', () => {
  const s = sandbox();
  s.windows(['0 2.1.332', '1 fm-mate']); s.pane('0', PROMPT);
  s.pane('fm-mate', `API Error: x\n${PROMPT}`);
  writeFileSync(join(s.fm, 'state/mate.meta'), 'window=firstmate:fm-mate\n');
  s.run(0); s.run(6); s.run(11);
  assert.deepEqual(s.keys(), []);
});
