#!/usr/bin/env node
// Orchestrator sweep: one read-only pass over every executor, so nothing stalls unseen.
// It writes one line per problem through modules/cron/tg-notify.py, which lands in the master
// session's alert log when <profile>/telegram/ALERTS_TO_MASTER is set (docs/master-session.md).
// The same problem (same key or same text) is not repeated within DEDUPE_MIN (120) minutes. The sweep never merges, kills,
// resumes or restarts anything: the master session acts on each line.
//
//   sweep.mjs              run every check, send the new lines
//   sweep.mjs --dry-run    print every problem found; send nothing, record nothing
//
// Checks: hcron (global pause, a job overdue for 2x its interval, a job failing), firstmate (dead
// workers, fm-* windows idle, inbox notes waiting), no-mistakes (runs parked at a gate or awaiting
// the agent), GitHub PRs (green and mergeable but not merged, conflicting), health targets, the Mac
// (load average, screen locked while a gui job is due). An idle fm-* window is only info (printed,
// not sent) unless inbox notes are waiting. When every URL health target fails on DNS (or, with no
// URL targets, github.com does not resolve), the network is down: one "network down" line is sent
// and the PR, health and hcron-failure lines that would follow from it are held back.
// Personal values (repos, health URLs, load limit) come from <profile>/orchestrator/sweep.json:
//   { "repos": ["owner/name"], "health": [{ "name": "app", "url": "https://..." } | { "name": "x", "cmd": "..." }],
//     "load_max": 12, "ignore": ["owner/name#62", "label:parked"] }
// "ignore" drops PR lines for a PR (owner/name#N) or for any PR carrying a label (label:NAME).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir, loadavg, cpus } from 'node:os';
import { lookup } from 'node:dns/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCron, cronMatches, inWindow, screenLocked } from '../cron/hcron.mjs';

const MIN = 60_000;
export const LIMITS = { dedupeMin: 120, fmIdleMin: 20, inboxMin: 10, parkedMin: 15, prGreenMin: 30 };
const ago = ms => `${Math.round(ms / MIN)} min`;
const toMs = t => (t == null ? null : typeof t === 'string' ? Date.parse(t) : t > 1e12 ? t : t * 1000);

// ---------- hcron ----------
// Most recent slot at or before `now` that the cron and window allow, and the one before it.
// Scans back at most `maxMin` minutes (two weeks), so a yearly job simply has no interval.
export function lastTwoSlots(job, now, maxMin = 14 * 1440) {
  const fields = parseCron(job.cron);
  const out = [];
  let t = new Date(now); t.setSeconds(0, 0);
  for (let i = 0; i < maxMin && out.length < 2; i++, t = new Date(t.getTime() - MIN))
    if (cronMatches(fields, t) && inWindow(job.window, t)) out.push(new Date(t));
  return out;
}

// jobs = the parsed jobs.json; states = { id: state json }; returns [{ key, text }].
export function hcronProblems(jobs, states, now = new Date()) {
  const out = [];
  if (jobs.paused) out.push({ key: 'hcron:paused', text: 'hcron: ALL jobs paused (global pause on): nothing scheduled runs. Lift with `hcron resume all` if nobody meant it.' });
  for (const [id, job] of Object.entries(jobs.jobs || {})) {
    if (job.paused) continue;
    const st = states[id] || {};
    if ((st.consecutive_failures || 0) > 0)
      out.push({ key: `hcron:fail:${id}`, text: `hcron: ${id} failing (exit ${st.last_exit}, ${st.consecutive_failures} in a row). Logs: hcron logs ${id}` });
    if (jobs.paused) continue;
    let slots;
    try { slots = lastTwoSlots(job, now); } catch { out.push({ key: `hcron:cron:${id}`, text: `hcron: ${id} has a bad cron "${job.cron}"` }); continue; }
    if (slots.length < 2) continue;
    const interval = slots[0] - slots[1];
    const last = toMs(st.started_at) ?? toMs(job.added);
    if (last != null && now - last > 2 * interval && last < slots[1].getTime())
      out.push({ key: `hcron:overdue:${id}`, text: `hcron: ${id} has not run for ${ago(now - last)} (every ${ago(interval)}). ${st.skip_notified ? `Last skip: ${st.skip_notified}. ` : ''}Check: hcron status` });
  }
  return out;
}

