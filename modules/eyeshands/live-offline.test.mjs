// node --test modules/eyeshands/live-offline.test.mjs   (never touches Hammerspoon, the screen or the input)
// The live fixture test (test/live.test.mjs, design part 18) checked offline: the fixture server and
// form, the gate (EYESHANDS_LIVE=1, never CI), the preconditions and their skip reasons (the driver
// hold file with a manual or live hold, job-hunt, the harness port, hcron GUI jobs, the running
// Spoon), the run's test tag on the takeover nudge (registered for the run, removed in the clean-up),
// awake mode away (no skip), the clean-up in its finally, a whole run against a fake world, and the read-only probe
// under a plain Lua 5.4 with a fake hs. Also checks that a default run of test/live.test.mjs skips
// before it starts any process.
// The probe test needs Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); it skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './test/fixture-server.mjs';
import {
  DETECTOR, EVENT_TAG, FILL, GLOBAL, OWNER, SELECT, Skip, TEST_TAG_BASE, UPLOAD, WHO, cleanup, compareFill, eventProblems,
  gate, guiJobsRunning, holdFileFrom, holdReason, judge, lockIsOurs, preflight, runLive, testTagFrom,
} from './test/live-lib.mjs';
import { lua } from './test/live-world.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'eh-live-offline-'));
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);

function http(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------- the fixture ----------
test('fixture server: serves the form on 127.0.0.1 only, keeps the newest report, refuses the rest', async () => {
  const fx = await startFixture();
  try {
    assert.match(fx.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await http(fx.url);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.text, readFileSync(here('./test/fixture/form.html'), 'utf8'));
    assert.equal((await http(fx.url + 'form.html')).status, 200);
    assert.equal((await http(fx.url + '../etc/passwd')).status, 404);
    assert.equal((await http(fx.url + 'report')).status, 404, 'GET /report is not served');

    assert.equal(fx.report(), null);
    const post = b => http(fx.url + 'report', { method: 'POST', body: b, headers: { 'content-type': 'application/json' } });
    assert.equal((await post(JSON.stringify({ seq: 2, values: { name: 'b' } }))).status, 204);
    assert.equal((await post(JSON.stringify({ seq: 1, values: { name: 'a' } }))).status, 204);
    assert.equal(fx.report().seq, 2, 'an older report never replaces a newer one');
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('x'.repeat(4 * 1024 * 1024 + 10)).catch(() => ({ status: 413 }))).status, 413);
    assert.equal(fx.reports(), 2);

    assert.equal((await fx.waitFor(r => r.seq === 2, 200)).values.name, 'b');
    const t0 = Date.now();
    assert.equal(await fx.waitFor(r => r.seq === 9, 150), null);
    assert.ok(Date.now() - t0 >= 140);
  } finally {
    await fx.close();
  }
});

// Runs the page's own script against a small fake DOM in a vm and lets it POST to the real fixture
// server, so the report the server keeps is the one the live test compares (compareFill, eventProblems).
function fakePage(fx) {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, tagName: 'INPUT', value: '', checked: false, files: [], scrollTop: 0, scrollHeight: 0, appendChild() {} });
    return els.get(id);
  };
  const listeners = {};
  const document = {
    getElementById: el,
    createElement: tag => ({ tagName: tag.toUpperCase(), textContent: '' }),
    querySelector: sel => (sel === 'input[name=contact]:checked'
      ? ['contact-mail', 'contact-phone'].map(el).find(e => e.checked) || null : null),
    addEventListener: (type, fn, capture) => { assert.equal(capture, true); (listeners[type] ||= []).push(fn); },
  };
  const fire = (type, id, isTrusted = true) => {
    for (const fn of listeners[type] || []) fn({ type, isTrusted, target: id === 'document' ? document : el(id) });
  };
  const fetch = (path, init) => globalThis.fetch(new URL(path, fx.url), init);
  return { el, fire, listeners, sandbox: { document, fetch, setTimeout, JSON } };
}

test('fixture form: its script reports every field, the radio, the box, the file and a trusted event log', async () => {
  const fx = await startFixture();
  try {
    const html = (await http(fx.url)).text;
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    const page = fakePage(fx);
    runInNewContext(script, page.sandbox);
    for (const t of ['mousemove', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'input', 'change', 'focusin']) {
      assert.ok(page.listeners[t]?.length, `listens for ${t}`);
    }
    const first = await fx.waitFor(r => r.seq === 1, 2000);
    assert.ok(first, 'the page reports once on load');
    assert.deepEqual(first.log, []);

    for (const [id, v] of Object.entries(FILL)) page.el(id).value = v;
    page.el(SELECT.id).value = SELECT.value;
    page.el('contact-mail').value = 'mail';
    page.el('contact-phone').value = 'phone';
    page.el('contact-phone').checked = true;
    page.el('agree').checked = true;
    page.el('upload').files = [{ name: UPLOAD.name, size: Buffer.byteLength(UPLOAD.text) }];
    page.fire('mousemove', 'document');
    page.fire('mousemove', 'name');
    page.fire('mousedown', 'name');
    page.fire('mouseup', 'name');
    page.fire('input', 'name');

    const r = await fx.waitFor(x => x.seq >= 2, 2000);
    assert.ok(r, 'a change sends a new report');
    const ax = [
      ...[...Object.keys(FILL), SELECT.id].map(id => ({ dom: id, value: r.values[id] })),
      { dom: 'contact-phone', checked: true }, { dom: 'agree', checked: true },
    ];
    assert.deepEqual(compareFill(r, ax), []);
    assert.deepEqual(r.log.map(e => [e.type, e.id, e.n]), [['mousemove', 'name', 2], ['mousedown', 'name', 1], ['mouseup', 'name', 1], ['input', 'name', 1]]);
    assert.deepEqual(eventProblems(r.log), []);

    page.fire('click', 'agree', false);
    const u = await fx.waitFor(x => x.log.some(e => e.type === 'click'), 2000);
    assert.deepEqual(eventProblems(u.log), ['an untrusted click on agree']);
  } finally {
    await fx.close();
  }
});

