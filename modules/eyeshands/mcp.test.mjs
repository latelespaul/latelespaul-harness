// node --test modules/eyeshands/mcp.test.mjs   (never touches Hammerspoon, the real ports or any agent config)
// `eyeshands mcp --owner O` (part 14 of docs/eyes-hands-design.md) end to end: a scripted MCP client speaks
// JSON-RPC over the server's stdio, and a fake Eyes & Hands port (test/fake-eh-port.py: a real CFMessagePort
// with the arm, HMAC and seq rules of port.lua) records every envelope. Covers the handshake and the 22 tool
// schemas, no arm before the first signed call, owner_in_use without an arm, one re-arm after a restart,
// disarm when stdin closes, the per-URL wall guard, the kept interrupt count, and the eyes_shot image cap.
// Every run uses a throwaway HOME, port name and access file. Needs python3; skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const CLI = here('./bin/eyeshands');
const FAKE = here('./test/fake-eh-port.py');
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const skip = PY ? false : 'no python3';

const tmp = () => mkdtempSync(join(tmpdir(), 'eh-mcp-'));
const portName = () => `eyeshands-test-${randomBytes(4).toString('hex')}`;

const EYES = ['eyes_status', 'eyes_targets', 'eyes_fields', 'eyes_value', 'eyes_text', 'eyes_focused', 'eyes_dialog',
  'eyes_tree', 'eyes_frontmost', 'eyes_pixels', 'eyes_shot'];
const HANDS = ['hands_focus', 'hands_move', 'hands_click', 'hands_type', 'hands_key', 'hands_scroll', 'hands_drag',
  'hands_status', 'hands_resume', 'hands_abort', 'hands_release'];

async function fakePort(conf) {
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
    log: () => readFileSync(logFile, 'utf8').trimEnd().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    stop: () => child.kill(),
  };
}
const cmds = log => log.filter(e => e.cmd).map(e => e.cmd);
const handsCmds = log => cmds(log).filter(c => c.startsWith('eh.hands.'));
const targetsConf = rows => ({ file: '/tmp/targets.json', state: 'ok', targets: rows });
const TARGETS = targetsConf([
  { name: 'chrome-test', bundle: 'com.example.browser', running: true },
  { name: 'chrome-other', bundle: 'com.example.browser', profile: '/tmp/eh-other-profile', running: true },
  { name: 'chrome-agent', bundle: 'com.example.browser', profile: '/tmp/eh-agent-profile', running: true },
  { name: 'notes-test', bundle: 'com.example.notes', running: true },
  { name: 'textedit', bundle: 'com.apple.TextEdit', running: true }]);

// A scripted MCP client: starts `eyeshands mcp`, sends one JSON-RPC message per line, matches replies by id.
function client(port, { owner = 'runner', dir = tmp() } = {}) {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const env = { ...process.env, HOME: join(dir, 'home'), HARNESS_ENV: join(dir, 'no-harness.env'),
    EYESHANDS_ACCESS_FILE: join(dir, 'access.json'), EYESHANDS_PORT: port };
  const child = spawn(CLI, ['mcp', '--owner', owner], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', stderr = '', nextId = 0;
  const waiting = new Map(), lines = [];
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const send = obj => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params) => {
    const id = ++nextId;
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
      waiting.set(id, m => { clearTimeout(t); resolve(m); });
    });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    return p;
  };
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    assert.ok(r.result, JSON.stringify(r));
    const text = r.result.content.find(c => c.type === 'text');
    return { isError: r.result.isError, json: JSON.parse(text.text), content: r.result.content };
  };
  const init = async () => {
    const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  };
  const close = async () => { child.stdin.end(); return exited; };
  return { send, request, call, init, close, lines, stderr: () => stderr, kill: () => child.kill() };
}

