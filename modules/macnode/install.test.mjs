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
  const run = (args = []) => spawnSync('/bin/zsh', [INSTALL, ...args], { encoding: 'utf8',
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
  assert.match(r.stdout, new RegExp(`MACNODE_VM_DIR=${s.state}`));
  assert.match(r.stdout, /restrict,port-forwarding,permitlisten="127\.0\.0\.1:1",permitopen="127\.0\.0\.1:1",command="\/bin\/false"/);
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
  for (const want of [/set MACNODE_VM=/, /set MACNODE_VM_DIR/, /ssh-keygen -t ed25519 -N '' -C mac-node -f .*\/\.ssh\/mac-node_ed25519/, /add cron to MODULES/])
    assert.match(r.stdout, want);
  assert.ok(!existsSync(s.jobs), 'no hcron job without the settings');
  assert.ok(!existsSync(join(s.home, '.ssh')), 'the installer never makes a key');
});

test('mac side, complete: registers the hcron keepalive job (no plist) and prints the authorized_keys line', t => {
  const s = sandbox(t, '');
  mkdirSync(join(s.home, '.ssh'));
  writeFileSync(join(s.home, '.ssh/mac-node_ed25519'), 'not a real key\n');
  writeFileSync(join(s.home, '.ssh/mac-node_ed25519.pub'), 'ssh-ed25519 AAAAtestkey mac-node\n');
  writeFileSync(join(s.d, 'harness.env'), readFileSync(join(s.d, 'harness.env'), 'utf8') +
    'MACNODE_ROLE=mac\nMODULES="cron macnode"\nMACNODE_VM="tester@vm.invalid"\nMACNODE_VM_DIR="/srv/mac-node"\n');
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const job = JSON.parse(readFileSync(s.jobs, 'utf8')).jobs['mac-node'];
  assert.deepEqual({ cron: job.cron, cmd: job.cmd, timeout: job.timeout },
    { cron: '* * * * *', cmd: `${s.home}/.local/bin/mac-node serve`, timeout: '720h' });
  assert.match(r.stdout, /restrict,port-forwarding,permitlisten="127\.0\.0\.1:1",permitopen="127\.0\.0\.1:1",command="\/bin\/false" ssh-ed25519 AAAAtestkey mac-node/);
  assert.ok(!existsSync(join(s.home, 'Library/LaunchAgents')), 'no launchd plist');
  const kl = s.run(['--key-line']);
  assert.equal(kl.stdout, 'restrict,port-forwarding,permitlisten="127.0.0.1:1",permitopen="127.0.0.1:1",command="/bin/false" ssh-ed25519 AAAAtestkey mac-node\n');
  assert.equal(s.run().status, 0, 'a second run is fine');
  assert.equal(Object.keys(JSON.parse(readFileSync(s.jobs, 'utf8')).jobs).length, 1);
  const un = s.run(['--uninstall']);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.equal(JSON.parse(readFileSync(s.jobs, 'utf8')).jobs['mac-node'], undefined);
});
