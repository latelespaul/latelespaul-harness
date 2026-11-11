// node --test modules/eyeshands/standalone.test.mjs   (never touches the real home, Hammerspoon or its ports)
// The standalone `eyeshands install` / `uninstall` (a clone with no harness; design parts 16 A and 17):
// it shows every change and asks first, links the Spoon and the CLI, backs up ~/.hammerspoon/init.lua and
// adds a marked loader block, creates a default-deny access file, and wires MCP clients only when asked.
// Uninstall removes exactly what install added. It refuses inside a configured harness, when another tool
// owns init.lua, and when a file it would link is not its own.
// Every run uses a throwaway HOME, no harness (HARNESS_ENV points at nothing), an unused port name and a
// stub `claude`. Needs python3; skips without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const CLI = here('./bin/eyeshands');
const MODULE = realpathSync(here('.'));
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const skip = PY ? false : 'no python3';

// A throwaway world: dir/home is HOME; dir/bin holds a stub `claude` that logs to dir/claude.log.
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eh-standalone-')));
  const home = join(dir, 'home'), bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "$*" >> '${join(dir, 'claude.log')}'
case "$2" in
  add) printf '{"mcpServers":{"eyeshands":{"type":"stdio"}}}' > "$HOME/.claude.json" ;;
  remove) printf '{"mcpServers":{}}' > "$HOME/.claude.json" ;;
esac
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const run = (args, { env = {}, input = '' } = {}) => spawnSync(CLI, args, {
    input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, HARNESS_ENV: join(dir, 'no-harness.env'), EYESHANDS_PORT: 'eyeshands-test-unused',
      EYESHANDS_HAMMERSPOON_APP: join(dir, 'no', 'Hammerspoon.app'), EYESHANDS_ACCESS_FILE: '',
      PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  const claudeLog = () => existsSync(join(dir, 'claude.log')) ? readFileSync(join(dir, 'claude.log'), 'utf8') : '';
  return { dir, home, run, claudeLog, h: (...p) => join(home, ...p) };
}

// Every file, link and folder under root: path -> content, link target or "dir".
function tree(root) {
  const out = {};
  const walk = rel => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name, full = join(root, r), st = lstatSync(full);
      if (st.isSymbolicLink()) out[r] = `-> ${readlinkSync(full)}`;
      else if (st.isDirectory()) { out[r] = 'dir'; walk(r); }
      else out[r] = readFileSync(full, 'utf8');
    }
  };
  walk('');
  return out;
}

const INIT = 'hs.alert.show("my own config")';   // no final newline: uninstall must give it back byte for byte
const CODEX = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n';
const CURSOR = '{"mcpServers":{"other":{"command":"other","args":[]}}}';

function seed(w) {
  mkdirSync(w.h('.hammerspoon'), { recursive: true });
  writeFileSync(w.h('.hammerspoon', 'init.lua'), INIT);
  mkdirSync(w.h('.codex'));
  writeFileSync(w.h('.codex', 'config.toml'), CODEX);
  mkdirSync(w.h('.cursor'));
  writeFileSync(w.h('.cursor', 'mcp.json'), CURSOR);
}

test('a dry run and an unanswered question change nothing', { skip }, () => {
  const w = world();
  seed(w);
  const before = tree(w.home);
  const dry = w.run(['install', '--dry-run', '--mcp', 'all']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /will make these changes/);
  assert.match(dry.stdout, /-- >>> eyeshands/, 'the block is shown before it is added');
  assert.match(dry.stdout, /Dry run: nothing changed/);
  const asked = w.run(['install']);   // stdin is not a terminal and there is no --yes
  assert.equal(asked.status, 1);
  assert.match(asked.stderr, /add --yes/);
  assert.deepEqual(tree(w.home), before);
  assert.equal(w.claudeLog(), '');
});