// ---------- the gate ----------
test('gate: never on CI, only with EYESHANDS_LIVE=1, only on macOS', () => {
  assert.match(gate({ CI: 'true', EYESHANDS_LIVE: '1' }, 'darwin'), /CI is set/);
  assert.match(gate({ CI: '1' }, 'darwin'), /CI is set/);
  assert.match(gate({}, 'darwin'), /EYESHANDS_LIVE=1/);
  assert.match(gate({ EYESHANDS_LIVE: 'yes' }, 'darwin'), /EYESHANDS_LIVE=1/);
  assert.match(gate({ EYESHANDS_LIVE: '1' }, 'linux'), /macOS/);
  assert.equal(gate({ EYESHANDS_LIVE: '1' }, 'darwin'), null);
});

test('a default run of test/live.test.mjs skips and starts no process (no EYESHANDS_LIVE, or CI set)', () => {
  const dir = tmp();
  const log = join(dir, 'calls.log');
  for (const name of ['hs', 'hcron', 'open', 'osascript']) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 1\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(log, '');
  const base = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  delete base.NODE_TEST_CONTEXT;
  delete base.EYESHANDS_LIVE;
  delete base.CI;
  for (const env of [base, { ...base, CI: '1', EYESHANDS_LIVE: '1' }, { ...base, CI: 'true' }]) {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', here('./test/live.test.mjs')], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# skipped 1/);
    assert.match(r.stdout, /# fail 0/);
    assert.match(r.stdout, env.CI ? /CI is set/ : /set EYESHANDS_LIVE=1/);
  }
  assert.equal(readFileSync(log, 'utf8'), '', 'a skipped run calls no hs, hcron, open or osascript');
});

// ---------- the preconditions ----------
// A probe where every precondition holds.
const goodProbe = (over = {}) => ({
  grants: { accessibility: true, screen_recording: true }, session: { locked: false, on_console: true }, idle_s: 30,
  awake: { on: false }, add_event_tag: true, foreign: {}, jobhunt: { loaded: true, info: '{"state":"idle"}' },
  production: { running: true, port: 'eyeshands', armed: {}, hold_file: '/locks/driver.lock', tag_registered: true },
  hold: { configured: true, file: '/locks/driver.lock', held: false, kind: 'missing' }, test_loaded: false, ...over,
});

test('holdFileFrom: EYESHANDS_HOLD_FILE, else the running Spoon hold_file; none or two different is a skip', () => {
  assert.equal(holdFileFrom({ EYESHANDS_HOLD_FILE: '/a/lock' }, null), '/a/lock');
  assert.equal(holdFileFrom({ EYESHANDS_HOLD_FILE: '~/x/lock', HOME: '/home/t' }, null), '/home/t/x/lock');
  assert.equal(holdFileFrom({}, goodProbe()), '/locks/driver.lock');
  assert.equal(holdFileFrom({ EYESHANDS_HOLD_FILE: '/locks/driver.lock' }, goodProbe()), '/locks/driver.lock');
  assert.throws(() => holdFileFrom({ EYESHANDS_HOLD_FILE: 'rel/lock' }, null), e => e instanceof Skip && /absolute/.test(e.message));
  assert.throws(() => holdFileFrom({ EYESHANDS_HOLD_FILE: '/b/lock' }, goodProbe()), e => e instanceof Skip && /one driver lock/.test(e.message));
  assert.throws(() => holdFileFrom({}, goodProbe({ production: { running: false } })), e => e instanceof Skip && /no driver hold file/.test(e.message));
  assert.throws(() => holdFileFrom({}, null), e => e instanceof Skip && /EYESHANDS_HOLD_FILE/.test(e.message));
});

test('holdReason: a manual hold, a live pid, a borrowed hold and a bad file skip; no file or a stale one is free', () => {
  const f = '/locks/driver.lock';
  assert.equal(holdReason({ configured: true, held: false, kind: 'missing' }, f), null);
  assert.equal(holdReason({ configured: true, held: false, kind: 'free', pid: 99 }, f), null);
  assert.match(holdReason({ configured: true, held: true, kind: 'manual', who: 'me', until: '2026-11-14T10:00:00Z' }, f),
    /a manual hold \(me\) until 2026-11-14T10:00:00Z; wait for it to end, never force/);
  assert.match(holdReason({ configured: true, held: true, kind: 'pid', pid: 4242, who: 'job-hunt' }, f), /a live driver, pid 4242 \(job-hunt\)/);
  assert.match(holdReason({ configured: true, held: true, kind: 'borrowed', who: 'me' }, f), /a borrowed manual hold/);
  assert.match(holdReason({ configured: true, held: true, kind: 'malformed' }, f), /cannot be read \(it counts as held\)/);
  assert.match(holdReason({ configured: true, held: true, kind: 'unreadable' }, f), /cannot be read/);
  assert.match(holdReason(null, f), /was not judged/);
});

test('guiJobsRunning: only RUNNING jobs that need the GUI, from `hcron status`', () => {
  const text = [
    'jobs: /p/cron/jobs.json',
    '  jobhunt-apply          */20 * * * *     08:00-23:00  next 11/14/2026, 9:20:00 AM  RUNNING pid 4242 since 3m ago  needs gui  awake',
    '  nightly-sync           0 3 * * *        any time     next 11/15/2026, 3:00:00 AM  RUNNING pid 777 since 1m ago',
    '⏸ ui-check               0 * * * *        any time     next 11/14/2026, 10:00:00 AM  last 0 1h ago  needs unlocked,gui  awake',
    '  ui-other               0 * * * *        any time     next 11/14/2026, 10:00:00 AM  RUNNING pid 9 since 5s ago  needs unlocked,gui  awake',
    'screen unlocked · gui ok (via hammerspoon)',
  ].join('\n');
  assert.deepEqual(guiJobsRunning(text), ['jobhunt-apply', 'ui-other']);
  assert.deepEqual(guiJobsRunning(null), []);
});

test('judge: each precondition in order, with its reason; a clean probe passes', () => {
  const opts = { hcron: '', holdFile: '/locks/driver.lock' };
  assert.equal(judge(goodProbe(), opts), null);
  const cases = [
    [null, /does not answer `hs -c`/],
    [goodProbe({ grants: { accessibility: false } }), /no Accessibility/],
    [goodProbe({ grants: { accessibility: true, screen_recording: false } }), /no Screen Recording/],
    [goodProbe({ session: { locked: true } }), /screen is locked/],
    [goodProbe({ session: { on_console: false } }), /not on the console/],
    [goodProbe({ awake: { on: true, mode: 'present' }, add_event_tag: false }), /no addEventTag/],
    [goodProbe({ foreign: ['jobhunt'] }), /job-hunt holds its hands/],
    [goodProbe({ foreign: ['harness:harness-session'] }), /harness port has an armed hands owner \(harness:harness-session\)/],
    [goodProbe({ foreign: ['otherdriver'] }), /another driver holds hands/],
    [goodProbe({ production: { running: true, lease: 'harness-session' } }), /running Eyes & Hands Spoon is in use/],
    [goodProbe({ production: { running: true, busy: 7 } }), /in use \(lease -, job 7\)/],
    [goodProbe({ production: { running: true, armed: ['harness-session'] } }), /armed hands owner \(harness-session\)/],
    [goodProbe({ test_loaded: true }), new RegExp(`${GLOBAL} is still loaded`)],
    [goodProbe({ hold: { configured: true, held: true, kind: 'manual', who: 'me' } }), /manual hold \(me\)/],
    [goodProbe({ hold: { configured: true, held: true, kind: 'pid', pid: 51 } }), /live driver, pid 51/],
  ];
  for (const [probe, want] of cases) assert.match(judge(probe, opts), want, JSON.stringify(probe));
  assert.match(judge(goodProbe(), { hcron: '  jh  * * * * *  any time  next x  RUNNING pid 5 since 1s ago  needs gui', holdFile: '/l' }), /hcron runs a --needs gui job \(jh\)/);
  assert.equal(judge(goodProbe({ awake: { on: true, mode: 'present' } }), opts), null, 'awake mode present is fine');
  assert.equal(judge(goodProbe({ awake: { on: true, mode: 'away', owners: ['x'] } }), opts), null, 'awake mode away is fine: the nudge carries a registered tag');
  assert.equal(judge(goodProbe({ awake: undefined, add_event_tag: false }), opts), null, 'no harness awake mode: no tag needed');
  assert.equal(judge(goodProbe({ production: { running: false } }), opts), null);
  // job-hunt wins over a held lock: the first failing check names the reason.
  assert.match(judge(goodProbe({ foreign: ['jobhunt'], hold: { configured: true, held: true, kind: 'manual' } }), opts), /job-hunt/);
});

// ---------- a fake world ----------
// What a run touches, recorded; `over` replaces any part. The session answers like the test Spoon:
// jobs run for a few polls, the nudge interrupts the running job, the present rule holds for the
// idle buffer after it, the fake detector refuses foreign_hands, and the stop command disarms.
function fakeWorld(over = {}) {
  const calls = [];
  const files = new Map();
  const st = { t: 1_800_000_000_000, idle: 30, armed: false, lease: false, interrupted: false, presentUntil: 0, detector: false,
    job: 0, jobs: new Map(), alive: new Set(), loaded: false, fxClosed: false, rm: [], probe: goodProbe(), tags: new Set() };
  const SESSION_PID = 5151;
  const record = (name, ...a) => calls.push([name, ...a]);
  const fieldsOk = () => [
    ...Object.entries(FILL).map(([dom, value], i) => ({ id: `f${i}`, dom, value, onscreen: true })),
    { id: 'fs', dom: SELECT.id, value: SELECT.label }, { id: 'fr', dom: 'contact-phone', checked: true },
    { id: 'fa', dom: 'agree', checked: true }, { id: 'fu', dom: 'upload' },
  ];
  const report = {
    seq: 9, values: { ...FILL, [SELECT.id]: SELECT.value }, contact: 'phone', agree: true,
    file: { name: UPLOAD.name, size: Buffer.byteLength(UPLOAD.text) },
    log: [{ type: 'mousemove', id: 'name', trusted: true, n: 4 }, { type: 'mousedown', id: 'name', trusted: true },
      { type: 'mouseup', id: 'name', trusted: true }, { type: 'click', id: 'name', trusted: true }],
  };
  const INPUT = new Set(['eh.hands.click', 'eh.hands.type', 'eh.hands.key', 'eh.hands.move', 'eh.hands.scroll']);
  const session = {
    pid: SESSION_PID, who: WHO,
    call: async (cmd, args) => {
      record('call', cmd);
      if (!st.armed) return { ok: false, error: 'not armed' };
      const ok = result => ({ ok: true, result });
      if (cmd === 'eh.hands.status') return ok({ ok: true, lease: st.lease ? OWNER : false, interrupted: st.interrupted });
      if (cmd === 'eh.hands.focus') {
        st.lease = true;
        files.set(world.holdFile, JSON.stringify({ pid: SESSION_PID, who: WHO, since: 1234 }));
        return ok({ ok: true, focused: true });
      }
      if (cmd === 'eh.eyes.fields') return ok({ ok: true, fields: fieldsOk() });
      if (cmd === 'eh.eyes.dialog') return ok({ open: true });
      if (INPUT.has(cmd)) {
        if (st.detector) return ok({ ok: false, reason: 'foreign_hands', by: [DETECTOR] });
        if (st.interrupted || st.t < st.presentUntil) return ok({ ok: false, reason: 'present' });
        st.job += 1;
        st.jobs.set(st.job, { state: 'running', polls: 2 });
        return ok({ ok: true, job: st.job, state: 'running' });
      }
      if (cmd === 'eh.hands.job') {
        const j = st.jobs.get(args.id);
        if (j.state === 'running' && --j.polls <= 0) j.state = 'done';
        return ok({ ok: j.state === 'done' || j.state === 'running', job: args.id, state: j.state, reason: j.state === 'interrupted' ? 'interrupted' : undefined });
      }
      if (cmd === 'eh.hands.resume') {
        if (st.interrupted && st.t < st.presentUntil) return ok({ ok: false, reason: 'present' });
        st.interrupted = false;
        return ok({ ok: true, interrupted: false });
      }
      if (cmd === 'eh.hands.abort') return ok({ ok: true, aborted: false });
      return { ok: false, error: `unknown ${cmd}` };
    },
    // A disarm ends the lease, and the Spoon drops its own lock entry (guards.holdDrop).
    close: async () => {
      record('session.close');
      st.armed = false; st.lease = false;
      if (lockIsOurs(files.get(world.holdFile), SESSION_PID)) files.delete(world.holdFile);
    },
  };
  const world = {
    env: { EYESHANDS_HOLD_FILE: '/locks/driver.lock' },
    holdFile: '/locks/driver.lock',
    log: m => record('log', m),
    now: () => st.t,
    sleep: async ms => { st.t += ms; },
    probe: async holdFile => { record('probe', holdFile); return { ...st.probe, idle_s: st.idle }; },
    hcronStatus: async () => '',
    mkTemp: async () => { record('mkTemp'); return '/tmp/eh-live-x'; },
    mkdir: async p => record('mkdir', p),
    writeFile: async (p, text) => { record('writeFile', p); files.set(p, text); },
    readFile: async p => (files.has(p) ? files.get(p) : null),
    unlink: async p => { record('unlink', p); files.delete(p); },
    rmTemp: async d => { record('rmTemp', d); st.rm.push(d); },
    startFixture: async () => {
      record('startFixture');
      return { url: 'http://127.0.0.1:1/', report: () => report, waitFor: async pred => (pred(report) ? report : null),
        close: async () => { st.fxClosed = true; record('fixture.close'); } };
    },
    portName: () => 'eyeshands-test-abcd',
    loadSpoon: async cfg => { record('loadSpoon', cfg); st.loaded = true; },
    unloadSpoon: async opts => { record('unloadSpoon', opts); st.loaded = false; return { gone: true }; },
    portOpen: async () => st.loaded,
    testStatus: async () => ({ running: true, hands: { lease: st.lease ? OWNER : false, busy: false } }),
    setDetector: async on => { record('setDetector', on); st.detector = on; },
    random24: async () => 0xabcdef,
    addEventTag: async tag => { record('addEventTag', tag); st.tags.add(tag); return { ok: true }; },
    removeEventTag: async tag => { record('removeEventTag', tag); st.tags.delete(tag); return { ok: true }; },
    // The harness's view: the nudge's tag is machine input only while it is registered.
    nudge: async tag => {
      record('nudge', tag, tag != null && st.tags.has(tag));
      for (const j of st.jobs.values()) if (j.state === 'running') j.state = 'interrupted';
      st.interrupted = true;
      st.presentUntil = st.t + 20000;
    },
    releaseAwake: async who => record('releaseAwake', who),
    startChrome: async (profile, url) => { record('startChrome', profile, url); st.alive.add(4242); },
    chromePids: async () => [...st.alive],
    ownsProfile: async pid => st.alive.has(pid),
    kill: async (pid, sig) => { record('kill', pid, sig); st.alive.delete(pid); },
    openSession: async port => { record('openSession', port); st.armed = true; return session; },
    stopCommand: async port => {
      record('stop', port);
      st.armed = false; st.lease = false;
      for (const j of st.jobs.values()) if (j.state === 'running') j.state = 'aborted';
      files.delete(world.holdFile);
      return { stopped: true, disarmed: [OWNER] };
    },
    ...over,
  };
  return { world, calls, files, st, session, names: () => calls.map(c => c[0]) };
}

test('runLive: a whole run against a fake world passes, takes the driver lock and cleans up', async () => {
  const f = fakeWorld();
  const out = await runLive(f.world);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(out.problems, []);
  assert.equal(out.measured.driver_lock, true);
  assert.equal(out.measured.present_refusal, true);
  assert.equal(out.measured.tagged_resets_idle, false);
  const load = f.calls.find(c => c[0] === 'loadSpoon')[1];
  assert.equal(load.holdFile, '/locks/driver.lock', 'the test Spoon gets the driver lock as its hold file');
  assert.equal(load.port, 'eyeshands-test-abcd');
  const access = JSON.parse(f.files.get('/tmp/eh-live-x/access.json'));
  assert.deepEqual(Object.keys(access.owners), [OWNER]);
  assert.deepEqual(access.owners[OWNER].apps, ['chrome-test']);
  const targets = JSON.parse(f.files.get('/tmp/eh-live-x/targets.json'));
  assert.equal(targets.targets['chrome-test'].profile, '/tmp/eh-live-x/chrome-profile');
  assert.equal(targets.targets['chrome-test'].refuse_debug_port, true);
  // The order: focus (the lock) before any input, the nudge, then the fake detector, then stop.
  const n = f.names();
  const cmds = f.calls.filter(c => c[0] === 'call').map(c => c[1]);
  assert.ok(cmds.indexOf('eh.hands.focus') < cmds.indexOf('eh.hands.click'));
  assert.ok(n.indexOf('nudge') < n.indexOf('setDetector'));
  assert.ok(n.indexOf('setDetector') < n.indexOf('stop'));
  // The clean-up: session, Spoon (with the event tag restored), Chrome by pid, fixture, folder.
  assert.deepEqual(f.calls.find(c => c[0] === 'unloadSpoon')[1], { restoreTag: true });
  assert.deepEqual(f.calls.filter(c => c[0] === 'kill'), [['kill', 4242, 'SIGTERM']]);
  assert.equal(f.st.fxClosed, true);
  assert.deepEqual(f.st.rm, ['/tmp/eh-live-x']);
  assert.equal(f.files.has('/locks/driver.lock'), false);
  assert.ok(f.calls.some(c => c[0] === 'log' && /Hands off the mouse and keyboard/.test(c[1])));
});

test('runLive: the nudge carries the run\'s test tag, registered for the run and removed in the clean-up', async () => {
  const f = fakeWorld();
  const out = await runLive(f.world);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  const tag = testTagFrom(0xabcdef);
  assert.equal(tag, TEST_TAG_BASE + 0xabcdef);
  assert.notEqual(tag, EVENT_TAG, 'never the Spoon\'s own tag');
  assert.notEqual(tag, 0x484e, 'never harness.EVENT_TAG');
  assert.notEqual(tag, 0x4a484844, 'never job-hunt\'s tag');
  assert.deepEqual(f.calls.filter(c => c[0] === 'nudge'), [['nudge', tag, true]], 'one nudge, with the tag registered at that time');
  assert.deepEqual(f.calls.filter(c => c[0] === 'addEventTag'), [['addEventTag', tag]]);
  assert.deepEqual(f.calls.filter(c => c[0] === 'removeEventTag'), [['removeEventTag', tag]]);
  assert.equal(f.st.tags.size, 0, 'the clean-up removed the test tag');
  const n = f.names();
  assert.ok(n.indexOf('addEventTag') < n.indexOf('mkTemp'), 'registered before the run makes anything');
  assert.ok(n.indexOf('nudge') < n.indexOf('removeEventTag'));
  assert.ok(n.indexOf('removeEventTag') < n.indexOf('unloadSpoon'));
  // With no harness (no awake mode, no addEventTag), the nudge goes untagged and nothing is registered.
  const g = fakeWorld();
  g.st.probe = goodProbe({ awake: undefined, add_event_tag: false });
  assert.equal((await runLive(g.world)).status, 'pass');
  assert.deepEqual(g.calls.filter(c => c[0] === 'nudge'), [['nudge', undefined, false]]);
  assert.ok(!g.names().includes('addEventTag') && !g.names().includes('removeEventTag'));
});

test('runLive: the test tag is removed in the clean-up when a step throws, and when the add itself fails', async () => {
  // A step throws after the tag was registered (the takeover's typing job).
  let f = fakeWorld();
  const call = f.session.call;
  let nudged = false;
  const nudge = f.world.nudge;
  f.world.nudge = async tag => { nudged = true; return nudge(tag); };
  f.session.call = async (cmd, args) => {
    if (nudged && cmd === 'eh.hands.job') throw new Error('port gone');
    return call(cmd, args);
  };
  let out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /port gone/);
  assert.equal(f.st.tags.size, 0);
  assert.deepEqual(f.calls.filter(c => c[0] === 'removeEventTag'), [['removeEventTag', testTagFrom(0xabcdef)]]);
  assert.ok(f.names().includes('unloadSpoon'));

  // An early failure (the Spoon does not load) still removes it.
  f = fakeWorld({ loadSpoon: async () => { throw new Error('boom'); } });
  out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.equal(f.st.tags.size, 0);
  assert.ok(f.names().includes('removeEventTag'));

  // The add throws half-way: the remove still runs, and the run fails.
  f = fakeWorld({ addEventTag: async tag => { f.st.tags.add(tag); throw new Error('hs -c failed'); } });
  out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /hs -c failed/);
  assert.equal(f.st.tags.size, 0);
  assert.ok(!f.names().includes('mkTemp'));

  // The harness refuses the tag: a skip that makes nothing (the remove is harmless).
  f = fakeWorld({ addEventTag: async () => ({ ok: false, why: 'event tag must be an integer' }) });
  out = await runLive(f.world);
  assert.equal(out.status, 'skip');
  assert.match(out.reason, /addEventTag refused the test tag: event tag must be an integer/);
  assert.ok(!f.names().includes('mkTemp') && !f.names().includes('loadSpoon'));

  // A refused remove is a clean-up problem: the run fails with it.
  f = fakeWorld({ removeEventTag: async () => ({ ok: false, why: 'no harness.removeEventTag' }) });
  out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.ok(out.problems.some(p => /clean-up tag: harness.removeEventTag refused the test tag: no harness.removeEventTag/.test(p)), out.problems.join('\n'));
});