// ---------- firstmate ----------
// metas = [{ id, window: "session:name", last: "<last status line>" }], windows = Map(name -> activity epoch s),
// stall = Map(name -> since epoch s) from the stall watcher, notes = [{ path, mtimeMs }].
export function firstmateProblems({ sessionUp, metas = [], windows = new Map(), stall = new Map(), notes = [], now = Date.now() }) {
  const out = [];
  if (!sessionUp) {
    if (metas.length) out.push({ key: 'fm:session', text: `firstmate: tmux session is down but ${metas.length} worker(s) are registered. Start it: hcron run firstmate-start` });
    return out;
  }
  for (const m of metas) {
    const name = (m.window || '').split(':').pop();
    const state = (m.last || '').split(/\s/)[0];
    if (name && !windows.has(name) && !/^(done|stopped|closed|failed|teardown|resolved|merged)/i.test(state))
      out.push({ key: `fm:dead:${m.id}`, text: `firstmate: ${m.id} is dead: registry says "${state || 'no status'}" but window ${name} is gone. Restart it or tear it down.` });
  }
  for (const [name, act] of windows) {
    if (!name.startsWith('fm-')) continue;
    const since = stall.get(name) ?? act;
    const idle = now - since * 1000;
    // Idle is not an error: only worth a line when work is queued (inbox notes waiting).
    if (idle >= LIMITS.fmIdleMin * MIN)
      out.push({ key: `fm:idle:${name}:${since}`, info: !notes.length, text: `firstmate: window ${name} idle ${ago(idle)}. Look: tmux capture-pane -p -t firstmate:${name}` });
  }
  const old = notes.filter(n => now - n.mtimeMs >= LIMITS.inboxMin * MIN);
  if (old.length) {
    const oldest = Math.max(...old.map(n => now - n.mtimeMs));
    out.push({ key: `fm:inbox:${old.map(n => n.path).sort().join(',')}`, text: `firstmate: ${old.length} inbox note(s) waiting, oldest ${ago(oldest)}: ${old.map(n => n.path).join(' ')}` });
  }
  return out;
}

// ---------- no-mistakes ----------
// rows from the run table: { id, branch, status, awaiting_agent_since, worktree_dir, working_path, gates, gate_since }.
export function noMistakesProblems(rows, now = Date.now()) {
  const out = [];
  for (const r of rows) {
    const since = toMs(r.awaiting_agent_since) ?? (r.gates ? toMs(r.gate_since) : null);
    if (since == null || now - since < LIMITS.parkedMin * MIN) continue;
    const what = r.gates ? `waiting at gate ${r.gates}` : 'parked (awaiting_agent)';
    out.push({ key: `nm:${r.id}:${since}`, text: `no-mistakes: run ${r.id} (${r.branch}) ${what} for ${ago(now - since)}. Checkout ${r.working_path}, worktree ${r.worktree_dir}. See: no-mistakes axi status --run ${r.id}` });
  }
  return out;
}

// ---------- GitHub PRs ----------
const GOOD = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
export function prProblems(repo, prs, now = Date.now(), ignore = []) {
  const out = [];
  for (const p of prs) {
    if (p.isDraft) continue;
    const tag = `${repo}#${p.number}`;
    if (ignore.includes(tag) || (p.labels || []).some(l => ignore.includes(`label:${l.name ?? l}`))) continue;
    if (p.mergeable === 'CONFLICTING') { out.push({ key: `pr:conflict:${tag}`, text: `PR ${tag} conflicts with its base: rebase it ("${p.title}")` }); continue; }
    const checks = p.statusCheckRollup || [];
    const green = checks.every(c => GOOD.has(c.conclusion || c.state));
    if (!green || p.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(p.mergeStateStatus)) continue;
    const done = Math.max(...checks.map(c => toMs(c.completedAt) || 0), toMs(p.updatedAt) || 0);
    if (now - done >= LIMITS.prGreenMin * MIN)
      out.push({ key: `pr:green:${tag}`, text: `PR ${tag} green and mergeable for ${ago(now - done)}, not merged ("${p.title}")` });
  }
  return out;
}

// ---------- health and the Mac ----------
export function healthProblems(results) {
  return results.filter(r => !r.ok).map(r => ({ key: `health:${r.name}`, text: `health: ${r.name} unhealthy (${r.detail})` }));
}

// Network errors that mean "no DNS / no route", not "this target is broken".
const NET_DOWN = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|nodename nor servname/;
export const netDown = results => results.length > 0 && results.every(r => !r.ok && NET_DOWN.test(r.detail || ''));

// While the network is down, keep one line for it and drop the lines it causes.
export function networkFilter(problems, down, why = '') {
  if (!down) return problems;
  const dependent = p => /^(pr:|health:|hcron:fail:|sweep:err:PRs of )/.test(p.key);
  return [{ key: 'net:down', text: `network down (${why || 'DNS fails for every target'}): PR, health and hcron-failure lines held back until it is back` },
    ...problems.filter(p => !dependent(p))];
}

