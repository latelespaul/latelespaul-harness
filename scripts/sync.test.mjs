// node --test scripts/sync.test.mjs
// Runs sync.sh on a throwaway profile clone of a throwaway bare remote. sync.sh and lib/env.sh are
// copied into a temp harness folder that is not a git repo, so the framework part is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = fileURLToPath(new URL('..', import.meta.url));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sync-'));
  const harness = join(root, 'harness'), home = join(root, 'home');
  for (const d of [join(harness, 'scripts'), join(harness, 'lib'), home]) mkdirSync(d, { recursive: true });
  copyFileSync(join(HARNESS, 'scripts/sync.sh'), join(harness, 'scripts/sync.sh'));
  copyFileSync(join(HARNESS, 'lib/env.sh'), join(harness, 'lib/env.sh'));
  const remote = join(root, 'remote.git'), profile = join(root, 'profile'), other = join(root, 'other');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  for (const d of [profile, other]) {
    spawnSync('git', ['clone', '-q', remote, d]);
    git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@t');
  }
  writeFileSync(join(profile, 'notes.md'), 'one\n');
  git(profile, 'add', '-A'); git(profile, 'commit', '-q', '-m', 'init'); git(profile, 'push', '-q', '-u', 'origin', 'main');
  git(other, 'pull', '-q', 'origin', 'main'); git(other, 'branch', '-q', '-u', 'origin/main');
  const envFile = join(root, 'harness.env'), alerts = join(root, 'alerts.log');
  writeFileSync(envFile, `PROFILE_DIR="${profile}"\n`);
  const env = { PATH: process.env.PATH, HOME: home, HARNESS_ENV: envFile, SYNC_ALERT_LOG: alerts, GIT_CONFIG_GLOBAL: '/dev/null' };
  const sync = (args = [], extra = {}) => new Promise(resolve => {
    const p = spawn('/bin/zsh', [join(harness, 'scripts/sync.sh'), ...args], { env: { ...env, ...extra } });
    let out = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', status => resolve({ status, out }));
  });
  const alertText = () => existsSync(alerts) ? readFileSync(alerts, 'utf8') : '';
  // pushFromOther: a commit from another machine lands on the remote.
  const pushFromOther = (file, text) => {
    writeFileSync(join(other, file), text);
    git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', `other ${file}`); git(other, 'push', '-q');
  };
  return { root, profile, other, remote, sync, alertText, pushFromOther };
}

test('5 concurrent pulls (plus 2 full syncs) all succeed and land the remote commit', async () => {
  const { profile, remote, sync, alertText, pushFromOther } = setup();
  pushFromOther('other.md', 'from other\n');
  writeFileSync(join(profile, 'local.md'), 'local change\n');
  const runs = await Promise.all([...Array(5)].map(() => sync(['--pull'])).concat([sync(), sync()]));
  for (const r of runs) assert.equal(r.status, 0, r.out);
  assert.equal(alertText(), '');
  assert.ok(existsSync(join(profile, 'other.md')));
  assert.equal(git(profile, 'branch', '--show-current'), 'main');
  assert.match(git(remote, 'ls-tree', '--name-only', 'main'), /local\.md/);
  assert.ok(!existsSync(join(profile, '.git/harness-sync.lock')), 'lock released');
});

test('a sync that cannot get the lock skips quietly; a dead owner\'s lock is taken over', async () => {
  const { profile, sync, alertText, pushFromOther } = setup();
  const lock = join(profile, '.git/harness-sync.lock');
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  let r = await sync(['--pull'], { SYNC_LOCK_WAIT: '1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /another sync holds/);
  writeFileSync(join(lock, 'pid'), '999999\n');
  pushFromOther('other.md', 'x\n');
  r = await sync(['--pull'], { SYNC_LOCK_WAIT: '1' });
  assert.equal(r.status, 0, r.out);
  assert.ok(existsSync(join(profile, 'other.md')));
  assert.equal(alertText(), '');
});

test('a rebase conflict is aborted and the alert says conflict', async () => {
  const { profile, sync, alertText, pushFromOther } = setup();
  pushFromOther('notes.md', 'theirs\n');
  writeFileSync(join(profile, 'notes.md'), 'mine\n');
  git(profile, 'commit', '-q', '-am', 'mine');
  const r = await sync(['--pull']);
  assert.equal(r.status, 1, r.out);
  assert.equal(git(profile, 'branch', '--show-current'), 'main');
  assert.ok(!existsSync(join(profile, '.git/rebase-merge')) && !existsSync(join(profile, '.git/rebase-apply')));
  assert.match(alertText(), /rebase onto origin\/main hit a conflict/);
  assert.doesNotMatch(alertText(), /network/);
});

test('a fetch failure is reported as a fetch failure', async () => {
  const { root, profile, sync, alertText } = setup();
  git(profile, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  const r = await sync(['--pull']);
  assert.equal(r.status, 1, r.out);
  assert.match(alertText(), /fetch from origin failed/);
});

// leaveInterrupted: the state a sync killed right after git took its autostash leaves behind (the
// changes are stashed and reset away, and rebase-merge holds only the autostash, with no head-name).
function leaveInterrupted(profile) {
  writeFileSync(join(profile, 'notes.md'), 'local edit\n');
  const sha = git(profile, 'stash', 'create', 'autostash');
  git(profile, 'reset', '-q', '--hard');
  mkdirSync(join(profile, '.git/rebase-merge'));
  writeFileSync(join(profile, '.git/rebase-merge/autostash'), `${sha}\n`);
  return sha;
}

test('a rebase interrupted after the autostash is quit and the changes come back', async () => {
  const { profile, remote, sync, alertText, pushFromOther } = setup();
  leaveInterrupted(profile);
  pushFromOther('other.md', 'from other\n');
  const r = await sync();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /restored its autostash/);
  assert.ok(!existsSync(join(profile, '.git/rebase-merge')));
  assert.equal(git(profile, 'branch', '--show-current'), 'main');
  assert.equal(git(profile, 'stash', 'list'), '');
  assert.equal(readFileSync(join(profile, 'notes.md'), 'utf8'), 'local edit\n');
  assert.ok(existsSync(join(profile, 'other.md')));
  assert.equal(git(remote, 'show', 'main:notes.md'), 'local edit');
  assert.equal(alertText(), '');
});

test('an autostash taken on another HEAD stays in the stash and the alert says where', async () => {
  const { profile, sync, alertText } = setup();
  const sha = leaveInterrupted(profile);
  writeFileSync(join(profile, 'later.md'), 'later\n');
  git(profile, 'add', '-A'); git(profile, 'commit', '-q', '-m', 'later');
  const r = await sync(['--pull']);
  assert.equal(r.status, 1, r.out);
  assert.ok(!existsSync(join(profile, '.git/rebase-merge')));
  assert.equal(git(profile, 'rev-parse', 'stash@{0}'), sha);
  assert.equal(readFileSync(join(profile, 'notes.md'), 'utf8'), 'one\n');
  assert.match(alertText(), new RegExp(`safe in git stash there \\(autostash ${sha}\\)`));
});

test('a --pull past its time budget skips the rebase instead of risking the hook kill', async () => {
  const { profile, sync, alertText, pushFromOther } = setup();
  pushFromOther('other.md', 'x\n');
  writeFileSync(join(profile, 'local.md'), 'local\n');
  const r = await sync(['--pull'], { SYNC_PULL_BUDGET: '-1' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /not starting a rebase/);
  assert.ok(!existsSync(join(profile, 'other.md')));
  assert.ok(existsSync(join(profile, 'local.md')));
  assert.equal(alertText(), '');
});