test('runLive: awake mode away no longer skips, before or during the run', async () => {
  let f = fakeWorld();
  f.st.probe = goodProbe({ awake: { on: true, mode: 'away', owners: ['eh-live-test'] } });
  let out = await runLive(f.world);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.deepEqual(f.calls.filter(c => c[0] === 'nudge'), [['nudge', testTagFrom(0xabcdef), true]]);

  // Awake mode switches to away mid-run (nobody touched the Mac for 5 min): the run goes on.
  f = fakeWorld();
  const nudge = f.world.nudge;
  f.world.nudge = async tag => { f.st.probe = goodProbe({ awake: { on: true, mode: 'away', owners: ['x'] } }); return nudge(tag); };
  out = await runLive(f.world);
  assert.equal(out.status, 'pass', JSON.stringify(out));
  assert.equal(out.measured.present_refusal, true, 'the takeover was still exercised');
});

test('runLive: a precondition skip touches nothing (no folder, Spoon, Chrome or session)', async () => {
  const f = fakeWorld();
  f.st.probe = goodProbe({ hold: { configured: true, held: true, kind: 'manual', who: 'me', until: '2026-11-14T12:00:00Z' } });
  const out = await runLive(f.world);
  assert.equal(out.status, 'skip');
  assert.match(out.reason, /manual hold \(me\)/);
  assert.deepEqual(out.problems, []);
  const n = f.names();
  for (const name of ['addEventTag', 'removeEventTag', 'mkTemp', 'loadSpoon', 'unloadSpoon', 'startChrome', 'openSession', 'kill', 'rmTemp', 'setDetector', 'startFixture']) {
    assert.ok(!n.includes(name), `${name} after a skip`);
  }
});