test('install, then uninstall, gives back exactly the home it found', { skip }, () => {
  const w = world();
  seed(w);
  const before = tree(w.home);
  const r = w.run(['install', '--yes', '--mcp', 'all']);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  assert.equal(realpathSync(w.h('.hammerspoon', 'Spoons', 'EyesHands.spoon')), join(MODULE, 'EyesHands.spoon'));
  assert.equal(realpathSync(w.h('.local', 'bin', 'eyeshands')), join(MODULE, 'bin', 'eyeshands'));
  const init = readFileSync(w.h('.hammerspoon', 'init.lua'), 'utf8');
  assert.ok(init.startsWith(INIT + '\n'), 'the person\'s config stays first, unchanged');
  assert.match(init, /-- >>> eyeshands[^\n]*\ndo\n  local ok, err = pcall\(function\(\) hs\.loadSpoon\("EyesHands"\):start\(\) end\)/);
  assert.match(init, /-- <<< eyeshands\n$/);
  const backups = readdirSync(w.h('.config', 'eyeshands', 'backups'));
  const initBackup = backups.find(n => n.startsWith('init.lua.'));
  assert.equal(readFileSync(w.h('.config', 'eyeshands', 'backups', initBackup), 'utf8'), INIT);

  const access = JSON.parse(readFileSync(w.h('.config', 'eyeshands', 'access.json'), 'utf8'));
  assert.deepEqual(access.owners, {}, 'default deny: no owner');
  assert.equal(statSync(w.h('.config', 'eyeshands', 'access.json')).mode & 0o777, 0o600);
  assert.equal(statSync(w.h('.config', 'eyeshands')).mode & 0o777, 0o700);

  const cli = w.h('.local', 'bin', 'eyeshands');
  assert.match(readFileSync(w.h('.codex', 'config.toml'), 'utf8'),
    new RegExp(`^${CODEX.replace(/[[\].]/g, '\\$&')}\\n# >>> eyeshands[^\\n]*\\n\\[mcp_servers\\.eyeshands\\]\\ncommand = "${cli}"\\nargs = \\["mcp", "--owner", "codex"\\]\\n# <<< eyeshands\\n$`));
  assert.deepEqual(JSON.parse(readFileSync(w.h('.cursor', 'mcp.json'), 'utf8')).mcpServers,
    { other: { command: 'other', args: [] }, eyeshands: { command: cli, args: ['mcp', '--owner', 'cursor'] } });
  assert.equal(w.claudeLog(), `mcp add --scope user eyeshands -- ${cli} mcp --owner claude-code\n`);
  assert.match(r.stdout, /Reload Config/, 'it tells the person to reload');
  assert.match(r.stdout, /eyeshands access allow claude-code/);
  assert.match(r.stdout, /PASS +the Spoon loads at start/, 'the doctor ran');

  const again = w.run(['install', '--yes', '--mcp', 'all']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already installed/);

  const u = w.run(['uninstall', '--yes']);
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.match(w.claudeLog(), /mcp remove --scope user eyeshands\n$/);
  const after = tree(w.home);
  assert.equal(after['.hammerspoon/init.lua'], INIT);
  assert.equal(after['.codex/config.toml'], CODEX);
  assert.deepEqual(JSON.parse(after['.cursor/mcp.json']), JSON.parse(CURSOR));
  assert.equal(after['.local'], undefined, 'the folders install made are gone');
  assert.equal(after['.hammerspoon/Spoons'], undefined);
  assert.deepEqual(JSON.parse(after['.config/eyeshands/install.json']).uninstalled, true,
    'only a short record of the folders that kept files hold stays');
  assert.ok(after['.config/eyeshands/access.json'], 'the access file stays without --purge');
  assert.match(u.stdout, /Kept \(add --purge to delete\)/);

  const p = w.run(['uninstall', '--yes', '--purge']);
  assert.equal(p.status, 0, p.stderr);
  const purged = tree(w.home);
  delete purged['.claude.json'];   // the stub claude's own file
  for (const k of Object.keys(before)) if (k.startsWith('.cursor/')) assert.deepEqual(JSON.parse(purged[k]), JSON.parse(before[k]));
  for (const k of Object.keys(purged)) if (k.startsWith('.cursor/')) purged[k] = before[k];
  assert.deepEqual(purged, before);
});

