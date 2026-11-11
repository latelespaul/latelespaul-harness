// node --test modules/eyeshands/hands.test.mjs   (never touches Hammerspoon, the screen or the input)
// The hands (EyesHands.spoon/hands.lua) through the Spoon's own port, under a plain Lua 5.4 with a
// fake hs (test/spoon-driver.lua): the guard order before a job, jobs on the 4 ms timer, the 250 ms
// re-checks, the takeover tap (it only reads) and resume, the lease (one owner, 2 idle minutes,
// disarm), a held button, held keys and the clipboard on abort and unload, the awake hold (harness
// with the caller's pid, released with lock=true; standalone hs.caffeinate), the hold file (a real
// file and real pids: it refuses eyes and hands and ends a running job; the lease takes the driver
// lock in it and removes only its own entry), and the Eyes & Hands tag on every
// posted event. "Posted" here means the fake hs.eventtap recorded it; nothing reaches a Mac.
// Needs Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); the tests skip without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const skip = LUA ? false : 'no Lua 5.4 (brew install lua@5.4)';
const TAG = 0x45484E44;

function drive(chunks) {
  const r = spawnSync(LUA, [here('./test/spoon-driver.lua')], {
    input: chunks.map(c => c.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n', encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trimEnd().split('\n').map(l => (l.startsWith('ERROR') ? l : JSON.parse(l)));
}
const ok = out => { for (const o of out) if (typeof o === 'string' && o.startsWith('ERROR')) assert.fail(o); return out; };
const lstr = s => JSON.stringify(s);
const j = v => lstr(JSON.stringify(v));   // a Lua string literal holding v as JSON text

const ACCESS = JSON.stringify({ owners: {
  runner: { enabled: true, capabilities: ['eyes', 'hands'], apps: ['textedit'] },
  other: { enabled: true, capabilities: ['eyes', 'hands'], apps: ['textedit'] },
  looker: { enabled: true, capabilities: ['eyes'], apps: ['textedit'] },
} });
const TARGETS = JSON.stringify({ targets: { textedit: { bundle: 'com.apple.TextEdit' } } });

// Boots the Spoon in a throwaway folder with a fake harness (or none), the target TextEdit (pid 7,
// frontmost), nobody at the Mac for 600 s, and arms runner (pid 4242) and other (pid 5151).
// hc(owner, cmd, argsJSON) is a signed call; it returns the command's result (or the port error).
function prelude({ harness = true, extra = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eh-hands-'));
  writeFileSync(join(dir, 'access.json'), ACCESS);
  writeFileSync(join(dir, 'targets.json'), TARGETS);
  const keys = { runner: randomBytes(32).toString('hex'), other: randomBytes(32).toString('hex'), looker: randomBytes(32).toString('hex') };
  const fakeHarness = harness ? `AWAKE = {}
    harness = { EVENT_TAG = 0x484E, addEventTag = function() return true end, removeEventTag = function() return true end,
      portInfo = function() return { owners = {} } end, awakeInfo = function() return { mode = "present" } end,
      awake = function(on, o) AWAKE[#AWAKE + 1] = { on = on, owner = o.owner, pid = o.pid, minutes = o.minutes, lock = o.lock }; return "{}" end }` : '';
  const cfg = `{ port = "eyeshands-test-${randomBytes(4).toString('hex')}", access_file = ${lstr(join(dir, 'access.json'))},
    targets_file = ${lstr(join(dir, 'targets.json'))}, log_file = ${lstr(join(dir, 'eyeshands.log'))},
    stop_hotkey = false, menubar = false ${extra} }`;
  const lua = `${fakeHarness}
    APPS = { ["com.apple.TextEdit"] = { { pid = 7 } } }; FRONT = 7; IDLE = 600
    KEYS = { runner = ${lstr(keys.runner)}, other = ${lstr(keys.other)}, looker = ${lstr(keys.looker)} }; SEQ = {}
    boot(${cfg})
    function arm(owner, pid) return call({ cmd = "arm", args = hs.json.encode({ owner = owner, secret = KEYS[owner], pid = pid }) }) end
    function hc(owner, cmd, a)
      SEQ[owner] = (SEQ[owner] or 0) + 1
      local r = signed(KEYS[owner], owner, cmd, a or "{}", SEQ[owner])
      if r.ok then return r.result end
      return r
    end
    function tagged() for _, e in ipairs(POSTED) do if e.tag ~= ${TAG} then return false end end; return #POSTED end
    function kinds(from) local t = {}; for i = from or 1, #POSTED do t[#t + 1] = POSTED[i].type end; return t end
    function sweep() SPOONOBJ._s.hands.sweep() end
    function tapsOn() local n = 0; for _, t in ipairs(TAPS) do if t.on then n = n + 1 end end; return n end
    arm("runner", 4242); arm("other", 5151); arm("looker", 6161)
    return true`;
  return { dir, lua, log: () => readFileSync(join(dir, 'eyeshands.log'), 'utf8') };
}
const T = 'target = "textedit"';
const RECT = [400, 300, 200, 40];

test('the guard order before a job: stopped, foreign_hands, lease_held, locked, present, interrupted, focus; nothing posts', { skip }, () => {
  const p = prelude();
  const click = j({ target: 'textedit', to: { rect: RECT } });
  const out = ok(drive([
    p.lua,
    `SPOONOBJ._s.guards.stopFor("hotkey"); return hc("runner", "eh.hands.click", ${click})`,
    `SPOONOBJ._s.guards.clearStop(); jobhunt = { hands = { status = function() return { armed = true } end } }
     return hc("runner", "eh.hands.click", ${click})`,
    `jobhunt = nil; local r = hc("other", "eh.hands.click", ${click}); run(3000); return { r.state, hc("other", "eh.hands.job", hs.json.encode({ id = r.job })).state, #POSTED }`,
    `POSTED = {}; return hc("runner", "eh.hands.click", ${click})`,
    `hc("other", "disarm"); SESSION = { CGSSessionScreenIsLocked = true }; return hc("runner", "eh.hands.click", ${click})`,
    `SESSION = {}; IDLE = 3; return hc("runner", "eh.hands.click", ${click})`,
    `IDLE = 600; FRONT = 9; return hc("runner", "eh.hands.click", ${click})`,
    `return { #POSTED, tapsOn(), SPOONOBJ:status().hands.lease }`,
    `FRONT = 7; local r = hc("runner", "eh.hands.click", ${click}); return { r.ok, r.state, type(r.job), r.planned_ms > 0 }`,
    `return hc("looker", "eh.hands.click", ${click})`,
  ]));
  assert.equal(out[1].reason, 'stopped');
  assert.equal(out[2].reason, 'foreign_hands');
  assert.deepEqual(out[2].by, ['jobhunt']);
  assert.deepEqual(out[3].slice(0, 2), ['running', 'done']);
  assert.ok(out[3][2] > 10, 'the other owner\'s click posted');
  assert.equal(out[4].reason, 'lease_held');
  assert.equal(out[4].by, 'other');
  assert.equal(out[5].reason, 'locked', 'disarm ended the other lease; the lock refuses next');
  assert.equal(out[6].reason, 'present');
  assert.equal(out[6].retry_after_s, 17);
  assert.equal(out[7].reason, 'focus');
  assert.deepEqual(out[8], [0, 0, false], 'no refused call posted anything, took a lease or started the tap');
  assert.deepEqual(out[9], [true, 'running', 'number', true]);
  assert.deepEqual(out[10], { ok: false, error: 'capability hands not granted' });
});

test('a click job: moves first, then press and release, every event with the Eyes & Hands tag', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `MOUSE = { x = 100, y = 100 }; local r = hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { rect: RECT }, clicks: 2 })})
     JOB = r.job; return r`,
    `run(200); return hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })).state`,
    `run(3000); return hc("runner", "eh.hands.job", hs.json.encode({ id = JOB }))`,
    `return { tagged(), kinds() }`,
    `local d = {}; for _, e in ipairs(POSTED) do if e.type ~= "mouseMoved" then d[#d + 1] = { e.type, e.clicks, e.x >= 400 and e.x <= 600 and e.y >= 300 and e.y <= 340 } end end; return d`,
    `return hc("runner", "eh.hands.job", hs.json.encode({ id = JOB + 1 })).reason`,
    `return hc("other", "eh.hands.job", hs.json.encode({ id = JOB })).reason`,
  ]));
  assert.equal(out[1].state, 'running');
  assert.equal(out[1].ok, true);
  assert.equal(out[2], 'running', 'the job plays on the 4 ms timer, not in the call');
  const rep = out[3];
  assert.equal(rep.state, 'done');
  assert.equal(rep.posted, rep.total);
  assert.equal(rep.ok, true);
  assert.ok(rep.at[0] >= 400 && rep.at[0] <= 600 && rep.at[1] >= 300 && rep.at[1] <= 340, 'ends in the rect');
  const [n, kinds] = out[4];
  assert.equal(n, rep.total, 'every posted event carries the tag');
  const firstDown = kinds.indexOf('leftMouseDown');
  assert.ok(firstDown > 10 && kinds.slice(0, firstDown).every(k => k === 'mouseMoved'), 'mouse moves come before the click');
  assert.deepEqual(out[5], [['leftMouseDown', 1, true], ['leftMouseUp', 1, true], ['leftMouseDown', 2, true], ['leftMouseUp', 2, true]]);
  assert.equal(out[6], 'unknown_job');
  assert.equal(out[7], 'unknown_job', 'a job belongs to its owner');
});

