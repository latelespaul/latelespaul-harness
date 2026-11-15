#!/usr/bin/env node
// mac-node: the VM asks the Mac to do named things, over an SSH link that only the Mac opens.
//
//   VM:  mac-node [--no-queue] [--ttl 60m] [--timeout 90s] [--json] <action> [args..]
//          run one allowlisted action on the Mac (mac-node help lists them) and print its output
//        mac-node status | queue | result <id> | drain [--wait] | log [-n 20] | help
//   Mac: mac-node serve
//          the service (an hcron keepalive job): the allowlist runner on a local socket, plus
//          `ssh -N -R <VM socket>:<local socket>` to the VM in a reconnect loop
//
// The Mac opens no port: its ssh dials out and asks the VM's sshd to listen on a Unix socket in
// $MACNODE_VM_DIR/link/ (a new name per connection, so a stale one never blocks a reconnect). The VM
// client connects to the newest socket that answers; the Mac greets each connection with a hello line,
// so a socket whose Mac side is gone counts as down within a few seconds.
// Outcomes and exit codes on the VM: the action's own exit code when it ran; 75 mac-offline (queued
// unless --no-queue; a background `mac-node drain --wait` runs it when the link returns); 76 locked
// (screen locked: reported once, never queued or retried); 77 refused (not on the allowlist, or bad
// args); 74 link lost mid-request (it may have run, so it is not retried).
// Both sides append one JSON line per request to $MACNODE_DIR/requests.log: time, id, action summary,
// outcome, exit code, duration. Never the output, typed text or a secret.

import { spawn, execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, renameSync, chmodSync,
  linkSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, summary, ACTIONS } from './actions.mjs';

const VERSION = 1;
const SELF = realpathSync(fileURLToPath(import.meta.url));
const HARNESS = resolve(dirname(SELF), '../..');
const HOME = homedir();
const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
// Timings; tests shorten them through the environment.
const HELLO_MS = num('MACNODE_HELLO_MS', 3000);      // a socket that sends no hello in this time is dead
const FIND_MS = num('MACNODE_FIND_MS', 8000);        // all sockets tried within this: mac-offline in < 10 s
const POLL_MS = num('MACNODE_POLL_MS', 3000);        // the drainer looks for the link this often
const BACKOFF_MS = num('MACNODE_BACKOFF_MS', 2000);  // first reconnect delay; doubles up to 60 s
const OUT_MAX = 1024 * 1024;                         // per stream, per action
const EXIT = { lost: 74, offline: 75, locked: 76, refused: 77 };

// ---------- config: harness.env, read the way every harness script reads it ----------
const KEYS = ['MACNODE_DIR', 'MACNODE_VM', 'MACNODE_VM_DIR', 'MACNODE_KEY', 'MACNODE_SSH_PORT', 'MACNODE_JOBHUNT_DIR',
  'MACNODE_JOBHUNT_SUBS', 'MACNODE_GH_CODE', 'MACNODE_PORTAL_PASS', 'MACNODE_REPOS', 'MACNODE_HS_OWNER'];
