// node --test modules/eyeshands/eyes.test.mjs   (never touches Hammerspoon, the screen or the input)
// The eyes (EyesHands.spoon/eyes.lua) under a plain Lua 5.4 with a fake hs (test/spoon-driver.lua):
// field records from a JSON AX tree fixture (test/ax-form.json), the stale id fallback to dom, the
// walk limits and `truncated`, text, focused, dialog, tree and frontmost, the pixel decisions on
// synthetic images, and, through the Spoon's own port, the capability and target refusals.
// Needs Lua 5.4 (LUA=..., `lua5.4`, `lua`, or Homebrew's lua@5.4); the Lua tests skip without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const lstr = s => JSON.stringify(s);
const secret = () => randomBytes(32).toString('hex');

// The fixture's app as target chrome-test (pid 9, a Chromium profile target), and its front window
// as a synthetic Retina image (2 pixels per point): white, with the "I agree" checkbox filled with
// the accent colour (its rounded corner shows the page) and the "Yes" radio button an empty grey ring.
const FORM = `AXAPPS[9] = ax(fixture("ax-form.json"))
  TARGETS["chrome-test"] = { ok = true, name = "chrome-test", bundle = "com.google.Chrome", profile = "/tmp/p", pid = 9 }
  function FORMPX(px, py) local gx, gy = px / 2, py / 2 + 25
    if gx >= 412 and gx < 428 and gy >= 440 and gy < 456 and not (gx < 413 and gy < 441) then return 0.0, 0.48, 1.0 end
    if gx >= 412 and gx < 428 and gy >= 500 and gy < 516 then
      local d = math.sqrt((gx - 420) ^ 2 + (gy - 508) ^ 2); if d >= 6.5 and d <= 8 then return 0.6, 0.6, 0.6 end end
    return 1, 1, 1 end
  WIMG[9] = { frame = { 0, 25, 1280, 775 }, w = 2560, h = 1550, color = FORMPX }`;
const T = 'target = "chrome-test"';
const byId = fields => Object.fromEntries(fields.map(f => [f.id, f]));