test('type, key, scroll, drag and play post what the planner planned; the paste puts the clipboard back', { skip }, () => {
  const p = prelude();
  const long = 'x'.repeat(320);
  const out = ok(drive([
    p.lua,
    `hc("runner", "eh.hands.type", ${j({ target: 'textedit', text: 'Hi @é' })}); run(5000)
     local t = {}; for _, e in ipairs(POSTED) do if e.type == "keyDown" or e.type == "flagsChanged" then t[#t + 1] = (e.chars or "") .. ":" .. tostring(e.key) .. ":" .. (e.flags or "") end end
     return t`,
    `POSTED = {}; hc("runner", "eh.hands.type", ${j({ target: 'textedit', text: long })}); run(30)
     return { PB.data["public.utf8-plain-text"] == ${lstr(long)}, #POSTED }`,
    `run(3000); return { PB.data["public.utf8-plain-text"], kinds() }`,
    `POSTED = {}; hc("runner", "eh.hands.key", ${j({ target: 'textedit', combo: 'cmd+shift+g' })}); run(2000)
     local t = {}; for _, e in ipairs(POSTED) do t[#t + 1] = e.type .. ":" .. e.key .. ":" .. (e.flags or "") end; return t`,
    `return hc("runner", "eh.hands.key", ${j({ target: 'textedit', combo: 'cmd+hyper+g' })})`,
    `POSTED = {}; hc("runner", "eh.hands.scroll", ${j({ target: 'textedit', dy: 300 })}); run(3000)
     local sum = 0; for _, e in ipairs(POSTED) do sum = sum + e.dy end; return { kinds()[1], sum }`,
    `POSTED = {}; MOUSE = { x = 100, y = 100 }; hc("runner", "eh.hands.drag", ${j({ target: 'textedit', from: { x: 200, y: 200 }, to: { rect: [600, 500, 20, 20] } })}); run(5000)
     local k = kinds(); local d, u = 0, 0
     for i, x in ipairs(k) do if x == "leftMouseDown" then d = i elseif x == "leftMouseUp" then u = i end end
     local dragged = 0; for i = d + 1, u - 1 do if k[i] == "leftMouseDragged" then dragged = dragged + 1 end end
     local last = POSTED[#POSTED]; return { d > 1, dragged > 10, u == #k, last.x >= 600 and last.x <= 620 }`,
    `POSTED = {}; hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'move', x: 300, y: 300, dx: 1, dy: 1 }, { t: 10, type: 'down', x: 300, y: 300, clicks: 1 }, { t: 90, type: 'up', x: 300, y: 300, clicks: 1 }] })}); run(200)
     return { kinds(), tagged() }`,
    `return { hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 5, type: 'move', x: 1, y: 1 }, { t: 1, type: 'move', x: 2, y: 2 }] })}).hint,
       hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'launch' }] })}).hint }`,
    `return { hc("runner", "eh.hands.focus", ${j({ target: 'textedit' })}), ACTIVATED }`,
    `return { tagged(), #POSTED > 0 }`,
  ]));
  assert.deepEqual(out[1], [':56:shift', 'H:4:shift', ':56:', 'i:34:', ' :49:', ':56:shift', '@:19:shift', ':56:', 'é:14:'],
    'a capital and @ inside a real Shift press; é types on its base key with its Unicode string');
  assert.equal(out[2][0], true, 'long text goes on the clipboard');
  assert.equal(out[2][1], 0, 'nothing is typed yet');
  assert.deepEqual(out[3][1], ['flagsChanged', 'keyDown', 'keyUp', 'flagsChanged'], 'then cmd+v');
  assert.equal(out[3][0], 'old clip', 'the old clipboard is back after the paste');
  assert.deepEqual(out[4], ['flagsChanged:55:cmd', 'flagsChanged:56:cmd+shift', 'keyDown:5:cmd+shift', 'keyUp:5:cmd+shift',
    'flagsChanged:56:cmd', 'flagsChanged:55:']);
  assert.equal(out[5].reason, 'bad_args');
  assert.equal(out[5].hint, 'unknown modifier "hyper"');
  assert.deepEqual(out[6], ['scrollWheel', -300], 'wheel ticks sum to the requested pixels (positive dy = page down)');
  assert.deepEqual(out[7], [true, true, true, true], 'press at from, a dragged path, release at to');
  assert.deepEqual(out[8], [['mouseMoved', 'leftMouseDown', 'leftMouseUp'], 3]);
  assert.deepEqual(out[9], ['events out of order at 2', 'bad event 1']);
  assert.deepEqual(out[10][0], { ok: true, focused: true, target: 'textedit', pid: 7 });
  assert.deepEqual(out[10][1], [7]);
  assert.deepEqual(out[11], [out[11][0], true]);
  assert.ok(out[11][0] > 0, 'every posted event carries the tag');
  assert.ok(!p.log().includes('Hi @'), 'typed text never reaches the log');
});

