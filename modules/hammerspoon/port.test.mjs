// node --test modules/hammerspoon/port.test.mjs   (never touches the real Hammerspoon)
// The port logic (port.lua) runs under a plain Lua 5.4 with fake hs pieces (test/driver.lua); hsx is
// tested end to end against a fake port (test/fake-port.py) that hands each message to that driver.
// Needs lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4) and python3; skips without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const DRIVER = here('./test/driver.lua');
const FAKE_PORT = here('./test/fake-port.py');
const HSX = here('./hsx');
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const skipLua = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';
const skipE2E = skipLua || (PY ? false : 'no python3');

// Runs lines through the driver; one parsed output per input line.
function drive(lines) {
  const r = spawnSync(LUA, [DRIVER], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n').map(l => (l.startsWith('ERROR') ? l : JSON.parse(l)));
}
const secret = () => randomBytes(32).toString('hex');
const mac = (key, seq, cmd, args) => createHmac('sha256', key).update(`${seq}|${cmd}|${args}`).digest('hex');
const signed = (key, owner, cmd, args, seq) => JSON.stringify({ cmd, owner, args, seq, mac: mac(key, seq, cmd, args) });
const arm = (owner, key, extra = {}) => JSON.stringify({ cmd: 'arm', args: JSON.stringify({ owner, secret: key, ...extra }) });

test('read-only commands work without a secret; hands do not', { skip: skipLua }, () => {
  const [st, click] = drive(['{"cmd":"status"}', '{"cmd":"hands.click","owner":"runner","args":"{\\"x\\":1}"}']);
  assert.deepEqual(st, { ok: true, result: { ok: 'status' } });
  assert.deepEqual(click, { ok: false, error: 'not armed' });
});

test('an armed owner with a good MAC and rising seq drives the hands', { skip: skipLua }, () => {
  const k = secret();
  const [a, c1, c2] = drive([arm('runner', k), signed(k, 'runner', 'hands.click', '{"x":5}', 1),
    signed(k, 'runner', 'hands.click', '{"x":6}', 7)]);
  assert.equal(a.ok, true);
  assert.deepEqual(c1, { ok: true, result: { clicked: 5 } });
  assert.deepEqual(c2, { ok: true, result: { clicked: 6 } });
});

test('a forged MAC is denied, disarms, locks the owner against re-arming, and alerts once', { skip: skipLua }, () => {
  const k = secret(), evil = secret();
  const out = drive([arm('runner', k), signed(evil, 'runner', 'hands.click', '{}', 1),
    signed(k, 'runner', 'hands.click', '{}', 2), arm('runner', evil), '!return #ALERTS', '!return ALERTS[1]',
    '!return table.concat(LOG, "\\n")']);
  assert.deepEqual(out[1], { ok: false, error: 'bad mac' });
  assert.deepEqual(out[2], { ok: false, error: 'not armed' });
  assert.deepEqual(out[3], { ok: false, error: 'locked after a failed check' });
  assert.equal(out[4], 1, 'one alert for the whole incident');
  assert.match(out[5], /runner: bad mac on hands\.click; disarmed and locked/);
  assert.ok(!out[6].includes(k) && !out[6].includes(evil), 'the audit log never holds a secret');
  assert.match(out[6], /deny owner=runner cmd=hands\.click reason=bad\?mac/);
});

test('a replayed (or older) seq is denied and disarms', { skip: skipLua }, () => {
  const k = secret();
  const req = signed(k, 'runner', 'hands.click', '{}', 10);
  const out = drive([arm('runner', k), req, req]);
  assert.equal(out[1].ok, true);
  assert.deepEqual(out[2], { ok: false, error: 'replay' });
  const older = drive([arm('runner', k), signed(k, 'runner', 'hands.click', '{}', 10), signed(k, 'runner', 'hands.click', '{}', 9)]);
  assert.deepEqual(older[2], { ok: false, error: 'replay' });
});

test('an unsigned call to an armed owner counts as an attack', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('runner', k), '{"cmd":"hands.click","owner":"runner","args":"{}"}', signed(k, 'runner', 'hands.click', '{}', 1)]);
  assert.deepEqual(out[1], { ok: false, error: 'unsigned call' });
  assert.deepEqual(out[2], { ok: false, error: 'not armed' });
});