export function macProblems({ load, loadMax, locked, jobs, states }) {
  const out = [];
  if (load > loadMax) out.push({ key: 'mac:load', text: `mac: load average ${load.toFixed(1)} is over ${loadMax}. Look: top -o cpu` });
  if (locked && !jobs?.paused) {
    const skipped = Object.entries(jobs?.jobs || {})
      .filter(([id, j]) => !j.paused && (j.needs || []).some(n => n === 'gui' || n === 'unlocked') && /locked/.test(states[id]?.skip_notified || ''))
      .map(([id]) => id);
    if (skipped.length) out.push({ key: 'mac:locked', text: `mac: screen locked while gui job(s) are due: ${skipped.join(', ')}` });
  }
  return out;
}

// ---------- dedupe ----------
// sent = { key or "text:<text>": epoch ms last sent }. Returns the problems to send now and the new
// sent map (entries not seen for a day are dropped). A line is held if its key or its exact text was
// sent within the window; info lines are never sent.
export function dedupe(problems, sent, now = Date.now(), windowMin = LIMITS.dedupeMin) {
  const next = Object.fromEntries(Object.entries(sent).filter(([, t]) => now - t < 1440 * MIN));
  const recent = k => next[k] && now - next[k] < windowMin * MIN;
  const send = [];
  for (const p of problems) {
    if (p.info || recent(p.key) || recent(`text:${p.text}`)) continue;
    next[p.key] = next[`text:${p.text}`] = now; send.push(p);
  }
  return { send, sent: next };
}

// ---------- collectors (I/O) ----------
const HOME = homedir();
const SELF = fileURLToPath(import.meta.url);
const HARNESS = resolve(dirname(SELF), '../..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, ...opts });
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };

function harnessEnv() {
  const keys = ['PROFILE_DIR', 'FIRSTMATE_DIR', 'FIRSTMATE_SESSION'];
  if (keys.every(k => process.env[k])) return Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const vals = run('/bin/zsh', ['-c', 'source "$1/lib/env.sh"; print -rl -- "$PROFILE_DIR" "$FIRSTMATE_DIR" "$FIRSTMATE_SESSION"', 'sweep', HARNESS]).split('\n');
  return Object.fromEntries(keys.map((k, i) => [k, process.env[k] || vals[i]]));
}

function collectHcron(profile) {
  const jobs = readJson(process.env.HCRON_JOBS || join(profile, 'cron/jobs.json'), { jobs: {} });
  const dir = process.env.HCRON_STATE || join(HOME, '.local/state/hcron');
  const states = Object.fromEntries(Object.keys(jobs.jobs || {}).map(id => [id, readJson(join(dir, `${id}.json`), {})]));
  return { jobs, states };
}

function collectFirstmate(env) {
  const fm = env.FIRSTMATE_DIR, session = env.FIRSTMATE_SESSION, st = join(fm, 'state');
  const metas = existsSync(st) ? readdirSync(st).filter(f => f.endsWith('.meta')).map(f => {
    const id = f.slice(0, -5);
    const window = (/^window=(.*)$/m.exec(readFileSync(join(st, f), 'utf8')) || [])[1] || '';
    let last = '';
    try { last = readFileSync(join(st, `${id}.status`), 'utf8').trimEnd().split('\n').pop(); } catch {}
    return { id, window, last };
  }) : [];
  let sessionUp = true, windows = new Map();
  try {
    for (const l of run('tmux', ['list-windows', '-t', session, '-F', '#W #{window_activity}']).trim().split('\n').filter(Boolean)) {
      const [name, act] = l.split(' '); windows.set(name, Number(act));
    }
  } catch { sessionUp = false; }
  const stall = new Map();
  const sf = join(env.PROFILE_DIR, 'logs/fm-stall-watch.state');
  try {
    if (Date.now() - statSync(sf).mtimeMs < 15 * MIN)
      for (const l of readFileSync(sf, 'utf8').split('\n').filter(Boolean)) { const [w, , since] = l.split(' '); stall.set(w, Number(since)); }
  } catch {}
  const notes = [];
  const dirs = [join(st, 'inbox'), ...(existsSync(st) ? readdirSync(st).filter(f => f.endsWith('.inbox')).map(f => join(st, f)) : [])];
  for (const d of dirs) {
    try { for (const f of readdirSync(d)) if (f.endsWith('.note')) notes.push({ path: join(d, f).replace(fm + '/', ''), mtimeMs: statSync(join(d, f)).mtimeMs }); } catch {}
  }
  return { sessionUp, metas, windows, stall, notes };
}