test('takeover: a person stops the job at the next tick, the tap only reads, and hands wait for resume', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `return { tapsOn(), SPOONOBJ:status().hands.watch }`,
    `JOB = hc("runner", "eh.hands.type", ${j({ target: 'textedit', text: 'Hello there, friend' })}).job; run(300)
     return { tapsOn(), SPOONOBJ:status().hands }`,
    `local before = #POSTED; local passed = human("mouseMoved"); return { passed, #POSTED == before }`,
    `run(4); local r = hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })); return { r.state, r.by, r.ok, r.posted < r.total }`,
    `local n = #POSTED; run(2000); return #POSTED == n`,
    `local up = {}; for _, e in ipairs(POSTED) do if e.type == "keyDown" then up[e.key] = (up[e.key] or 0) + 1 elseif e.type == "keyUp" then up[e.key] = (up[e.key] or 0) - 1 end end
     local stuck = 0; for _, v in pairs(up) do if v > 0 then stuck = stuck + 1 end end; return stuck`,
    `return hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { rect: RECT } })})`,
    `return hc("runner", "eh.hands.resume")`,
    `T = T + 21; return hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { rect: RECT } })})`,
    `return hc("runner", "eh.hands.status")`,
    `local r = hc("runner", "eh.hands.resume"); return { r.ok, r.interrupted }`,
    `return hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { rect: RECT } })}).state`,
    `run(3000); human("keyDown", nil, nil, 0, 0, 0x4A484844); run(4); return { SPOONOBJ:status().hands.interrupted, SPOONOBJ:status().present.present }`,
    `return tagged() == #POSTED`,
  ]));
  assert.deepEqual(out[1], [0, 'off'], 'no tap without a lease');
  assert.equal(out[2][0], 1, 'the tap runs while the lease exists');
  assert.equal(out[2][1].lease, 'runner');
  assert.equal(out[2][1].watch, 'tap');
  assert.deepEqual(out[3], [[false], true], 'the tap returns false (the event goes on unchanged) and posts nothing');
  assert.deepEqual(out[4], ['interrupted', 'mouseMoved', false, true]);
  assert.equal(out[5], true, 'nothing posts after the takeover');
  assert.equal(out[6], 0, 'no key is left down');
  assert.equal(out[7].reason, 'present', 'the person was just here: the present rule (from the tap\'s clock) refuses first');
  assert.equal(out[8].reason, 'present', 'resume needs the present rule to pass');
  assert.equal(out[9].reason, 'interrupted', 'after the idle buffer, the takeover still waits for resume');
  assert.equal(out[10].interrupted.by, 'mouseMoved');
  assert.equal(out[10].interrupts, 1);
  assert.deepEqual(out[11], [true, false]);
  assert.equal(out[12], 'running');
  assert.deepEqual(out[13], [true, false], 'a job-hunt event stops our hands, but is not a person');
  assert.equal(out[14], true);
});