test('first arm wins: a second arm is refused with an alert and the first keeps working', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('runner', k), arm('runner', secret()), signed(k, 'runner', 'hands.click', '{}', 1), '!return ALERTS']);
  assert.deepEqual(out[1], { ok: false, error: 'already armed' });
  assert.equal(out[2].ok, true);
  assert.match(out[3][0], /runner: arm refused \(already armed\)/);
});

test('arming outside the window is refused, unless a manual run was allowed for that owner', { skip: skipLua }, () => {
  const k = secret();
  const out = drive(['!MINUTE = 12 * 60', arm('runner', k), '!return ALERTS[1]', '!return port.allowArm("runner", 5)',
    arm('runner', k), '!return port.allowArm("looker", 5)']);
  assert.deepEqual(out[1], { ok: false, error: 'outside the arm window' });
  assert.match(out[2], /arm refused \(outside the arm window\)/);
  assert.equal(out[3], true);
  assert.equal(out[4].ok, true, 'a manual run arms outside the window');
  assert.equal(out[5], false, 'owners without manual_runs cannot be let in early');
  const night = drive(['!MINUTE = 2 * 60', arm('runner', k)]);   // 02:00 is inside 20:00-05:00
  assert.equal(night[1].ok, true);
});

test('owners not in the policy, or disabled, cannot arm or call', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('stranger', k), signed(k, 'stranger', 'hands.click', '{}', 1), arm('off', k), '{"cmd":"hands.click","args":"{}"}']);
  assert.deepEqual(out[0], { ok: false, error: 'owner not in the access policy' });
  assert.deepEqual(out[1], { ok: false, error: 'owner not in the access policy' });
  assert.deepEqual(out[2], { ok: false, error: 'owner disabled in the access policy' });
  assert.deepEqual(out[3], { ok: false, error: 'owner not in the access policy' });
});

test('a capability or app the owner was not granted is denied', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('looker', k), signed(k, 'looker', 'eyes.read', '', 1), signed(k, 'looker', 'hands.click', '{}', 2),
    arm('runner', k), signed(k, 'runner', 'hands.type', '{"app":"chrome"}', 1), signed(k, 'runner', 'hands.type', '{"app":"safari"}', 2),
    signed(k, 'runner', 'hands.type', '{}', 3), '!return #ALERTS']);
  assert.deepEqual(out[1], { ok: true, result: 'seen' });
  assert.deepEqual(out[2], { ok: false, error: 'capability hands not granted' });
  assert.deepEqual(out[4], { ok: true, result: 'typed' });
  assert.deepEqual(out[5], { ok: false, error: 'app safari not granted' });
  assert.deepEqual(out[6], { ok: false, error: 'no target app' });
  assert.ok(out[7] >= 2, 'denials alert');
});

test('an invalid policy denies everything, disarms, and alerts; it never keeps the old grants', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('runner', k), '!return port.setPolicy([[{"owners":{"runner":{"enabled":true,"capabilites":["hands"]}}}]])',
    signed(k, 'runner', 'hands.click', '{}', 1), arm('runner', secret()), '!return table.concat(ALERTS, "\\n")', '!return port.policyInfo().policy',
    '{"cmd":"status"}']);
  assert.equal(out[1], false);
  assert.deepEqual(out[2], { ok: false, error: 'access policy invalid' });
  assert.equal(out[3].ok, false);
  assert.match(out[4], /invalid access file: runner: unknown key capabilites/);
  assert.match(out[5], /^invalid/);
  assert.equal(out[6].ok, true, 'read-only status still answers');
  for (const bad of ['not json', '[1,2]', '{"owners":{"r":{"window":"25:00-05:00"}}}', '{"owners":{"r":{"capabilities":"hands"}}}',
    '{"owners":{"r":{"max_arm_minutes":0}}}', '{"owners":{"r":{"enabled":"yes"}}}', '{"owners":{"bad name":{}}}', '{"extra":1}']) {
    assert.equal(drive([`!return port.setPolicy(${JSON.stringify(bad)})`])[0], false, bad);
  }
});

