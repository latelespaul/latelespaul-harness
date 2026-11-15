// node --test modules/macnode/install.test.mjs
// The macnode installer on both sides, against a throwaway HOME and harness.env. The Mac side writes
// its keepalive job into a throwaway hcron jobs file (HCRON_JOBS); no launchd, no ssh, no key is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, statSync, realpathSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = fileURLToPath(new URL('./install.sh', import.meta.url));
const CLI = fileURLToPath(new URL('./mac-node.mjs', import.meta.url));

function sandbox(t, env) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mn-install-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const home = join(d, 'home');
  mkdirSync(home, { recursive: true });
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `PROFILE_DIR="${d}/profile"\nLABEL_PREFIX="test"\nMACNODE_DIR="${d}/state"\n${env}\n`);
  const jobs = join(d, 'jobs.json');
  const run = (args = [], input = '') => spawnSync('/bin/zsh', [INSTALL, ...args], { encoding: 'utf8', input,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, HARNESS_ENV: envFile, HCRON_JOBS: jobs,
      HCRON_STATE: join(d, 'hcron-state'), HCRON_LOGS: join(d, 'hcron-logs'), HARNESS_SKIP_LAUNCHD: '1', TMPDIR: d } });
  return { d, home, jobs, run, state: join(d, 'state') };
}

test('vm side: a dry run changes nothing; a real run links mac-node and makes private state folders', t => {
  const s = sandbox(t, 'MACNODE_ROLE=vm\nMODULES="macnode"');
  const dry = s.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /would: ln -s .*mac-node\.mjs .*\.local\/bin\/mac-node/);
  assert.ok(!existsSync(s.state) && !existsSync(join(s.home, '.local/bin/mac-node')));
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readlinkSync(join(s.home, '.local/bin/mac-node')), CLI);
  for (const sub of ['', 'link', 'queue', 'results']) assert.equal(statSync(join(s.state, sub)).mode & 0o777, 0o700, `state/${sub}`);
  const bin = join(s.home, '.local/bin/mac-node'), node = join(dirname(process.execPath), 'node');   // the first node on PATH
  assert.ok(r.stdout.includes(`restrict,command="${node} ${bin} bridge" <the Mac's mac-node_ed25519.pub>`), r.stdout);
  assert.doesNotMatch(r.stdout, /port-forwarding|permitlisten|permitopen|MACNODE_VM_DIR/);
  // --key-line: one restricted line for the Mac's public key, from stdin or a file; anything else is refused.
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkey mac-node';
  const want = `restrict,command="${node} ${bin} bridge" ${key}\n`;
  const kl = s.run(['--key-line', '-'], `${key}\n`);
  assert.equal(kl.status, 0, kl.stderr);
  assert.equal(kl.stdout, want);
  writeFileSync(join(s.d, 'k.pub'), `${key}\n`);
  assert.equal(s.run(['--key-line', join(s.d, 'k.pub')]).stdout, want);
  for (const bad of ['', 'not a key', `command="sh" ${key}`, `${key}"`, `restrict ${key}`, 'ssh-ed25519 AAAA bad"comment']) {
    const b = s.run(['--key-line', '-'], bad);
    assert.equal(b.status, 1, `refused: ${bad}`);
    assert.equal(b.stdout, '');
  }
  // --status: installed, link down (no Mac) is still a healthy install on the VM.
  const st = s.run(['--status']);
  assert.equal(st.status, 0, st.stdout + st.stderr);
  assert.match(st.stdout, /link: down/);
});

test('vm side --status before install says so and fails', t => {
  const s = sandbox(t, 'MACNODE_ROLE=vm');
  const st = s.run(['--status']);
  assert.equal(st.status, 1);
  assert.match(st.stdout, /not installed/);
});

test('mac side without its settings, key or the cron module lists what is missing and adds no job', t => {
  const s = sandbox(t, 'MACNODE_ROLE=mac\nMODULES="macnode"');
  const r = s.run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const want of [/set MACNODE_VM=/, /ssh-keygen -t ed25519 -N '' -C mac-node -f .*\/\.ssh\/mac-node_ed25519/, /add cron to MODULES/])
    assert.match(r.stdout, want);
  assert.ok(!existsSync(s.jobs), 'no hcron job without the settings');
  assert.ok(!existsSync(join(s.home, '.ssh')), 'the installer never makes a key');
});

test('mac side, complete: registers the hcron keepalive job (no plist) and prints how to send the key', t => {
  const s = sandbox(t, '');
  mkdirSync(join(s.home, '.ssh'));
  writeFileSync(join(s.home, '.ssh/mac-node_ed25519'), 'not a real key\n');
  writeFileSync(join(s.home, '.ssh/mac-node_ed25519.pub'), 'ssh-ed25519 AAAAtestkey mac-node\n');
  writeFileSync(join(s.d, 'harness.env'), readFileSync(join(s.d, 'harness.env'), 'utf8') +
    'MACNODE_ROLE=mac\nMODULES="cron macnode"\nMACNODE_VM="tester@vm.invalid"\n');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const job = JSON.parse(readFileSync(s.jobs, 'utf8')).jobs['mac-node'];
  assert.deepEqual({ cron: job.cron, cmd: job.cmd, timeout: job.timeout },
    { cron: '* * * * *', cmd: `${s.home}/.local/bin/mac-node serve`, timeout: '720h' });
  assert.ok(r.stdout.includes(`install.sh --key-line - >> ~/.ssh/authorized_keys' < ${s.home}/.ssh/mac-node_ed25519.pub`), r.stdout);
  assert.ok(!existsSync(join(s.home, 'Library/LaunchAgents')), 'no launchd plist');
  const kl = s.run(['--key-line', '-'], 'ssh-ed25519 AAAAtestkey mac-node\n');
  assert.equal(kl.status, 1, 'the key line is made on the VM');
  assert.match(kl.stderr, /runs on the VM/);
  assert.equal(s.run().status, 0, 'a second run is fine');
  assert.equal(Object.keys(JSON.parse(readFileSync(s.jobs, 'utf8')).jobs).length, 1);
  const un = s.run(['--uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.equal(JSON.parse(readFileSync(s.jobs, 'utf8')).jobs['mac-node'], undefined);
});