test('the 250 ms re-checks end a job as focus or locked; the stop switch aborts it', { skip }, () => {
  const p = prelude();
  const text = j({ target: 'textedit', text: 'a slow sentence to type out' });
  const out = ok(drive([
    p.lua,
    `JOB = hc("runner", "eh.hands.type", ${text}).job; run(100); FRONT = 9; run(260)
     return hc("runner", "eh.hands.job", hs.json.encode({ id = JOB }))`,
    `FRONT = 7; JOB = hc("runner", "eh.hands.type", ${text}).job; run(100); SESSION = { CGSSessionScreenIsLocked = true }; run(260)
     return hc("runner", "eh.hands.job", hs.json.encode({ id = JOB }))`,
    `SESSION = {}; JOB = hc("runner", "eh.hands.type", ${text}).job; run(100); SPOONOBJ:stopAgents("hotkey", true)
     return { SPOONOBJ._s.hands.info(), call({ cmd = "status" }).result.access.owners.runner.armed }`,
    `return { #AWAKE, AWAKE[#AWAKE].on, AWAKE[#AWAKE].lock, tapsOn() }`,
  ]));
  assert.equal(out[1].state, 'focus');
  assert.equal(out[1].hint, 'call hands_focus');
  assert.equal(out[2].state, 'locked');
  assert.equal(out[2].why, 'screen locked');
  assert.deepEqual(out[3][0], { lease: false, busy: false, interrupted: false, watch: 'off', awake: false });
  assert.equal(out[3][1], false, 'the stop switch disarmed the owner');
  assert.deepEqual(out[4], [2, false, true, 0], 'the lease ended: hold released with lock=true, tap off');
});