test('a missing policy file means nothing may arm', { skip: skipLua }, () => {
  const out = drive(['!return port.setPolicy(nil)', arm('runner', secret()), '!return port.policyInfo()']);
  assert.equal(out[0], true);
  assert.deepEqual(out[1], { ok: false, error: 'owner not in the access policy' });
  assert.equal(out[2].policy, 'no access file');
});

test('a reloaded policy applies at once and is announced; an owner that lost its place is disarmed', { skip: skipLua }, () => {
  const k = secret(), k2 = secret();
  const grant = '{"owners":{"runner":{"enabled":true,"capabilities":["hands"],"apps":["chrome"]},"looker":{"enabled":true,"capabilities":["eyes","hands"]}}}';
  const out = drive([arm('looker', k), signed(k, 'looker', 'hands.fail', '', 1), `!return port.setPolicy(${JSON.stringify(grant)})`,
    signed(k, 'looker', 'hands.fail', '', 2), '!return ALERTS[#ALERTS]', arm('runner', k2),
    '!return port.setPolicy([[{"owners":{"looker":{"enabled":true,"capabilities":["eyes"]}}}]])',
    signed(k2, 'runner', 'hands.click', '{}', 1), `!return port.setPolicy(${JSON.stringify(grant)})`, '!return #ALERTS']);
  assert.deepEqual(out[1], { ok: false, error: 'capability hands not granted' });
  assert.equal(out[2], true);
  assert.match(out[3].error, /command failed: .*boom/, 'the new grant applies without re-arming');
  assert.match(out[4], /access policy changed: looker\[eyes,hands\]/);
  assert.equal(out[5].ok, true);
  assert.deepEqual(out[7], { ok: false, error: 'owner not in the access policy' });
  const unchanged = drive([`!return port.setPolicy(${JSON.stringify(drive(['!return POLICY'])[0])})`, '!return #ALERTS']);
  assert.equal(unchanged[1], 0, 'reloading the same grants is silent');
});

test('arms end when the runner exits or the time runs out (capped by max_arm_minutes)', { skip: skipLua }, () => {
  const k = secret();
  const gone = drive([arm('runner', k, { pid: 4242 }), '!DEAD[4242] = true; port.sweep()', signed(k, 'runner', 'hands.click', '{}', 1), arm('runner', k)]);
  assert.deepEqual(gone[2], { ok: false, error: 'not armed' });
  assert.equal(gone[3].ok, true, 'a runner that exited can be re-armed by the next run');
  const late = drive([arm('runner', k, { minutes: 9999 }), '!T = T + 601 * 60', signed(k, 'runner', 'hands.click', '{}', 1)]);
  assert.deepEqual(late[2], { ok: false, error: 'not armed' });
});

test('a signed disarm releases the owner without locking it', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('runner', k), JSON.stringify({ cmd: 'disarm', owner: 'runner', seq: 1, mac: mac(k, 1, 'disarm', '') }),
    arm('runner', secret())]);
  assert.deepEqual(out[1], { ok: true, result: true });
  assert.equal(out[2].ok, true);
});

test('only registered commands run, and malformed messages are refused', { skip: skipLua }, () => {
  const out = drive(['{"cmd":"os.execute","args":"[\\"id\\"]"}', 'not json', '{"cmd":"status","args":{"x":1}}',
    '{"cmd":"status","args":"1"}', '{"cmd":"bad name"}', '!return #ALERTS']);
  assert.deepEqual(out[0], { ok: false, error: 'unknown command' });
  assert.deepEqual(out[1], { ok: false, error: 'not a JSON object' });
  assert.deepEqual(out[2], { ok: false, error: 'args must be JSON text' });
  assert.deepEqual(out[3], { ok: false, error: 'args are not a JSON object or array' });
  assert.deepEqual(out[4], { ok: false, error: 'bad command name' });
  assert.equal(out[5], 0);
});