function collectNoMistakes() {
  const db = process.env.NM_DB || join(HOME, '.no-mistakes/state.sqlite');
  if (!existsSync(db)) return [];
  const sql = `select r.id, r.branch, r.status, r.awaiting_agent_since, r.worktree_dir, p.working_path,
    (select group_concat(step_name) from step_results s where s.run_id = r.id and s.status = 'awaiting_approval') as gates,
    (select min(coalesce(s.completed_at, s.last_activity_at, s.started_at)) from step_results s where s.run_id = r.id and s.status = 'awaiting_approval') as gate_since
    from runs r join repos p on p.id = r.repo_id where r.status not in ('completed', 'cancelled', 'failed')`;
  const out = run('sqlite3', ['-readonly', '-json', db, sql]).trim();
  return out ? JSON.parse(out) : [];
}

function collectPrs(repo) {
  return JSON.parse(run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,isDraft,labels,mergeable,mergeStateStatus,statusCheckRollup,updatedAt']));
}

const resolves = host => lookup(host).then(() => true, () => false);

async function checkHealth(t) {
  if (t.cmd) {
    const r = spawnSync('/bin/zsh', ['-c', t.cmd], { encoding: 'utf8', timeout: 30_000 });
    return { name: t.name, ok: r.status === 0, detail: r.status === null ? 'timed out' : `exit ${r.status}` };
  }
  try {
    const res = await fetch(t.url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' });
    const want = t.expect ?? 200;
    return { name: t.name, ok: res.status === want, detail: `HTTP ${res.status} from ${t.url}` };
  } catch (e) { return { name: t.name, ok: false, detail: `${e.cause?.code || e.name} from ${t.url}` }; }
}

export async function sweep(env = harnessEnv()) {
  const conf = readJson(process.env.SWEEP_CONFIG || join(env.PROFILE_DIR, 'orchestrator/sweep.json'), {});
  const problems = [];
  const guard = async (name, fn) => {
    try { problems.push(...await fn()); }
    catch (e) { problems.push({ key: `sweep:err:${name}`, text: `sweep: the ${name} check failed (${String(e.message).split('\n')[0].slice(0, 120)})` }); }
  };
  const hc = collectHcron(env.PROFILE_DIR);
  const health = await Promise.all((conf.health || []).map(checkHealth));
  const urls = health.filter((r, i) => conf.health[i].url);
  const down = urls.length ? netDown(urls) : !(await resolves('github.com'));
  await guard('hcron', () => hcronProblems(hc.jobs, hc.states));
  await guard('firstmate', () => firstmateProblems(collectFirstmate(env)));
  await guard('no-mistakes', () => noMistakesProblems(collectNoMistakes()));
  if (!down) for (const repo of conf.repos || []) await guard(`PRs of ${repo}`, () => prProblems(repo, collectPrs(repo), Date.now(), conf.ignore || []));
  await guard('health', () => healthProblems(health));
  await guard('mac', () => macProblems({ load: loadavg()[0], loadMax: conf.load_max ?? cpus().length, locked: screenLocked().locked, ...hc }));
  return networkFilter(problems, down, urls.length ? `DNS fails for all ${urls.length} health target(s)` : 'github.com does not resolve');
}

async function main(args) {
  const env = harnessEnv();
  const problems = await sweep(env);
  if (args.includes('--dry-run')) { for (const p of problems) console.log(`${p.info ? 'info: ' : ''}${p.text}`); if (!problems.length) console.log('sweep: all clear'); return; }
  const statePath = process.env.SWEEP_STATE || join(env.PROFILE_DIR, 'logs/orchestrator-sweep.state.json');
  const { send, sent } = dedupe(problems, readJson(statePath, {}));
  const notify = process.env.SWEEP_NOTIFY || `python3 "${join(HARNESS, 'modules/cron/tg-notify.py')}"`;
  for (const p of send) {
    const r = spawnSync('/bin/zsh', ['-c', `${notify} "$1"`, 'sweep', `Sweep: ${p.text}`], { stdio: 'ignore', timeout: 30_000 });
    if (r.status !== 0) delete sent[p.key];   // not delivered: try again next sweep
    console.log(`${r.status === 0 ? 'sent' : 'NOT sent'}: ${p.text}`);
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath + '.tmp', JSON.stringify(sent, null, 2) + '\n'); renameSync(statePath + '.tmp', statePath);
  for (const p of problems.filter(p => p.info)) console.log(`info: ${p.text}`);
  console.log(`sweep: ${problems.length} problem(s), ${send.length} new`);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
