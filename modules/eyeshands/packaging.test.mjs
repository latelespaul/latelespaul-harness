// node --test modules/eyeshands/packaging.test.mjs   (no network; never touches the real home, /Applications or Hammerspoon)
// The disk image build (design part 16, options E and H): packaging/build-dmg.sh refuses a Hammerspoon.app that is
// unsigned, changed after signing or not from the Hammerspoon team, and a download whose SHA-256 is not the pinned
// one. Its layout check refuses anything but the five expected items, and any app, installer, .command script,
// link or binary code outside Hammerspoon.app. The real build (download, sign check, hdiutil) runs in the
// `package` workflow. The CLI copy inside the shipped Spoon installs from ~/.hammerspoon/Spoons and writes
// ~/.local/bin/eyeshands as a new script; uninstall removes that script and leaves the Spoon.
// Needs macOS (codesign) and python3; skips without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const BUILD = here('./packaging/build-dmg.sh');
const README_HTML = here('./packaging/readme-html.py');
const MAC = process.platform === 'darwin' && spawnSync('codesign', ['-h']).error === undefined;
const PY = spawnSync('python3', ['-c', '1']).status === 0;
const skip = !MAC ? 'needs macOS codesign' : !PY ? 'no python3' : false;
const PAGE = 'Read Me First.html';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'eh-pkg-')));
const build = (...args) => spawnSync(BUILD, args, { encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: tmpdir() } });

// A fake Hammerspoon.app with the real bundle id and version; its executable is a shell script, so no real code.
function fakeApp(dir, { sign = false } = {}) {
  const app = join(dir, 'Hammerspoon.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'));
  writeFileSync(join(app, 'Contents', 'MacOS', 'Hammerspoon'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(app, 'Contents', 'MacOS', 'Hammerspoon'), 0o755);
  writeFileSync(join(app, 'Contents', 'Resources', 'setup.lua'), '-- fake\n');
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.hammerspoon.Hammerspoon</string>
<key>CFBundleExecutable</key><string>Hammerspoon</string>
<key>CFBundleShortVersionString</key><string>1.1.1</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  if (sign) {
    const r = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  return app;
}

// A staged image folder with the five expected items (the app is a fake: the layout check reads no signature).
function fakeStage() {
  const dir = tmp(), stage = join(dir, 'stage');
  mkdirSync(stage);
  fakeApp(stage);
  const r = build('--stage-spoon', join(stage, 'EyesHands.spoon'));
  assert.equal(r.status, 0, r.stderr);
  symlinkSync('/Applications', join(stage, 'Applications'));
  writeFileSync(join(stage, PAGE), '<!doctype html><title>x</title>');
  cpSync(here('./packaging/licenses'), join(stage, 'Licenses'), { recursive: true });
  return stage;
}

test('the build refuses an unsigned Hammerspoon.app', { skip }, () => {
  const r = build('--verify-app', fakeApp(tmp()));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codesign --verify --deep --strict failed/);
});

test('the build refuses a signed Hammerspoon.app that changed after signing', { skip }, () => {
  const app = fakeApp(tmp(), { sign: true });
  writeFileSync(join(app, 'Contents', 'Resources', 'setup.lua'), '-- changed\n');
  const r = build('--verify-app', app);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /codesign --verify --deep --strict failed/);
});

test('the build refuses a validly signed app that the Hammerspoon team did not sign', { skip }, () => {
  const app = fakeApp(tmp(), { sign: true });
  assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status, 0, 'the ad-hoc signature itself is valid');
  const r = build('--verify-app', app);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not signed by the Hammerspoon team \(VQCYSNZB89\)/);
});

test('the build refuses a Hammerspoon download whose SHA-256 is not the pinned one, before it unpacks it', { skip }, () => {
  const dir = tmp(), zip = join(dir, 'Hammerspoon.zip');
  writeFileSync(zip, 'not the release');
  const r = build('--out', join(dir, 'dist'), '--hammerspoon-zip', zip);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SHA-256 of .* is [0-9a-f]{64}, not the pinned [0-9a-f]{64}/);
  assert.ok(!existsSync(join(dir, 'dist', 'EyesHands.dmg')));
});

test('the layout check accepts the expected image layout', { skip }, () => {
  const r = build('--check-layout', fakeStage());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /layout of .* is as expected/);
});

test('the shipped Spoon carries the CLI and the same hsx', { skip }, () => {
  const spoon = join(fakeStage(), 'EyesHands.spoon');
  assert.ok(existsSync(join(spoon, 'init.lua')));
  assert.equal(readFileSync(join(spoon, 'bin', 'eyeshands'), 'utf8'), readFileSync(here('./bin/eyeshands'), 'utf8'));
  assert.equal(readFileSync(join(spoon, 'bin', 'hsx'), 'utf8'), readFileSync(here('./bin/hsx'), 'utf8'));
  assert.ok(lstatSync(join(spoon, 'bin', 'eyeshands')).mode & 0o100, 'the CLI is executable');
});