test('preflight: a live driver in the hold file, job-hunt or someone at the Mac skips; it waits for the idle buffer', async () => {
  let f = fakeWorld();
  f.st.probe = goodProbe({ hold: { configured: true, held: true, kind: 'pid', pid: 4242, who: 'job-hunt' } });
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /live driver, pid 4242/.test(e.message));

  f = fakeWorld();
  f.st.probe = goodProbe({ foreign: ['jobhunt'] });
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /job-hunt/.test(e.message));

  f = fakeWorld({ hcronStatus: async () => '  jh  * * * * *  any time  next x  RUNNING pid 5 since 1s ago  needs gui  awake' });
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /hcron runs a --needs gui job \(jh\)/.test(e.message));

  f = fakeWorld({ hcronStatus: async () => { throw new Error('no profile'); } });
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /cannot read hcron status \(no profile\)/.test(e.message));

  f = fakeWorld({ probe: async () => { throw new Error('hs -c failed'); } });
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /does not answer `hs -c`/.test(e.message));

  f = fakeWorld();
  f.st.idle = 3;
  await assert.rejects(preflight(f.world, { idleTimeoutS: 5 }), e => e instanceof Skip && /someone is using the Mac \(idle 3 s, need 20 s\)/.test(e.message));

  // The person leaves after a few seconds: the run goes on.
  f = fakeWorld();
  f.st.idle = 3;
  const sleep = f.world.sleep;
  f.world.sleep = async ms => { await sleep(ms); f.st.idle += ms / 1000 * 4; };
  const pre = await preflight(f.world);
  assert.equal(pre.holdFile, '/locks/driver.lock');

  // The hold file is judged again after the wait.
  f = fakeWorld();
  f.st.idle = 3;
  f.world.sleep = async () => { f.st.idle = 60; f.st.probe = goodProbe({ hold: { configured: true, held: true, kind: 'manual' } }); };
  await assert.rejects(preflight(f.world), e => e instanceof Skip && /manual hold/.test(e.message));
});

