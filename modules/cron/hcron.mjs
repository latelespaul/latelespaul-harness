#!/usr/bin/env node
// hcron: one scheduler for every harness, firstmate and personal job on this Mac.
// A single launchd agent runs `hcron tick` every minute; jobs live in one JSON file
// ($HCRON_JOBS, default <profile>/cron/jobs.json) so any project registers with `hcron add`.
//
//   hcron add <id> --cron "7 * * * *" --cmd "bin/jobhunt tick" [--cwd DIR] [--window 20:00-05:00]
//             [--needs unlocked,gui] [--timeout 50m] [--catchup] [--project NAME]
//   hcron list | status | run <id> | pause <id|all> | resume <id|all> | rm <id> | logs <id> [-n 40]
//   hcron tick            (launchd calls this; runs every due job, at most one copy of each)
//   hcron next <id> [-n 5]  next fire times, to check a cron expression
//
// Rules: a job never runs twice at once (pid lock); it runs under `caffeinate -i` so the Mac stays
// awake only while it works; `--needs unlocked|gui` skips (and reports) while the screen is locked,
// asking Hammerspoon (the one app that holds the GUI permissions); a missed slot (Mac asleep) runs
// once on wake with --catchup; failures, timeouts and skips go to $HCRON_NOTIFY (a command that
// takes the message as its last argument), never silently.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const HOME = homedir();
const JOBS = process.env.HCRON_JOBS || join(process.env.PROFILE_DIR || join(HOME, 'Projects/latelespaul-profile'), 'cron/jobs.json');
const STATE_DIR = process.env.HCRON_STATE || join(HOME, '.local/state/hcron');
const LOG_DIR = process.env.HCRON_LOGS || join(HOME, 'Library/Logs/hcron');
const PATH = process.env.HCRON_PATH || `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

// ---------- cron expressions ----------
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MACROS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

export function parseCron(expr) {
  const parts = (MACROS[expr.trim()] || expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  return parts.map((p, i) => {
    const [lo, hi] = RANGES[i];
    const set = new Set();
    for (const item of p.toLowerCase().split(',')) {
      const [base, stepS] = item.split('/');
      const step = stepS ? Number(stepS) : 1;
      let a, b;
      if (base === '*') [a, b] = [lo, hi];
      else {
        const [x, y] = base.split('-').map(v => (v in NAMES ? NAMES[v] : Number(v)));
        a = x; b = y ?? (stepS ? hi : x);
      }
      if (![a, b, step].every(Number.isInteger) || a < lo || b > hi + (i === 4 ? 1 : 0) || a > b || step < 1)
        throw new Error(`bad cron field ${i + 1}: "${p}"`);
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return { set, star: p === '*' };
  });
}

export function cronMatches(fields, d) {
  const [mi, h, dom, mon, dow] = fields;
  if (!mi.set.has(d.getMinutes()) || !h.set.has(d.getHours()) || !mon.set.has(d.getMonth() + 1)) return false;
  const domOk = dom.set.has(d.getDate()), dowOk = dow.set.has(d.getDay());
  if (dom.star && dow.star) return true;
  if (dom.star) return dowOk;
  if (dow.star) return domOk;
  return domOk || dowOk;   // classic cron: either day field may match
}

// ---------- windows ("20:00-05:00" may cross midnight) ----------
export function inWindow(win, d) {
  if (!win) return true;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(win);
  if (!m) throw new Error(`bad window "${win}" (want HH:MM-HH:MM)`);
  const s = +m[1] * 60 + +m[2], e = +m[3] * 60 + +m[4], t = d.getHours() * 60 + d.getMinutes();
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

export function parseDuration(s) {
  if (s == null) return 0;
  const m = /^(\d+)\s*(s|m|h)?$/.exec(String(s));
  if (!m) throw new Error(`bad duration "${s}" (e.g. 90s, 50m, 2h)`);
  return +m[1] * ({ s: 1, m: 60, h: 3600 }[m[2] || 'm']) * 1000;
}

const minute = d => { const x = new Date(d); x.setSeconds(0, 0); return x; };

// Slots between (last, now] that the cron matches; newest last. Scans at most `maxMin` minutes.
export function dueSlots(fields, last, now, maxMin = 1440) {
  const out = [];
  let t = minute(now);
  const floor = last ? minute(last).getTime() : t.getTime() - 60_000;
  for (let i = 0; i < maxMin && t.getTime() > floor; i++, t = new Date(t.getTime() - 60_000))
    if (cronMatches(fields, t)) out.unshift(new Date(t));
  return out;
}

// ---------- storage ----------
function readJson(p, dflt) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, v) { mkdirSync(dirname(p), { recursive: true }); const tmp = p + '.tmp'; writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n'); renameSync(tmp, p); }
const loadJobs = () => readJson(JOBS, { version: 1, paused: false, jobs: {} });
const saveJobs = j => writeJson(JOBS, j);
const statePath = id => join(STATE_DIR, `${id}.json`);
const loadState = id => readJson(statePath(id), {});
const saveState = (id, s) => writeJson(statePath(id), s);

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---------- environment checks ----------
function screenLocked() {
  try {
    const out = execFileSync('hs', ['-t', '3', '-c', 'return harness and harness.status() or "{}"'], { encoding: 'utf8', env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out.trim().split('\n').pop());
    return { locked: !!j.screen_locked, gui: j.accessibility === true, via: 'hammerspoon' };
  } catch {
    // Fallback without Hammerspoon: ioreg reports the lock state of the console session.
    try {
      const out = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8' });
      return { locked: /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(out), gui: false, via: 'ioreg' };
    } catch { return { locked: false, gui: false, via: 'unknown' }; }
  }
}

function notify(msg) {
  const cmd = process.env.HCRON_NOTIFY;
  const line = `hcron: ${msg}`;
  log('_hcron', line);
  if (!cmd) return;
  try { spawn('/bin/zsh', ['-c', `${cmd} "$1"`, 'hcron', line], { detached: true, stdio: 'ignore', env: { ...process.env, PATH } }).unref(); } catch {}
}

function log(id, line) {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(join(LOG_DIR, `${id}.log`), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
}

// ---------- running ----------
function start(id, job, reason) {
  const st = loadState(id);
  if (st.pid && alive(st.pid)) { log(id, `skip (${reason}): still running as pid ${st.pid}`); return 'running'; }
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, `${id}.log`), 'a');
  const timeoutS = Math.ceil(parseDuration(job.timeout ?? '55m') / 1000);
  // A tiny supervisor: keeps the Mac awake while the job runs, enforces the timeout, records the exit.
  const sup = `
    start=$(date +%s)
    print -r -- "$(date -u +%FT%TZ) start (${reason}) $HCRON_CMD"
    caffeinate -i /bin/zsh -lc "$HCRON_CMD" &
    child=$!
    ( sleep ${timeoutS}; kill -TERM $child 2>/dev/null; sleep 10; kill -KILL $child 2>/dev/null ) & watchdog=$!
    wait $child; rc=$?
    kill $watchdog 2>/dev/null
    print -r -- "$(date -u +%FT%TZ) exit $rc after $(( $(date +%s) - start ))s"
    node "$HCRON_SELF" _done "$HCRON_ID" $rc $(( $(date +%s) - start ))
  `;
  const child = spawn('/bin/zsh', ['-c', sup], {
    cwd: job.cwd ? resolve(job.cwd.replace(/^~/, HOME)) : HOME,
    detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, PATH, HCRON_CMD: job.cmd, HCRON_ID: id, HCRON_SELF: new URL(import.meta.url).pathname, ...(job.env || {}) },
  });
  child.unref();
  saveState(id, { ...st, pid: child.pid, started_at: new Date().toISOString(), last_reason: reason });
  return 'started';
}

function done(id, rc, secs) {
  const st = loadState(id);
  const job = loadJobs().jobs[id] || {};
  const timedOut = Number(rc) === 143 || Number(rc) === 137;
  const fails = Number(rc) === 0 ? 0 : (st.consecutive_failures || 0) + 1;
  saveState(id, { ...st, pid: null, last_exit: Number(rc), last_secs: Number(secs), finished_at: new Date().toISOString(), consecutive_failures: fails });
  if (Number(rc) !== 0 && job.notify !== false && (fails === 1 || fails % 5 === 0))
    notify(`${id} ${timedOut ? 'timed out' : `failed (exit ${rc})`} after ${secs}s${fails > 1 ? `, ${fails} in a row` : ''}. Logs: hcron logs ${id}`);
}

function tick(now = new Date()) {
  const all = loadJobs();
  if (all.paused) return;
  let lock;
  for (const [id, job] of Object.entries(all.jobs)) {
    if (job.paused) continue;
    const st = loadState(id);
    let fields;
    try { fields = parseCron(job.cron); } catch (e) { log(id, `bad cron: ${e.message}`); continue; }
    const last = st.last_check ? new Date(st.last_check) : null;
    const slots = dueSlots(fields, last, now);
    saveState(id, { ...st, last_check: now.toISOString() });
    if (!slots.length) continue;
    const newest = slots[slots.length - 1];
    const missed = minute(now).getTime() - newest.getTime() > 60_000;
    if (missed && !job.catchup) { log(id, `missed slot ${newest.toISOString()} (Mac asleep?), no catchup`); continue; }
    if (!inWindow(job.window, now)) { log(id, `outside window ${job.window}`); continue; }
    const needs = job.needs || [];
    if (needs.includes('unlocked') || needs.includes('gui')) {
      lock ??= screenLocked();
      if (lock.locked) { if (!st.skip_notified) notify(`${id} skipped: screen is locked (unlock to let it run)`); saveState(id, { ...loadState(id), skip_notified: true }); continue; }
      if (needs.includes('gui') && !lock.gui) { notify(`${id} skipped: Hammerspoon not answering or no Accessibility`); continue; }
    }
    saveState(id, { ...loadState(id), skip_notified: false });
    start(id, job, missed ? `catchup ${newest.toISOString()}` : 'schedule');
  }
}

// ---------- CLI ----------
function flags(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; o[k] = v; }
    else if (a === '-n') o.n = Number(args[++i]);
    else o._.push(a);
  }
  return o;
}

function fmtAgo(iso) { if (!iso) return '-'; const s = Math.round((Date.now() - new Date(iso)) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; }

function nextTimes(cron, n = 3, from = new Date()) {
  const f = parseCron(cron); const out = []; let t = minute(from);
  for (let i = 0; i < 60 * 24 * 40 && out.length < n; i++) { t = new Date(t.getTime() + 60_000); if (cronMatches(f, t)) out.push(t); }
  return out;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = flags(rest);
  const all = loadJobs();
  const need = id => { if (!all.jobs[id]) { console.error(`no job "${id}" (hcron list)`); process.exit(1); } return all.jobs[id]; };
  switch (cmd) {
    case 'tick': return tick();
    case '_done': return done(o._[0], o._[1], o._[2]);
    case 'add': {
      const id = o._[0];
      if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) { console.error('usage: hcron add <id> --cron "..." --cmd "..." (id: lowercase, digits, . _ -)'); process.exit(1); }
      if (!o.cron || !o.cmd) { console.error('--cron and --cmd are required'); process.exit(1); }
      parseCron(o.cron); if (o.window) inWindow(o.window, new Date()); if (o.timeout) parseDuration(o.timeout);
      const job = { cron: o.cron, cmd: o.cmd, ...(o.cwd && { cwd: o.cwd }), ...(o.window && { window: o.window }),
        ...(o.needs && { needs: String(o.needs).split(',') }), ...(o.timeout && { timeout: o.timeout }), ...(o.catchup && { catchup: true }),
        ...(o.project && { project: o.project }), ...(o['no-notify'] && { notify: false }), added: new Date().toISOString() };
      const existed = !!all.jobs[id];
      all.jobs[id] = { ...(all.jobs[id] || {}), ...job };
      saveJobs(all);
      console.log(`${existed ? 'updated' : 'added'} ${id}; next: ${nextTimes(o.cron, 3).map(d => d.toLocaleString()).join(' | ')}`);
      return;
    }
    case 'rm': need(o._[0]); delete all.jobs[o._[0]]; saveJobs(all); return console.log(`removed ${o._[0]}`);
    case 'pause': case 'resume': {
      const v = cmd === 'pause';
      if (o._[0] === 'all') all.paused = v; else need(o._[0]).paused = v;
      saveJobs(all); return console.log(`${o._[0]} ${v ? 'paused' : 'resumed'}`);
    }
    case 'run': { const id = o._[0]; return console.log(`${id}: ${start(id, need(id), 'manual')}`); }
    case 'next': { const j = need(o._[0]); return console.log(nextTimes(j.cron, o.n || 5).map(d => d.toLocaleString()).join('\n')); }
    case 'logs': {
      const p = join(LOG_DIR, `${o._[0] || '_hcron'}.log`);
      if (!existsSync(p)) return console.log('(no log yet)');
      return console.log(readFileSync(p, 'utf8').trimEnd().split('\n').slice(-(o.n || 40)).join('\n'));
    }
    case 'list': case 'status': case undefined: {
      console.log(`jobs: ${JOBS}${all.paused ? '   ** ALL PAUSED **' : ''}`);
      const rows = Object.entries(all.jobs);
      if (!rows.length) return console.log('(no jobs; hcron add <id> --cron "..." --cmd "...")');
      for (const [id, j] of rows) {
        const s = loadState(id);
        const run = s.pid && alive(s.pid) ? `RUNNING pid ${s.pid} since ${fmtAgo(s.started_at)}` : `last ${s.last_exit ?? '-'} ${fmtAgo(s.finished_at)}`;
        let nxt = '-'; try { nxt = nextTimes(j.cron, 1)[0]?.toLocaleString() ?? '-'; } catch {}
        console.log(`${j.paused ? '⏸ ' : '  '}${id.padEnd(22)} ${j.cron.padEnd(16)} ${(j.window || 'any time').padEnd(12)} next ${nxt.padEnd(22)} ${run}${(j.needs || []).length ? `  needs ${j.needs.join(',')}` : ''}`);
      }
      if (cmd === 'status') { const l = screenLocked(); console.log(`screen ${l.locked ? 'LOCKED' : 'unlocked'} · gui ${l.gui ? 'ok' : 'no'} (via ${l.via})`); }
      return;
    }
    default:
      console.error('usage: hcron add|list|status|run|pause|resume|rm|logs|next|tick  (see the header of hcron.mjs)'); process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/hcron')) main(process.argv.slice(2));