test('fields: field records from a JSON AX tree, in page order, with onscreen and global rects', { skip }, () => {
  const [r, set, m, bad] = ok(drive([
    `${FORM}; E = eyes(); return E.fields({ ${T} }, "runner")`,
    'return AXSET',
    `return E.fields({ ${T}, match = { label = "MAIL" } }, "runner")`,
    `return { E.fields({ ${T}, match = { name = "x" } }, "runner"), E.fields({ ${T}, match = "Email" }, "runner") }`,
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.target, 'chrome-test');
  assert.equal(r.url, 'http://127.0.0.1:53111/form');
  assert.equal(r.title, 'Fixture form');
  assert.deepEqual(r.window, [0, 25, 1280, 775]);
  assert.deepEqual(r.viewport, [0, 112, 1280, 688]);
  assert.equal(r.truncated, undefined);
  assert.deepEqual(r.fields.map(f => [f.id, f.role, f.label]), [
    ['f1', 'AXTextField', 'First name'], ['f2', 'AXTextField', 'Email'], ['f3', 'AXCheckBox', 'I agree'],
    ['f4', 'AXCheckBox', 'Newsletter'], ['f5', 'AXRadioButton', 'Yes'], ['f6', 'AXComboBox', 'City'],
    ['f7', 'AXButton', 'Submit'], ['f8', 'AXLink', 'Help'], ['f9', 'AXTextArea', 'Notes'],
  ], 'the toolbar outside the web area is not a field; the iframe link is');
  const f = byId(r.fields);
  assert.deepEqual(f.f2, {
    id: 'f2', role: 'AXTextField', label: 'Email', labelSource: 'description', value: '', placeholder: 'you@example.com',
    required: true, focused: true, enabled: true, dom: 'email', rect: [412, 388, 320, 32], onscreen: true, subrole: 'AXEmailField',
  }, 'the jobhunt.lua record shape plus onscreen');
  assert.deepEqual([f.f1.label, f.f1.labelSource, f.f1.value], ['First name', 'titleElement', 'Ada'], 'a <label> element, spaces cleaned');
  assert.equal(f.f9.onscreen, false, 'below the viewport');
  assert.equal(f.f7.enabled, false);
  assert.deepEqual([f.f4.checked, f.f4.checkedSource], [true, 'ax'], 'a numeric AXValue decides');
  assert.deepEqual([f.f3.checked, f.f3.checkedSource], [undefined, 'unknown'], 'Chrome leaves AXValue empty; no shot, no pixels');
  assert.deepEqual([f.f6.shown, f.f6.expanded, f.f6.roleDescription], ['Springfield', false, 'combo box']);
  assert.ok(set.includes('AXManualAccessibility=true'), 'the web tree is switched on, as a screen reader does');
  assert.deepEqual(m.fields.map(x => x.id), ['f2'], 'a match keeps the ids of a full call');
  assert.deepEqual([bad[0].reason, bad[0].hint], ['bad_args', 'unknown match key name']);
  assert.equal(bad[1].hint, 'match must be an object');
});

test('checked from pixels: only for an owner with shot, one window image per call, never for a clipped box', { skip }, () => {
  const out = ok(drive([
    `${FORM}; CAPS.shooter = { eyes = true, shot = true }; E = eyes()
     local r = E.fields({ ${T} }, "shooter"); return { r.fields[3], r.fields[5], IMGREADS }`,
    `IMGREADS = 0; local r = E.fields({ ${T} }, "runner"); return { r.fields[3].checkedSource, IMGREADS }`,
    `WIMG[9] = nil; IMGREADS = 0; local r = E.fields({ ${T} }, "shooter"); return { r.fields[3].checkedSource, IMGREADS }`,
    `WIMG[9] = { frame = { 0, 25, 1280, 775 }, w = 2560, h = 1550, color = FORMPX }
     AX.terms.node.rect = { 412, 795, 16, 16 }; return E.value({ ${T}, dom = "terms" }, "shooter")`,
    `AX.terms.node.rect = { 412, 440, 16, 10 }; return E.value({ ${T}, dom = "terms" }, "shooter").checkedSource`,
  ]));
  assert.deepEqual([out[0][0].checked, out[0][0].checkedSource], [true, 'pixels'], 'filled with the accent colour');
  assert.deepEqual([out[0][1].checked, out[0][1].checkedSource], [false, 'pixels'], 'an empty ring is not ticked');
  assert.equal(out[0][2], 1, 'one window image for the whole walk');
  assert.deepEqual(out[1], ['unknown', 0], 'an owner without shot never reads pixels');
  assert.deepEqual(out[2], ['unknown', 1], 'no Screen Recording: unknown');
  assert.equal(out[3].checkedSource, 'unknown', 'a box that runs past its web area');
  assert.equal(out[3].onscreen, false);
  assert.equal(out[4], 'unknown', 'a box that is not square was clipped');
});

test('value: reads live by id; a stale id falls back to dom; ids belong to one owner and target', { skip }, () => {
  const out = ok(drive([
    `${FORM}; TARGETS.other = { ok = true, name = "other", bundle = "com.example.other", pid = 9 }
     E = eyes(); E.fields({ ${T} }, "runner"); AX.first.node.AXValue = "Grace"; return E.value({ ${T}, id = "f1" }, "runner")`,
    `local old = AX.email; AXAPPS[9] = ax(fixture("ax-form.json")); old.dead = true
     return E.value({ ${T}, id = "f2" }, "runner")`,
    `AX.email.node.AXValue = "a@b.c"; return E.value({ ${T}, id = "f2" }, "runner")`,
    `return E.value({ ${T}, id = "f99" }, "runner")`,
    `return E.value({ ${T}, dom = "nope" }, "runner")`,
    `return E.value({ ${T} }, "runner")`,
    `return E.value({ ${T}, id = "f1" }, "looker")`,
    `return E.value({ target = "other", id = "f1" }, "runner")`,
    `return E.value({ ${T}, id = "f1", dom = "first" }, "looker")`,
    `E.fields({ ${T}, match = { role = "AXButton" } }, "runner"); return E.value({ ${T}, id = "f7" }, "runner").label`,
    `E.forget("runner"); return E.value({ ${T}, id = "f7" }, "runner").reason`,
    `E.fields({ ${T} }, "runner"); local old = AX.email; AXAPPS[9] = ax(fixture("ax-form.json")); old.dead = true
     return E.value({ ${T}, id = "f2", dom = "first" }, "runner")`,
    `return E.value({ ${T}, id = "f2" }, "runner")`,
  ]));
  assert.deepEqual([out[0].ok, out[0].id, out[0].via, out[0].value, out[0].dom, out[0].target], [true, 'f1', 'id', 'Grace', 'first', 'chrome-test'],
    'read live, not from the fields call');
  assert.deepEqual([out[1].ok, out[1].id, out[1].via, out[1].dom, out[1].label], [true, 'f2', 'dom', 'email', 'Email'],
    'the page was rebuilt: the old element is stale, its HTML id finds the new one');
  assert.deepEqual([out[2].via, out[2].value], ['id', 'a@b.c'], 'the fallback updated the id');
  assert.deepEqual([out[3].reason, out[3].id], ['unknown_id', 'f99']);
  assert.deepEqual([out[4].reason, out[4].dom], ['not_found', 'nope']);
  assert.equal(out[5].reason, 'bad_args');
  assert.equal(out[6].reason, 'unknown_id', 'another owner has no ids');
  assert.equal(out[7].reason, 'unknown_id', 'ids from one target are not ids of another');
  assert.deepEqual([out[8].ok, out[8].via, out[8].value], [true, 'dom', 'Ada'], 'dom works without a fields call (on the rebuilt page)');
  assert.equal(out[9], 'Submit');
  assert.equal(out[10], 'unknown_id', 'forget (on disarm) drops the ids');
  assert.deepEqual([out[11].ok, out[11].via, out[11].dom], [true, 'dom', 'first'], 'a stale id with another dom reads that dom');
  assert.deepEqual([out[12].via, out[12].dom, out[12].label], ['dom', 'email', 'Email'],
    'the stale id was not rebound to the other control: it still finds its own');
});

test('walk limits: max_depth 80, max_nodes 8000, time_ms 4000, and truncated', { skip }, () => {
  // Builders for big trees: a deep chain of groups, a wide web area, slow nodes.
  const TREES = `function app(web) return ax({ role = "AXApplication", AXFocusedWindow = { ["$ref"] = "w" },
      children = { { _id = "w", role = "AXWindow", rect = { 0, 0, 800, 600 }, children = { web } } } }) end
    function chain(n, leaf) local node = leaf; for i = 1, n do node = { role = "AXGroup", children = { node } } end; return node end
    function field(dom) return { role = "AXTextField", AXDOMIdentifier = dom, rect = { 10, 10, 100, 20 } } end
    TARGETS.t = { ok = true, name = "t", bundle = "com.example.app", pid = 5 }; E = eyes()`;
  const out = ok(drive([
    `${TREES}; AXAPPS[5] = app({ role = "AXWebArea", rect = { 0, 0, 800, 600 }, children = { chain(100, field("deep")), field("after") } })
     return E.fields({ target = "t" }, "o")`,
    `local kids = {}; for i = 1, 9000 do kids[i] = { role = "AXStaticText", AXValue = "x" .. i } end
     AXAPPS[5] = app({ role = "AXWebArea", rect = { 0, 0, 800, 600 }, children = kids }); local r = E.fields({ target = "t" }, "o")
     return { r.nodes, r.truncated }`,
    `local r = E.text({ target = "t", limits = { max_nodes = 50 } }, "o"); return { r.nodes, r.truncated, #r.lines }`,
    `local kids = {}; for i = 1, 500 do kids[i] = { role = "AXStaticText", AXValue = "x", _cost = 10 } end
     AXAPPS[5] = app({ role = "AXWebArea", rect = { 0, 0, 800, 600 }, children = kids }); local t0 = CLOCK
     local r = E.text({ target = "t" }, "o"); return { r.truncated, r.nodes, CLOCK - t0 }`,
    `local r = E.text({ target = "t", limits = { time_ms = 100 } }, "o"); return { r.truncated, r.nodes }`,
    `return { E.fields({ target = "t", limits = { max_nodes = 9000 } }, "o").hint, E.fields({ target = "t", limits = { max_depth = 0 } }, "o").hint,
       E.fields({ target = "t", limits = { depth = 3 } }, "o").hint, E.fields({ target = "t", limits = 5 }, "o").hint }`,
    `AXAPPS[5] = app({ role = "AXWebArea", rect = { 0, 0, 800, 600 }, children = { chain(10, field("d10")) } })
     local r = E.fields({ target = "t", limits = { max_depth = 5 } }, "o"); return { #r.fields, r.truncated }`,
  ]));
  assert.deepEqual(out[0].fields.map(f => f.dom), ['after'], 'too deep skips that subtree only');
  assert.equal(out[0].truncated, 'depth');
  assert.deepEqual(out[1], [8000, 'nodes']);
  assert.deepEqual(out[2], [50, 'nodes', 49], 'a caller may lower a limit');
  assert.equal(out[3][0], 'time');
  assert.ok(out[3][1] >= 395 && out[3][1] <= 402, `about 4000 ms of 10 ms nodes, got ${out[3][1]}`);
  assert.ok(out[3][2] <= 4020, 'the walk stopped at the time limit');
  assert.deepEqual(out[4][0], 'time');
  assert.ok(out[4][1] <= 12);
  assert.deepEqual(out[5], ['limits.max_nodes must be a whole number 1-8000', 'limits.max_depth must be a whole number 1-80',
    'unknown limit depth', 'limits must be an object'], 'a caller can never raise a limit');
  assert.deepEqual(out[6], [0, 'depth']);
});

test('the walk root: a browser waits briefly for its web tree; an app without one walks its window', { skip }, () => {
  const out = ok(drive([
    `AXAPPS[5] = ax({ role = "AXApplication", AXMainWindow = { ["$ref"] = "w" }, children = { { _id = "w", role = "AXWindow",
       AXTitle = "Untitled", rect = { 100, 100, 600, 400 }, children = { { role = "AXScrollArea", rect = { 100, 128, 600, 372 },
       children = { { role = "AXTextArea", AXValue = "Dear reader,  hello.", rect = { 100, 128, 600, 372 } } } } } } } })
     TARGETS.textedit = { ok = true, name = "textedit", bundle = "com.example.TextEdit", pid = 5 }; E = eyes(); local t0 = CLOCK
     local r = E.fields({ target = "textedit" }, "o"); return { r, CLOCK - t0 }`,
    'return E.text({ target = "textedit" }, "o")',
    `AXAPPS[6] = ax({ role = "AXApplication", AXFocusedWindow = { ["$ref"] = "w" }, children = { { _id = "w", role = "AXWindow",
       rect = { 0, 0, 800, 600 }, children = { { role = "AXWebArea", rect = { 0, 50, 800, 550 } } } } } })
     TARGETS.chrome = { ok = true, name = "chrome", bundle = "com.google.Chrome", pid = 6 }; local t0 = CLOCK
     return { E.fields({ target = "chrome" }, "o"), CLOCK - t0 }`,
    `AXAPPS[7] = ax({ role = "AXApplication" }); TARGETS.nowin = { ok = true, name = "nowin", bundle = "com.example.x", pid = 7 }
     return E.fields({ target = "nowin" }, "o").reason`,
    'return E.fields({ target = "gone" }, "o")',
    'TARGETS.noel = { ok = true, name = "noel", bundle = "com.example.y", pid = 8 }; return E.focused({ target = "noel" }, "o").reason',
    'AXOK = false; return E.fields({ target = "textedit" }, "o").reason',
  ]));
  const [r, waited] = out[0];
  assert.equal(waited, 0, 'no wait for an app that is not a browser');
  assert.deepEqual(r.viewport, [100, 100, 600, 400], 'the viewport is the window without a web area');
  assert.deepEqual(r.window, [100, 100, 600, 400]);
  assert.equal(r.url, undefined);
  assert.deepEqual(r.fields.map(f => [f.role, f.value, f.onscreen]), [['AXTextArea', 'Dear reader,  hello.', true]]);
  assert.deepEqual(out[1].lines, ['Dear reader, hello.'], 'a native document is text');
  assert.equal(out[2][0].reason, 'no_web_content');
  assert.equal(out[2][1], 7 * 150, 'eight tries, 150 ms apart');
  assert.equal(out[3], 'no_window');
  assert.deepEqual(out[4], { ok: false, reason: 'target_not_running', name: 'gone' });
  assert.equal(out[5], 'no_ax_element');
  assert.equal(out[6], 'no_accessibility');
});

test('text, focused, dialog, tree and frontmost on the fixture', { skip }, () => {
  const [text, focused, none, dialog, tree, deep, front, nofront] = ok(drive([
    `${FORM}; E = eyes(); return E.text({ ${T} }, "runner")`,
    `E.fields({ ${T} }, "runner"); return E.focused({ ${T} }, "runner")`,
    `AX.email.node.AXFocused = false; AXAPPS[9].node.AXFocusedUIElement = nil; return E.focused({ ${T} }, "runner")`,
    `return E.dialog({ ${T} }, "runner")`,
    `return E.tree({ ${T}, depth = 4 }, "runner")`,
    `return { E.tree({ ${T}, max_nodes = 5 }, "runner").truncated, E.tree({ ${T}, depth = 81 }, "runner").reason }`,
    `FRONTAPP = { pid = 9, name = "Browser", bundle = "com.google.Chrome" }
     TLIST = { { name = "chrome-agent", running = true, pid = 4 }, { name = "chrome-test", running = true, pid = 9 } }; return E.frontmost()`,
    'FRONTAPP = nil; return E.frontmost()',
  ]));
  assert.deepEqual(text.lines, ['Fixture form', 'First name', 'Ada', 'Springfield', 'Submit', 'Inside the frame']);
  assert.deepEqual(text.frames, ['Embedded frame']);
  assert.equal(text.url, 'http://127.0.0.1:53111/form');
  assert.equal(focused.id, 'f2');
  assert.equal(focused.focused.dom, 'email');
  assert.equal(focused.focused.id, 'f2');
  assert.deepEqual(none, { ok: true, target: 'chrome-test', focused: false });
  assert.equal(dialog.open, true);
  assert.deepEqual(dialog.dialogs.map(d => [d.role, d.title]), [['AXSheet', 'Open'], ['AXSheet', 'Go to folder'], ['AXWindow', 'Confirm']]);
  assert.equal(tree.tree.role, 'AXWindow');
  assert.deepEqual(tree.tree.children.map(c => c.role), ['AXButton', 'AXWebArea', 'AXSheet'], 'empty wrappers collapse; the depth cut keeps siblings');
  assert.equal(tree.depth_limited, true);
  assert.equal(tree.truncated, undefined);
  assert.deepEqual(deep, ['nodes', 'bad_args']);
  assert.deepEqual(front, { ok: true, pid: 9, name: 'Browser', bundle: 'com.google.Chrome', target: 'chrome-test', targets: ['chrome-test'] });
  assert.deepEqual(nofront, { ok: true, targets: {} });
});

test('pixel decisions on synthetic images: ticked, empty, unreadable, and the pixels command', { skip }, () => {
  const out = ok(drive([
    `E = eyes(); return { E.tickState(function() return 0, 0.48, 1 end),
       E.tickState(function(fx, fy) if fx == 0 then return 1, 1, 1 end; return 0, 0.48, 1 end),
       E.tickState(function() return 0.95, 0.95, 0.95 end),
       E.tickState(function(fx) if fx == 0 then return nil end; return 1, 1, 1 end),
       E.tickState(function(fx, fy) if fx == 0 or fy < 0.3 then return 1, 1, 1 end; return nil end) }`,
    `${FORM}; return E.pixels({ ${T}, points = { { 420, 448 }, { 100, 100 }, { 1279.5, 799.5 } } })`,
    `return E.pixels({ ${T}, rect = { 412, 440, 16, 16 } })`,
    `return { E.pixels({ ${T}, rect = { 412, 500, 16, 16 } }).checked, E.pixels({ ${T}, rect = { 412, 440, 30, 16 } }).checked == nil }`,
    `return { E.pixels({ ${T}, points = { { 10, 10 } } }), E.pixels({ ${T}, rect = { 1270, 790, 20, 20 } }).reason }`,
    `return { E.pixels({ ${T} }).reason, E.pixels({ ${T}, points = {}, rect = { 1, 1, 1, 1 } }).reason,
       E.pixels({ ${T}, points = { { 1 } } }).reason, E.pixels({ ${T}, rect = { 1, 1, 0, 5 } }).reason }`,
    `WIMG[9] = nil; return E.pixels({ ${T}, points = { { 420, 448 } } }).reason`,
  ]));
  assert.deepEqual(out[0], [false, true, false], 'all one colour (no corner contrast) is empty; a filled box is ticked');
  assert.equal(out[0].length, 3, 'unreadable corners and too few samples give nil (absent)');
  assert.deepEqual(out[1].colors, ['#007aff', '#ffffff', '#ffffff'], 'Retina: 2 pixels per point');
  assert.deepEqual(out[1].window, [0, 25, 1280, 775]);
  assert.equal(out[2].checked, true);
  assert.equal(out[2].center, '#007aff');
  assert.equal(out[2].corner, '#ffffff');
  assert.equal(out[2].grid.length, 5);
  assert.deepEqual(out[3], [false, true], 'an empty radio; no checked for a rect that is no tick box');
  assert.deepEqual([out[4][0].reason, out[4][0].index], ['not_on_target', 1], 'never a pixel outside the target window');
  assert.equal(out[4][1], 'not_on_target');
  assert.deepEqual(out[5], ['bad_args', 'bad_args', 'bad_args', 'bad_args']);
  assert.equal(out[6], 'no_screen_recording');
});

// ---- through the Spoon's own port -----------------------------------------------------------------
const OWNERS = {
  reader: { enabled: true, capabilities: ['eyes'], apps: ['chrome-test'] },
  shooter: { enabled: true, capabilities: ['eyes', 'shot'], apps: ['chrome-test'] },
  shotonly: { enabled: true, capabilities: ['shot'], apps: ['chrome-test'] },
  other: { enabled: true, capabilities: ['eyes', 'shot'], apps: ['textedit'] },
};
function spoonSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'eh-eyes-'));
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ owners: OWNERS }));
  writeFileSync(join(dir, 'targets.json'), JSON.stringify({ targets: { 'chrome-test': { bundle: 'com.google.Chrome', profile: '/tmp/p' } } }));
  const keys = Object.fromEntries(Object.keys(OWNERS).map(o => [o, secret()]));
  const cfg = `{ port = "eyeshands-test-${randomBytes(4).toString('hex')}", access_file = ${lstr(join(dir, 'access.json'))},
    targets_file = ${lstr(join(dir, 'targets.json'))}, log_file = ${lstr(join(dir, 'eyeshands.log'))},
    shot_dir = ${lstr(join(dir, 'shots'))}, stop_hotkey = false, menubar = false }`;
  const boot = `${FORM}; PS = "  9 /x/Chrome --user-data-dir=/tmp/p"; APPS = { ["com.google.Chrome"] = { { pid = 9 } } }
    WINDOWS[9] = { frame = { 0, 25, 1280, 775 }, img = image(2560, 1550, FORMPX) }; boot(${cfg})
    ${Object.entries(keys).map(([o, k]) => `call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: o, secret: k }))} })`).join('; ')}
    return true`;
  let seq = 0;
  const call = (owner, cmd, args = {}) => `signed(${lstr(keys[owner])}, "${owner}", "${cmd}", ${lstr(JSON.stringify(args))}, ${++seq})`;
  return { dir, boot, call };
}