test('runLive: job-hunt arming during the run aborts the job, ends inconclusive and still cleans up', async () => {
  const f = fakeWorld();
  let probes = 0;
  const probe = f.world.probe;
  f.world.probe = async h => {
    const p = await probe(h);
    probes += 1;
    return f.st.armed && probes > 12 ? { ...p, foreign: ['jobhunt'] } : p;
  };
  const out = await runLive(f.world);
  assert.equal(out.status, 'inconclusive', JSON.stringify(out));
  assert.equal(out.reason, 'inconclusive: job-hunt started');
  assert.deepEqual(out.problems, [], 'the jobhunt.info() check is skipped once job-hunt started');
  const cmds = f.calls.filter(c => c[0] === 'call').map(c => c[1]);
  assert.ok(cmds.includes('eh.hands.abort'));
  assert.ok(f.names().includes('unloadSpoon'));
  assert.ok(f.names().includes('session.close'));
  assert.deepEqual(f.st.rm, ['/tmp/eh-live-x']);
});

test('runLive: a real takeover during the fill ends inconclusive, not failed', async () => {
  const f = fakeWorld();
  const call = f.session.call;
  let clicks = 0;
  f.session.call = async (cmd, args) => {
    const rep = await call(cmd, args);
    if (cmd === 'eh.hands.click' && ++clicks === 3) { const j = f.st.jobs.get(rep.result.job); j.state = 'interrupted'; }
    return rep;
  };
  const out = await runLive(f.world);
  assert.equal(out.status, 'inconclusive');
  assert.match(out.reason, /a person took over/);
});