test('initialize and tools/list answer at once with 22 tools, each with a JSON Schema, and no arm', { skip }, async () => {
  const f = await fakePort({});
  const c = client(f.name);
  try {
    const init = await c.init();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, 'eyeshands');
    assert.equal((await c.request('ping')).result && true, true);
    const { result } = await c.request('tools/list');
    const names = result.tools.map(t => t.name);
    assert.equal(names.length, 22);
    assert.deepEqual([...names].sort(), [...EYES, ...HANDS].sort());
    for (const t of result.tools) {
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      assert.ok(t.description.length > 40, t.name);
      for (const k of ['oneOf', 'anyOf', 'allOf']) assert.ok(!(k in t.inputSchema), `${t.name}: no top-level ${k}`);
      const needsTarget = !['eyes_status', 'eyes_targets', 'eyes_frontmost', 'hands_status', 'hands_resume', 'hands_abort', 'hands_release'].includes(t.name);
      assert.equal((t.inputSchema.required || []).includes('target'), needsTarget, `${t.name} target`);
    }
    // Hints per tool: eyes and hands_status only read; the tools that act on the target window are destructive.
    const acts = ['hands_move', 'hands_click', 'hands_type', 'hands_key', 'hands_scroll', 'hands_drag', 'hands_focus', 'hands_resume'];
    const hints = Object.fromEntries(result.tools.map(t => [t.name, t.annotations]));
    for (const n of [...EYES, 'hands_status']) assert.equal(hints[n].readOnlyHint, true, `${n} readOnlyHint`);
    for (const n of acts) {
      assert.equal(hints[n].readOnlyHint, false, `${n} readOnlyHint`);
      assert.equal(hints[n].destructiveHint, true, `${n} destructiveHint`);
      assert.equal(hints[n].openWorldHint, true, `${n} openWorldHint`);
    }
    for (const n of ['hands_abort', 'hands_release']) assert.equal(hints[n].readOnlyHint, false, `${n} readOnlyHint`);
    // Guard rules are in the descriptions.
    const d = Object.fromEntries(result.tools.map(t => [t.name, t.description]));
    for (const n of ['hands_move', 'hands_click', 'hands_type', 'hands_key', 'hands_scroll', 'hands_drag']) {
      for (const want of [/present/, /interrupted/, /foreign_hands/, /lease_held/, /held =/, /wall/, /locked/, /hands capability/]) assert.match(d[n], want, n);
    }
    assert.match(d.eyes_fields, /eyes capability/);
    assert.match(d.eyes_shot, /shot capabilities/);
    assert.match(d.eyes_shot, /1568/);
    assert.match(d.hands_status, /until hands_release/);
    assert.match(d.hands_status, /3 interruptions/);
    assert.deepEqual(result.tools.find(t => t.name === 'hands_click').inputSchema.properties.to.oneOf.map(o => o.required), [['field'], ['rect'], ['x', 'y']]);
    // Unknown methods and tools are JSON-RPC errors; a notification gets no reply.
    assert.equal((await c.request('resources/list')).error.code, -32601);
    assert.equal((await c.request('tools/call', { name: 'eyes_explode', arguments: {} })).error.code, -32602);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    assert.equal(await c.close(), 0);
    assert.equal(c.lines.length, 5, 'one line per request, none for notifications');
    assert.deepEqual(cmds(f.log()), [], 'nothing reached the port: no status, no arm, no disarm');
  } finally { c.kill(); f.stop(); }
});

test('initialize and tools/list work with no Hammerspoon at all', { skip }, async () => {
  const c = client(portName());
  try {
    assert.ok((await c.init()).result);
    assert.equal((await c.request('tools/list')).result.tools.length, 22);
    const r = await c.call('eyes_fields', { target: 'textedit' });
    assert.equal(r.isError, true);
    assert.match(r.json.error, /^unreachable/);
    assert.match(r.json.hint, /eyeshands doctor/);
    assert.equal(await c.close(), 0);
  } finally { c.kill(); }
});

test('lazy arm: status reads need no arm; the first signed call reads status, arms once; EOF disarms', { skip }, async () => {
  const f = await fakePort({});
  const c = client(f.name);
  try {
    await c.init();
    const st = await c.call('eyes_status');
    assert.equal(st.isError, false);
    assert.deepEqual(st.json.mcp, { owner: 'runner', armed: false, interrupts: 0 });
    assert.equal((await c.call('eyes_targets')).isError, false);
    assert.deepEqual(cmds(f.log()), ['status', 'eh.targets'], 'unsigned reads, no arm');
    const r = await c.call('eyes_fields', { target: 'textedit', match: { label: 'Email' } });
    assert.equal(r.isError, false);
    assert.deepEqual(r.json.args, { target: 'textedit', match: { label: 'Email' } });
    await c.call('eyes_focused', { target: 'textedit' });
    let log = f.log();
    assert.deepEqual(cmds(log), ['status', 'eh.targets', 'status', 'arm', 'eh.eyes.fields', 'eh.eyes.focused']);
    const arm = JSON.parse(log[3].args);
    assert.equal(arm.owner, 'runner');
    assert.match(arm.secret, /^[0-9a-f]{64}$/);
    assert.equal(typeof arm.pid, 'number');
    assert.ok(!('minutes' in arm), 'no --minutes: the policy decides how long');
    assert.equal(await c.close(), 0);
    log = f.log();
    assert.equal(cmds(log).at(-1), 'disarm', 'stdin closed: disarm');
    const seqs = log.filter(e => 'seq' in e).map(e => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'one signer: seq always rises');
    assert.ok(!c.stderr().includes(arm.secret) && !c.lines.join('\n').includes(arm.secret), 'the secret stays inside port messages');
  } finally { c.kill(); f.stop(); }
});