test('port: eyes need the eyes capability and a granted target; pixels and shot also need shot', { skip }, () => {
  const { dir, boot, call } = spoonSetup();
  const t = { target: 'chrome-test' };
  const out = ok(drive([
    boot,
    `return ${call('reader', 'eh.eyes.fields', t)}`,
    `return { ${call('reader', 'eh.eyes.pixels', { ...t, points: [[420, 448]] })}, ${call('reader', 'eh.eyes.shot', t)}, SNAPS }`,
    `return { ${call('shotonly', 'eh.eyes.fields', t)}, ${call('shotonly', 'eh.eyes.pixels', { ...t, points: [[420, 448]] })} }`,
    `return { ${call('other', 'eh.eyes.fields', t)}, ${call('other', 'eh.eyes.text', { target: 'com.google.Chrome' })} }`,
    `return { ${call('reader', 'eh.eyes.fields')}, ${call('reader', 'eh.eyes.value', { id: 'f1' })} }`,
    `return { ${call('reader', 'eh.eyes.dialog', t)}.result.open, ${call('reader', 'eh.eyes.tree', t)}.result.tree.role,
       ${call('reader', 'eh.eyes.text', t)}.result.lines[1], ${call('reader', 'eh.eyes.focused', t)}.result.id }`,
    `FRONT = 9; FRONTBUNDLE = "com.google.Chrome"; return ${call('reader', 'eh.eyes.frontmost')}`,
    `return call({ cmd = "eh.eyes.fields", owner = "reader", args = ${lstr(JSON.stringify(t))} })`,
    'return { touched = R.touched, ipc = R.ipcLoaded == true }',
  ]));
  const r = out[1];
  assert.equal(r.ok, true);
  assert.equal(r.result.fields.length, 9);
  assert.equal(r.result.fields[2].checkedSource, 'unknown', 'no shot: no pixel path');
  assert.deepEqual(out[2][0], { ok: false, error: 'capability shot not granted' });
  assert.deepEqual(out[2][1], { ok: false, error: 'capability shot not granted' });
  assert.equal(out[2][2], 0, 'no window snapshot for an owner without shot');
  assert.deepEqual(out[3][0], { ok: false, error: 'capability eyes not granted' });
  assert.deepEqual([out[3][1].ok, out[3][1].result.ok, out[3][1].result.reason], [true, false, 'capability'], 'shot alone is not eyes');
  assert.deepEqual(out[4][0], { ok: false, error: 'app chrome-test not granted' });
  assert.deepEqual(out[4][1], { ok: false, error: 'app com.google.Chrome not granted' }, 'a bundle id is a target name too');
  assert.deepEqual(out[5], [{ ok: false, error: 'no target app' }, { ok: false, error: 'no target app' }]);
  assert.deepEqual(out[6], [true, 'AXWindow', 'Fixture form', 'f2']);
  assert.deepEqual(out[8], { ok: false, error: 'unsigned call' });
  assert.deepEqual(out[7].result, { ok: true, pid: 9, name: 'front', bundle: 'com.google.Chrome', target: 'chrome-test', targets: ['chrome-test'] });
  assert.deepEqual(out[9], { touched: {}, ipc: false }, 'eyes touch no hs.eventtap, hs.mouse or other input module');
  const log = readFileSync(join(dir, 'eyeshands.log'), 'utf8');
  assert.match(log, /deny owner=shotonly cmd=eh.eyes.pixels reason=capability\?eyes\?not\?granted/);
});

