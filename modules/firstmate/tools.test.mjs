// node --test modules/firstmate/tools.test.mjs
// tools.sh --dry-run under a fake uname: picks the right pinned release archive and hash per OS/CPU,
// and gives Linux package-manager hints instead of Homebrew. A dry run downloads and installs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = fileURLToPath(new URL('./tools.sh', import.meta.url));

function run(os, arch, args = ['--dry-run'], { noHires = false } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'fm-tools-test-')));
  const bin = join(d, 'bin'), home = join(d, 'home');
  for (const p of [bin, home]) mkdirSync(p, { recursive: true });
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; *) echo ${os} ;; esac\n`);
  chmodSync(join(bin, 'uname'), 0o755);
  if (noHires) {   // a perl without Time::HiRes, like a minimal Oracle Linux install
    writeFileSync(join(bin, 'perl'), '#!/bin/sh\ncase "$1" in -MTime::HiRes) exit 2 ;; esac\nexec /usr/bin/perl "$@"\n');
    chmodSync(join(bin, 'perl'), 0o755);
  }
  writeFileSync(join(d, 'harness.env'), '');
  // Only system folders after the fake: no brew, npm, treehouse or no-mistakes, so each takes its install path.
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, HARNESS_ENV: join(d, 'harness.env') };
  return spawnSync('/bin/zsh', [TOOLS, ...args], { env, encoding: 'utf8' });
}

const url = (name, pin, plat) => `https://github.com/kunchenguid/${name}/releases/download/v${pin}/${name}-v${pin}-${plat}.tar.gz`;

test('Linux x86_64 picks the linux-amd64 archives and their pinned hashes', () => {
  const r = run('Linux', 'x86_64');
  assert.ok(r.stdout.includes(`would download ${url('treehouse', '3.1.8', 'linux-amd64')}, check sha256 bd6227d909ba8046263ae5d4e072ccbcf43010cac9d7289b1262126510edfeed`), r.stdout);
  assert.ok(r.stdout.includes(`would download ${url('no-mistakes', '1.84.0', 'linux-amd64')}, check sha256 b0fb8a9df412c5fa1fb92a3584ffa1d4d5b4d6e0d1738efa2f8b88320f8bf1c2`), r.stdout);
  assert.doesNotMatch(r.stdout, /brew\.sh/);
  assert.match(r.stdout, /No Homebrew \(Linux\)/);
});

test('Linux aarch64 picks the linux-arm64 archives', () => {
  const r = run('Linux', 'aarch64');
  assert.ok(r.stdout.includes(`${url('treehouse', '3.1.8', 'linux-arm64')}, check sha256 3d1c02c8ab13049709ace66be51d99b72fe7b6d0b73d0d0efd90f226e1aa87d1`), r.stdout);
  assert.ok(r.stdout.includes(`${url('no-mistakes', '1.84.0', 'linux-arm64')}, check sha256 8d8cefd927b7f921c207e4dd6c575081dc255dc068f0205f74b52e482bf2f7ab`), r.stdout);
});

test('macOS keeps the darwin archives and the Homebrew hint', () => {
  const r = run('Darwin', 'arm64');
  assert.ok(r.stdout.includes(`${url('treehouse', '3.1.8', 'darwin-arm64')}, check sha256 007c55c26e0bd8b672b1a917465f06c3f89d93a66cd171364ffb65743d268601`), r.stdout);
  assert.ok(r.stdout.includes(`${url('no-mistakes', '1.84.0', 'darwin-arm64')}, check sha256 2e5f838303ab727edccd1a60a4834068024606c68ae7d97fdc0fdeecd7bd4d90`), r.stdout);
  assert.match(r.stdout, /brew\.sh/);
});

test('--status on Linux names the package manager, not Homebrew, for a missing brew tool', () => {
  const r = run('Linux', 'x86_64', ['--status']);
  const gh = r.stdout.split('\n').find(l => / gh /.test(` ${l} `) && l.startsWith('MISSING'));
  if (gh) assert.match(gh, /package manager/);
  assert.doesNotMatch(r.stdout, /brew install/);
});

test('perl Time::HiRes: ok when present, MISSING with a package-manager hint on Linux when not', () => {
  assert.match(run('Linux', 'x86_64', ['--status']).stdout, /^ok {7}perl Time::HiRes$/m);
  const r = run('Linux', 'x86_64', ['--status'], { noHires: true });
  assert.match(r.stdout, /^MISSING {2}perl Time::HiRes \(install: your package manager, e\.g\. sudo dnf install perl-Time-HiRes\)$/m);
  assert.equal(r.status, 1);
});