test('an owner that another session holds gets owner_in_use and no arm', { skip }, async () => {
  const f = await fakePort({ status: { name: 'EyesHands', running: true, access: { policy: 'ok', owners: { runner: { enabled: true, armed: true } } } } });
  const c = client(f.name);
  try {
    await c.init();
    const r = await c.call('hands_click', { target: 'textedit', to: { x: 1, y: 2 } });
    assert.equal(r.isError, true);
    assert.equal(r.json.reason, 'owner_in_use');
    assert.match(r.json.hint, /own owner name/);
    assert.equal(await c.close(), 0);
    assert.deepEqual(cmds(f.log()), ['status'], 'no arm (no false alarm) and nothing to disarm');
  } finally { c.kill(); f.stop(); }
});

test('after a Hammerspoon restart the server arms again, once, and the call goes through', { skip }, async () => {
  const flag = join(tmp(), 'restart');
  const f = await fakePort({ restart_flag: flag });
  const c = client(f.name);
  try {
    await c.init();
    assert.equal((await c.call('eyes_text', { target: 'textedit' })).isError, false);
    writeFileSync(flag, '');   // the fake drops every arm, as a restarted Hammerspoon holds none
    const r = await c.call('eyes_text', { target: 'textedit' });
    assert.equal(r.isError, false, JSON.stringify(r.json));
    const log = f.log();
    assert.deepEqual(log.map(e => e.cmd || e.event),
      ['status', 'arm', 'eh.eyes.text', 'eh.eyes.text', 'restart', 'status', 'arm', 'eh.eyes.text']);   // the fake logs, then restarts
    assert.notEqual(JSON.parse(log[1].args).secret, JSON.parse(log[6].args).secret, 'a new secret');
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('a port that keeps saying not armed gets exactly one re-arm per call', { skip }, async () => {
  const f = await fakePort({ forget_arms: true });
  const c = client(f.name);
  try {
    await c.init();
    const r = await c.call('eyes_value', { target: 'textedit', id: 'f1' });
    assert.equal(r.isError, true);
    assert.equal(r.json.error, 'not armed');
    assert.deepEqual(cmds(f.log()), ['status', 'arm', 'eh.eyes.value', 'status', 'arm', 'eh.eyes.value']);
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('wall guard: after eyes_text shows a wall, hands on that URL refuse until a new eyes_text shows none', { skip }, async () => {
  const A = 'https://example.test/apply', B = 'https://example.test/next';
  const f = await fakePort({ job_polls: 1, targets: TARGETS, text_seq: [
    { url: A, lines: ['Please verify you are human'] },
    { url: A, lines: ['Email', 'Submit'] },
    { url: A, frames: ['https://www.google.com/recaptcha/api2/anchor'] },
    { url: B, lines: ['Thanks'] },
  ] });
  const c = client(f.name);
  try {
    await c.init();
    const t1 = await c.call('eyes_text', { target: 'chrome-test' });
    assert.deepEqual(t1.json.wall, ['human']);
    const before = handsCmds(f.log()).length;
    for (const [name, args] of [['hands_click', { to: { field: 'f1' } }], ['hands_type', { text: 'x' }], ['hands_key', { combo: 'tab' }],
      ['hands_scroll', { dy: 100 }], ['hands_move', { to: { x: 1, y: 1 } }], ['hands_drag', { from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }]]) {
      const r = await c.call(name, { target: 'chrome-test', ...args });
      assert.equal(r.isError, true, name);
      assert.equal(r.json.reason, 'wall', name);
      assert.deepEqual(r.json.wall, ['human']);
      assert.equal(r.json.url, A);
      assert.match(r.json.hint, /eyes_shot/);
    }
    assert.equal(handsCmds(f.log()).length, before, 'the refused hands reached no port');
    // hands on another target and hands without input are not walled
    assert.equal((await c.call('hands_status')).isError, false);
    assert.equal((await c.call('hands_click', { target: 'textedit', to: { x: 1, y: 1 } })).isError, false);
    // a new eyes_text on the same URL with no wall lifts the mark
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, []);
    const ok = await c.call('hands_click', { target: 'chrome-test', to: { field: 'f1' } });
    assert.equal(ok.isError, false);
    assert.equal(ok.json.state, 'done');
    // a wall again, then the page moves on to another URL without one
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, ['recaptcha']);
    assert.equal((await c.call('hands_key', { target: 'chrome-test', combo: 'enter' })).json.reason, 'wall');
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, []);
    assert.equal((await c.call('hands_key', { target: 'chrome-test', combo: 'enter' })).isError, false);
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('wall guard: every spelling of one window shares its mark, and a clean eyes_text through either lifts it', { skip }, async () => {
  const A = 'https://example.test/apply';
  const f = await fakePort({ job_polls: 1, targets: TARGETS,
    text_seq: [{ url: A, lines: ['Please verify you are human'] }, { url: A, lines: ['Email'] }] });
  const c = client(f.name);
  try {
    await c.init();
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, ['human']);
    const before = handsCmds(f.log()).length;
    for (const target of ['com.example.browser', 'chrome-test']) {
      const r = await c.call('hands_click', { target, to: { x: 1, y: 1 } });
      assert.equal(r.json.reason, 'wall', target);
      assert.equal(r.json.url, A, target);
    }
    assert.equal(handsCmds(f.log()).length, before, 'the refused hands reached no port');
    // a target with no profile may be any process of its bundle, so profiled aliases of that bundle are walled too
    assert.equal((await c.call('hands_click', { target: 'chrome-other', to: { x: 1, y: 1 } })).json.reason, 'wall');
    // another app, under its name or its bundle id, is not walled
    for (const target of ['notes-test', 'com.example.notes']) {
      assert.equal((await c.call('hands_click', { target, to: { x: 1, y: 1 } })).isError, false, target);
    }
    // a new eyes_text with no wall through the other spelling lifts the mark for every spelling
    assert.deepEqual((await c.call('eyes_text', { target: 'com.example.browser' })).json.wall, []);
    for (const target of ['chrome-test', 'com.example.browser']) {
      assert.equal((await c.call('hands_click', { target, to: { x: 1, y: 1 } })).isError, false, target);
    }
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('wall guard: profiled aliases of one bundle are separate windows; a target with no profile is any of them', { skip }, async () => {
  const A = 'https://example.test/apply';
  let f = await fakePort({ job_polls: 1, targets: TARGETS, text_seq: [{ url: A, lines: ['Please verify you are human'] }] });
  let c = client(f.name);
  try {
    await c.init();
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-other' })).json.wall, ['human']);
    assert.equal((await c.call('hands_click', { target: 'chrome-agent', to: { x: 1, y: 1 } })).isError, false);
    for (const target of ['chrome-other', 'com.example.browser', 'chrome-test']) {
      const r = await c.call('hands_click', { target, to: { x: 1, y: 1 } });
      assert.equal(r.json.reason, 'wall', target);
      assert.equal(r.json.url, A, target);
    }
    await c.close();
  } finally { c.kill(); f.stop(); }
  // a wall seen through the bare bundle id blocks every profiled alias of that bundle
  f = await fakePort({ job_polls: 1, targets: TARGETS, text_seq: [{ url: A, lines: ['Please verify you are human'] }] });
  c = client(f.name);
  try {
    await c.init();
    assert.deepEqual((await c.call('eyes_text', { target: 'com.example.browser' })).json.wall, ['human']);
    for (const target of ['chrome-agent', 'chrome-other', 'chrome-test']) {
      assert.equal((await c.call('hands_click', { target, to: { x: 1, y: 1 } })).json.reason, 'wall', target);
    }
    assert.equal((await c.call('hands_click', { target: 'notes-test', to: { x: 1, y: 1 } })).isError, false);
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('wall guard: a refusal across spellings names the target that saw the wall (seen_via); eyes_text there lifts it', { skip }, async () => {
  const A = 'https://example.test/apply';
  for (const [via, other] of [['com.example.browser', 'chrome-agent'], ['chrome-agent', 'com.example.browser']]) {
    const f = await fakePort({ job_polls: 1, targets: TARGETS,
      text_seq: [{ url: A, lines: ['Please verify you are human'] }, { url: A, lines: ['Email'] }] });
    const c = client(f.name);
    try {
      await c.init();
      assert.deepEqual((await c.call('eyes_text', { target: via })).json.wall, ['human']);
      const r = await c.call('hands_click', { target: other, to: { x: 1, y: 1 } });
      assert.equal(r.json.reason, 'wall', via);
      assert.equal(r.json.seen_via, via);
      assert.match(r.json.hint, /seen_via/);
      assert.deepEqual((await c.call('eyes_text', { target: r.json.seen_via })).json.wall, []);
      assert.equal((await c.call('hands_click', { target: other, to: { x: 1, y: 1 } })).isError, false, via);
      await c.close();
    } finally { c.kill(); f.stop(); }
  }
});

test('wall guard fails closed when the window cannot be told', { skip }, async () => {
  const A = 'https://example.test/apply';
  // a name that is neither a target nor a bundle id, while a wall mark exists
  let f = await fakePort({ job_polls: 1, targets: TARGETS, text_seq: [{ url: A, lines: ['Please verify you are human'] }] });
  let c = client(f.name);
  try {
    await c.init();
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, ['human']);
    const r = await c.call('hands_click', { target: 'mystery', to: { x: 1, y: 1 } });
    assert.equal(r.isError, true);
    assert.equal(r.json.reason, 'wall');
    assert.match(r.json.hint, /cannot tell which window/);
    assert.equal(handsCmds(f.log()).length, 0, 'the refused hands reached no port');
    await c.close();
  } finally { c.kill(); f.stop(); }
  // eh.targets gives no target list: every input hands call refuses until eyes_text there shows no wall
  f = await fakePort({ job_polls: 1, targets: { file: '/tmp/targets.json', error: 'bad json' },
    text_seq: [{ url: A, lines: ['Please verify you are human'] }, { url: A, lines: ['Email'] }] });
  c = client(f.name);
  try {
    await c.init();
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, ['human']);
    for (const target of ['chrome-test', 'com.example.browser', 'com.example.notes']) {
      const r = await c.call('hands_click', { target, to: { x: 1, y: 1 } });
      assert.equal(r.json.reason, 'wall', target);
      assert.deepEqual(r.json.wall, ['human'], target);
    }
    assert.equal(handsCmds(f.log()).length, 0, 'the refused hands reached no port');
    assert.deepEqual((await c.call('eyes_text', { target: 'chrome-test' })).json.wall, []);
    assert.equal((await c.call('hands_click', { target: 'chrome-test', to: { x: 1, y: 1 } })).isError, false);
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('hands: the tool waits for the job; typed text stays out of replies and stderr; bad args reach no port', { skip }, async () => {
  const f = await fakePort({ job_polls: 3 });
  const c = client(f.name);
  try {
    await c.init();
    const r = await c.call('hands_type', { target: 'textedit', text: 'private words' });
    assert.equal(r.isError, false);
    assert.equal(r.json.state, 'done');
    assert.deepEqual(cmds(f.log()), ['status', 'arm', 'eh.hands.type', 'eh.hands.job', 'eh.hands.job', 'eh.hands.job']);
    const n = cmds(f.log()).length;
    for (const [name, args, want] of [
      ['hands_click', { target: 'textedit', clicks: 4 }, /clicks must be 1-3/],
      ['hands_click', { target: 'textedit', to: { x: 1 } }, /\{field\}, \{rect\} or \{x, y\}/],
      ['hands_type', { target: 'textedit' }, /text is required/],
      ['eyes_fields', { target: 'a/b' }, /not allowed/],
      ['eyes_fields', { target: 'textedit', secret: 'x' }, /not an argument/],
      ['eyes_shot', { target: 'textedit', max_px: 10.5 }, /whole number/],
    ]) {
      const b = await c.call(name, args);
      assert.equal(b.isError, true, name);
      assert.equal(b.json.reason, 'bad_args');
      assert.match(b.json.hint, want);
    }
    assert.equal(cmds(f.log()).length, n, 'schema errors reach no port');
    await c.close();
    assert.ok(!c.stderr().includes('private words') && !c.lines.join('\n').includes('private words'));
  } finally { c.kill(); f.stop(); }
});

test('hands_status keeps the interrupt count across a lease reset until hands_release', { skip }, async () => {
  const f = await fakePort({ job_polls: 1, job_end: 'interrupted', hands_status_seq: [1, 1, 0, 2, 3, 0] });
  const c = client(f.name);
  try {
    await c.init();
    const j = await c.call('hands_click', { target: 'textedit', to: { x: 1, y: 1 } });
    assert.equal(j.isError, true);
    assert.equal(j.json.state, 'interrupted');
    assert.equal(j.json.interrupts, 1, 'an interrupted job reads the count at once');
    assert.equal((await c.call('hands_status')).json.interrupts, 1);
    assert.equal((await c.call('hands_status')).json.interrupts, 1, 'the Spoon reset its lease (0): the server keeps 1');
    assert.equal((await c.call('hands_status')).json.interrupts, 3, 'two more takeovers in the new lease');
    const s = await c.call('hands_status');
    assert.equal(s.json.interrupts, 4);
    assert.match(s.json.stop_rule, /stop and tell the person/);
    const rel = await c.call('hands_release');
    assert.deepEqual(rel.json, { ok: true, released: true });
    assert.equal(cmds(f.log()).at(-1), 'disarm');
    assert.equal((await c.call('hands_status')).json.interrupts, 0, 'a new task starts at 0');
    assert.deepEqual(cmds(f.log()).slice(-3), ['status', 'arm', 'eh.hands.status'], 'the call after a release arms again');
    assert.deepEqual((await c.call('hands_release')).json, { ok: true, released: true });
    assert.deepEqual((await c.call('hands_release')).json, { ok: true, released: false }, 'nothing to release');
    await c.close();
    assert.equal(cmds(f.log()).filter(x => x === 'disarm').length, 2, 'no extra disarm at EOF after a release');
  } finally { c.kill(); f.stop(); }
});

function pngSize(b64) {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('eyes_shot returns MCP image content with a long edge of 1568 px or less, and deletes the file', { skip }, async () => {
  const shots = tmp();   // mkdtemp makes a mode 700 folder, as the Spoon's shot folder is
  const f = await fakePort({ shot: { dir: shots, w: 2400, h: 1200, honor_max_px: true } });
  const c = client(f.name);
  try {
    await c.init();
    const r = await c.call('eyes_shot', { target: 'textedit', max_px: 4000 });
    assert.equal(r.isError, false, JSON.stringify(r.json));
    const img = r.content.find(x => x.type === 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.deepEqual(pngSize(img.data), [1568, 784]);
    assert.deepEqual(r.json.size, [1568, 784]);
    assert.ok(!('path' in r.json), 'the file is gone, so no path comes back');
    assert.deepEqual(r.json.bounds, [0, 25, 1568, 784]);
    assert.equal(JSON.parse(f.log().find(e => e.cmd === 'eh.eyes.shot').args).max_px, 1568, 'the server asks for at most 1568');
    const small = await c.call('eyes_shot', { target: 'textedit', max_px: 800 });
    assert.deepEqual(pngSize(small.content[0].data), [800, 400]);
    assert.deepEqual(readdirSync(shots), [], 'every shot file is deleted once read');
    await c.close();
  } finally { c.kill(); f.stop(); }
});

test('eyes_shot scales a shot that comes back too large (sips), and refuses a file outside the rules', { skip }, async () => {
  const shots = tmp();
  const f = await fakePort({ shot: { dir: shots, w: 3000, h: 1000, honor_max_px: false } });
  const c = client(f.name);
  try {
    await c.init();
    const r = await c.call('eyes_shot', { target: 'textedit' });
    assert.equal(r.isError, false, JSON.stringify(r.json));
    const [w, h] = pngSize(r.content[0].data);
    assert.ok(Math.max(w, h) <= 1568, `${w}x${h}`);
    assert.deepEqual(r.json.size, [w, h]);
    assert.deepEqual(readdirSync(shots), []);
    await c.close();
  } finally { c.kill(); f.stop(); }
  // A reply that names some other file: nothing is read or deleted.
  const other = tmp(), keep = join(other, 'notes.png');
  writeFileSync(keep, 'keep me');
  const g = await fakePort({ refuse: { 'eh.eyes.shot': { ok: true, path: keep, bounds: [0, 0, 1, 1] } } });
  const d = client(g.name);
  try {
    await d.init();
    const r = await d.call('eyes_shot', { target: 'textedit' });
    assert.equal(r.isError, true);
    assert.equal(r.json.reason, 'shot_unreadable');
    assert.ok(existsSync(keep));
    await d.close();
  } finally { d.kill(); g.stop(); }
});
