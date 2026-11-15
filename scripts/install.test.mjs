// node --test scripts/install.test.mjs
// install.sh --dry-run with and without launchctl on PATH (a Linux machine has no launchd),
// against a throwaway HOME and profile. A dry run changes nothing, so this never touches launchd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('../install.sh', import.meta.url));

// A bin folder with every system tool except launchctl and gh, plus jq; optionally a fake launchctl.
function sandbox({ launchctl = false } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'install-test-')));
  const bin = join(d, 'bin'), home = join(d, 'home');
  for (const p of [bin, home]) mkdirSync(p, { recursive: true });
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name === 'launchctl' || name === 'gh' || existsSync(join(bin, name))) continue;
      symlinkSync(join(dir, name), join(bin, name));
    }
  }
  if (!existsSync(join(bin, 'jq'))) {
    symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).trim(), join(bin, 'jq'));
  }
  if (launchctl) {
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "$*" >> "$FAKE_LOG"\nexit 1\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
  }
  const args = ['--dry-run', `PROJECTS_DIR=${d}`, `PROFILE_DIR=${d}/profile`, 'PROFILE_REMOTE=', 'MODULES=',
    `MEMORY_DIRS=${home}`, 'LABEL_PREFIX=test'];
  const env = { PATH: `${bin}:${dirname(process.execPath)}`, HOME: home, FAKE_LOG: join(d, 'launchctl.log'), TMPDIR: d };
  return spawnSync('/bin/zsh', [INSTALL, ...args], { env, encoding: 'utf8', input: '' });
}

test('without launchd: no sync agent, a crontab hint, and no launchctl call', () => {
  const r = sandbox();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no launchd here, so no sync agent/);
  assert.match(r.stdout, /crontab: .*scripts\/sync\.sh/);
  assert.doesNotMatch(r.stdout, /launchctl|harness-sync\.plist/);
  assert.match(r.stdout, /would write .*harness\.env/);   // the dry-run env copy (mktemp template) worked
});

test('with launchd: the sync agent plist is written and loaded as before', () => {
  const r = sandbox({ launchctl: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /would write .*LaunchAgents\/com\.test\.harness-sync\.plist/);
  assert.match(r.stdout, /would: launchctl bootstrap gui\/\d+ .*com\.test\.harness-sync\.plist/);
  assert.doesNotMatch(r.stdout, /no launchd here/);
});