function config() {
  const out = execFileSync('/bin/zsh', ['-c', 'source "$1/lib/env.sh"; shift; for k; print -r -- "$k=${(P)k}"', 'mac-node', HARNESS, ...KEYS],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const cfg = { HARNESS_DIR: HARNESS };
  for (const line of out.split('\n')) { const i = line.indexOf('='); if (i > 0) cfg[line.slice(0, i)] = line.slice(i + 1); }
  return cfg;
}

// ---------- shared helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const ID = /^[A-Za-z0-9-]{1,40}$/;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function ensureDir(d) { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); return d; }
function writePrivate(f, text) { writeFileSync(`${f}.tmp`, text, { mode: 0o600 }); renameSync(`${f}.tmp`, f); }

function log(dir, entry) {
  const f = join(ensureDir(dir), 'requests.log');
  try { if (statSync(f).size > 5 * 1024 * 1024) renameSync(f, `${f}.1`); } catch {}
  writeFileSync(f, JSON.stringify({ ts: now(), ...entry }) + '\n', { flag: 'a', mode: 0o600 });
}

// lines(socket, max): an async reader of newline-terminated lines; next() resolves null on close.
function lines(sock, max) {
  let buf = '', waiting = null, closed = false;
  const queue = [];
  const push = v => { if (waiting) { const w = waiting; waiting = null; w(v); } else queue.push(v); };
  sock.setEncoding('utf8');
  sock.on('data', d => {
    buf += d;
    if (buf.length > max && !buf.includes('\n')) { sock.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const end = () => { if (!closed) { closed = true; push(null); } };
  sock.on('close', end); sock.on('error', end);
  return {
    next(ms) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise(r => {
        const t = setTimeout(() => { waiting = null; r(undefined); }, ms);   // undefined = timed out
        waiting = v => { clearTimeout(t); r(v); };
      });
    },
  };
}

// run(file, args, opts): one program, no shell; output capped; killed (whole group) on timeout.
function run(file, args, { cwd, input, timeoutMs = 120_000 } = {}) {
  return new Promise(res => {
    let out = '', err = '', truncated = false, timedOut = false, child;
    const add = (s, d) => { if (s.length + d.length > OUT_MAX) { truncated = true; return (s + d).slice(0, OUT_MAX); } return s + d; };
    try { child = spawn(file, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: macPath() } }); }
    catch (e) { return res({ exit: 127, stdout: '', stderr: `cannot start ${file}: ${e.message}` }); }
    child.stdout.on('data', d => { out = add(out, d.toString()); });
    child.stderr.on('data', d => { err = add(err, d.toString()); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const group = sig => { try { process.kill(-child.pid, sig); } catch {} };
    const timer = setTimeout(() => { timedOut = true; group('SIGTERM'); setTimeout(() => group('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); res({ exit: 127, stdout: '', stderr: `cannot start ${file}: ${e.code || e.message}` }); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      res({ exit: timedOut ? 124 : code ?? 128, stdout: out, stderr: timedOut ? `${err}\nmac-node: timed out after ${Math.round(timeoutMs / 1000)}s` : err,
        ...(truncated && { truncated: true }), ...(sig && !timedOut && { signal: sig }) });
    });
  });
}
// The Mac's tools live in ~/.local/bin (hsx, hcron, awake) and Homebrew; launchd and hcron start us with a bare PATH.
const macPath = () => [process.env.PATH, `${HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  .filter(Boolean).join(':');

// ---------- Mac: the allowlist runner ----------
// screen(): is the screen locked? Asks Hammerspoon (hsx status), then ioreg; unknown counts as unlocked
// (the action itself then reports what is wrong).
async function screen() {
  const r = await run('hsx', ['status'], { timeoutMs: 5000 });
  if (r.exit === 0) {
    try { const j = JSON.parse(r.stdout.trim().split('\n').pop()); return { locked: !!j.screen_locked, gui: j.accessibility === true, via: 'hammerspoon' }; } catch {}
  }
  const io = await run('ioreg', ['-n', 'Root', '-d1', '-a'], { timeoutMs: 5000 });
  if (io.exit === 0) return { locked: /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(io.stdout), gui: false, via: 'ioreg' };
  return { locked: false, gui: false, via: 'unknown' };
}

// hands: arm the owner for this request only (fresh secret, kept in memory), run the calls in order
// through one signer under an awake hold, then disarm. One request at a time (hsx needs one signer).
let handsChain = Promise.resolve();
function hands(calls, cfg, timeoutMs) {
  const go = async () => {
    const owner = cfg.MACNODE_HS_OWNER;
    const mins = String(Math.ceil(timeoutMs / 60_000) + 1);
    const arm = await run('hsx', ['arm', owner, '--new', '--minutes', mins, '--pid', String(process.pid)], { timeoutMs: 15_000 });
    const secret = arm.stdout.trim().split('\n').pop();
    if (arm.exit !== 0 || !/^[0-9a-fA-F]{32,}$/.test(secret || ''))
      return { exit: arm.exit || 1, stdout: '', stderr: `hsx arm ${owner} failed: ${arm.stderr.trim().split('\n').pop() || 'no secret'}` };
    try {
      const input = `${secret}\n${calls.map(c => JSON.stringify(c)).join('\n')}\n`;
      return await run('awake', ['run', 'mac-node', '--minutes', mins, '--', 'hsx', 'session', owner], { input, timeoutMs });
    } finally {
      await run('hsx', ['disarm', owner], { input: `${secret}\n`, timeoutMs: 15_000 });
    }
  };
  const p = handsChain.then(go, go);
  handsChain = p.catch(() => {});
  return p;
}

async function handle(req, cfg) {
  const p = parse(req.argv, cfg);
  if (!p.ok) return { status: 'refused', reason: p.reason };
  if (p.gui) {
    const s = await screen();
    if (s.locked) return { status: 'locked', reason: `screen is locked (via ${s.via}); unlock the Mac, then ask again` };
  }
  let r;
  if (p.run.kind === 'ping') {
    const s = await screen();
    r = { exit: 0, stdout: JSON.stringify({ pong: true, version: VERSION, screen_locked: s.locked, gui: s.gui, via: s.via }) + '\n', stderr: '' };
  } else if (p.run.kind === 'hands') r = await hands(p.run.calls, cfg, p.run.timeoutMs);
  else r = await run(p.run.file, p.run.args, { cwd: p.run.cwd, timeoutMs: p.run.timeoutMs });
  return { status: r.exit === 0 ? 'ok' : 'failed', ...r };
}

function serveConn(conn, cfg) {
  const rd = lines(conn, 64 * 1024);
  conn.on('error', () => {});
  conn.write(JSON.stringify({ hello: 'mac-node', v: VERSION }) + '\n');
  (async () => {
    const line = await rd.next(30_000);
    if (typeof line !== 'string') return conn.destroy();
    const t0 = Date.now();
    let req;
    try { req = JSON.parse(line); } catch { req = null; }
    const id = req && ID.test(String(req.id)) ? req.id : newId();
    const resp = req && Array.isArray(req.argv) ? await handle(req, cfg) : { status: 'refused', reason: 'malformed request' };
    log(cfg.MACNODE_DIR, { side: 'mac', id, action: summary(req?.argv), status: resp.status, ...(resp.exit !== undefined && { exit: resp.exit }),
      ms: Date.now() - t0, ...(req?.queued && { queued: true }), ...(resp.status === 'refused' && { reason: resp.reason }) });
    conn.end(JSON.stringify({ id, ...resp }) + '\n');
  })().catch(e => { try { conn.end(JSON.stringify({ status: 'error', reason: e.message }) + '\n'); } catch {} });
}

// Is something already serving on this socket path?
const answers = path => new Promise(r => {
  const c = createConnection(path);
  c.once('connect', () => { c.destroy(); r(true); });
  c.once('error', () => r(false));
});

async function serve() {
  const cfg = config();
  for (const k of ['MACNODE_VM', 'MACNODE_VM_DIR']) if (!cfg[k]) { console.error(`mac-node serve: set ${k} in harness.env (see modules/macnode/SETUP.md)`); process.exit(2); }
  if (!cfg.MACNODE_VM_DIR.startsWith('/')) { console.error('mac-node serve: MACNODE_VM_DIR must be an absolute path on the VM'); process.exit(2); }
  const dir = ensureDir(cfg.MACNODE_DIR);
  const sock = join(dir, 'runner.sock');
  if (existsSync(sock)) {
    if (await answers(sock)) { console.error(`mac-node serve: already running (${sock} answers)`); process.exit(0); }
    unlinkSync(sock);
  }
  const server = createServer(c => serveConn(c, cfg));
  await new Promise((r, j) => { server.once('error', j); server.listen(sock, r); });
  chmodSync(sock, 0o600);
  writePrivate(join(dir, 'serve.pid'), `${process.pid}\n`);
  const linkLog = msg => writeFileSync(join(dir, 'link.log'), `${now()} ${msg}\n`, { flag: 'a', mode: 0o600 });
  linkLog(`serve started (pid ${process.pid}), runner on ${sock}`);

  let child = null, stopping = false, backoff = BACKOFF_MS;
  const ssh = process.env.MACNODE_SSH || 'ssh';
  const connect = () => {
    if (stopping) return;
    const remote = `${cfg.MACNODE_VM_DIR}/link/${Date.now().toString(36)}-${randomBytes(2).toString('hex')}.sock`;
    // -F none: only these options and this key, whatever ~/.ssh/config says about the host.
    const args = ['-F', 'none', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=2', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${HOME}/.ssh/known_hosts`,
      '-i', cfg.MACNODE_KEY, '-p', cfg.MACNODE_SSH_PORT || '22', '-R', `${remote}:${sock}`, cfg.MACNODE_VM];
    const t0 = Date.now();
    let err = '';
    child = spawn(ssh, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', d => { err = (err + d).slice(-400); });
    child.on('error', e => { err = e.message; });
    linkLog(`link: ssh started (pid ${child.pid}) -> ${remote}`);
    child.on('close', code => {
      const up = Date.now() - t0;
      if (up > 60_000) backoff = BACKOFF_MS;
      linkLog(`link: ssh exited ${code} after ${Math.round(up / 1000)}s${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`);
      child = null;
      if (stopping) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60_000);
    });
  };
  const stop = () => {
    if (stopping) return; stopping = true;
    if (child) child.kill('SIGTERM');
    server.close();
    try { unlinkSync(sock); } catch {}
    try { unlinkSync(join(dir, 'serve.pid')); } catch {}
    linkLog('serve stopped');
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
  connect();
}

// ---------- VM: client, queue, drainer ----------
// findLink(dir): the newest link socket whose Mac says hello, or null. Sockets that refuse are stale
// (their sshd is gone) and are removed; one that accepts but stays silent is skipped.
async function findLink(dir) {
  const ld = join(dir, 'link');
  const deadline = Date.now() + FIND_MS;
  let socks = [];
  try { socks = readdirSync(ld).filter(f => f.endsWith('.sock')).map(f => join(ld, f)); } catch { return null; }
  const mtime = f => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  socks.sort((a, b) => mtime(b) - mtime(a));
  for (const s of socks) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const conn = createConnection(s);
    const rd = lines(conn, 4 * 1024 * 1024);
    const failed = await new Promise(r => { conn.once('connect', () => r(null)); conn.once('error', e => r(e)); });
    if (failed) { if (failed.code === 'ECONNREFUSED') try { unlinkSync(s); } catch {} continue; }
    const hello = await rd.next(Math.min(HELLO_MS, left));
    try { if (JSON.parse(hello).hello === 'mac-node') return { conn, rd, sock: s }; } catch {}
    conn.destroy();
  }
  return null;
}

// send(link, req, waitMs): one request on an open link; { resp } or { lost: true }.
async function send(link, req, waitMs) {
  link.conn.write(JSON.stringify(req) + '\n');
  const line = await link.rd.next(waitMs);
  link.conn.destroy();
  try { return { resp: JSON.parse(line) }; } catch { return { lost: true }; }
}

const waitFor = (argv, opts) => opts.timeoutMs ?? ((parse(argv).run?.timeoutMs ?? 120_000) + 30_000);
const qdir = dir => ensureDir(join(dir, 'queue'));
const rdir = dir => ensureDir(join(dir, 'results'));
function queued(dir) {
  return readdirSync(qdir(dir)).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(readFileSync(join(qdir(dir), f), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}
function finish(dir, job, resp) {
  writePrivate(join(rdir(dir), `${job.id}.json`), JSON.stringify({ ...resp, id: job.id, argv_summary: summary(job.argv), finished: now(), via: 'queue' }, null, 1));
  try { unlinkSync(join(qdir(dir), `${job.id}.json`)); } catch {}
  log(dir, { side: 'vm', id: job.id, action: summary(job.argv), status: resp.status, ...(resp.exit !== undefined && { exit: resp.exit }), via: 'queue' });
}
function startDrainer() {
  spawn(process.execPath, [SELF, 'drain', '--wait'], { detached: true, stdio: 'ignore', env: process.env }).unref();
}

// drain: run queued requests in order while the link is up. --wait keeps polling until the queue is
// empty (requests expire after their ttl). One drainer at a time (drain.pid). A locked or lost
// request is recorded and dropped, never retried.
async function drain(dir, wait) {
  const lock = join(ensureDir(dir), 'drain.pid'), mine = `${lock}.${process.pid}`;
  // The lock appears whole, pid inside (a hard link of a finished file), or not at all.
  writeFileSync(mine, `${process.pid}\n`, { mode: 0o600 });
  try { linkSync(mine, lock); }
  catch {
    let pid = 0;
    try { pid = Number(readFileSync(lock, 'utf8').trim()) || 0; } catch {}
    unlinkSync(mine);
    if (pid && alive(pid)) return 'busy';
    try { unlinkSync(lock); } catch {}
    return drain(dir, wait);
  }
  unlinkSync(mine);
  try {
    for (;;) {
      const jobs = queued(dir);
      const live = [];
      for (const j of jobs) {
        if (Date.parse(j.expires) < Date.now()) finish(dir, j, { status: 'expired', reason: `the Mac link did not return before ${j.expires}` });
        else live.push(j);
      }
      if (!live.length) break;
      const link = await findLink(dir);
      if (!link) { if (!wait) break; await sleep(POLL_MS); continue; }
      const job = live[0];
      const r = await send(link, { v: VERSION, id: job.id, argv: job.argv, queued: true }, waitFor(job.argv, {}));
      finish(dir, job, r.lost ? { status: 'lost', reason: 'the link dropped before the Mac answered; it may have run, so it is not retried' } : r.resp);
    }
  } finally { try { unlinkSync(lock); } catch {} }
  // A request queued while we were stopping found the lock taken: pick it up.
  if (wait && queued(dir).length) return drain(dir, wait);
  return 'done';
}

function print(resp, json) {
  if (json) { process.stdout.write(JSON.stringify(resp) + '\n'); return; }
  if (resp.stdout) process.stdout.write(resp.stdout);
  if (resp.stderr) process.stderr.write(resp.stderr);
  if (resp.truncated) process.stderr.write('mac-node: output was cut at 1 MB\n');
}

async function client(argv, opts) {
  const dir = config().MACNODE_DIR;
  const id = newId();
  const t0 = Date.now();
  const vlog = e => log(dir, { side: 'vm', id, action: summary(argv), ms: Date.now() - t0, ...e });
  if (!opts.unchecked) {
    const p = parse(argv);
    if (!p.ok) { vlog({ status: 'refused', reason: p.reason, where: 'vm' }); console.error(`refused: ${p.reason}`); return EXIT.refused; }
  }
  const link = await findLink(dir);
  if (!link) {
    if (opts.noQueue || opts.unchecked) {
      vlog({ status: 'mac-offline' });
      console.error(`mac-offline${opts.unchecked ? ' (unchecked requests are never queued)' : ''}`);
      return EXIT.offline;
    }
    const ttl = opts.ttlMs ?? 3_600_000;
    const job = { id, argv, created: now(), expires: new Date(Date.now() + ttl).toISOString() };
    writePrivate(join(qdir(dir), `${id}.json`), JSON.stringify(job));
    vlog({ status: 'mac-offline', queued: true, expires: job.expires });
    startDrainer();
    console.error(`mac-offline: queued ${id}; it runs when the Mac link returns (until ${job.expires}). Result: mac-node result ${id}`);
    return EXIT.offline;
  }
  const r = await send(link, { v: VERSION, id, argv }, waitFor(argv, opts));
  if (r.lost) {
    vlog({ status: 'lost' });
    console.error('mac-link-lost: the link dropped before the Mac answered; the request may have run, so it is not retried');
    return EXIT.lost;
  }
  const resp = r.resp;
  vlog({ status: resp.status, ...(resp.exit !== undefined && { exit: resp.exit }), ...(resp.reason && { reason: resp.reason }) });
  print(resp, opts.json);
  if (resp.status === 'refused') { if (!opts.json) console.error(`refused: ${resp.reason}`); return EXIT.refused; }
  if (resp.status === 'locked') { if (!opts.json) console.error(`locked: ${resp.reason}`); return EXIT.locked; }
  if (resp.status === 'error') { if (!opts.json) console.error(`mac-node error: ${resp.reason}`); return 1; }
  return resp.exit ?? 1;
}

function duration(s) {
  const m = /^(\d+)(s|m|h)?$/.exec(s || '');
  if (!m) { console.error(`bad duration "${s}" (e.g. 90s, 30m, 2h)`); process.exit(2); }
  return +m[1] * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] || 's'];
}

function help() {
  console.log(`usage: mac-node [--no-queue] [--ttl 60m] [--timeout 90s] [--json] <action> [args..]
       mac-node status | queue | result <id> | drain [--wait] | log [-n 20] | serve | help
actions (checked on the VM, then again on the Mac):`);
  for (const a of ACTIONS) console.log(`  ${a.use.padEnd(48)} ${a.about}${a.gui ? ' [needs an unlocked screen]' : ''}`);
  console.log('exit: action exit code | 74 link lost | 75 mac-offline (queued) | 76 locked | 77 refused');
}

async function main(args) {
  const opts = {};
  while (args[0]?.startsWith('--')) {
    const a = args.shift();
    if (a === '--no-queue') opts.noQueue = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--unchecked') opts.unchecked = true;    // skip the VM check, so the Mac's own refusal shows (tests, audits)
    else if (a === '--ttl') opts.ttlMs = Math.min(duration(args.shift()), 24 * 3_600_000);
    else if (a === '--timeout') opts.timeoutMs = duration(args.shift());
    else if (a === '--help') return help(), 0;
    else { console.error(`unknown option ${a} (mac-node help)`); return 2; }
  }
  const [cmd, ...rest] = args;
  const dir = () => config().MACNODE_DIR;
  switch (cmd) {
    case undefined: case 'help': help(); return 0;
    case 'serve': await serve(); return null;
    case 'drain': {
      const r = await drain(dir(), rest.includes('--wait'));
      if (r === 'busy') console.log('a drainer is already running');
      return 0;
    }
    case 'queue': {
      for (const j of queued(dir())) console.log(`${j.id}  ${j.created}  expires ${j.expires}  ${summary(j.argv)}`);
      return 0;
    }
    case 'result': {
      const id = rest[0];
      if (!ID.test(id || '')) { console.error('usage: mac-node result <id>'); return 2; }
      const f = join(rdir(dir()), `${id}.json`);
      if (existsSync(f)) { console.log(readFileSync(f, 'utf8')); return 0; }
      if (existsSync(join(qdir(dir()), `${id}.json`))) { console.log('queued: waiting for the Mac link'); return EXIT.offline; }
      console.error(`no request ${id}`); return 1;
    }
    case 'log': {
      const n = rest[0] === '-n' ? Number(rest[1]) || 20 : 20;
      try { console.log(readFileSync(join(dir(), 'requests.log'), 'utf8').trimEnd().split('\n').slice(-n).join('\n')); } catch { console.log('(no requests yet)'); }
      return 0;
    }
    case 'status': {
      const d = dir();
      const pidf = join(d, 'serve.pid');
      const pid = existsSync(pidf) ? Number(readFileSync(pidf, 'utf8')) : 0;
      if (pid && alive(pid)) {   // the Mac side: the service, and what its ssh did last
        console.log(`serve: running (pid ${pid})`);
        try { console.log(`link: last event ${readFileSync(join(d, 'link.log'), 'utf8').trimEnd().split('\n').pop()}`); } catch {}
        return 0;
      }
      const link = await findLink(d);
      if (link) link.conn.destroy();
      console.log(`link: ${link ? `up (${link.sock})` : 'down'}`);
      console.log(`queue: ${existsSync(join(d, 'queue')) ? queued(d).length : 0} waiting`);
      return link ? 0 : 1;
    }
  }
  return client(args, opts);
}

const code = await main(process.argv.slice(2));
if (code !== null) process.exit(code);
