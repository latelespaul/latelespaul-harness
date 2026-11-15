// node --test modules/macnode/macnode.test.mjs
// mac-node end to end, offline: the Mac service (`mac-node serve`) and the VM client run as two
// processes with their own harness.env and state folders in a throwaway folder. The SSH link is
// test/fake-ssh.mjs (MACNODE_SSH), which only pipes a local Unix socket: no real ssh, no network.
// hsx, awake, hcron and bin/jobhunt are stub scripts that record their calls, so Hammerspoon, the
// screen, Chrome and the real scheduler are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, chmodSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, summary } from './actions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'mac-node.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const exe = (f, body) => { writeFileSync(f, body); chmodSync(f, 0o755); };

// A short base folder: Unix socket paths are limited to about 104 bytes on macOS.
function sandbox() {
  const d = realpathSync(mkdtempSync('/tmp/mn-'));
  const p = { d, home: join(d, 'h'), bin: join(d, 'bin'), mac: join(d, 'mac'), vm: join(d, 'vm'), jh: join(d, 'jh'),
    calls: join(d, 'calls.log'), sshLog: join(d, 'ssh.log'), down: join(d, 'ssh-down'), locked: join(d, 'locked') };
  for (const x of [p.home, p.bin, p.mac, join(p.vm, 'link'), join(p.jh, 'bin')]) mkdirSync(x, { recursive: true });
  const SECRET = 'ab'.repeat(32);
  // hsx: status says locked while $d/locked exists; arm prints a fresh secret; session answers each request line.
  exe(join(p.bin, 'hsx'), `#!/bin/sh
echo "hsx $*" >> "${p.calls}"
case "$1" in
  status) if [ -e "${p.locked}" ]; then echo '{"screen_locked":true,"accessibility":true}'; else echo '{"screen_locked":false,"accessibility":true}'; fi ;;
  arm) echo "${SECRET}" ;;
  session) read s; [ "$s" = "${SECRET}" ] && echo "hsx session got the secret" >> "${p.calls}"
           while read l; do echo "{\\"ok\\":true,\\"req\\":$l}"; done ;;
  disarm) read s; [ "$s" = "${SECRET}" ] && echo "hsx disarm got the secret" >> "${p.calls}" ;;
  *) exit 2 ;;
esac
`);
  // awake run <name> --minutes N -- cmd...: run the command (stdin passes through).
  exe(join(p.bin, 'awake'), `#!/bin/sh
echo "awake $1 $2" >> "${p.calls}"
while [ "$1" != "--" ]; do shift; done; shift
exec "$@"
`);
  exe(join(p.bin, 'hcron'), `#!/bin/sh\necho "hcron $*" >> "${p.calls}"\necho "fake hcron: $* ok"\n`);
  exe(join(p.jh, 'bin', 'jobhunt'), `#!/bin/sh\necho "jobhunt $* (cwd $(pwd))" >> "${p.calls}"\necho "applied=3 queued=5 failed=0"\n`);
  exe(join(p.bin, 'ssh-fake'), `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'test', 'fake-ssh.mjs')}" "$@"\n`);
  writeFileSync(join(d, 'mac.env'), `MACNODE_ROLE=mac\nMACNODE_DIR="${p.mac}"\nMACNODE_VM="tester@vm.invalid"\nMACNODE_VM_DIR="${p.vm}"
MACNODE_KEY="${p.home}/.ssh/mac-node_ed25519"\nMACNODE_JOBHUNT_DIR="${p.jh}"\nMACNODE_JOBHUNT_SUBS="status"\nMACNODE_REPOS="tools=${d}/norepo"\n`);
  writeFileSync(join(d, 'vm.env'), `MACNODE_ROLE=vm\nMACNODE_DIR="${p.vm}"\n`);
  const base = { PATH: `${p.bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: p.home,
    FAKE_SSH_LOG: p.sshLog, FAKE_SSH_DOWN: p.down, MACNODE_SSH: join(p.bin, 'ssh-fake'), MACNODE_BACKOFF_MS: '150', MACNODE_POLL_MS: '150' };
  p.macEnv = { ...base, HARNESS_ENV: join(d, 'mac.env') };
  p.vmEnv = { ...base, HARNESS_ENV: join(d, 'vm.env') };
  p.SECRET = SECRET;
  return p;
}

// mac-node on the VM side; resolves { code, stdout, stderr, ms }.
function vm(p, args, extraEnv = {}) {
  return new Promise(res => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...p.vmEnv, ...extraEnv } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; });
    c.on('close', code => res({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

async function until(what, fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  assert.fail(`timed out waiting for ${what}`);
}
const linkSocks = p => readdirSync(join(p.vm, 'link')).filter(f => f.endsWith('.sock'));
const logLines = (dir) => existsSync(join(dir, 'requests.log'))
  ? readFileSync(join(dir, 'requests.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const queueLen = p => existsSync(join(p.vm, 'queue')) ? readdirSync(join(p.vm, 'queue')).length : 0;
const calls = p => existsSync(p.calls) ? readFileSync(p.calls, 'utf8') : '';

async function startMac(p) {
  const serve = spawn(process.execPath, [CLI, 'serve'], { env: p.macEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  serve.out = ''; serve.stdout.on('data', d => { serve.out += d; }); serve.stderr.on('data', d => { serve.out += d; });
  await until('the link socket', () => linkSocks(p).length > 0);
  await until('a live link', async () => (await vm(p, ['status'])).stdout.includes('link: up'));
  return serve;
}
// The pid of the fake ssh the service runs now (its newest "ssh started" line in link.log).
const currentSsh = p => Number([...readFileSync(join(p.mac, 'link.log'), 'utf8').matchAll(/ssh started \(pid (\d+)\)/g)].pop()[1]);
const stopMac = async serve => { serve.kill('SIGTERM'); await new Promise(r => serve.once('close', r)); };

// ---------- the allowlist itself ----------
test('allowlist: each named action parses; anything else is refused', () => {
  for (const argv of [['ping'], ['eyes', 'status'], ['hands', 'call', 'eyes.fields'], ['hands', 'call', 'hands.click', '{"x":1}'],
    ['hands', 'batch', '[{"cmd":"a.b"},{"cmd":"c","args":{"k":1}}]'], ['chrome-mode', 'personal'], ['chrome-mode', 'personal', 'desktop'],
    ['jobhunt', 'status'], ['jobhunt', 'status', '--json'], ['hcron', 'status'], ['hcron', 'pause', 'all'], ['hcron', 'run', 'job-1'],
    ['gh-code', 'Acme Corp', '30'], ['portal-pass', 'amazon', '--create'], ['git', 'pull', 'harness']])
    assert.ok(parse(argv).ok, `${argv.join(' ')}: ${parse(argv).reason}`);
  for (const argv of [['rm', '-rf', '/'], ['sh', '-c', 'id'], ['git', 'push'], ['git', 'pull', '../etc'], ['hcron', 'rm', 'x'],
    ['hcron', 'run', 'all'], ['hcron', 'status', 'extra'], ['jobhunt', 'status;id'], ['jobhunt', 'status', '$(id)'], ['jobhunt', 'x', 'a/../b'],
    ['chrome-mode', 'personal', 'root'], ['chrome-mode', '../x'], ['hands', 'call', 'x', '[1]'], ['hands', 'call', 'x', 'nope'],
    ['hands', 'batch', '[]'], ['hands', 'batch', '[{"cmd":"x","sh":"id"}]'], ['gh-code', 'Acme', '99999'], ['portal-pass', 'a', '--show'],
    ['eyes', 'status', 'x'], [], ['ping', ...Array(20).fill('x')], 'ping'])
    assert.equal(parse(argv).ok, false, `${JSON.stringify(argv)} should be refused`);
});

test('allowlist on the Mac: config decides what is enabled and resolves fixed programs', () => {
  const cfg = { HARNESS_DIR: '/h', MACNODE_JOBHUNT_DIR: '/jh', MACNODE_JOBHUNT_SUBS: 'status report', MACNODE_GH_CODE: '',
    MACNODE_PORTAL_PASS: '/t/portal-pass.mjs', MACNODE_REPOS: 'harness=/r/harness bad=relative', node: '/n' };
  assert.deepEqual(parse(['jobhunt', 'status'], cfg).run, { kind: 'exec', file: '/jh/bin/jobhunt', args: ['status'], cwd: '/jh', timeoutMs: 600000 });
  assert.match(parse(['jobhunt', 'apply'], cfg).reason, /not enabled on this Mac/);
  assert.match(parse(['gh-code', 'Acme'], cfg).reason, /not enabled/);
  assert.deepEqual(parse(['portal-pass', 'amazon'], cfg).run.args, ['/t/portal-pass.mjs', 'amazon']);
  assert.equal(parse(['portal-pass', 'amazon'], cfg).gui, true);
  assert.deepEqual(parse(['git', 'pull', 'harness'], cfg).run.args, ['-C', '/r/harness', 'pull', '--ff-only', '-q']);
  assert.match(parse(['git', 'pull', 'bad'], cfg).reason, /not a repo named/);
  assert.deepEqual(parse(['chrome-mode', 'personal', 'desktop'], cfg).run.args,
    ['/h/modules/browser/chrome-mode.sh', 'personal', 'desktop', '--writer', 'mac-node']);
});

test('log summaries keep hands command names but never their arguments', () => {
  assert.equal(summary(['hands', 'call', 'hands.type', '{"text":"hunter2"}']), 'hands call hands.type');
  assert.equal(summary(['hands', 'batch', '[{"cmd":"a"},{"cmd":"b","args":{"text":"x"}}]']), 'hands batch a,b');
  assert.equal(summary(['rm', '-rf', '/']), 'rm (refused)');
  assert.equal(summary(['$(curl evil)']), '??curl?evil? (refused)');
});

// ---------- end to end ----------
test('brief test 1: eyes status, hcron status and jobhunt status answer from the VM, and both sides log them', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  const eyes = await vm(p, ['eyes', 'status']);
  assert.equal(eyes.code, 0, eyes.stderr);
  assert.deepEqual(JSON.parse(eyes.stdout), { screen_locked: false, accessibility: true });
  const hc = await vm(p, ['hcron', 'status']);
  assert.equal(hc.code, 0, hc.stderr);
  assert.match(hc.stdout, /fake hcron: status ok/);
  const jh = await vm(p, ['jobhunt', 'status']);
  assert.equal(jh.code, 0, jh.stderr);
  assert.match(jh.stdout, /applied=3 queued=5/);
  assert.match(calls(p), new RegExp(`jobhunt status \\(cwd ${p.jh}\\)`));
  const ping = await vm(p, ['ping']);
  assert.equal(JSON.parse(ping.stdout).pong, true);
  for (const [dir, side] of [[p.vm, 'vm'], [p.mac, 'mac']]) {
    const acts = logLines(dir).filter(l => l.side === side && l.status === 'ok').map(l => l.action);
    for (const a of ['eyes status', 'hcron status', 'jobhunt status']) assert.ok(acts.includes(a), `${side} log has ${a}: ${acts}`);
  }
  // The link: dedicated key, no ~/.ssh/config, exit on a failed forward, socket into the VM's link folder.
  const args = JSON.parse(readFileSync(p.sshLog, 'utf8').trim().split('\n')[0]);
  assert.deepEqual(args.slice(0, 3), ['-F', 'none', '-N']);
  for (const o of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=5', 'IdentitiesOnly=yes']) assert.ok(args.includes(o), o);
  assert.equal(args[args.indexOf('-i') + 1], `${p.home}/.ssh/mac-node_ed25519`);
  assert.match(args[args.indexOf('-R') + 1], new RegExp(`^${p.vm}/link/[a-z0-9]+-[0-9a-f]{4}\\.sock:${p.mac}/runner\\.sock$`));
  assert.equal(args.at(-1), 'tester@vm.invalid');
});

test('brief test 2: a denied action is refused and logged, on the VM and (unchecked) by the Mac itself', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  const local = await vm(p, ['rm', '-rf', '/']);
  assert.equal(local.code, 77);
  assert.match(local.stderr, /refused: not on the allowlist: rm/);
  assert.ok(logLines(p.vm).some(l => l.status === 'refused' && l.where === 'vm' && l.action === 'rm (refused)'));
  const mac = await vm(p, ['--unchecked', 'rm', '-rf', '/']);
  assert.equal(mac.code, 77);
  assert.match(mac.stderr, /refused: not on the allowlist: rm/);
  assert.ok(logLines(p.mac).some(l => l.side === 'mac' && l.status === 'refused' && l.action === 'rm (refused)'), 'the Mac logged its refusal');
  const notEnabled = await vm(p, ['jobhunt', 'apply']);   // a valid shape, but not in this Mac's MACNODE_JOBHUNT_SUBS
  assert.equal(notEnabled.code, 77);
  assert.match(notEnabled.stderr, /not enabled on this Mac/);
  assert.doesNotMatch(calls(p), /jobhunt apply|rm -rf/);
  assert.equal(queueLen(p), 0, 'refused requests are never queued');
});

test('hands call: armed for that request only, secret over stdin, never in a log or the reply', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  const r = await vm(p, ['hands', 'call', 'hands.type', '{"text":"typed-words"}']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).req, { cmd: 'hands.type', args: { text: 'typed-words' } });
  const c = calls(p);
  assert.match(c, /hsx arm mac-node --new --minutes \d+ --pid \d+\nawake run mac-node\nhsx session mac-node\nhsx session got the secret\nhsx disarm mac-node\nhsx disarm got the secret/);
  for (const f of [join(p.vm, 'requests.log'), join(p.mac, 'requests.log'), join(p.mac, 'link.log')]) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!text.includes(p.SECRET) && !text.includes('typed-words'), `${f} holds no secret or typed text`);
  }
  assert.ok(!r.stdout.includes(p.SECRET));
});

test('brief test 4: a locked screen is reported once, with no arm, no queue and no retry', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  writeFileSync(p.locked, '');
  const r = await vm(p, ['hands', 'call', 'hands.click', '{"x":1}']);
  assert.equal(r.code, 76);
  assert.equal(r.stderr.match(/locked/g).length, 2, r.stderr);   // one line: "locked: screen is locked ..."
  assert.equal(r.stderr.trim().split('\n').length, 1);
  await sleep(600);   // several poll periods: nothing retries in the background
  assert.equal((calls(p).match(/hsx status/g) || []).length, 1, 'one lock check');
  assert.doesNotMatch(calls(p), /hsx arm/);
  assert.equal(queueLen(p), 0);
  // Status actions still answer while locked, and say so.
  const eyes = await vm(p, ['eyes', 'status']);
  assert.equal(JSON.parse(eyes.stdout).screen_locked, true);
});

test('brief test 3: link killed -> mac-offline within 10 s and queued; it runs once the link returns', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  writeFileSync(p.down, '');                 // the VM is unreachable from now on
  process.kill(currentSsh(p), 'SIGKILL');    // the link dies hard: its socket file stays behind, stale
  await sleep(100);
  assert.equal(linkSocks(p).length, 1, 'the stale socket is still there');
  const r = await vm(p, ['hcron', 'pause', 'all']);
  assert.equal(r.code, 75, r.stderr);
  assert.ok(r.ms < 10_000, `mac-offline took ${r.ms} ms`);
  const id = /queued (\S+);/.exec(r.stderr)[1];
  assert.equal(linkSocks(p).length, 0, 'the stale socket was removed');
  assert.ok(existsSync(join(p.vm, 'queue', `${id}.json`)));
  assert.equal((await vm(p, ['result', id])).code, 75);
  assert.ok(logLines(p.vm).some(l => l.id === id && l.status === 'mac-offline' && l.queued));
  const noq = await vm(p, ['--no-queue', 'hcron', 'status']);
  assert.equal(noq.code, 75);
  assert.equal(queueLen(p), 1, '--no-queue adds nothing');
  assert.doesNotMatch(calls(p), /hcron pause/);
  unlinkSync(p.down);                        // the network is back: the service reconnects, the drainer runs the job
  await until('the queued job result', () => existsSync(join(p.vm, 'results', `${id}.json`)), 9000);
  const res = JSON.parse(readFileSync(join(p.vm, 'results', `${id}.json`), 'utf8'));
  assert.equal(res.status, 'ok');
  assert.match(res.stdout, /fake hcron: pause all ok/);
  assert.equal((calls(p).match(/hcron pause all/g) || []).length, 1, 'ran exactly once');
  assert.equal(queueLen(p), 0);
  assert.ok(logLines(p.mac).some(l => l.id === id && l.queued && l.status === 'ok'));
  assert.ok(logLines(p.vm).some(l => l.id === id && l.via === 'queue' && l.status === 'ok'));
});

test('a queued GUI request that meets a locked screen is recorded as locked and dropped', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  writeFileSync(p.down, '');
  process.kill(currentSsh(p), 'SIGKILL');
  const r = await vm(p, ['hands', 'call', 'hands.click']);
  assert.equal(r.code, 75);
  const id = /queued (\S+);/.exec(r.stderr)[1];
  writeFileSync(p.locked, '');               // the Mac wakes up locked
  unlinkSync(p.down);
  await until('the result', () => existsSync(join(p.vm, 'results', `${id}.json`)), 9000);
  assert.equal(JSON.parse(readFileSync(join(p.vm, 'results', `${id}.json`), 'utf8')).status, 'locked');
  await sleep(600);
  assert.equal((calls(p).match(/hsx status/g) || []).length, 1, 'checked once, not retried');
  assert.doesNotMatch(calls(p), /hsx arm/);
  assert.equal(queueLen(p), 0);
});

test('a queued request expires after its ttl when the Mac never comes back', async t => {
  const p = sandbox();                       // no Mac service at all
  t.after(() => rmSync(p.d, { recursive: true, force: true }));
  const r = await vm(p, ['--ttl', '1s', 'eyes', 'status']);
  assert.equal(r.code, 75);
  const id = /queued (\S+);/.exec(r.stderr)[1];
  await until('expiry', () => existsSync(join(p.vm, 'results', `${id}.json`)), 6000);
  assert.equal(JSON.parse(readFileSync(join(p.vm, 'results', `${id}.json`), 'utf8')).status, 'expired');
  await until('the drainer to exit', () => !existsSync(join(p.vm, 'drain.pid')), 3000);
});

test('a socket that accepts but never greets (a dead Mac behind a live sshd) counts as offline within 10 s', async t => {
  const p = sandbox();
  const zombie = createServer(() => {}).listen(join(p.vm, 'link', 'zz-0000.sock'));
  t.after(() => { zombie.close(); rmSync(p.d, { recursive: true, force: true }); });
  const r = await vm(p, ['--no-queue', 'ping'], {});   // the real timings: 3 s hello, 8 s in all
  assert.equal(r.code, 75);
  assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  assert.match(r.stderr, /^mac-offline/);
});

test('a second serve on the same Mac exits and leaves the first one serving', async t => {
  const p = sandbox();
  const serve = await startMac(p);
  t.after(async () => { await stopMac(serve); rmSync(p.d, { recursive: true, force: true }); });
  const second = await new Promise(res => {
    const c = spawn(process.execPath, [CLI, 'serve'], { env: p.macEnv });
    let err = ''; c.stderr.on('data', d => { err += d; });
    c.on('close', code => res({ code, err }));
  });
  assert.equal(second.code, 0);
  assert.match(second.err, /already running/);
  assert.equal((await vm(p, ['ping'])).code, 0);
});

test('serve refuses to start without the VM settings', async t => {
  const p = sandbox();
  t.after(() => rmSync(p.d, { recursive: true, force: true }));
  writeFileSync(join(p.d, 'mac.env'), `MACNODE_DIR="${p.mac}"\n`);
  const r = await new Promise(res => {
    const c = spawn(process.execPath, [CLI, 'serve'], { env: p.macEnv });
    let err = ''; c.stderr.on('data', d => { err += d; });
    c.on('close', code => res({ code, err }));
  });
  assert.equal(r.code, 2);
  assert.match(r.err, /set MACNODE_VM in harness.env/);
  assert.ok(!existsSync(p.sshLog), 'no ssh was started');
});