test('the hold file: a hold refuses hands before any input, a hold that appears ends a running job, status shows it', { skip }, () => {
  const lock = join(mkdtempSync(join(tmpdir(), 'eh-hold-')), 'driver.lock');
  const p = prelude({ extra: `, hold_file = ${lstr(lock)}` });
  const dead = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;   // gone once spawnSync returns
  const ms = s => (1800000000 + s) * 1000;                    // the driver's clock T, in ms
  const manual = until => ({ pid: 0, who: 'captain', since: ms(-60), manual: true, until });
  const click = j({ target: 'textedit', to: { rect: RECT } });
  const text = j({ target: 'textedit', text: 'a slow sentence to type out' });
  const out = ok(drive([
    p.lua,
    `HP = ${lstr(lock)}
     function put(text) local f = assert(io.open(HP, "w")); f:write(text); f:close() end
     return call({ cmd = "status" }).result.hold`,
    `put(${j(manual(ms(600)))}); local r = hc("runner", "eh.hands.click", ${click})
     return { r, #POSTED, SPOONOBJ._s.hands.info().lease, call({ cmd = "status" }).result.hold }`,
    `put(${j({ pid: process.pid, who: 'night run', since: ms(-5) })}); return hc("runner", "eh.hands.focus", ${j({ target: 'textedit' })})`,
    `put(${j({ pid: dead, who: 'refill', since: ms(0), borrowed: manual(ms(600)) })}); local r = hc("runner", "eh.hands.click", ${click})
     return { r.reason, r.kind, r.who }`,
    `put("{not json"); return hc("runner", "eh.hands.click", ${click}).kind`,
    `os.remove(HP); os.execute("mkdir " .. HP); local r = hc("runner", "eh.hands.click", ${click}); os.execute("rmdir " .. HP)
     return { r.reason, r.kind, #POSTED }`,
    `put(${j({ pid: dead, who: 'refill', since: ms(0), borrowed: manual(ms(-10)) })}); local r = hc("runner", "eh.hands.click", ${click})
     run(3000); return { r.state, hc("runner", "eh.hands.job", hs.json.encode({ id = r.job })).state, #POSTED > 10 }`,
    `os.remove(HP); local r = hc("runner", "eh.hands.type", ${text}); JOB = r.job; run(100); local n = #POSTED
     put(${j(manual(ms(600)))}); run(260); local n2 = #POSTED; run(2000)
     return { r.state, n2 > n, #POSTED == n2, hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })) }`,
    `return { SPOONOBJ._s.hands.info().busy, hc("runner", "eh.hands.click", ${click}).reason }`,
  ]));
  assert.deepEqual(out[1], { configured: true, file: lock, held: false, kind: 'missing' }, 'no file is free');
  const [refused, posted, lease, status] = out[2];
  assert.equal(refused.reason, 'held');
  assert.equal(refused.kind, 'manual');
  assert.equal(refused.who, 'captain');
  assert.equal(refused.until, '2027-01-15T08:10:00Z');
  assert.equal(refused.retry_after_s, 600);
  assert.equal(posted, 0, 'nothing posted');
  assert.equal(lease, false, 'no lease taken');
  assert.equal(status.held, true);
  assert.equal(status.kind, 'manual');
  assert.equal(out[3].reason, 'held', 'focus is refused too');
  assert.equal(out[3].kind, 'pid');
  assert.equal(out[3].pid, process.pid);
  assert.deepEqual(out[4], ['held', 'borrowed', 'captain'], 'a dead borrower falls back to the manual hold');
  assert.equal(out[5], 'malformed');
  assert.deepEqual(out[6], ['held', 'unreadable', 0]);
  assert.deepEqual(out[7], ['running', 'done', true], 'a dead borrower of an expired hold: hands run');
  const [state, postedBefore, stopped, job] = out[8];
  assert.equal(state, 'running');
  assert.ok(postedBefore, 'the job posted before the hold appeared');
  assert.ok(stopped, 'nothing posts after the hold appears');
  assert.equal(job.state, 'held');
  assert.equal(job.reason, 'held');
  assert.equal(job.who, 'captain');
  assert.equal(job.kind, 'manual');
  assert.deepEqual(out[9], [false, 'held']);
});

