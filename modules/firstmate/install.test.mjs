// node --test modules/firstmate/install.test.mjs
// The firstmate module installer against a throwaway HOME: a home with no zsh startup file gets a
// comment-only ~/.zshrc (zsh's new-user menu would otherwise block run-firstmate.sh), and an existing
// one is left alone. Every tool is a stub that reports a new enough version, so nothing is installed,
// downloaded or cloned, and no tmux session is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('./install.sh', import.meta.url));

function sandbox(modules = 'firstmate') {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fm-install-test-')));
  const home = join(d, 'home'), fm = join(d, 'firstmate'), bin = join(d, 'bin');
  for (const p of [home, bin]) mkdirSync(p, { recursive: true });
  const stub = `#!/bin/sh\ncase "$1" in has-session) exit 1 ;; -V) echo "tmux 99.0" ;; auth) echo '"loggedIn": true' ;; *) echo "stub 99.0.0" ;; esac\n`;
  for (const t of ['git', 'tmux', 'gh', 'node', 'npm', 'jq', 'curl', 'gh-axi', 'chrome-devtools-axi', 'tasks-axi', 'quota-axi',
    'lavish-axi', 'treehouse', 'no-mistakes', 'claude']) {
    writeFileSync(join(bin, t), stub); chmodSync(join(bin, t), 0o755);
  }
  mkdirSync(join(fm, '.git'), { recursive: true });   // "already cloned": the installer leaves it alone
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `FIRSTMATE_DIR="${fm}"\nMODULES="${modules}"\nFIRSTMATE_TELEGRAM=0\nLABEL_PREFIX="test"\nPROFILE_DIR="${d}/profile"\n`);
  // HCRON_JOBS keeps hcron off the real profile (with the cron module off it is never written anyway).
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, HARNESS_ENV: envFile, HCRON_JOBS: join(d, 'jobs.json'), TMPDIR: d };
  const run = (args = []) => spawnSync('/bin/zsh', [INSTALL, ...args], { env, encoding: 'utf8' });
  return { d, home, run };
}

test('a home with no zsh startup file: dry run says it would write ~/.zshrc and writes nothing', () => {
  const s = sandbox();
  const r = s.run(['--dry-run']);
  assert.match(r.stdout, new RegExp(`would write ${s.home}/\\.zshrc \\(a comment only\\)`), r.stdout + r.stderr);
  assert.ok(!existsSync(join(s.home, '.zshrc')));
});

test('a real run writes a comment-only ~/.zshrc once', () => {
  const s = sandbox();
  const r = s.run();
  assert.match(r.stdout, /wrote .*\.zshrc \(a comment only\)/, r.stdout + r.stderr);
  assert.match(readFileSync(join(s.home, '.zshrc'), 'utf8'), /^# Created by the harness firstmate module/);
  assert.doesNotMatch(s.run().stdout, /comment only/);
});

test('an existing zsh startup file is left alone', () => {
  const s = sandbox();
  writeFileSync(join(s.home, '.zprofile'), 'export FOO=1\n');
  const r = s.run(['--dry-run']);
  assert.doesNotMatch(r.stdout, /comment only/);
  assert.ok(!existsSync(join(s.home, '.zshrc')));
});

test('start hint: the "or wait" hcron line only when the cron module is on', () => {
  const off = sandbox().run(['--dry-run']);
  assert.match(off.stdout, /autostart needs the cron module/, off.stdout + off.stderr);
  assert.doesNotMatch(off.stdout, /or wait: hcron/);
  const on = sandbox('firstmate cron').run(['--dry-run']);
  assert.match(on.stdout, /or wait: hcron job firstmate-start/, on.stdout + on.stderr);
  assert.doesNotMatch(on.stdout, /autostart needs the cron module/);
});
