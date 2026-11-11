// node --test modules/eyeshands/install.test.mjs
// The eyeshands module install (install.sh) against a throwaway HOME and profile: the three links,
// idempotence, backups, the MCP line (asked, never silent), the access hint, the one deferred
// Hammerspoon restart through modules/hammerspoon/install.sh --restart, --status, --uninstall and
// --dry-run. Stub pgrep, hs, osascript, open, sleep and claude; a fake Eyes & Hands port
// (test/fake-eh-port.py) stands in for the Spoon. Never quits, opens or calls the real Hammerspoon,
// and writes nothing outside the temp folders. Also checks the example files and the loader (Lua 5.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const MOD = here('.').replace(/\/$/, '');
const REPO = dirname(dirname(MOD));
const INSTALL = join(MOD, 'install.sh');
const FAKE = join(MOD, 'test/fake-eh-port.py');
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const JQ = spawnSync('/bin/sh', ['-c', 'command -v jq']).stdout?.toString().trim();
const skip = !PY ? 'no python3' : !JQ ? 'no jq' : false;
const LUA = [process.env.LUA, 'lua5.4', 'lua', '/opt/homebrew/opt/lua@5.4/bin/lua', '/usr/local/opt/lua@5.4/bin/lua']
  .filter(Boolean).find(b => spawnSync(b, ['-e', 'assert(_VERSION >= "Lua 5.4")']).status === 0);
const QUIT = 'osascript -e tell application "Hammerspoon" to quit';
const OPEN = 'open -a Hammerspoon';
const OWNER = 'harness-session';