test('the driver lock: the lease takes it when free or stale, a live holder refuses, the caller itself is exempt, only ours is removed', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'eh-lock-'));
  const lock = join(dir, 'driver.lock');
  const p = prelude({ extra: `, hold_file = ${lstr(lock)}` });
  const dead = spawnSync('/bin/sh', ['-c', 'exit 0']).pid;
  const click = j({ target: 'textedit', to: { rect: RECT } });
  const text = j({ target: 'textedit', text: 'a slow sentence to type out' });
  const ours = { pid: 4242, who: 'eyeshands-runner' };
  const out = ok(drive([
    p.lua,
    `HP = ${lstr(lock)}
     function put(text) local f = assert(io.open(HP, "w")); f:write(text); f:close() end
     function raw() local f = io.open(HP); if not f then return false end; local t = f:read("a"); f:close(); return t end
     function get() local t = raw(); return t and hs.json.decode(t) end
     function manual(dt) return hs.json.encode({ pid = 0, who = "captain", since = 1, manual = true, ["until"] = math.floor((T + dt) * 1000) }) end
     function done() run(3000); T = T + 121; sweep(); return raw() end
     return true`,
    `local r = hc("runner", "eh.hands.click", ${click}); return { r.state, get(), done() }`,
    `put(${j({ pid: dead, who: 'refill', since: 5 })}); local r = hc("runner", "eh.hands.click", ${click}); return { r.state, get(), done() }`,
    `put(manual(-10)); local r = hc("runner", "eh.hands.click", ${click}); return { r.state, get(), done() }`,
    `put(${j({ pid: dead, who: 'eyeshands-runner', since: 5 })}); local r = hc("runner", "eh.hands.click", ${click}); return { r.state, get(), done() }`,
    `put(${j({ pid: process.pid, who: 'night run', since: 5 })}); local before, n = raw(), #POSTED
     local r = hc("runner", "eh.hands.click", ${click}); return { r.reason, r.kind, r.hint, raw() == before, #POSTED == n, SPOONOBJ._s.hands.info().lease }`,
    `put(manual(600)); local before = raw()
     return { hc("runner", "eh.hands.focus", ${j({ target: 'textedit' })}).reason, hc("looker", "eh.eyes.frontmost").reason,
       hc("looker", "eh.eyes.value", ${j({ target: 'textedit', id: 'f1' })}).kind, hc("runner", "eh.eyes.text", ${j({ target: "textedit" })}).reason,
       call({ cmd = "status" }).ok, call({ cmd = "eh.targets" }).ok, raw() == before }`,
    `os.remove(HP); local r = hc("runner", "eh.hands.type", ${text}); run(100); local mid = get()
     put(manual(600)); local before = raw(); run(300); local st = hc("runner", "eh.hands.job", hs.json.encode({ id = r.job })).state
     hc("runner", "eh.hands.abort"); local a = raw() == before; T = T + 121; sweep()
     return { mid.who, st, a, raw() == before }`,
    `os.remove(HP); hc("runner", "eh.hands.click", ${click}); run(3000); local mine = get().who
     put(${j({ pid: process.pid, who: 'night run', since: 5 })}); local before = raw(); T = T + 121; sweep(); return { mine, raw() == before }`,
    `os.remove(HP); local r = hc("runner", "eh.hands.type", ${text}); run(100); local mine = get().who
     hc("runner", "eh.hands.abort"); local afterAbort = raw(); local again = hc("runner", "eh.hands.click", ${click}); local retaken = get().who
     run(3000); call({ cmd = "stop" }); return { mine, afterAbort, again.state, retaken, raw() }`,
    `arm("runner", ${process.pid}); put(${j({ pid: process.pid, who: 'job-hunt run', since: 5 })}); local before = raw()
     local r = hc("runner", "eh.hands.click", ${click}); run(3000)
     local e = hc("runner", "eh.eyes.frontmost"); T = T + 121; sweep()
     return { r.state, hc("runner", "eh.hands.job", hs.json.encode({ id = r.job })).state, e.reason or "ok", raw() == before }`,
  ]));
  const since = 1800000000 * 1000;
  assert.deepEqual(out[2], ['running', { ...ours, since }, false], 'no file: the lease writes our entry; its end removes it');
  assert.equal(out[3][0], 'running');
  assert.deepEqual({ pid: out[3][1].pid, who: out[3][1].who }, ours, 'a dead pid is stale: replaced by our entry');
  assert.equal(out[3][2], false);
  assert.deepEqual({ pid: out[4][1].pid, who: out[4][1].who }, ours, 'an expired manual hold is stale');
  assert.equal(out[4][2], false);
  assert.deepEqual({ pid: out[5][1].pid, who: out[5][1].who }, ours, 'a crash (our entry with a dead pid) is stale');
  assert.equal(out[5][0], 'running');
  assert.deepEqual(out[6], ['held', 'pid', 'another driver holds the desktop lock; wait, never force', true, true, false],
    'a live foreign holder refuses; its file does not change; no lease, nothing posted');
  assert.deepEqual(out[7], ['held', 'held', 'manual', 'held', true, true, true],
    'a manual hold refuses focus and every eyes command; status and eh.targets still answer; the file does not change');
  assert.deepEqual(out[8], ['eyeshands-runner', 'held', true, true], 'abort and the lease end leave a manual hold untouched');
  assert.deepEqual(out[9], ['eyeshands-runner', true], 'the lease end leaves a foreign holder untouched');
  assert.deepEqual(out[10], ['eyeshands-runner', false, 'running', 'eyeshands-runner', false],
    'abort removes our entry, the next job takes it again, the stop switch removes it');
  assert.deepEqual(out[11], ['running', 'done', 'ok', true], 'the caller itself holds the lock: no refusal and no write');
  assert.deepEqual(readdirSync(dir), ['driver.lock'], 'no temp or stale file is left');
});

test('lease: one owner at a time; it ends after 2 idle minutes or on disarm, with the awake hold', { skip }, () => {
  const p = prelude();
  const click = j({ target: 'textedit', to: { rect: RECT } });
  const out = ok(drive([
    p.lua,
    `hc("runner", "eh.hands.click", ${click}); run(3000); return AWAKE`,
    `return hc("other", "eh.hands.click", ${click})`,
    `T = T + 119; sweep(); return { SPOONOBJ:status().hands.lease, hc("other", "eh.hands.click", ${click}).reason }`,
    `T = T + 1; sweep(); return { SPOONOBJ:status().hands.lease, AWAKE[2], tapsOn() }`,
    `local r = hc("other", "eh.hands.click", ${click}); run(3000); return { r.state, AWAKE[3] }`,
    `T = T + 60; sweep(); hc("other", "eh.hands.status"); T = T + 100; sweep(); return SPOONOBJ:status().hands.lease`,
    `hc("other", "disarm"); return { SPOONOBJ:status().hands.lease, AWAKE[4] }`,
    `return hc("runner", "eh.hands.status").lease`,
  ]));
  assert.deepEqual(out[1], [{ on: true, owner: 'eyeshands-runner', pid: 4242, minutes: 10 }], 'the hold uses the caller pid from the arm');
  assert.equal(out[2].reason, 'lease_held');
  assert.equal(out[2].by, 'runner');
  assert.deepEqual(out[3], ['runner', 'lease_held'], 'still held at 119 idle seconds');
  assert.deepEqual(out[4], [false, { on: false, owner: 'eyeshands-runner', lock: true }, 0], 'ends at 2 idle minutes');
  assert.deepEqual(out[5], ['running', { on: true, owner: 'eyeshands-other', pid: 5151, minutes: 10 }]);
  assert.equal(out[6], 'other', 'a hands call keeps the lease alive');
  assert.deepEqual(out[7], [false, { on: false, owner: 'eyeshands-other', lock: true }], 'hands_release (disarm) ends it at once');
  assert.equal(out[8], false);
});