test('runLive: a hands lease that did not take the driver lock fails; a failed Spoon start is still unloaded', async () => {
  let f = fakeWorld();
  const call = f.session.call;
  f.session.call = async (cmd, args) => {
    const rep = await call(cmd, args);
    if (cmd === 'eh.hands.focus') f.files.delete('/locks/driver.lock');
    return rep;
  };
  let out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /did not take the driver lock/);

  f = fakeWorld({ loadSpoon: async () => { throw new Error('boom'); } });
  out = await runLive(f.world);
  assert.equal(out.status, 'fail');
  assert.match(out.reason, /boom/);
  assert.ok(f.names().includes('unloadSpoon'), 'a start that failed half-way is unloaded');
  assert.ok(!f.names().includes('startChrome'));

  // hands_focus refused held (another driver took the lock first): inconclusive.
  f = fakeWorld();
  f.session.call = async (cmd, args) => (cmd === 'eh.hands.focus'
    ? { ok: true, result: { ok: false, reason: 'held', kind: 'pid' } } : call.call(null, cmd, args));
  out = await runLive(f.world);
  assert.equal(out.status, 'inconclusive');
  assert.match(out.reason, /hands_focus refused held \(pid\)/);
});

// ---------- the clean-up ----------
test('cleanup: every step runs even when one throws; only the run\'s own lock entry and Chrome are touched', async () => {
  const f = fakeWorld({
    unloadSpoon: async () => { throw new Error('hs gone'); },
    chromePids: async () => [4242, 777],
    ownsProfile: async pid => f.st.alive.has(pid) && pid === 4242,
  });
  f.st.alive = new Set([4242, 777]);
  f.st.armed = true;
  f.session.close = async () => { f.calls.push(['session.close']); };   // a Spoon that cannot drop its lock
  f.files.set('/locks/driver.lock', JSON.stringify({ pid: 5151, who: WHO, since: 1234 }));
  const st = { loaded: true, session: f.session, holdFile: '/locks/driver.lock', lockEntry: { pid: 5151, who: WHO, since: 1234 },
    port: 'eyeshands-test-abcd', profile: '/tmp/eh-live-x/chrome-profile', chromePid: 4242, dir: '/tmp/eh-live-x',
    fx: { close: async () => { f.st.fxClosed = true; } }, jobhuntBefore: '{"state":"idle"}', restoreTag: false };
  const problems = await cleanup(f.world, st);
  assert.ok(problems.some(p => /clean-up spoon: hs gone/.test(p)), problems.join('\n'));
  assert.ok(problems.some(p => /driver lock entry was left; removed it/.test(p)));
  assert.equal(f.files.has('/locks/driver.lock'), false);
  assert.deepEqual(f.calls.filter(c => c[0] === 'kill'), [['kill', 4242, 'SIGTERM']], 'pid 777 is not the run\'s Chrome');
  assert.equal(f.st.fxClosed, true);
  assert.deepEqual(f.st.rm, ['/tmp/eh-live-x']);
  const n = f.names();
  assert.ok(n.indexOf('session.close') < n.indexOf('kill'));
});

