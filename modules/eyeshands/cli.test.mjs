// node --test modules/eyeshands/cli.test.mjs   (never touches Hammerspoon, the real ports or the real access file)
// The `eyeshands` CLI (bin/eyeshands) end to end against a fake Eyes & Hands port (test/fake-eh-port.py: a
// real CFMessagePort with the arm, HMAC and seq rules of port.lua and canned replies): argument parsing,
// arm-call-disarm for one-shot commands, a hands job waited out before the disarm, session seq always
// rising, owner_in_use without an arm, the secret only inside port messages, access edits on a throwaway
// file, wall detection, the doctor with fake system tools (and its hold file line), and the bundled hsx equal
// to the harness file.
// Every run uses a throwaway HOME, port name and access file. Needs python3; skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const CLI = here('./bin/eyeshands');
const FAKE = here('./test/fake-eh-port.py');
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const skip = PY ? false : 'no python3';

const tmp = () => mkdtempSync(join(tmpdir(), 'eh-cli-'));
const portName = () => `eyeshands-test-${randomBytes(4).toString('hex')}`;

// A throwaway environment: own HOME, no harness around (HARNESS_ENV points at nothing), own access file.
function envFor(dir, extra = {}) {
  return { ...process.env, HOME: join(dir, 'home'), HARNESS_ENV: join(dir, 'no-harness.env'),
    EYESHANDS_ACCESS_FILE: join(dir, 'access.json'), EYESHANDS_PORT: 'eyeshands-test-unused', ...extra };
}
function cli(args, { dir = tmp(), input, env = {} } = {}) {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const r = spawnSync(CLI, args, { input, encoding: 'utf8', env: envFor(dir, env), timeout: 60000 });
  return { ...r, json: () => JSON.parse(r.stdout) };
}

// Starts a fake port with `conf`; returns run(args, input) for the CLI on it, the parsed log, and stop().
async function fake(conf) {
  const dir = tmp(), name = portName();
  const confFile = join(dir, 'conf.json'), logFile = join(dir, 'port.jsonl');
  writeFileSync(confFile, JSON.stringify({ owners: { runner: { enabled: true } }, ...conf }));
  writeFileSync(logFile, '');
  const child = spawn('python3', [FAKE, name, confFile, logFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => String(d).includes('ready') && resolve());
    child.on('exit', c => reject(new Error(`fake port exited ${c}`)));
  });
  return {
    dir, name,
    run: (args, input, env = {}) => cli(args, { dir, input, env: { EYESHANDS_PORT: name, ...env } }),
    log: () => readFileSync(logFile, 'utf8').trimEnd().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    stop: () => child.kill(),
  };
}
const cmds = log => log.filter(e => e.cmd).map(e => e.cmd);

test('the bundled hsx equals the harness hsx', () => {
  const a = readFileSync(here('./bin/hsx')), b = readFileSync(here('../hammerspoon/hsx'));
  assert.ok(a.equals(b), 'copy modules/hammerspoon/hsx to modules/eyeshands/bin/hsx');
  assert.ok(statSync(CLI).mode & 0o111, 'bin/eyeshands is executable');
});

test('argument parsing: usage errors exit 2 before anything reaches a port', { skip }, () => {
  const cases = [
    [['eyes', 'fields', '--owner', 'runner']],                                   // a target command without a target
    [['eyes', 'explode', '--owner', 'runner', '--target', 't']],                 // unknown eyes command
    [['hands', 'click', '--target', 't']],                                       // no owner
    [['eyes', 'fields', '--owner', 'bad owner', '--target', 't']],               // owner name
    [['eyes', 'fields', '--owner', 'runner', '--target', 'a/b']],                // target name
    [['eyes', 'fields', '--owner', 'runner', '--target', 't', '[1]']],           // args not an object
    [['eyes', 'fields', '--owner', 'runner', '--target', 't', '{bad']],          // args not JSON
    [['eyes', 'fields', '--owner', 'runner', '--target', 't', '{"target":"u"}']], // two targets
    [['eyes', 'fields', '--owner', 'runner', '--target', 't', '--secret', 'ab']], // no secret option exists
    [['session']],                                                               // session needs an owner
  ];
  for (const [args] of cases) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /eyeshands session --owner O/);
});