test('abort and unload release a held button and keys, and put the clipboard back', { skip }, () => {
  const p = prelude();
  const hold = j({ target: 'textedit', events: [
    { t: 0, type: 'paste', text: 'secret-ish text' },
    { t: 5, type: 'flagsDown', key: 55, flags: 0x100000 },
    { t: 10, type: 'down', x: 300, y: 300, clicks: 1 },
    { t: 5000, type: 'up', x: 300, y: 300, clicks: 1 },
    { t: 5001, type: 'flagsUp', key: 55, flags: 0 },
    { t: 5002, type: 'restore' },
  ] });
  const out = ok(drive([
    p.lua,
    `JOB = hc("runner", "eh.hands.play", ${hold}).job; run(100); return { kinds(), PB.data["public.utf8-plain-text"] }`,
    `local r = hc("runner", "eh.hands.abort"); return { r.state, kinds(), PB.data["public.utf8-plain-text"], POSTED[#POSTED].tag == ${TAG} }`,
    `POSTED = {}; hc("runner", "eh.hands.play", ${hold}); run(100); SPOONOBJ:stop()
     return { kinds(), PB.data["public.utf8-plain-text"], tapsOn(), AWAKE[#AWAKE], tagged() }`,
  ]));
  assert.deepEqual(out[1], [['flagsChanged', 'leftMouseDown'], 'secret-ish text']);
  assert.equal(out[2][0], 'aborted');
  assert.deepEqual(out[2][1], ['flagsChanged', 'leftMouseDown', 'leftMouseUp', 'flagsChanged'], 'the button and cmd are let go');
  assert.equal(out[2][2], 'old clip');
  assert.equal(out[2][3], true);
  assert.deepEqual(out[3][0], ['flagsChanged', 'leftMouseDown', 'leftMouseUp', 'flagsChanged']);
  assert.equal(out[3][1], 'old clip');
  assert.equal(out[3][2], 0, 'unload stops the tap');
  assert.deepEqual(out[3][3], { on: false, owner: 'eyeshands-runner', lock: true });
  assert.equal(out[3][4], 4);
});

test('the clipboard is left alone when something else wrote to it during the paste', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `hc("runner", "eh.hands.type", ${j({ target: 'textedit', text: 'y'.repeat(301) })}); run(30)
     PB.data = { ["public.utf8-plain-text"] = "copied by the person" }; PB.change = PB.change + 1; run(3000)
     return PB.data["public.utf8-plain-text"]`,
  ]));
  assert.equal(out[1], 'copied by the person');
});

test('standalone (no harness): the lease holds hs.caffeinate displayIdle instead', { skip }, () => {
  const p = prelude({ harness: false });
  const out = ok(drive([
    p.lua,
    `hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { x: 500, y: 320 } })}); run(3000); return { CAF, SPOONOBJ:status().hands.awake }`,
    `hc("runner", "disarm"); return CAF`,
  ]));
  assert.deepEqual(out[1], [['displayIdle=true'], 'caffeinate']);
  assert.deepEqual(out[2], ['displayIdle=true', 'displayIdle=false']);
});

test('where to: a field is read again before the plan; off-screen and off-window points are refused', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `SPOONOBJ._s.eyes.value = function(a, owner) SEEN = { a.target, a.id, owner }
       return { ok = true, rect = { 420, 900, 100, 20 }, onscreen = false, viewport = { 0, 100, 1200, 700 } } end
     return { hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { field: 'f3' } })}), SEEN }`,
    `SPOONOBJ._s.eyes.value = function() return { ok = true, rect = { 420, 300, 100, 20 }, onscreen = true } end
     local r = hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { field: 'f3' } })}); run(3000)
     local last = POSTED[#POSTED]; return { r.state, last.x >= 420 and last.x <= 520 }`,
    `SPOONOBJ._s.eyes.value = function() return { ok = false, reason = "unknown_id" } end
     return hc("runner", "eh.hands.move", ${j({ target: 'textedit', to: { field: 'f9' } })}).reason`,
    `WINS[7] = { { 0, 0, 800, 600 } }; return hc("runner", "eh.hands.move", ${j({ target: 'textedit', to: { x: 900, y: 100 } })})`,
    `return hc("runner", "eh.hands.move", ${j({ target: 'textedit', to: { rect: [1, 2, 0, 4] } })}).reason`,
    `return hc("runner", "eh.hands.click", ${j({ target: 'textedit', clicks: 4 })}).hint`,
    `return hc("runner", "eh.hands.move", ${j({ target: 'other-app', to: { x: 1, y: 1 } })})`,
  ]));
  assert.equal(out[1][0].reason, 'offscreen');
  assert.equal(out[1][0].dy, 460, 'the suggested scroll brings the field to the viewport centre');
  assert.deepEqual(out[1][1], ['textedit', 'f3', 'runner']);
  assert.deepEqual(out[2], ['running', true]);
  assert.equal(out[3], 'unknown_id');
  assert.equal(out[4].reason, 'focus');
  assert.equal(out[4].hint, 'the point is not on a target window');
  assert.equal(out[5], 'bad_args');
  assert.equal(out[6], 'clicks must be 1-3');
  assert.deepEqual(out[7], { ok: false, error: 'app other-app not granted' }, 'the port checks the target first');
});

