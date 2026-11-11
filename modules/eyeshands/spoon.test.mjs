// node --test modules/eyeshands/spoon.test.mjs   (never touches Hammerspoon, the screen or the input)
// The Spoon skeleton (EyesHands.spoon: init.lua, config.lua, targets.lua, guards.lua and its port.lua)
// runs under a plain Lua 5.4 with a fake hs (test/spoon-driver.lua): config, the guard order, the
// present rule with known and unknown event tags, the foreign hands detectors (fake jobhunt and
// harness tables, read only), the stop switch, target resolution from fake ps output, and the
// Spoon's own port with status, eh.targets and stop. Also checks that the vendored port.lua equals
// the harness file.
// Needs Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); the Lua tests skip without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const skip = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';

// One Lua chunk per line through the driver; one parsed result per chunk. ERROR lines come back as text.
function drive(chunks) {
  const r = spawnSync(LUA, [here('./test/spoon-driver.lua')], {
    input: chunks.map(c => c.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n', encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n').map(l => (l.startsWith('ERROR') ? l : JSON.parse(l)));
}
const ok = out => { for (const o of out) if (typeof o === 'string' && o.startsWith('ERROR')) assert.fail(o); return out; };
const tmp = () => mkdtempSync(join(tmpdir(), 'eh-spoon-'));
const secret = () => randomBytes(32).toString('hex');
const lstr = s => JSON.stringify(s);   // a JSON string is a valid Lua string literal for these values
// A Spoon config for a throwaway folder: own port name, no hotkey, no menu bar.
function cfgFor(dir, extra = '') {
  return `{ port = "eyeshands-test-${randomBytes(4).toString('hex')}", access_file = ${lstr(join(dir, 'access.json'))},
    targets_file = ${lstr(join(dir, 'targets.json'))}, log_file = ${lstr(join(dir, 'eyeshands.log'))},
    stop_hotkey = false, menubar = false ${extra} }`;
}
const ACCESS = JSON.stringify({ owners: { runner: { enabled: true, capabilities: ['eyes', 'hands'], apps: ['chrome-test'] } } });
// A fake harness: functions that record what was called in locals, never in the table itself.
const HARNESS = `TAGS = {}; PORTINFO = { policy = "ok", owners = {} }; AWAKE = { on = false }
  harness = { EVENT_TAG = 0x484E,
    addEventTag = function(t) TAGS[#TAGS + 1] = "add:" .. t; return true end,
    removeEventTag = function(t) TAGS[#TAGS + 1] = "remove:" .. t; return true end,
    portInfo = function() return PORTINFO end, awakeInfo = function() return AWAKE end }`;

test('the vendored EyesHands.spoon/port.lua equals the harness port.lua', () => {
  const a = readFileSync(here('./EyesHands.spoon/port.lua'));
  const b = readFileSync(here('../hammerspoon/port.lua'));
  assert.ok(a.equals(b), 'copy modules/hammerspoon/port.lua to modules/eyeshands/EyesHands.spoon/port.lua');
});

test('config: defaults, ~ expansion, and a bad key or value fails at start', { skip }, () => {
  const [d, mine, typo, badBuf, badKey, noKey, badPort, tags] = drive([
    'return config(nil)', 'return config({ idle_buffer_s = 45, stop_hotkey = false, menubar = false, detectors = {"otherdriver"} })',
    'return select(2, config({ idle_bufer_s = 30 }))', 'return select(2, config({ idle_buffer_s = 0 }))',
    'return select(2, config({ stop_hotkey = { mods = {"hyper"}, key = "x" } }))', 'return select(2, config({ access_file = "relative.json" }))',
    'return select(2, config({ port = "bad name" }))', 'return select(2, config({ machine_tags = { 0x1234 } }))']);
  assert.equal(d.idle_buffer_s, 20);
  assert.equal(d.port, 'eyeshands');
  assert.equal(d.access_file, '/home/test/.config/eyeshands/access.json');
  assert.equal(d.targets_file, '/home/test/.config/eyeshands/targets.json');
  assert.equal(d.log_file, '/home/test/Library/Logs/eyeshands.log');
  assert.equal(d.shot_dir, '/home/test/Library/Caches/eyeshands/shots');
  assert.deepEqual(d.stop_hotkey, { mods: ['ctrl', 'alt', 'cmd'], key: 'escape' });
  assert.equal(d.stop_minutes, 30);
  assert.equal(d.consent_minutes, 10);
  assert.equal(d.menubar, true);
  assert.equal(mine.idle_buffer_s, 45);
  assert.equal(mine.stop_hotkey, false);
  assert.deepEqual(mine.detectors, ['otherdriver']);
  assert.equal(typo, 'unknown config key idle_bufer_s');
  assert.match(badBuf, /^idle_buffer_s: must be a whole number 1-3600/);
  assert.match(badKey, /^stop_hotkey: mods are/);
  assert.match(noKey, /^access_file: must be an absolute path/);
  assert.match(badPort, /^port:/);
  assert.equal(tags, 'unknown config key machine_tags');
});

test('guard order: stop switch, foreign hands, lease, session, present, takeover, focus', { skip }, () => {
  // Every guard fails at first; each step fixes the one that refused, so the next one shows.
  const out = ok(drive([
    `G = guards(); IDLE = 3; SESSION = { CGSSessionScreenIsLocked = true }
     jobhunt = { hands = { status = function() return { armed = true } end } }
     G.stopFor("hotkey")
     CTX = { owner = "runner", targetPid = 7, frontPid = 9,
       lease = function() return LEASED and { ok = false, reason = "lease_held" } or nil end,
       takeover = function() return TOOK and { ok = false, reason = "interrupted" } or nil end }
     LEASED, TOOK = true, true
     SESSION = { locked = true }; return G.check(CTX)`,
    'G.clearStop(); return G.check(CTX)',
    'jobhunt = nil; return G.check(CTX)',
    'LEASED = false; return G.check(CTX)',
    'SESSION = {}; return G.check(CTX)',
    'IDLE = 25; return G.check(CTX)',
    'TOOK = false; return G.check(CTX)',
    'CTX.frontPid = 7; return G.check(CTX) == nil',
  ]));
  assert.deepEqual(out.slice(0, 7).map(r => r.reason),
    ['stopped', 'foreign_hands', 'lease_held', 'locked', 'present', 'interrupted', 'focus']);
  assert.equal(out[7], true, 'all guards pass');
  assert.equal(out[0].by, 'hotkey');
  assert.deepEqual(out[1].by, ['jobhunt']);
  assert.equal(out[1].retry_after_s, 60);
});

test('the session guard: lock, console, display sleep, screen saver; and an away harness that cannot tell our tag', { skip }, () => {
  const out = ok(drive([
    `G = guards(); IDLE = 100; SESSION = { locked = true }; return G.check()`,
    'SESSION = { on_console = false }; return G.check()',
    'SESSION = { display_asleep = true }; return G.check()',
    'SESSION = { screensaver = true }; return G.check()',
    `SESSION = {}; harness = { awakeInfo = function() return { mode = "away" } end }; return G.check() == nil`,
    `G2 = guards({ tagRegistered = function() return false end }); return G2.check()`,
    `harness = { awakeInfo = function() return { mode = "present" } end }; return G2.check() == nil`,
    `G3 = guards({ session = function() error("no session") end }); return G3.check()`,
  ]));
  assert.deepEqual(out.slice(0, 4).map(r => [r.reason, r.why]), [['locked', 'screen locked'],
    ['locked', 'session not on the console'], ['locked', 'display asleep'], ['locked', 'screen saver running']]);
  assert.equal(out[4], true, 'with our tag registered, away mode is no problem');
  assert.equal(out[5].reason, 'awake_away');
  assert.equal(out[6], true);
  assert.equal(out[7].reason, 'locked', 'an unreadable session fails closed');
});

test('present rule: idle_buffer_s (default 20), retry_after_s, and consent', { skip }, () => {
  const out = ok(drive([
    'G = guards(); IDLE = 12; return G.check()',
    'IDLE = 20; return G.check() == nil',
    'IDLE = 2; G.consent(); return G.check() == nil',
    'return G.presentInfo()',
    'T = T + 601; return G.check()',
    'G2 = guards({ idleBuffer = 60 }); IDLE = 45; return G2.check()',
  ]));
  assert.deepEqual(out[0], { ok: false, reason: 'present', human_idle_s: 12, idle_buffer_s: 20, retry_after_s: 8,
    hint: 'ask the person, or wait' });
  assert.equal(out[1], true);
  assert.equal(out[2], true, 'consent lets hands start while the person is present');
  assert.equal(out[3].present, true);
  assert.equal(out[3].idle_buffer_s, 20);
  assert.match(out[3].consent_until, /^\d{4}-\d\d-\d\dT/);
  assert.equal(out[4].reason, 'present', 'consent ends after consent_minutes');
  assert.equal(out[5].retry_after_s, 15);
});

test('present rule with the tap: known machine tags are not a person, any other tag is', { skip }, () => {
  const out = ok(drive([
    'G = guards(); IDLE = 300; G.tap(true); return G.check() == nil',
    `local seen = {}
     for _, tag in ipairs({ 0x45484E44, 0x484E, 0x4A484844 }) do seen[#seen + 1] = G.noteEvent(tag) end
     return seen`,
    'return G.check() == nil',
    'harness = { EVENT_TAG = 0x5555 }; local a = G.noteEvent(0x5555); harness = nil; return { a, G.check() == nil }',
    'T = T + 5; return G.noteEvent(0)',
    'return G.check()',
    'T = T + 20; return G.check() == nil',
    'return G.noteEvent(0x1234)',
    'return G.check()',
    'G.noteEvent(0x99); G.tap(false); IDLE = 400; return G.check() == nil',
  ]));
  assert.equal(out[0], true, 'the tap starts from the hardware idle time');
  assert.deepEqual(out[1], [false, false, false], 'ours, the harness and job-hunt tags are machine input');
  assert.equal(out[2], true);
  assert.deepEqual(out[3], [false, true], 'the harness EVENT_TAG is read from the harness when it is there');
  assert.equal(out[4], true, 'an untagged event is a person');
  assert.equal(out[5].reason, 'present');
  assert.equal(out[5].human_idle_s, 0);
  assert.equal(out[6], true, 'after the idle buffer the person counts as gone');
  assert.equal(out[7], true, 'an unknown tag is a person');
  assert.equal(out[8].reason, 'present');
  assert.equal(out[9], true, 'without the tap the hardware idle time decides');
});

test('foreign hands detectors read jobhunt, the harness port and configured globals, and change nothing', { skip }, () => {
  const out = ok(drive([
    `G = guards({ detectors = { "otherdriver" } }); ${HARNESS}
     JH = { armed = false, busy = false }
     jobhunt = { hands = { status = function() return JH end }, info = function() return "jh" end }
     ORIG = jobhunt.hands.status; BEFORE = snapshot(jobhunt) .. snapshot(harness); return G.foreign()`,
    'JH = { armed = true }; return G.foreign()',
    `JH = '{"armed":false,"busy":3}'; return G.foreign()`,
    `JH = '{"armed":false,"busy":false}'; PORTINFO.owners = {
       ["job-hunt"] = { armed = true, capabilities = { "eyes", "hands" } },
       looker = { armed = true, capabilities = { "eyes" } },
       idle = { armed = false, capabilities = { "hands" } } }; return G.foreign()`,
    'otherdriver = { hands = { status = function() return { busy = 1 } end } }; return G.foreign()',
    'jobhunt.hands.status = function() error("broken") end; return #G.foreign()',
    'jobhunt.hands.status = ORIG; return snapshot(jobhunt) .. snapshot(harness) == BEFORE',
    'jobhunt = setmetatable({}, { __index = function() error("lazy loader ran") end }); return #G.foreign()',
  ]));
  assert.deepEqual(out[0], {});
  assert.deepEqual(out[1], ['jobhunt']);
  assert.deepEqual(out[2], ['jobhunt'], 'JSON text status, busy job');
  assert.deepEqual(out[3], ['harness:job-hunt'], 'only armed owners with hands');
  assert.deepEqual(out[4], ['harness:job-hunt', 'otherdriver']);
  assert.equal(out[5], 2, 'a status() that fails is not a driver');
  assert.equal(out[6], true, 'the detectors wrote nothing into jobhunt or harness');
  assert.equal(out[7], 2, 'rawget only: no metatable runs');
});

test('stop switch: refuses hands for stop_minutes, then ends; clearStop ends it early', { skip }, () => {
  const out = ok(drive([
    'G = guards(); IDLE = 100; return { G.stopFor("menu"), G.stopInfo() }',
    'return G.check()',
    'T = T + 30 * 60 - 1; return G.check().reason',
    'T = T + 1; return { G.check() == nil, G.stopInfo() }',
    'G.stopFor("hotkey"); G.clearStop(); return G.check() == nil',
  ]));
  assert.equal(out[0][0], 1800000000 + 1800);
  assert.equal(out[0][1].stopped, true);
  assert.equal(out[0][1].by, 'menu');
  assert.equal(out[0][1].retry_after_s, 1800);
  assert.equal(out[1].reason, 'stopped');
  assert.equal(out[2], 'stopped');
  assert.deepEqual(out[3], [true, { stopped: false }]);
  assert.equal(out[4], true);
});

test('targets: profile targets resolve from ps by the exact --user-data-dir of a main process', { skip }, () => {
  const file = JSON.stringify({ _comment: 'test', targets: {
    'chrome-agent': { bundle: 'com.google.Chrome', profile: '~/.chrome-agent' },
    'chrome-test': { bundle: 'com.google.Chrome', profile: '/tmp/eh test profile/', refuse_debug_port: true },
    textedit: { bundle: 'com.apple.TextEdit' },
  } });
  const C = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ps = [
    `  101 ${C} --user-data-dir=/home/test/.chrome-agent --remote-debugging-port=9222`,
    `  102 ${C.replace('Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome.app/Contents/Frameworks/Helper')} --type=renderer --user-data-dir=/tmp/eh test profile`,
    `  103 /usr/bin/open -na Google Chrome --args --user-data-dir=/tmp/eh test profile`,
    `  104 ${C} --user-data-dir=/tmp/eh test profile2 --no-first-run`,
    `  105 ${C} --no-first-run --user-data-dir=/tmp/eh test profile/ --no-default-browser-check`,
    '  200 /System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
  ].join('\n');
  const out = ok(drive([
    `PS = ${lstr(ps)}; APPS = { ["com.google.Chrome"] = { { pid = 101 }, { pid = 104 }, { pid = 105 } },
       ["com.apple.TextEdit"] = { { pid = 300 }, { pid = 200 } } }; TG = targets(${lstr(file)})
     return TG.resolve("chrome-agent")`,
    'return TG.resolve("chrome-test")',
    'APPS["com.google.Chrome"][3] = nil; return TG.resolve("chrome-test")',
    'return TG.resolve("textedit")',
    'FRONT = 300; return TG.resolve("textedit").pid',
    'return TG.resolve("com.apple.TextEdit").pid',
    'return TG.resolve("com.apple.Safari")',
    'return TG.resolve("bad name")',
    'APPS["com.google.Chrome"][3] = { pid = 105 }; return TG.list()',
  ]));
  assert.deepEqual(out[0], { ok: true, pid: 101, name: 'chrome-agent', bundle: 'com.google.Chrome', profile: '/home/test/.chrome-agent' });
  assert.equal(out[1].ok, true);
  assert.equal(out[1].pid, 105, 'not the helper, the open line, or the profile2 prefix; trailing slash allowed');
  assert.equal(out[1].profile, '/tmp/eh test profile');
  assert.equal(out[2].reason, 'target_not_running', 'a process that is not a running app never matches');
  assert.deepEqual([out[3].ok, out[3].pid], [true, 200], 'lowest pid when none is frontmost');
  assert.equal(out[4], 300, 'the frontmost instance wins');
  assert.equal(out[5], 300, 'a bundle id works without an alias');
  assert.deepEqual(out[6], { ok: false, reason: 'target_not_running', name: 'com.apple.Safari', bundle: 'com.apple.Safari' });
  assert.equal(out[7].reason, 'bad_target');
  assert.equal(out[8].file, '/cfg/targets.json');
  assert.deepEqual(out[8].targets, [
    { name: 'chrome-agent', bundle: 'com.google.Chrome', profile: '/home/test/.chrome-agent', running: true, pid: 101 },
    { name: 'chrome-test', bundle: 'com.google.Chrome', profile: '/tmp/eh test profile', refuse_debug_port: true, running: true, pid: 105 },
    { name: 'textedit', bundle: 'com.apple.TextEdit', running: true, pid: 300 },
  ]);
});

test('targets: refuse_debug_port, a missing file, and an invalid file (fails closed)', { skip }, () => {
  const file = JSON.stringify({ targets: { 'chrome-test': { bundle: 'com.google.Chrome', profile: '/tmp/p', refuse_debug_port: true } } });
  const out = ok(drive([
    `PS = "  9 /x/Chrome --user-data-dir=/tmp/p --remote-debugging-port=9333"; APPS = { ["com.google.Chrome"] = { { pid = 9 } } }
     return targets(${lstr(file)}).resolve("chrome-test")`,
    'return targets(nil).resolve("com.google.Chrome")',
    'return targets(nil).list()',
    `return targets(${lstr(JSON.stringify({ targets: { x: { bundle: 'com.a.b', profil: '/tmp' } } }))}).resolve("com.google.Chrome")`,
    `return targets(${lstr(JSON.stringify({ targets: { x: { bundle: 'com.a.b', profile: 'rel' } } }))}).list()`,
    `return targets(${lstr(JSON.stringify({ targets: { x: { bundle: 'com.a.b', refuse_debug_port: true } } }))}).fileState()`,
    'return targets("not json").fileState()',
  ]));
  assert.equal(out[0].reason, 'debug_port');
  assert.equal(out[0].pid, 9);
  assert.deepEqual([out[1].ok, out[1].pid], [true, 9], 'no file: bundle ids still resolve');
  assert.deepEqual(out[2], { file: '/cfg/targets.json', state: 'missing', targets: {} });
  assert.deepEqual(out[3], { ok: false, reason: 'targets_invalid', error: 'invalid targets file: x: unknown key profil' });
  assert.match(out[4].error, /x: profile must be an absolute path/);
  assert.match(out[5].error, /refuse_debug_port needs a profile/);
  assert.equal(out[6].error, 'invalid targets file: not a JSON object');
});

test('the Spoon opens its own port, writes no global, never loads hs.ipc, and answers status and eh.targets without a secret', { skip }, () => {
  const dir = tmp();
  writeFileSync(join(dir, 'access.json'), ACCESS);
  writeFileSync(join(dir, 'targets.json'), JSON.stringify({ targets: { 'chrome-test': { bundle: 'com.google.Chrome', profile: '/tmp/p' } } }));
  const k = secret();
  const args = JSON.stringify({ owner: 'runner', secret: k, pid: 4242 });
  const out = ok(drive([
    `${HARNESS}; jobhunt = { hands = { status = function() return { armed = false } end } }
     BEFORE = snapshot(jobhunt) .. snapshot(harness)
     PS = "  9 /x/Chrome --user-data-dir=/tmp/p"; APPS = { ["com.google.Chrome"] = { { pid = 9 } } }
     local s = boot(${cfgFor(dir)}); local n = 0; for _ in pairs(R.ports) do n = n + 1 end
     return { n = n, name = s._s.cfg.port, touched = R.touched, ipc = R.ipcLoaded == true, tags = TAGS }`,
    `return call({ cmd = "status" })`,
    `return call({ cmd = "arm", args = ${lstr(args)} })`,
    `local r = call({ cmd = "status" }); return { r, string.find(snapshot(r), ${lstr(k)}, 1, true) == nil }`,
    `return call({ cmd = "eh.targets" })`,
    `return call({ cmd = "eh.hands.click", owner = "runner", args = "{}" })`,
    `return snapshot(jobhunt) .. snapshot(harness) == BEFORE`,
  ]));
  assert.equal(out[0].n, 1);
  assert.match(out[0].name, /^eyeshands-test-/);
  assert.deepEqual(out[0].touched, {}, 'only the hs pieces the Spoon needs, never hs.ipc');
  assert.equal(out[0].ipc, false);
  assert.deepEqual(out[0].tags, [`add:${0x45484E44}`], 'our tag is registered with the harness');
  const st = out[1];
  assert.equal(st.ok, true);
  assert.equal(st.result.name, 'EyesHands');
  assert.equal(st.result.port_open, true);
  assert.equal(st.result.event_tag, 0x45484E44);
  assert.equal(st.result.tag_registered, true);
  assert.equal(st.result.idle_buffer_s, 20);
  assert.equal(st.result.present.idle_buffer_s, 20);
  assert.equal(st.result.present.present, false);
  assert.deepEqual(st.result.grants, { accessibility: true, screen_recording: false });
  assert.deepEqual(st.result.stop, { stopped: false });
  assert.equal(st.result.access.policy, 'ok');
  assert.equal(st.result.access.owners.runner.armed, false);
  assert.deepEqual(st.result.targets, { file: join(dir, 'targets.json'), state: 'ok', count: 1 });
  assert.equal(out[2].ok, true);
  assert.equal(out[3][0].result.access.owners.runner.armed, true);
  assert.equal(out[3][1], true, 'status never holds the secret');
  assert.deepEqual(out[4].result.targets, [{ name: 'chrome-test', bundle: 'com.google.Chrome', profile: '/tmp/p', running: true, pid: 9 }]);
  assert.deepEqual(out[5], { ok: false, error: 'unsigned call' }, 'hands commands exist and need a signed call');
  assert.equal(out[6], true, 'the Spoon wrote nothing into jobhunt or harness');
  const log = readFileSync(join(dir, 'eyeshands.log'), 'utf8');
  assert.match(log, /arm owner=runner cmd=arm/);
  assert.ok(!log.includes(k), 'the audit log never holds a secret');
});

test('the stop command disarms every owner without a secret; unload closes the port and removes the tag', { skip }, () => {
  const dir = tmp();
  writeFileSync(join(dir, 'access.json'), ACCESS);
  const k = secret();
  const out = ok(drive([
    `${HARNESS}; boot(${cfgFor(dir)}); return call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'runner', secret: k }))} }).ok`,
    `return call({ cmd = "stop" })`,
    `return call({ cmd = "status" }).result.access.owners.runner.armed`,
    `return SPOONOBJ._s.guards.stopInfo()`,
    `local name = SPOONOBJ._s.cfg.port; SPOONOBJ:stop(); local on = 0
     for _, t in ipairs(R.timers) do if t.on then on = on + 1 end end
     return { closed = R.closed[name] == true, timers = on, tags = TAGS, gone = SPOONOBJ._s == nil, status = SPOONOBJ:status() }`,
  ]));
  assert.equal(out[0], true);
  assert.deepEqual(out[1], { ok: true, result: { stopped: true, disarmed: ['runner'] } });
  assert.equal(out[2], false);
  assert.deepEqual(out[3], { stopped: false }, 'the stop command holds no 30-minute refusal; the hotkey does');
  assert.equal(out[4].closed, true);
  assert.equal(out[4].timers, 0);
  assert.deepEqual(out[4].tags, [`add:${0x45484E44}`, `remove:${0x45484E44}`]);
  assert.equal(out[4].gone, true);
  assert.equal(out[4].status.running, false);
});

test('standalone: no harness, no tag registration, and the Spoon still works', { skip }, () => {
  const dir = tmp();
  const out = ok(drive([
    `local s = boot(${cfgFor(dir)}); return call({ cmd = "status" }).result`,
    `return call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'runner', secret: secret() }))} })`,
  ]));
  assert.equal(out[0].harness, false);
  assert.equal(out[0].tag_registered, false);
  assert.equal(out[0].port_open, true);
  assert.equal(out[0].access.policy, 'no access file');
  assert.deepEqual(out[1], { ok: false, error: 'owner not in the access policy' }, 'default deny: no access file allows nothing');
});

test('an access file change applies at once; a late file (and its folder) is picked up', { skip }, () => {
  const dir = join(tmp(), 'later');
  const access = join(dir, 'access.json');
  const out = ok(drive([
    `boot(${cfgFor(dir)}); return call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'runner', secret: secret() }))} }).error`,
    `local f = io.open(${lstr(access)}, "w"); f:write(${lstr(ACCESS)}); f:close(); R.watch({ ${lstr(access)} })
     return call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'runner', secret: secret() }))} }).ok`,
  ]));
  assert.equal(out[0], 'owner not in the access policy');
  assert.equal(out[1], true, 'the folder watch reloads the file');
});

test('the stop hotkey and the menu bar item stop agents and refuse hands for 30 minutes', { skip }, () => {
  const dir = tmp();
  writeFileSync(join(dir, 'access.json'), ACCESS);
  const out = ok(drive([
    `boot({ port = "eyeshands-test-hk", access_file = ${lstr(join(dir, 'access.json'))}, log_file = ${lstr(join(dir, 'l.log'))},
       targets_file = ${lstr(join(dir, 't.json'))} })
     call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'runner', secret: secret() }))} })
     for _, t in ipairs(R.timers) do if t.secs == 5 then t.fn() end end
     return { mods = R.hotkeys[1].mods, key = R.hotkeys[1].key, title = R.menus[1].title }`,
    'R.hotkeys[1].fn(); IDLE = 100; return { SPOONOBJ._s.guards.check(), R.menus[1].title, R.notes }',
    'local items = R.menus[1].items(); local t = {}; for i, x in ipairs(items) do t[i] = x.title end; return t',
    'R.menus[1].items()[4].fn(); return { SPOONOBJ._s.guards.check() == nil, R.menus[1].title }',
    'R.menus[1].items()[2].fn(); return SPOONOBJ._s.guards.stopInfo().by',
    'SPOONOBJ:stop(); return { R.hotkeys[1].deleted, R.menus[1].deleted }',
  ]));
  assert.deepEqual(out[0], { mods: ['ctrl', 'alt', 'cmd'], key: 'escape', title: 'EH eyes' });
  assert.equal(out[1][0].reason, 'stopped');
  assert.equal(out[1][0].by, 'hotkey');
  assert.equal(out[1][1], 'EH stop');
  assert.match(out[1][2][0], /agents stopped \(hotkey\); no new hands for 30 minutes/);
  assert.deepEqual(out[2], ['Eyes & Hands: stopped', 'Stop agents', 'Let agents drive for 10 minutes', 'Allow agents again']);
  assert.deepEqual(out[3], [true, 'EH'], '"Allow agents again" ends the stop; the stop also disarmed the owner');
  assert.equal(out[4], 'menu');
  assert.deepEqual(out[5], [true, true]);
});

test('a port name that is taken is reported, and the Spoon keeps running', { skip }, () => {
  const dir = tmp();
  const out = ok(drive([`PORT_TAKEN = true; boot(${cfgFor(dir)}); return { SPOONOBJ:status().port_open, R.notes }`]));
  assert.equal(out[0][0], false);
  assert.match(out[0][1][0], /could not open the eyeshands-test-\w+ port/);
});