test('status, targets and stop need no secret and send no signature', { skip }, async () => {
  const f = await fake({ targets: { file: '/x/targets.json', state: 'ok', targets: [{ name: 'textedit', running: true, pid: 7 }] } });
  try {
    const st = f.run(['status']);
    assert.equal(st.status, 0, st.stderr);
    assert.equal(st.json().running, true);
    assert.equal(f.run(['targets']).json().targets[0].name, 'textedit');
    assert.deepEqual(f.run(['stop']).json(), { stopped: true, disarmed: [] });
    const log = f.log();
    assert.deepEqual(cmds(log), ['status', 'eh.targets', 'stop']);
    for (const e of log) assert.ok(!('mac' in e) && !('owner' in e), 'unsigned');
  } finally { f.stop(); }
});

test('a one-shot eyes command arms, makes one signed call, and disarms; the secret stays inside port messages', { skip }, async () => {
  const f = await fake({});
  try {
    const r = f.run(['eyes', 'fields', '--owner', 'runner', '--target', 'textedit', '{"match":{"label":"Email"}}']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json(), { ok: true, cmd: 'eh.eyes.fields', args: { match: { label: 'Email' }, target: 'textedit' } });
    const log = f.log();
    assert.deepEqual(cmds(log), ['status', 'arm', 'eh.eyes.fields', 'disarm']);
    const arm = JSON.parse(log[1].args);
    assert.match(arm.secret, /^[0-9a-f]{64}$/);
    assert.equal(arm.owner, 'runner');
    assert.equal(typeof arm.pid, 'number');
    assert.ok(arm.minutes > 0 && arm.minutes <= 15, 'a one-shot arm asks for a short time');
    assert.ok(log[2].seq < log[3].seq, 'seq rises from the call to the disarm');
    // The secret never shows in the output, and no file under the run's folders holds it.
    assert.ok(!r.stdout.includes(arm.secret) && !r.stderr.includes(arm.secret));
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const file of walk(f.dir)) {
      if (file.endsWith('port.jsonl')) continue;   // the fake port's own record of what it received
      assert.ok(!readFileSync(file, 'utf8').includes(arm.secret), `${file} holds the secret`);
    }
  } finally { f.stop(); }
});

test('a one-shot hands command waits for its job to end before it disarms', { skip }, async () => {
  const f = await fake({ job_polls: 3 });
  try {
    const r = f.run(['hands', 'click', '--owner', 'runner', '--target', 'textedit', '{"to":{"field":"f3"}}']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().state, 'done');
    const log = f.log();
    const order = log.map(e => e.cmd || e.event);
    assert.deepEqual(order, ['status', 'arm', 'eh.hands.click', 'eh.hands.job', 'eh.hands.job', 'eh.hands.job', 'job-done', 'disarm']);
    assert.ok(!order.includes('job-aborted'));
  } finally { f.stop(); }
});

test('hands args from stdin keep typed text out of argv; a refusal exits 1 and still disarms', { skip }, async () => {
  const f = await fake({ refuse: { 'eh.hands.type': { ok: false, reason: 'present', retry_after_s: 8, hint: 'ask the person, or wait' } } });
  try {
    const r = f.run(['hands', 'type', '--owner', 'runner', '--target', 'textedit', '-'], '{"text":"private words"}');
    assert.equal(r.status, 1);
    assert.equal(r.json().reason, 'present');
    const log = f.log();
    assert.deepEqual(cmds(log), ['status', 'arm', 'eh.hands.type', 'disarm']);
    assert.equal(JSON.parse(log[2].args).text, 'private words');
    assert.ok(!r.stdout.includes('private words') && !r.stderr.includes('private words'));
  } finally { f.stop(); }
});

test('a hands job that runs past --max-wait is aborted, then the owner disarms', { skip }, async () => {
  const f = await fake({ job_polls: 1000 });
  try {
    const r = f.run(['hands', 'type', '--owner', 'runner', '--target', 'textedit', '--max-wait', '0.3', '{"text":"x"}']);
    assert.equal(r.status, 1);
    assert.equal(r.json().reason, 'max_wait');
    const c = cmds(f.log());
    assert.equal(c.at(-2), 'eh.hands.abort');
    assert.equal(c.at(-1), 'disarm');
  } finally { f.stop(); }
});

test('an owner that another session holds gets owner_in_use and no arm (so no false alarm)', { skip }, async () => {
  const f = await fake({ status: { name: 'EyesHands', running: true, access: { policy: 'ok', owners: { runner: { enabled: true, armed: true } } } } });
  try {
    const r = f.run(['eyes', 'text', '--owner', 'runner', '--target', 'textedit']);
    assert.equal(r.status, 1);
    assert.equal(r.json().reason, 'owner_in_use');
    assert.deepEqual(cmds(f.log()), ['status']);
  } finally { f.stop(); }
});