test('hands in awake away mode: refused only when the harness cannot take our tag', { skip }, () => {
  const p = prelude();
  const click = j({ target: 'textedit', to: { rect: RECT } });
  const out = ok(drive([
    p.lua,
    `harness.awakeInfo = function() return { mode = "away" } end; return hc("runner", "eh.hands.click", ${click}).state`,
    `run(3000); SPOONOBJ._s.tagRegistered = false; return hc("runner", "eh.hands.click", ${click}).reason`,
  ]));
  assert.equal(out[1], 'running', 'with addEventTag our events count as machine input');
  assert.equal(out[2], 'awake_away');
});

test('takeover: an untagged zero-delta move and an untagged move at our last posted point both count', { skip }, () => {
  const p = prelude();
  const text = j({ target: 'textedit', text: 'Hello there, friend' });
  const out = ok(drive([
    p.lua,
    `JOB = hc("runner", "eh.hands.type", ${text}).job; run(300); human("mouseMoved", nil, nil, 0, 0); run(4)
     return { hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })).state, SPOONOBJ:status().hands.interrupted }`,
    `T = T + 21; hc("runner", "eh.hands.resume"); POSTED = {}
     JOB = hc("runner", "eh.hands.move", ${j({ target: 'textedit', to: { x: 500, y: 400 } })}).job; run(100)
     local e = POSTED[#POSTED]; human("mouseMoved", e.x, e.y, 0, 0); run(4)
     return { #POSTED > 0, hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })).state, hc("runner", "eh.hands.status").interrupts }`,
  ]));
  assert.deepEqual(out[1], ['interrupted', true]);
  assert.deepEqual(out[2], [true, 'interrupted', 2], 'the second takeover in the same lease');
});

test('play: a point off the target windows is refused as focus with its event index; nothing posts', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `WINS[7] = { { 0, 0, 800, 600 } }
     return { hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'move', x: 300, y: 300 }, { t: 10, type: 'down', x: 900, y: 100 }, { t: 90, type: 'up', x: 900, y: 100 }] })}), #POSTED, tapsOn() }`,
  ]));
  assert.equal(out[1][0].reason, 'focus');
  assert.equal(out[1][0].event, 2);
  assert.deepEqual(out[1][0].at, [900, 100]);
  assert.deepEqual(out[1].slice(1), [0, 0]);
});

test('an unbalanced play that ends done still lets go of the button and the keys', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `JOB = hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'flagsDown', key: 55, flags: 0x100000 }, { t: 5, type: 'down', x: 300, y: 300, clicks: 1 }] })}).job; run(100)
     return { hc("runner", "eh.hands.job", hs.json.encode({ id = JOB })).state, kinds(), tagged() }`,
  ]));
  assert.equal(out[1][0], 'done');
  assert.deepEqual(out[1][1], ['flagsChanged', 'leftMouseDown', 'leftMouseUp', 'flagsChanged']);
  assert.equal(out[1][2], 4);
});

test('a harness without addEventTag that goes away when we take the awake hold: refused, nothing posts', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `SPOONOBJ._s.tagRegistered = false; MODE = "present"
     harness.awakeInfo = function() return { mode = MODE } end
     harness.awake = function(on) MODE = on and "away" or "present"; return "{}" end
     local r = hc("runner", "eh.hands.click", ${j({ target: 'textedit', to: { rect: RECT } })}); run(3000)
     return { r.reason, #POSTED, SPOONOBJ:status().hands.busy, SPOONOBJ:status().hands.lease, tapsOn(), MODE }`,
  ]));
  assert.deepEqual(out[1], ['awake_away', 0, false, false, 0, 'present'], 'the lease this call took ends: tap off, hold released');
});

test('play: a scroll is refused as focus when the cursor it scrolls at is off the target windows', { skip }, () => {
  const p = prelude();
  const out = ok(drive([
    p.lua,
    `WINS[7] = { { 0, 0, 800, 600 } }; MOUSE = { x = 900, y = 100 }
     return { hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'scroll', dy: 400 }] })}), #POSTED }`,
    `return { hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'move', x: 300, y: 300 }, { t: 5, type: 'scroll', dy: 40 }] })}).state, #POSTED > 0 }`,
    `MOUSE = { x = 300, y = 300 }; run(3000)
     return hc("runner", "eh.hands.play", ${j({ target: 'textedit', events: [{ t: 0, type: 'scroll', dy: 40 }, { t: 5, type: 'move', x: 900, y: 100 }] })}).event`,
  ]));
  assert.equal(out[1][0].reason, 'focus');
  assert.equal(out[1][0].event, 1);
  assert.deepEqual(out[1][0].at, [900, 100]);
  assert.equal(out[1][1], 0);
  assert.deepEqual(out[2], ['running', true], 'a scroll after a move on the window plays');
  assert.equal(out[3], 2);
});