test('a fresh home: install creates init.lua, uninstall removes it and the folders it made', { skip }, () => {
  const w = world();
  const r = w.run(['install', '--yes']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(w.h('.hammerspoon', 'init.lua'), 'utf8'), /^-- >>> eyeshands/);
  assert.equal(w.claudeLog(), '', 'no MCP client without --mcp');
  assert.equal(existsSync(w.h('.codex')) || existsSync(w.h('.cursor')), false);
  const u = w.run(['uninstall', '--yes', '--purge']);
  assert.equal(u.status, 0, u.stderr);
  assert.deepEqual(tree(w.home), {});
});

test('uninstall keeps what the person changed after the install', { skip }, () => {
  const w = world();
  seed(w);
  assert.equal(w.run(['install', '--yes', '--mcp', 'cursor']).status, 0);
  const f = w.h('.hammerspoon', 'init.lua');
  writeFileSync(f, '-- top\n' + readFileSync(f, 'utf8') + '-- bottom\n');
  const doc = JSON.parse(readFileSync(w.h('.cursor', 'mcp.json'), 'utf8'));
  doc.mcpServers.eyeshands.args.push('--minutes', '5');
  writeFileSync(w.h('.cursor', 'mcp.json'), JSON.stringify(doc));
  const u = w.run(['uninstall', '--yes']);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(readFileSync(f, 'utf8'), `-- top\n${INIT}-- bottom\n`);
  assert.match(u.stdout, /left mcpServers\.eyeshands .*changed after the install/);
  assert.ok(JSON.parse(readFileSync(w.h('.cursor', 'mcp.json'), 'utf8')).mcpServers.eyeshands);
});

test('uninstall removes a block the person edited (a hold file) by its markers', { skip }, () => {
  const w = world();
  seed(w);
  assert.equal(w.run(['install', '--yes']).status, 0);
  const f = w.h('.hammerspoon', 'init.lua');
  writeFileSync(f, readFileSync(f, 'utf8').replace(':start()', ':start({ hold_file = "~/.config/eyeshands/driver.lock" })') + '-- mine\n');
  const u = w.run(['uninstall', '--yes']);
  assert.equal(u.status, 0, u.stderr);
  assert.equal(readFileSync(f, 'utf8'), `${INIT}\n\n-- mine\n`);
});

test('refusals: a harness, a linked init.lua, the harness loader, a foreign Spoon', { skip }, () => {
  // Inside a configured harness: the module install owns these paths.
  let w = world();
  const env = join(w.dir, 'harness.env');
  writeFileSync(env, `PROFILE_DIR=${join(w.dir, 'profile')}\n`);
  let before = tree(w.home);
  for (const op of ['install', 'uninstall']) {
    const r = w.run([op, '--yes'], { env: { HARNESS_ENV: env } });
    assert.equal(r.status, 1, op);
    assert.match(r.stderr, /configured harness/);
  }
  assert.deepEqual(tree(w.home), before);

  // init.lua is a link: another tool owns the config, so nothing is edited and the block is printed.
  w = world();
  mkdirSync(w.h('.hammerspoon'), { recursive: true });
  const owned = join(w.dir, 'their-init.lua');
  writeFileSync(owned, '-- theirs\n');
  symlinkSync(owned, w.h('.hammerspoon', 'init.lua'));
  before = tree(w.home);
  let r = w.run(['install', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is a link to .*Add these lines/s);
  assert.equal(readFileSync(owned, 'utf8'), '-- theirs\n');
  assert.deepEqual(tree(w.home), before);

  // The harness loader exists, or something else sits where the Spoon link goes.
  for (const [rel, make] of [[['.hammerspoon', 'local', 'eyeshands.lua'], p => writeFileSync(p, '-- loader\n')],
                             [['.hammerspoon', 'Spoons', 'EyesHands.spoon'], p => mkdirSync(p)]]) {
    w = world();
    mkdirSync(join(w.home, ...rel.slice(0, -1)), { recursive: true });
    make(w.h(...rel));
    before = tree(w.home);
    r = w.run(['install', '--yes']);
    assert.equal(r.status, 1, rel.join('/'));
    assert.match(r.stderr, /not installing/);
    assert.deepEqual(tree(w.home), before);
  }
});

test('--mcp takes only known clients', { skip }, () => {
  const w = world();
  const r = w.run(['install', '--dry-run', '--mcp', 'claude-code,windsurf']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--mcp takes/);
});