// running: is Hammerspoon "running" (stub pgrep). harnessStatus: what the harness config answers to
// `hs -c 'harness.status()'` (an object), or null for a Hammerspoon that does not answer.
// hsConfig: ~/.hammerspoon/init.lua is the harness config (the hammerspoon module is installed).
function sandbox({ running = false, harnessStatus = {}, hsConfig = true, env: extra = {} } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'eh-install-'));
  const bin = join(d, 'bin'), home = join(d, 'home'), calls = join(d, 'calls.txt'), profile = join(d, 'profile');
  mkdirSync(bin);
  mkdirSync(join(home, '.hammerspoon'), { recursive: true });
  mkdirSync(profile);
  if (hsConfig) symlinkSync(join(REPO, 'modules/hammerspoon/init.lua'), join(home, '.hammerspoon', 'init.lua'));
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`, { mode: 0o755 });
  stub('pgrep', running ? 'exit 0' : 'exit 1');
  if (harnessStatus) writeFileSync(join(d, 'status.json'), JSON.stringify(harnessStatus));
  stub('hs', harnessStatus
    ? `case "$*" in *harness.status*) cat ${join(d, 'status.json')} ;; *) echo up ;; esac`
    : 'exit 1');
  for (const name of ['osascript', 'open', 'sleep', 'claude']) stub(name, 'exit 0');
  if (JQ) symlinkSync(JQ, join(bin, 'jq'));   // only jq: Homebrew's bin also holds the real `hs`
  writeFileSync(join(d, 'harness.env'), `PROFILE_DIR="${profile}"\n`);
  // EYESHANDS_PORT and HSX_PORT: ports nobody holds unless a test starts a fake one; never the live ones.
  const env = { ...process.env, HOME: home, HARNESS_ENV: join(d, 'harness.env'),
    PATH: `${bin}:/usr/bin:/bin`, HSX_PORT: 'eh-install-test-none',
    EYESHANDS_PORT: `eh-install-test-none-${randomBytes(3).toString('hex')}`, EYESHANDS_WAIT_SECS: '0', ...extra };
  const run = (...a) => spawnSync('/bin/zsh', [INSTALL, ...a], { env, encoding: 'utf8', timeout: 60000 });
  const lines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const acted = () => lines().filter(l => /^(osascript|open) /.test(l));
  const claude = () => lines().filter(l => l.startsWith('claude '));
  const links = {
    spoon: join(home, '.hammerspoon/Spoons/EyesHands.spoon'),
    loader: join(home, '.hammerspoon/local/eyeshands.lua'),
    cli: join(home, '.local/bin/eyeshands'),
  };
  return { d, home, profile, env, run, lines, acted, claude, links };
}

// A fake Eyes & Hands port that answers `status` with `status` (merged over a started Spoon).
async function fakePort(s, status = {}, owners = {}) {
  const name = `eyeshands-test-${randomBytes(4).toString('hex')}`;
  const conf = join(s.d, 'port.json'), log = join(s.d, 'port.jsonl');
  writeFileSync(conf, JSON.stringify({ owners, status: { name: 'EyesHands', version: '0.1.0', running: true, port: name,
    grants: { accessibility: true, screen_recording: true }, access: { policy: 'ok', owners: {} },
    hands: { lease: false, busy: false }, targets: { file: join(s.profile, 'eyeshands/targets.json'), state: 'missing', count: 0 },
    ...status } }));
  const child = spawn('python3', [FAKE, name, conf, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', b => String(b).includes('ready') && resolve());
    child.on('exit', c => reject(new Error(`fake port exited ${c}`)));
  });
  s.env.EYESHANDS_PORT = name;
  return () => child.kill();
}

const repoState = () => spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--ignored', '--', 'modules', 'lib'],
  { encoding: 'utf8' }).stdout;

test('fresh install: links the Spoon, loader and CLI into this module, and nothing outside the temp HOME', { skip }, () => {
  const before = repoState();
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(realpathSync(s.links.spoon), realpathSync(join(MOD, 'EyesHands.spoon')));
  assert.equal(realpathSync(s.links.loader), realpathSync(join(MOD, 'loader.lua')));
  assert.equal(realpathSync(s.links.cli), realpathSync(join(MOD, 'bin/eyeshands')));
  for (const l of Object.values(s.links)) assert.ok(lstatSync(l).isSymbolicLink(), l);
  // Registers nothing with Claude Code without --mcp: it only prints the line.
  assert.deepEqual(s.claude(), []);
  assert.match(r.stdout, new RegExp(`MCP \\(not registered\\): claude mcp add --scope user eyeshands -- ${s.links.cli} mcp --owner ${OWNER}`));
  assert.match(r.stdout, /Access \(default deny; harness-session has none\): eyeshands access allow harness-session eyes,shot,hands/);
  assert.match(r.stdout, /Targets \(optional.*cp .*targets\.example\.json .*profile\/eyeshands\/targets\.json/);
  assert.match(r.stdout, /Hammerspoon is not running; the Spoon starts with it/);
  assert.deepEqual(s.acted(), []);
  // Writes only the three links (and their folders) in HOME; the access and targets files stay unwritten.
  assert.ok(!existsSync(join(s.profile, 'hammerspoon')) && !existsSync(join(s.profile, 'eyeshands')));
  assert.ok(!existsSync(join(s.home, '.claude')), 'nothing replaced, so no backup folder');
  assert.deepEqual(readdirSync(join(s.home, '.hammerspoon')).sort(), ['Spoons', 'init.lua', 'local']);
  assert.equal(repoState(), before, 'the checkout gains no file (no __pycache__, no logs)');
});

test('idempotent: a second run changes nothing and makes no backup', { skip }, () => {
  const s = sandbox();
  assert.equal(s.run().status, 0);
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /linked|backed up/);
  assert.ok(!existsSync(join(s.home, '.claude')));
  assert.equal(readlinkSync(s.links.loader), join(MOD, 'loader.lua'));
});

test('a file already at a link path is backed up first', { skip }, () => {
  const s = sandbox();
  mkdirSync(dirname(s.links.loader), { recursive: true });
  writeFileSync(s.links.loader, '-- old loader\n');
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /backed up .*eyeshands\.lua -> .*\.claude\/backups\/harness-/);
  const backups = join(s.home, '.claude/backups');
  const [run] = readdirSync(backups);
  assert.equal(readFileSync(join(backups, run, 'hammerspoon__local__eyeshands.lua'), 'utf8'), '-- old loader\n');
  assert.equal(realpathSync(s.links.loader), realpathSync(join(MOD, 'loader.lua')));
});

test('needs the hammerspoon module: without the harness config it links nothing', { skip }, () => {
  const s = sandbox({ hsConfig: false });
  const r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Install the hammerspoon module first/);
  assert.ok(!existsSync(s.links.spoon) && !existsSync(s.links.cli));
});

test('MCP: --mcp registers harness-session with Claude Code; an existing entry is left alone', { skip }, () => {
  const s = sandbox();
  assert.equal(s.run('--mcp').status, 0);
  assert.deepEqual(s.claude(), [`claude mcp add --scope user eyeshands -- ${s.links.cli} mcp --owner ${OWNER}`]);
  const t = sandbox();
  writeFileSync(join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { eyeshands: { command: 'eyeshands' } } }));
  const r = t.run('--mcp');
  assert.deepEqual(t.claude(), []);
  assert.match(r.stdout, /MCP: Claude Code already has an eyeshands server/);
});

test('the access hint goes away once harness-session is enabled in HS_ACCESS_FILE (read, never written)', { skip }, () => {
  const s = sandbox();
  const access = join(s.d, 'access.json');
  const text = JSON.stringify({ owners: { [OWNER]: { enabled: true, capabilities: ['eyes'] } } });
  writeFileSync(access, text);
  writeFileSync(join(s.d, 'harness.env'), `PROFILE_DIR="${s.profile}"\nHS_ACCESS_FILE="${access}"\n`);
  const r = s.run();
  assert.doesNotMatch(r.stdout, /Access \(default deny/);
  assert.equal(readFileSync(access, 'utf8'), text);
});

test('running without the Spoon: one restart through the hammerspoon module, and it says why', { skip }, () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] }, port: { owners: {} } } });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [QUIT, OPEN]);
  assert.match(r.stdout, /restarting Hammerspoon: the Eyes & Hands Spoon is not loaded yet/);
});

test('running without the Spoon, but awake mode is held or a harness owner is armed: restart deferred', { skip }, () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: ['night-job'] }, port: { owners: { runner: { armed: true } } } } });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), [], 'never quits Hammerspoon under a hold or an arm');
  assert.match(r.stdout, new RegExp(`restart deferred: the Eyes & Hands Spoon is not loaded yet, but awake mode is held by night-job and armed: runner\\. Run ${INSTALL} again`));
});

test('the Spoon already runs: no restart; --restart restarts, deferred while Eyes & Hands is busy', { skip }, async () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  let stop = await fakePort(s);
  try {
    let r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.acted(), []);
    assert.match(r.stdout, /Eyes & Hands already runs; not restarting\. To load changed Spoon code: .* --restart/);
    r = s.run('--restart');
    assert.deepEqual(s.acted(), [QUIT, OPEN]);
    assert.match(r.stdout, /restarting Hammerspoon: --restart asked to load the Spoon again/);
  } finally { stop(); }

  const t = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  stop = await fakePort(t, { access: { policy: 'ok', owners: { agent: { enabled: true, armed: true } } }, hands: { lease: 'agent', busy: 7 } });
  try {
    const r = t.run('--restart');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(t.acted(), [], 'a restart would drop the arm and abort the job');
    assert.match(r.stdout, new RegExp(`restart deferred: --restart asked to load the Spoon again, but Eyes & Hands is busy \\(armed: agent; a hands job runs \\(job 7\\); agent holds the hands lease\\)\\. Run ${INSTALL} --restart again`));
  } finally { stop(); }
});

test('the stop switch is on: --restart and --uninstall defer the restart, so the person keeps the hold', { skip }, async () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  assert.equal(s.run('--no-restart').status, 0);
  const stop = await fakePort(s, { stop: { stopped: true, by: 'hotkey', until: '2026-11-11T10:30:00Z', retry_after_s: 1500 } });
  try {
    let r = s.run('--restart');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.acted(), [], 'a restart would clear the stop hold');
    assert.match(r.stdout, /restart deferred: .*Eyes & Hands is busy \(the stop switch is on until 2026-11-11T10:30:00Z\)/);
    r = s.run('--uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.acted(), []);
    assert.match(r.stdout, new RegExp(`restart deferred: Eyes & Hands was uninstalled and its Spoon still runs, but Eyes & Hands is busy \\(the stop switch is on until 2026-11-11T10:30:00Z\\)\\. Run ${INSTALL} --uninstall again`));
  } finally { stop(); }
});

test('--no-restart only links', { skip }, () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  const r = s.run('--no-restart');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.acted(), []);
  assert.match(r.stdout, /Not restarting \(--no-restart\)/);
  assert.ok(existsSync(s.links.loader));
});

test('--status: ok after install with the Spoon up; exit 1 when links are missing or the port does not answer', { skip }, async () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  let r = s.run('--status');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MISSING .*EyesHands\.spoon/);
  assert.equal(s.run('--no-restart').status, 0);
  r = s.run('--status');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /The eyeshands port does not answer/);
  const stop = await fakePort(s, { access: { policy: 'ok', owners: { [OWNER]: { enabled: true, armed: true }, off: { enabled: false } } } });
  try {
    r = s.run('--status');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const l of Object.values(s.links)) assert.match(r.stdout, new RegExp(`ok +${l.replace(/[.]/g, '\\.')}`));
    assert.match(r.stdout, /Eyes & Hands 0\.1\.0 runs on port eyeshands-test-/);
    assert.match(r.stdout, /Accessibility: on\nScreen Recording: on/);
    assert.match(r.stdout, /access policy: ok; enabled owners: harness-session; armed: harness-session/);
    assert.match(r.stdout, /MCP: not registered with Claude Code/);
  } finally { stop(); }
  const t = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  t.run('--no-restart');
  const stop2 = await fakePort(t, { grants: { accessibility: false } });
  try {
    r = t.run('--status');
    assert.equal(r.status, 1, 'Accessibility off is not ok');
    assert.match(r.stdout, /Accessibility: OFF/);
  } finally { stop2(); }
  const u = sandbox();
  u.run();
  r = u.run('--status');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Hammerspoon is not running/);
});

test('--uninstall: removes only its own links, keeps the policy files, restarts (deferred) so the Spoon stops', { skip }, async () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  assert.equal(s.run('--no-restart').status, 0);
  const access = join(s.profile, 'hammerspoon/access.json');
  mkdirSync(dirname(access), { recursive: true });
  writeFileSync(access, '{"owners":{}}');
  // Someone else's file at the CLI path is left alone.
  spawnSync('rm', [s.links.cli]);
  writeFileSync(s.links.cli, '#!/bin/sh\n');
  writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { eyeshands: {} } }));
  const stop = await fakePort(s);
  try {
    const r = s.run('--uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(s.links.spoon) && !existsSync(s.links.loader));
    assert.equal(readFileSync(s.links.cli, 'utf8'), '#!/bin/sh\n');
    assert.match(r.stdout, /left .*eyeshands: it is not a link into this module/);
    assert.equal(readFileSync(access, 'utf8'), '{"owners":{}}');
    assert.match(r.stdout, /Kept: the access policy file/);
    assert.match(r.stdout, /claude mcp remove --scope user eyeshands/);
    assert.deepEqual(s.claude(), [], 'the MCP entry goes only with --mcp');
    assert.deepEqual(s.acted(), [QUIT, OPEN]);
    assert.match(r.stdout, /restarting Hammerspoon: Eyes & Hands was uninstalled and its Spoon still runs/);
  } finally { stop(); }
  // Not loaded: nothing to restart.
  const t = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  t.run('--no-restart');
  assert.equal(t.run('--uninstall').status, 0);
  assert.deepEqual(t.acted(), []);
});

test('--dry-run changes nothing', { skip }, () => {
  const s = sandbox({ running: true, harnessStatus: { awake: { owners: [] } } });
  const r = s.run('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(s.home, '.hammerspoon/Spoons')) && !existsSync(join(s.home, '.local')));
  assert.deepEqual(s.acted(), []);
  assert.match(r.stdout, /would: ln -s .*EyesHands\.spoon/);
  assert.match(r.stdout, /would: osascript/);
});

test('example files: access.example.json passes the hsx policy check and enables harness-session', { skip: PY ? false : 'no python3' }, () => {
  const file = join(MOD, 'access.example.json');
  const r = spawnSync('python3', ['-I', join(MOD, 'bin/hsx'), 'access', 'list', '--file', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /harness-session +on +eyes,shot,hands +apps=chrome-agent,com\.apple\.TextEdit/);
  const targets = JSON.parse(readFileSync(join(MOD, 'targets.example.json'), 'utf8'));
  assert.ok(targets.targets['chrome-agent'], 'the example target harness-session may use');
});

test('targets.example.json parses with the Spoon targets.lua', { skip: LUA ? false : 'no Lua 5.4 (brew install lua@5.4)' }, () => {
  const text = readFileSync(join(MOD, 'targets.example.json'), 'utf8');
  const chunk = `TG = targets(${JSON.stringify(text)}); return TG.list()`;
  const r = spawnSync(LUA, [join(MOD, 'test/spoon-driver.lua')], { input: chunk.replace(/\n/g, ' ') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.error, undefined, r.stdout);
  assert.deepEqual(out.targets.map(t => [t.name, t.profile, t.refuse_debug_port]),
    [['chrome-agent', '/home/test/.chrome-agent', true]]);
});

test('loader: starts spoon.EyesHands with the harness access and targets files and an alert, and the config is valid',
  { skip: LUA ? false : 'no Lua 5.4 (brew install lua@5.4)' }, () => {
    const d = mkdtempSync(join(tmpdir(), 'eh-loader-'));
    const link = join(d, 'eyeshands.lua');
    symlinkSync(join(MOD, 'loader.lua'), link);
    // A fake hs: pathToAbsolute resolves the link, execute answers what env.sh would print, and
    // loadSpoon returns a Spoon whose start() checks the config with the real config.lua.
    const driver = `
      local C = dofile(${JSON.stringify(join(MOD, 'EyesHands.spoon/config.lua'))})
      local seen = {}
      hs = {
        fs = { pathToAbsolute = function(p) local h = io.popen("realpath '" .. p .. "'"); local r = h:read("l"); h:close(); return r end,
               attributes = function() return nil end },
        execute = function(cmd) seen.cmd = cmd; return "/acc/access.json\\n/prof/eyeshands/targets.json\\n" end,
        notify = { new = function() return { send = function() seen.notified = true end } end },
        loadSpoon = function(name) seen.name = name; return { start = function(self, cfg)
          seen.cfg = cfg
          local merged, err = C.merge(cfg, "/home/test")
          seen.err = err
          seen.merged = merged
        end } end,
      }
      dofile(${JSON.stringify(link)})
      seen.cfg.alert("test alert")
      print(seen.name, seen.cfg.access_file, seen.cfg.targets_file, type(seen.cfg.alert), tostring(seen.err),
        seen.merged and seen.merged.port, tostring(seen.notified),
        seen.cmd:find(${JSON.stringify(REPO)}, 1, true) and "harness" or seen.cmd)
    `;
    const r = spawnSync(LUA, ['-e', driver], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [name, access, targets, alertType, err, port, notified, cmd] = r.stdout.trim().split('\n').pop().split('\t');
    assert.deepEqual([name, access, targets, alertType, err, port], ['EyesHands', '/acc/access.json',
      '/prof/eyeshands/targets.json', 'function', 'nil', 'eyeshands']);
    assert.equal(notified, 'true', 'without the notifier, an alert is a macOS notification');
    assert.equal(cmd, 'harness', 'reads harness.env through the harness lib/env.sh');
    assert.match(r.stdout, /eyeshands loader: started/);
  });