test('cleanup: a foreign or manual lock is never removed; a Chrome that ignores SIGTERM gets SIGKILL', async () => {
  const f = fakeWorld({ kill: async (pid, sig) => { f.calls.push(['kill', pid, sig]); if (sig === 'SIGKILL') f.st.alive.delete(pid); } });
  f.st.alive = new Set([4242]);
  f.session.close = async () => {};
  for (const other of [{ pid: 4242, who: 'job-hunt', since: 1 }, { pid: 0, who: 'me', since: 1, manual: true }, { pid: 5151, who: WHO, since: 99 }]) {
    f.files.set('/locks/driver.lock', JSON.stringify(other));
    await cleanup(f.world, { session: f.session, holdFile: '/locks/driver.lock', lockEntry: { pid: 5151, who: WHO, since: 1234 } });
    assert.ok(f.files.has('/locks/driver.lock'), JSON.stringify(other));
  }
  const problems = await cleanup(f.world, { profile: '/tmp/eh-live-x/chrome-profile', chromePid: 4242 });
  assert.deepEqual(problems, []);
  assert.deepEqual(f.calls.filter(c => c[0] === 'kill').map(c => c[2]), ['SIGTERM', 'SIGKILL']);
});

test('cleanup: a left Spoon, an open port, a left awake hold and a changed jobhunt.info() are problems', async () => {
  const f = fakeWorld({ unloadSpoon: async () => ({ gone: false }), portOpen: async () => true });
  f.st.probe = goodProbe({ awake: { on: true, mode: 'present', owners: [WHO] }, jobhunt: { info: '{"state":"armed"}' } });
  const problems = await cleanup(f.world, { loaded: true, port: 'eyeshands-test-abcd', jobhuntBefore: '{"state":"idle"}', restoreTag: true });
  assert.ok(problems.some(p => /__eyeshands_test is still loaded/.test(p)));
  assert.ok(problems.some(p => /port eyeshands-test-abcd still answers/.test(p)));
  assert.ok(problems.some(p => /awake hold eyeshands-eh-live-test was left; released it/.test(p)));
  assert.ok(problems.some(p => /jobhunt.info\(\) changed/.test(p)));
  assert.deepEqual(f.calls.find(c => c[0] === 'releaseAwake'), ['releaseAwake', WHO]);
  // Nothing loaded (a skip): no Spoon, awake or jobhunt step.
  const g = fakeWorld();
  assert.deepEqual(await cleanup(g.world, {}), []);
  assert.ok(!g.names().includes('unloadSpoon') && !g.names().includes('probe'));
});