test('an arm the policy refuses exits 1 with the reason; an absent port exits 3', { skip }, async () => {
  const f = await fake({});
  try {
    const r = f.run(['eyes', 'frontmost', '--owner', 'stranger']);
    assert.equal(r.status, 1);
    assert.deepEqual(r.json(), { ok: false, error: 'owner not in the access policy' });
    assert.deepEqual(cmds(f.log()), ['status', 'arm']);
  } finally { f.stop(); }
  const gone = cli(['status'], { env: { EYESHANDS_PORT: portName() }, });
  assert.equal(gone.status, 3);
  assert.match(gone.json().error, /^unreachable/);
});

test('session: one arm, one signer (seq always rises), one reply per line, waits on request, disarm at EOF', { skip }, async () => {
  const f = await fake({ job_polls: 2, lines: ['Please verify you are human'], frames: [] });
  try {
    const lines = [
      '{"cmd":"eyes.fields","args":{"target":"textedit"}}',
      'not json',
      '{"cmd":"eh.eyes.text","args":{"target":"textedit"}}',
      '{"cmd":"hands.click","args":{"target":"textedit","to":{"x":1,"y":2}},"wait":true}',
      '{"cmd":"hands.key","args":{"target":"textedit","combo":"enter"}}',
      '{"cmd":"status"}',
      '{"cmd":"disarm"}',
      '{"cmd":"eyes.focused","args":{"target":"textedit"}}',
    ];
    const r = f.run(['session', '--owner', 'runner'], lines.join('\n') + '\n');
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout.trimEnd().split('\n').map(l => JSON.parse(l));
    assert.equal(out.length, lines.length);
    assert.equal(out[0].result.cmd, 'eh.eyes.fields');
    assert.equal(out[1].ok, false);
    assert.match(out[1].error, /^eyeshands:/);
    assert.deepEqual(out[2].result.wall, ['human']);
    assert.equal(out[3].result.state, 'done', 'wait: true polls the job');
    assert.equal(out[4].result.state, 'running', 'without wait the start reply comes back');
    assert.equal(out[5].result.running, true);
    assert.equal(out[6].ok, true, 'a session may disarm itself');
    assert.deepEqual(out[7], { ok: false, error: 'not armed' }, 'and then sends nothing more');
    const log = f.log().filter(e => e.cmd);
    assert.equal(log.filter(e => e.cmd === 'arm').length, 1);
    assert.equal(log.filter(e => e.cmd === 'disarm').length, 1, 'no second disarm at EOF');
    assert.equal(log.at(-1).cmd, 'disarm');
    const seqs = log.filter(e => 'seq' in e).map(e => e.seq);
    assert.ok(seqs.length >= 7);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} after ${seqs[i - 1]}`);
  } finally { f.stop(); }
});

// The wall patterns, through the CLI's own walls() (loaded as a module, not run).
function walls(lines, frames = []) {
  const code = `import importlib.machinery as m, importlib.util as u, json, sys
l = m.SourceFileLoader("eh", sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader("eh", l)); l.exec_module(mod)
print(json.dumps(mod.walls(json.loads(sys.argv[2]))))`;
  const r = spawnSync('python3', ['-c', code, CLI, JSON.stringify({ lines, frames })], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('eyes text: wall detection for each pattern, and none on a plain page', { skip }, () => {
  assert.deepEqual(walls(['Verify that you are a human']), ['human']);
  assert.deepEqual(walls(["I'm not a robot"]), ['human']);
  assert.deepEqual(walls(['Are you a robot?']), ['human']);
  assert.deepEqual(walls([], ['https://newassets.hcaptcha.com/captcha/v1']), ['hcaptcha', 'captcha']);
  assert.deepEqual(walls([], ['https://www.google.com/recaptcha/api2/anchor']), ['recaptcha']);
  assert.deepEqual(walls(['Solve the CAPTCHA below']), ['captcha']);
  assert.deepEqual(walls(['Enter the verification code we sent']), ['otp']);
  assert.deepEqual(walls(['Your one-time passcode']), ['otp']);
  assert.deepEqual(walls(['We noticed unusual activity']), ['unusual']);
  assert.deepEqual(walls(['Email', 'First name', 'Submit application']), []);
  assert.deepEqual(walls([], [{ not: 'a string' }]), []);
});

// The doctor's hold file line, through the CLI's own hold_report() (loaded as a module, not run).
function holdLines(hold) {
  const code = `import importlib.machinery as m, importlib.util as u, json, sys
l = m.SourceFileLoader("eh", sys.argv[1]); mod = u.module_from_spec(u.spec_from_loader("eh", l)); l.exec_module(mod)
r = mod.Report(); mod.hold_report(r, json.loads(sys.argv[2])); print("fails", r.fails)`;
  const r = spawnSync('python3', ['-c', code, CLI, JSON.stringify(hold)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('doctor: the hold file line says free, held (by whom, until when) or unreadable; nothing when it is off', { skip }, () => {
  const file = '/locks/driver.lock';
  assert.equal(holdLines({ configured: false }), 'fails 0\n');
  assert.equal(holdLines(null), 'fails 0\n');
  assert.equal(holdLines({ configured: true, file, held: false, kind: 'missing' }), `PASS  hold file ${file}: free (no file)\nfails 0\n`);
  assert.equal(holdLines({ configured: true, file, held: true, kind: 'manual', who: 'captain', since: '2027-01-15T07:59:00Z', until: '2027-01-15T08:10:00Z' }),
    `WARN  hold file ${file}: held (manual hold by captain, since 2027-01-15T07:59:00Z, until 2027-01-15T08:10:00Z); eyes and hands are refused until it ends\nfails 0\n`);
  assert.match(holdLines({ configured: true, file, held: true, kind: 'pid', pid: 4242, who: 'night run' }), /WARN  hold file .*: held \(pid 4242 \(night run\)\); eyes and hands/);
  assert.match(holdLines({ configured: true, file, held: true, kind: 'borrowed', who: 'captain' }), /held \(borrowed manual hold by captain\);/);
  const bad = holdLines({ configured: true, file, held: true, kind: 'malformed' });
  assert.match(bad, /^FAIL  hold file \/locks\/driver\.lock: malformed, so it counts as held and eyes and hands are refused\n      fix: /);
  assert.match(bad, /fails 1\n$/);
});

test('a one-shot eyes text adds wall', { skip }, async () => {
  const f = await fake({ lines: ['Welcome'], frames: ['https://www.google.com/recaptcha/api2/anchor'] });
  try {
    const r = f.run(['eyes', 'text', '--owner', 'runner', '--target', 'chrome-test']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json().wall, ['recaptcha']);
  } finally { f.stop(); }
});

test('access: allow, list and deny edit only the Eyes & Hands policy file, with hsx rules', { skip }, () => {
  const dir = tmp(), file = join(dir, 'access.json');
  const a = cli(['access', 'allow', 'claude-code', 'eyes,shot,hands', '--apps', 'chrome-agent,com.apple.TextEdit', '--max-minutes', '60'], { dir });
  assert.equal(a.status, 0, a.stderr);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc.owners['claude-code'], { enabled: true, capabilities: ['eyes', 'shot', 'hands'],
    apps: ['chrome-agent', 'com.apple.TextEdit'], max_arm_minutes: 60 });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const l = cli(['access', 'list'], { dir });
  assert.match(l.stdout, /claude-code\s+on\s+eyes,shot,hands\s+apps=chrome-agent,com\.apple\.TextEdit/);
  assert.equal(cli(['access', 'deny', 'claude-code'], { dir }).status, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).owners['claude-code'].enabled, false);
  // Notes for capabilities that Eyes & Hands does not use, and for shot without eyes.
  const n = cli(['access', 'allow', 'looker', 'shot,awake'], { dir });
  assert.equal(n.status, 0);
  assert.match(n.stderr, /awake is for other port commands/);
  assert.match(n.stderr, /shot works only together with eyes/);
  // hsx's checks hold: a bad window is refused and the file stays as it was.
  const before = readFileSync(file, 'utf8');
  assert.equal(cli(['access', 'allow', 'x', 'eyes', '--window', '25:00-01:00'], { dir }).status, 2);
  assert.equal(readFileSync(file, 'utf8'), before);
  // --file wins over the environment.
  const other = join(dir, 'other.json');
  assert.equal(cli(['access', 'allow', 'y', 'eyes', '--file', other], { dir }).status, 0);
  assert.ok(JSON.parse(readFileSync(other, 'utf8')).owners.y);
});

test('access: the default file is ~/.config/eyeshands/access.json, or HS_ACCESS_FILE inside a configured harness', { skip }, () => {
  const dir = tmp();
  const r = cli(['access', 'allow', 'z', 'eyes'], { dir, env: { EYESHANDS_ACCESS_FILE: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'home', '.config', 'eyeshands', 'access.json')));
  const henv = join(dir, 'harness.env'), hfile = join(dir, 'hs-access.json');
  writeFileSync(henv, `HS_ACCESS_FILE=${hfile}\nPROFILE_DIR=${join(dir, 'profile')}\n`);
  const h = cli(['access', 'allow', 'w', 'eyes'], { dir, env: { EYESHANDS_ACCESS_FILE: '', HARNESS_ENV: henv } });
  assert.equal(h.status, 0, h.stderr);
  assert.ok(JSON.parse(readFileSync(hfile, 'utf8')).owners.w);
});

// Fake system tools for the doctor: sw_vers, codesign, pgrep and open, plus a fake Hammerspoon.app.
function doctorEnv(dir, { team = 'VQCYSNZB89', running = true, axFlag } = {}) {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'Hammerspoon.app'), { recursive: true });
  const tool = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool('sw_vers', 'echo 15.5');
  tool('codesign', `echo "Identifier=org.hammerspoon.Hammerspoon" >&2; echo "TeamIdentifier=${team}" >&2`);
  tool('pgrep', running ? 'exit 0' : 'exit 1');
  tool('open', `echo "$*" >> '${join(dir, 'open.log')}'${axFlag ? `; touch '${axFlag}'` : ''}`);
  return { PATH: `${bin}:${process.env.PATH}`, EYESHANDS_HAMMERSPOON_APP: join(dir, 'Hammerspoon.app') };
}

test('doctor: every check passes or warns with a fix; --fix opens the Accessibility pane and waits for the grant', { skip }, async () => {
  const f0 = tmp(), axFlag = join(f0, 'ax-granted');
  const f = await fake({
    ax_flag: axFlag,
    status: { name: 'EyesHands', version: '0.1.0', running: true, grants: { accessibility: false, screen_recording: false }, access: { policy: 'ok', owners: {} } },
    targets: { file: '/x/targets.json', state: 'ok', targets: [{ name: 'textedit', running: true, pid: 9 }, { name: 'chrome-test', running: false }] },
  });
  try {
    writeFileSync(join(f.dir, 'access.json'), JSON.stringify({ owners: { 'claude-code': { enabled: true, capabilities: ['eyes'] } } }));
    const env = doctorEnv(f.dir, { axFlag });
    const plain = f.run(['doctor'], undefined, env);
    assert.equal(plain.status, 1);
    assert.match(plain.stdout, /FAIL  Accessibility is off/);
    assert.match(plain.stdout, /Stopped: grant Accessibility first/);
    const r = f.run(['doctor', '--fix'], undefined, env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const want of [/PASS  macOS 15\.5/, /PASS  Hammerspoon at .*VQCYSNZB89/, /PASS  Hammerspoon runs/,
      /PASS  the "eyeshands-test-[0-9a-f]+" port answers \(EyesHands 0\.1\.0\)/, /WARN  nothing loads the Spoon/,
      /PASS  Accessibility is on/, /WARN  Screen Recording is off/, /PASS  access policy .*enabled owners claude-code/,
      /PASS  targets file \/x\/targets\.json/, /PASS    target textedit: runs \(pid 9\)/, /WARN    target chrome-test: not running/,
      /PASS  python3 /, /WARN  MCP: no Claude Code, Codex or Cursor configuration/, /All checks passed\./]) {
      assert.match(r.stdout, want);
    }
    const opened = readFileSync(join(f.dir, 'open.log'), 'utf8');
    assert.match(opened, /Privacy_Accessibility/);
    assert.match(opened, /Privacy_ScreenCapture/);
  } finally { f.stop(); }
});

test('doctor: no Hammerspoon, a foreign signature, no port and no access file each fail', { skip }, () => {
  const dir = tmp();
  mkdirSync(join(dir, 'home', '.hammerspoon', 'local'), { recursive: true });
  writeFileSync(join(dir, 'home', '.hammerspoon', 'local', 'eyeshands.lua'), '-- loader');
  writeFileSync(join(dir, 'home', '.claude.json'), '{"mcpServers":{}}');
  const env = { ...doctorEnv(dir, { team: 'ABCDE12345', running: false }), EYESHANDS_PORT: portName() };
  const r = cli(['doctor'], { dir, env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL  Hammerspoon at .* is not signed by the Hammerspoon team/);
  assert.match(r.stdout, /FAIL  Hammerspoon does not run\n      fix: open -a Hammerspoon/);
  assert.match(r.stdout, /FAIL  the "eyeshands-test-[0-9a-f]+" port does not answer status/);
  assert.match(r.stdout, /PASS  the Spoon loads at start/);
  assert.match(r.stdout, /FAIL  access policy .*missing: nothing may arm/);
  assert.match(r.stdout, /WARN  MCP: Claude Code has no eyeshands server\n      fix: claude mcp add --scope user eyeshands/);
  assert.match(r.stdout, /\d+ check\(s\) failed\./);
  assert.ok(!existsSync(join(dir, 'open.log')), 'without --fix nothing is opened');
});