for (const [name, change, why] of [
  ['a .command script', s => writeFileSync(join(s, 'Install.command'), '#!/bin/sh\n'), /unexpected top level|forbidden item/],
  ['an installer package in the Spoon', s => writeFileSync(join(s, 'EyesHands.spoon', 'setup.pkg'), 'x'), /forbidden item/],
  ['an unsigned app in the Spoon', s => mkdirSync(join(s, 'EyesHands.spoon', 'Helper.app')), /forbidden item/],
  ['a link inside the Spoon', s => symlinkSync('/etc/hosts', join(s, 'EyesHands.spoon', 'hosts')), /forbidden item/],
  ['binary code outside Hammerspoon.app', s => copyFileSync('/usr/bin/true', join(s, 'Licenses', 'tool')), /binary code outside/],
  ['an Applications item that is not a link', s => {
    spawnSync('rm', [join(s, 'Applications')]);
    mkdirSync(join(s, 'Applications'));
  }, /not a link to \/Applications/],
  ['no Read Me page', s => spawnSync('rm', [join(s, PAGE)]), /unexpected top level/],
]) {
  test(`the layout check refuses ${name}`, { skip }, () => {
    const stage = fakeStage();
    change(stage);
    const r = build('--check-layout', stage);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, why);
  });
}

test('the Read Me page is the README as one self-contained page', { skip }, () => {
  const out = join(tmp(), PAGE);
  const r = spawnSync('python3', ['-I', README_HTML, here('./README.md'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const page = readFileSync(out, 'utf8');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>Eyes &amp; Hands: Read Me First<\/title>/);
  assert.match(page, /<h2>Install from the disk image<\/h2>/);
  assert.match(page, /<table>.*<th>Grant<\/th>/s);
  assert.match(page, /<pre><code>python3 ~\/.hammerspoon\/Spoons\/EyesHands.spoon\/bin\/eyeshands install<\/code><\/pre>/);
  assert.doesNotMatch(page, /\*\*|<script|https?:\/\/(?!github\.com|hammerspoon\.org)[^"]*"/);
});

// The Spoon's own CLI copy in a throwaway HOME: as Hammerspoon leaves it after a double-click on the Spoon.
function spoonWorld() {
  const dir = tmp(), home = join(dir, 'home');
  mkdirSync(join(home, '.hammerspoon', 'Spoons'), { recursive: true });
  writeFileSync(join(home, '.hammerspoon', 'init.lua'), 'hs.alert.show("mine")\n');
  const spoon = join(home, '.hammerspoon', 'Spoons', 'EyesHands.spoon');
  assert.equal(build('--stage-spoon', spoon).status, 0);
  const run = (cli, args) => spawnSync('python3', [cli, ...args], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, HARNESS_ENV: join(dir, 'no-harness.env'), EYESHANDS_PORT: 'eyeshands-test-unused',
      EYESHANDS_HAMMERSPOON_APP: join(dir, 'no', 'Hammerspoon.app'), EYESHANDS_ACCESS_FILE: '' },
  });
  return { dir, home, spoon, cli: join(spoon, 'bin', 'eyeshands'), run };
}

test('the Spoon CLI installs from the installed Spoon: a new script in ~/.local/bin, no Spoon link', { skip }, () => {
  const w = spoonWorld();
  const r = w.run(w.cli, ['install', '--yes']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stdout, /link .*EyesHands\.spoon/);
  const bin = join(w.home, '.local', 'bin', 'eyeshands');
  assert.ok(lstatSync(bin).isFile() && !lstatSync(bin).isSymbolicLink(), 'a new file, not a link into the Spoon');
  assert.match(readFileSync(bin, 'utf8'), /exec \/usr\/bin\/env python3 .*EyesHands\.spoon\/bin\/eyeshands/);
  assert.ok(lstatSync(w.spoon).isDirectory() && !lstatSync(w.spoon).isSymbolicLink());
  assert.match(readFileSync(join(w.home, '.hammerspoon', 'init.lua'), 'utf8'), /hs\.loadSpoon\("EyesHands"\):start\(\)/);
  assert.ok(existsSync(join(w.home, '.config', 'eyeshands', 'access.json')));
  const help = spawnSync(bin, ['--help'], { encoding: 'utf8', env: { ...process.env, HOME: w.home } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /eyeshands install/);
  assert.match(w.run(w.cli, ['install', '--yes']).stdout, /already installed from this Spoon/);

  const u = w.run(w.cli, ['uninstall', '--yes']);
  assert.equal(u.status, 0, u.stderr + u.stdout);
  assert.ok(!existsSync(bin));
  assert.ok(existsSync(join(w.spoon, 'init.lua')), 'uninstall leaves the Spoon that Hammerspoon installed');
  assert.match(u.stdout, /Hammerspoon installed it/);
  assert.equal(readFileSync(join(w.home, '.hammerspoon', 'init.lua'), 'utf8'), 'hs.alert.show("mine")\n');
});

test('the Spoon CLI refuses to install from a copy that is not the installed Spoon (for example the mounted image)', { skip }, () => {
  const w = spoonWorld();
  const elsewhere = join(w.dir, 'Volumes', 'Eyes & Hands', 'EyesHands.spoon');
  assert.equal(build('--stage-spoon', elsewhere).status, 0);
  const r = w.run(join(elsewhere, 'bin', 'eyeshands'), ['install', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not from the installed Spoon\. Double-click EyesHands\.spoon/);
  assert.ok(!existsSync(join(w.home, '.local', 'bin', 'eyeshands')));
});

test('the Spoon CLI refuses to overwrite a ~/.local/bin/eyeshands that it did not write', { skip }, () => {
  const w = spoonWorld();
  mkdirSync(join(w.home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(w.home, '.local', 'bin', 'eyeshands'), '#!/bin/sh\necho mine\n');
  const r = w.run(w.cli, ['install', '--yes']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not the script that this install writes/);
  assert.equal(readFileSync(join(w.home, '.local', 'bin', 'eyeshands'), 'utf8'), '#!/bin/sh\necho mine\n');
});