test('refused arms alert at most once per owner per 10 minutes', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([arm('runner', k), arm('runner', k), arm('runner', k), '!return #ALERTS', '!T = T + 601', arm('runner', k), '!return #ALERTS']);
  assert.equal(out[3], 1);
  assert.equal(out[6], 2);
});

test('a trip alerts even right after a refused-arm alert for the same owner', { skip: skipLua }, () => {
  const k = secret(), evil = secret();
  const out = drive([arm('runner', k), arm('runner', evil), signed(evil, 'runner', 'hands.click', '{}', 1),
    '!return #ALERTS', '!return ALERTS[2]']);
  assert.deepEqual(out[2], { ok: false, error: 'bad mac' });
  assert.equal(out[3], 2);
  assert.match(out[4], /runner: bad mac on hands\.click; disarmed and locked/);
});

test('an upper-case hex secret signs the same way on both sides', { skip: skipLua }, () => {
  const k = secret().toUpperCase();
  const [a, c] = drive([arm('runner', k), signed(k, 'runner', 'hands.click', '{"x":3}', 1)]);
  assert.equal(a.ok, true);
  assert.deepEqual(c, { ok: true, result: { clicked: 3 } });
});

test('the status view shows owners and capabilities but never a secret', { skip: skipLua }, () => {
  const k = secret();
  const [, info] = drive([arm('runner', k), '!return port.policyInfo()']);
  assert.equal(info.policy, 'ok');
  assert.deepEqual(info.owners.runner.capabilities, ['eyes', 'hands']);
  assert.equal(info.owners.runner.armed, true);
  assert.equal(info.owners.runner.window, '20:00-05:00');
  assert.ok(!JSON.stringify(info).includes(k));
});

test('register refuses unsafe registrations', { skip: skipLua }, () => {
  const out = drive(['!return port.register("x.y", function() end, {})', '!return port.register("arm", function() end, {auth=false})',
    '!return port.register("status", function() end, {auth=false})']);
  assert.match(out[0], /^ERROR .*needs a capability/, 'auth defaults to true, so a capability is required');
  assert.match(out[1], /^ERROR .*built in/);
  assert.match(out[2], /^ERROR .*already registered/);
});

// A command that records each caller it gets, then tries to change it.
const WHO = '!port.register("eyes.who", function(a, c) CALLERS = CALLERS or {}; CALLERS[#CALLERS + 1] = { owner = c.owner, pid = c.pid }; '
  + 'c.owner, c.pid = "evil", 1; return "seen" end, {cap="eyes"}); return true';

test('a command gets the armed owner and pid as its second argument', { skip: skipLua }, () => {
  const k = secret();
  const out = drive([WHO, arm('runner', k, { pid: 4242 }), signed(k, 'runner', 'eyes.who', '{}', 1), '!return CALLERS']);
  assert.deepEqual(out[2], { ok: true, result: 'seen' });
  assert.deepEqual(out[3], [{ owner: 'runner', pid: 4242 }]);
  const noPid = drive([WHO, arm('looker', k), signed(k, 'looker', 'eyes.who', '', 1), '!return CALLERS']);
  assert.deepEqual(noPid[3], [{ owner: 'looker' }], 'pid is nil when the arm had none');
});