test('port: an owner with shot gets pixel checks, pixels and a window shot in a private folder', { skip }, () => {
  const { dir, boot, call } = spoonSetup();
  const t = { target: 'chrome-test' };
  const out = ok(drive([
    boot,
    `SNAPS = 0; local r = ${call('shooter', 'eh.eyes.fields', t)}; return { r.result.fields[3], r.result.fields[5], SNAPS }`,
    `return ${call('shooter', 'eh.eyes.pixels', { ...t, points: [[420, 448], [100, 100]] })}`,
    `return ${call('shooter', 'eh.eyes.shot', { ...t, max_px: 1280 })}`,
    `return ${call('shooter', 'eh.eyes.shot', { ...t, max_px: 10 })}`,
    `SESSION = { CGSSessionScreenIsLocked = true }; return { ${call('shooter', 'eh.eyes.pixels', { ...t, points: [[420, 448]] })}.result.reason,
       ${call('shooter', 'eh.eyes.shot', t)}.result.reason }`,
    `SESSION = {}; WINDOWS[9].img = nil; return ${call('shooter', 'eh.eyes.shot', t)}.result.reason`,
  ]));
  assert.deepEqual([out[1][0].checked, out[1][0].checkedSource, out[1][1].checked, out[1][1].checkedSource, out[1][2]],
    [true, 'pixels', false, 'pixels', 1]);
  assert.deepEqual(out[2].result.colors, ['#007aff', '#ffffff']);
  const shot = out[3].result;
  assert.equal(shot.ok, true);
  assert.equal(shot.target, 'chrome-test');
  assert.deepEqual(shot.bounds, [0, 25, 1280, 775]);
  assert.deepEqual(shot.size, [1280, 775], 'scaled so the long side is max_px');
  assert.ok(shot.path.startsWith(join(dir, 'shots') + '/shot-') && shot.path.endsWith('.png'));
  assert.equal(readFileSync(shot.path, 'utf8'), 'PNG 1280x775');
  assert.equal(shot.bytes, 12);
  assert.equal(statSync(join(dir, 'shots')).mode & 0o777, 0o700, 'the shot folder is private');
  assert.equal(out[4].result.reason, 'bad_args');
  assert.deepEqual(out[5], ['locked', 'locked'], 'never read pixels of a locked screen');
  assert.equal(out[6], 'no_screen_recording');
});

test('port: a disarm drops the owner\'s field ids', { skip }, () => {
  const { boot, call } = spoonSetup();
  const t = { target: 'chrome-test' };
  const out = ok(drive([
    boot,
    `${call('reader', 'eh.eyes.fields', t)}; return ${call('reader', 'eh.eyes.value', { ...t, id: 'f9' })}.result.label`,
    `${call('reader', 'disarm')}; call({ cmd = "arm", args = ${lstr(JSON.stringify({ owner: 'reader', secret: 'a'.repeat(64) }))} })
     return signed(${lstr('a'.repeat(64))}, "reader", "eh.eyes.value", ${lstr(JSON.stringify({ ...t, id: 'f9' }))}, 1).result.reason`,
  ]));
  assert.equal(out[1], 'Notes');
  assert.equal(out[2], 'unknown_id');
});