// ---------- the fill checks ----------
test('compareFill and eventProblems: AX and DOM agree, trusted events, a move before each mousedown', () => {
  const values = { ...FILL, [SELECT.id]: SELECT.value };
  const fields = [...Object.entries(FILL).map(([dom, value]) => ({ dom, value })), { dom: 'size', value: 'Medium' },
    { dom: 'contact-phone', checked: true }, { dom: 'agree', checked: true }];
  const good = { values, contact: 'phone', agree: true, file: { name: UPLOAD.name, size: Buffer.byteLength(UPLOAD.text) } };
  assert.deepEqual(compareFill(good, fields), []);
  const bad = compareFill({ ...good, values: { ...values, email: 'x' }, agree: false, file: null },
    fields.map(f => (f.dom === 'name' ? { ...f, value: 'Ada' } : f)));
  assert.ok(bad.some(p => /DOM email is "x"/.test(p)));
  assert.ok(bad.some(p => /AX email is/.test(p)));
  assert.ok(bad.some(p => /AX name is "Ada"/.test(p)));
  assert.ok(bad.some(p => /DOM agree is not checked/.test(p)));
  assert.ok(bad.some(p => /DOM file is null/.test(p)));
  assert.deepEqual(compareFill(null, []), ['the page sent no report']);

  const log = [{ type: 'mousemove', trusted: true }, { type: 'mousedown', id: 'a', trusted: true }, { type: 'mouseup', trusted: true },
    { type: 'mousemove', trusted: true }, { type: 'mousedown', id: 'b', trusted: true }];
  assert.deepEqual(eventProblems(log), []);
  assert.deepEqual(eventProblems([...log, { type: 'mousedown', id: 'c', trusted: true }, { type: 'keydown', id: 'c', trusted: false }]),
    ['a mousedown on c with no mouse move before it', 'an untrusted keydown on c']);
});

test('lockIsOurs: only the exact pid and who of the run', () => {
  assert.equal(lockIsOurs(JSON.stringify({ pid: 5, who: WHO, since: 1 }), 5), true);
  assert.equal(lockIsOurs(JSON.stringify({ pid: 6, who: WHO }), 5), false);
  assert.equal(lockIsOurs(JSON.stringify({ pid: 5, who: 'job-hunt' }), 5), false);
  assert.equal(lockIsOurs('5', 5), false);
  assert.equal(lockIsOurs(null, 5), false);
  assert.equal(lockIsOurs('{bad', 5), false);
});

test('lua(): quotes paths as Lua string literals and refuses control characters', () => {
  assert.equal(lua('/a/b "c" \\d'), '"/a/b \\"c\\" \\\\d"');
  assert.throws(() => lua('a\nb'));
});

// ---------- the probe (Lua) ----------
test('live-probe.lua: reads grants, session, job-hunt, the harness port, the running Spoon and the hold file; writes nothing', { skip: LUA ? false : 'no Lua 5.4 (brew install lua@5.4)' }, () => {
  const dir = tmp();
  const hold = join(dir, 'driver.lock');
  writeFileSync(hold, JSON.stringify({ pid: 0, who: 'me', since: 1700000000000, manual: true }));
  const chunk = `
    local fakes = dofile(${JSON.stringify(here('../hammerspoon/test/fakes.lua'))})
    hs = { accessibilityState = function() return true end, screenRecordingState = function() return false end,
      caffeinate = { sessionProperties = function() return { CGSSessionScreenIsLocked = false } end },
      host = { idleTime = function() return 42 end }, timer = { secondsSinceEpoch = function() return 1800000000 end },
      json = fakes.json }
    local INFO = 0
    jobhunt = { hands = { status = function() return '{"armed":false,"busy":false}' end },
      info = function() INFO = INFO + 1; return { state = "idle" } end }
    harness = { addEventTag = function() error("no write") end, EVENT_TAG = 0x484E,
      awakeInfo = function() return { on = true, mode = "present", owners = { "x" } } end,
      portInfo = function() return { owners = { ["harness-session"] = { armed = true, capabilities = { "eyes", "hands" } },
        reader = { armed = true, capabilities = { "eyes" } } } } end }
    spoon = { EyesHands = { _s = {}, status = function() return { running = true, port = "eyeshands",
      hands = { lease = false, busy = false }, tag_registered = true, hold = { file = ${JSON.stringify(hold)} },
      access = { owners = { ["harness-session"] = { armed = true, capabilities = { "hands" } }, idle = { armed = false, capabilities = { "hands" } } } } } end } }
    local before = {}
    for k in pairs(_G) do before[k] = true end
    local out = dofile(${JSON.stringify(here('./test/live-probe.lua'))})({ spoon = ${JSON.stringify(here('./EyesHands.spoon'))},
      hold_file = ${JSON.stringify(hold)} })
    for k in pairs(_G) do if not before[k] then error("the probe wrote the global " .. tostring(k)) end end
    out.info_calls = INFO
    print(fakes.json.encode(out))`;
  const r = spawnSync(LUA, ['-e', chunk], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.deepEqual(p.grants, { accessibility: true, screen_recording: false });
  assert.deepEqual(p.session, { locked: false, on_console: true });
  assert.equal(p.idle_s, 42);
  assert.deepEqual(p.awake, { on: true, mode: 'present', owners: ['x'] });
  assert.equal(p.add_event_tag, true);
  assert.deepEqual(p.foreign, ['harness:harness-session'], 'job-hunt is not armed; an eyes-only owner is no driver');
  assert.deepEqual(p.jobhunt, { loaded: true, info: '{"state":"idle"}' });
  assert.equal(p.info_calls, 1);
  assert.deepEqual(p.production, { running: true, port: 'eyeshands', armed: ['harness-session'], hold_file: hold, tag_registered: true });
  assert.equal(p.hold.held, true);
  assert.equal(p.hold.kind, 'manual');
  assert.equal(p.hold.who, 'me');
  assert.equal(p.test_loaded, false);
  assert.match(judge(p, { hcron: '', holdFile: hold }), /no Screen Recording/);
  assert.match(judge({ ...p, grants: { accessibility: true } }, { hcron: '', holdFile: hold }), /harness port has an armed hands owner/);
});