test('a request cannot spoof the caller, and a command cannot change it for the next call', { skip: skipLua }, () => {
  const k = secret();
  const args = JSON.stringify({ owner: 'off', pid: 1, caller: { owner: 'off', pid: 1 } });
  const env = JSON.parse(signed(k, 'runner', 'eyes.who', args, 1));
  const spoof = JSON.stringify({ ...env, pid: 99, caller: { owner: 'off', pid: 99 } });
  const out = drive([WHO, arm('runner', k, { pid: 4242 }), spoof, signed(k, 'runner', 'eyes.who', '{}', 2),
    '!return CALLERS', '!return port.policyInfo().owners.runner.armed']);
  assert.equal(out[2].ok, true);
  assert.equal(out[3].ok, true);
  assert.deepEqual(out[4], [{ owner: 'runner', pid: 4242 }, { owner: 'runner', pid: 4242 }]);
  assert.equal(out[5], true, 'the owner stays armed');
});

test('a command that takes only args still works', { skip: skipLua }, () => {
  const k = secret();
  const [, c] = drive([arm('runner', k, { pid: 4242 }), signed(k, 'runner', 'hands.click', '{"x":3}', 1)]);
  assert.deepEqual(c, { ok: true, result: { clicked: 3 } });
});

// ---------- hsx end to end, over a real CFMessagePort ----------
async function fakePort() {
  const name = `harness-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  const child = spawn('python3', [FAKE_PORT, name, LUA], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => String(d).includes('ready') && resolve());
    child.on('exit', c => reject(new Error(`fake port exited ${c}`)));
  });
  const hsx = (args, input) => spawnSync(HSX, ['--port', name, ...args], { input, encoding: 'utf8' });
  return { hsx, stop: () => child.kill() };
}

test('hsx arms with a fresh secret on a pipe, signs calls, and is refused with a wrong secret', { skip: skipE2E }, async () => {
  const p = await fakePort();
  try {
    assert.deepEqual(JSON.parse(p.hsx(['status']).stdout), { ok: 'status' });
    const armed = p.hsx(['arm', 'runner', '--new', '--pid', String(process.pid)]);
    assert.equal(armed.status, 0, armed.stderr);
    const k = armed.stdout.trim();
    assert.match(k, /^[0-9a-f]{64}$/, 'stdout carries only the secret');
    const call = p.hsx(['call', '--owner', 'runner', 'hands.click', '{"x":3}'], k + '\n');
    assert.equal(call.status, 0, call.stderr);
    assert.deepEqual(JSON.parse(call.stdout), { clicked: 3 });
    const sess = p.hsx(['session', 'runner'], [k, '{"cmd":"hands.click","args":{"x":4}}', '{"cmd":"eyes.read"}', 'junk', ''].join('\n'));
    const replies = sess.stdout.trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(replies[0], { ok: true, result: { clicked: 4 } });
    assert.deepEqual(replies[1], { ok: true, result: 'seen' });
    assert.equal(replies[2].ok, false);
    const forged = p.hsx(['call', '--owner', 'runner', 'hands.click', '{}'], secret() + '\n');
    assert.equal(forged.status, 1);
    assert.match(forged.stderr, /refused: bad mac/);
    assert.match(p.hsx(['call', '--owner', 'runner', 'hands.click', '{}'], k + '\n').stderr, /not armed/, 'the forgery disarmed it');
  } finally { p.stop(); }
});

test('hsx raw relays envelopes the caller signed itself; disarm releases', { skip: skipE2E }, async () => {
  const p = await fakePort();
  try {
    const k = secret();
    assert.equal(p.hsx(['arm', 'runner'], k + '\n').status, 0);
    const raw = p.hsx(['raw'], signed(k, 'runner', 'hands.click', '{"x":9}', 5) + '\n');
    assert.deepEqual(JSON.parse(raw.stdout), { ok: true, result: { clicked: 9 } });
    assert.equal(p.hsx(['disarm', 'runner'], k + '\n').status, 0);
    assert.equal(p.hsx(['arm', 'runner'], secret() + '\n').status, 0, 'free to arm again after a clean disarm');
  } finally { p.stop(); }
});

test('hsx exits 3 when no port answers, and 2 on bad input', { skip: PY ? false : 'no python3' }, () => {
  const none = spawnSync(HSX, ['--port', `harness-none-${process.pid}`, 'status'], { encoding: 'utf8' });
  assert.equal(none.status, 3);
  assert.match(none.stderr, /no "harness-none-\d+" port/);
  assert.equal(spawnSync(HSX, ['--port', 'x', 'arm', 'runner'], { input: 'short\n', encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(HSX, ['--port', 'x', 'call', 'status', '3'], { encoding: 'utf8' }).status, 2);
});

// ---------- hsx access: the policy file ----------
const accessDir = () => mkdtempSync(join(tmpdir(), 'hsx-access-'));
const access = (file, ...a) => spawnSync(HSX, ['access', ...a.slice(0, 1), '--file', file, ...a.slice(1)], { encoding: 'utf8' });

test('hsx access allow and deny write a valid policy atomically, readable only by you', { skip: PY ? false : 'no python3' }, () => {
  const file = join(accessDir(), 'sub', 'access.json');
  assert.equal(access(file, 'list').status, 1, 'no file: list says nothing may arm');
  const a = access(file, 'allow', 'runner', 'eyes,hands', '--apps', 'chrome', '--window', '20:00-05:00', '--manual-runs', '--max-minutes', '600');
  assert.equal(a.status, 0, a.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(doc.owners.runner, { enabled: true, capabilities: ['eyes', 'hands'], apps: ['chrome'], window: '20:00-05:00',
    manual_runs: true, max_arm_minutes: 600 });
  assert.equal(access(file, 'deny', 'runner').status, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).owners.runner.enabled, false);
  assert.match(access(file, 'list').stdout, /runner\s+off\s+eyes,hands\s+apps=chrome\s+window=20:00-05:00/);
});

test('hsx access refuses bad input and never edits an invalid file', { skip: PY ? false : 'no python3' }, () => {
  const file = join(accessDir(), 'access.json');
  assert.equal(access(file, 'allow', 'runner', 'hands', '--window', '25:00-01:00').status, 2);
  assert.equal(existsSync(file), false, 'nothing written');
  assert.equal(access(file, 'allow', 'bad name', 'hands').status, 2);
  writeFileSync(file, '{"owners":{"x":{"capabilites":[]}}}');
  const r = access(file, 'allow', 'runner', 'hands');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid \(x: unknown key capabilites\)/);
  assert.equal(readFileSync(file, 'utf8'), '{"owners":{"x":{"capabilites":[]}}}');
});

test('hsx access and port.lua agree on what a valid policy is', { skip: skipLua || (PY ? false : 'no python3') }, () => {
  const ex = readFileSync(here('./access.example.json'), 'utf8');
  const cases = [ex, '{}', '{"owners":{}}', '{"owners":{"a":{"enabled":true,"capabilities":["eyes"],"window":"9:30-17:00"}}}',
    '{"_note":"x","owners":{"a":{"_why":"y","alert":"telegram","lock_minutes":10}}}',
    '{"owners":{"a":{"alert":"email"}}}', '{"owners":{"a":{"apps":[1]}}}', '{"owners":{"a":{"max_arm_minutes":1441}}}',
    '{"owners":{"a":{"window":"20:00-5:00x"}}}', '{"owners":[]}', '{"owners":{"a":{"manual_runs":1}}}'];
  const dir = accessDir();
  cases.forEach((text, i) => {
    const file = join(dir, `p${i}.json`);
    writeFileSync(file, text);
    const py = access(file, 'list').status === 0;
    const lua = drive([`!return port.setPolicy(${JSON.stringify(text)})`])[0];
    assert.equal(py, lua, `disagree on ${text}`);
  });
});

// ---------- init.lua wiring, under a stub `hs` ----------
// late: 'watch' or 'poll' = the access file's folder does not exist at load; the file appears
// afterwards and is seen through the folder watch or the backstop poll.
function smoke(generic, { late, notifyExit } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'hs-smoke-'));
  const cfg = join(d, 'config'), prof = join(d, 'profile', 'hammerspoon');
  mkdirSync(join(cfg, 'local'), { recursive: true });
  if (!late) mkdirSync(prof, { recursive: true });
  mkdirSync(join(d, 'Library', 'Logs'), { recursive: true });
  symlinkSync(here('./init.lua'), join(cfg, 'init.lua'));
  writeFileSync(join(cfg, 'local', 'smoke.lua'),
    'harness.register("smoke.click", function(a) return {clicked = a.x} end, {cap = "hands"})\n');
  const access = join(prof, 'access.json');
  if (!late) writeFileSync(access, '{"owners":{"runner":{"enabled":true,"capabilities":["hands"]}}}');
  writeFileSync(join(d, 'harness.env'), `HS_ACCESS_FILE="${access}"\n${generic === undefined ? '' : `HS_IPC_GENERIC=${generic}\n`}`);
  const r = spawnSync(LUA, [here('./test/init-smoke.lua'), cfg], { encoding: 'utf8',
    env: { ...process.env, HOME: d, HARNESS_ENV: join(d, 'harness.env'), ACCESS_FILE: access,
      LATE: late ?? '', NOTIFY_EXIT: String(notifyExit ?? 0) } });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), log: readFileSync(join(d, 'Library', 'Logs', 'hammerspoon-harness.log'), 'utf8'), access, prof };
}

test('init.lua opens the harness port, loads the access file and local commands, and reloads on change', { skip: skipLua }, () => {
  const { out, log, access } = smoke();
  assert.equal(out.opened, true);
  assert.equal(out.genericClosed, false, 'hs -c stays open by default');
  assert.equal(out.watched, access.replace(/\/access\.json$/, ''));
  assert.equal(out.status.ok, true);
  assert.equal(out.status.result.port.policy, 'ok');
  assert.deepEqual(out.status.result.port.owners.runner.capabilities, ['hands']);
  assert.equal(out.arm.ok, true, JSON.stringify(out.arm));
  assert.deepEqual(out.click, { ok: true, result: { clicked: 2 } });
  assert.deepEqual(out.afterRevoke, { ok: false, error: 'owner disabled in the access policy' });
  assert.ok(out.alerts.some(a => /access policy changed/.test(a)), 'the change is announced');
  assert.ok(out.tasks.some(t => t.some(x => /tg-notify\.py$/.test(x))), 'through the send-only Telegram notifier');
  assert.match(log, /arm owner=runner cmd=arm/);
  assert.match(log, /ok owner=runner cmd=smoke\.click/);
  assert.ok(!log.includes('ab'.repeat(32)), 'no secret in the audit log');
});

for (const late of ['watch', 'poll']) {
  test(`an access file made after load (folder missing too) is picked up through the ${late}`, { skip: skipLua }, () => {
    const { out, prof } = smoke(undefined, { late });
    assert.equal(out.before.result.port.policy, 'no access file');
    assert.equal(out.dirMade, true, 'the policy folder is created at load');
    assert.equal(statSync(prof).mode & 0o777, 0o700, 'the created folder is private');
    assert.equal(out.watched, prof, 'and watched from the start');
    assert.equal(out.status.result.port.policy, 'ok');
    assert.equal(out.arm.ok, true, JSON.stringify(out.arm));
    assert.deepEqual(out.click, { ok: true, result: { clicked: 2 } });
  });
}

test('each alert send is logged with its outcome only, never the text', { skip: skipLua }, () => {
  const ok = smoke();
  assert.match(ok.log, /^\S+ alert via=telegram result=ok$/m);
  const failed = smoke(undefined, { notifyExit: 1 });
  assert.match(failed.log, /^\S+ alert via=telegram result=fail reason=exit-1$/m);
  for (const { log } of [ok, failed]) {
    assert.ok(!/alert.*(policy changed|runner\[)/.test(log), 'no alert text in the log');
  }
});

test('HS_IPC_GENERIC=0 closes the generic hs -c port and leaves the harness port', { skip: skipLua }, () => {
  const { out } = smoke(0);
  assert.equal(out.genericClosed, true);
  assert.equal(out.opened, true);
  assert.equal(out.status.ok, true);
});
