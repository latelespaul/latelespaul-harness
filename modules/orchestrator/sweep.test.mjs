// node --test modules/orchestrator/sweep.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// hcron.mjs resolves its jobs file at import; point it at a dummy so no harness.env is needed.
process.env.HCRON_JOBS ??= '/nonexistent/jobs.json';
const { lastTwoSlots, hcronProblems, firstmateProblems, noMistakesProblems, prProblems, healthProblems, macProblems, dedupe } =
  await import('./sweep.mjs');

const MIN = 60_000;
const now = new Date(2026, 10, 10, 12, 0, 0);   // Tue 10 Nov 2026, 12:00 local
const keys = ps => ps.map(p => p.key);

test('hcron: global pause is one line, and no overdue lines while paused', () => {
  const jobs = { paused: true, jobs: { a: { cron: '*/5 * * * *' } } };
  assert.deepEqual(keys(hcronProblems(jobs, { a: { started_at: new Date(now - 300 * MIN).toISOString() } }, now)), ['hcron:paused']);
});

test('hcron: a job is overdue only past 2x its interval', () => {
  const jobs = { jobs: { a: { cron: '*/5 * * * *' }, b: { cron: '*/5 * * * *' }, off: { cron: '*/5 * * * *', paused: true } } };
  const st = { a: { started_at: new Date(now - 11 * MIN).toISOString() }, b: { started_at: new Date(now - 9 * MIN).toISOString() },
    off: { started_at: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(keys(hcronProblems(jobs, st, now)), ['hcron:overdue:a']);
});

test('hcron: windows and yearly jobs', () => {
  // Hourly job with a night window: at noon the last two allowed slots are 04:00 and 03:00, so a run at 04:00 is fine.
  const night = { cron: '0 * * * *', window: '20:00-05:00' };
  assert.deepEqual(lastTwoSlots(night, now).map(d => d.getHours()), [4, 3]);
  assert.deepEqual(hcronProblems({ jobs: { night } }, { night: { started_at: new Date(2026, 10, 10, 4, 0).toISOString() } }, now), []);
  // A once-a-year job has no interval inside the scan, so it is never called overdue.
  assert.deepEqual(hcronProblems({ jobs: { y: { cron: '30 10 12 11 *' } } }, {}, now), []);
});

test('hcron: failing jobs and bad crons', () => {
  const ps = hcronProblems({ jobs: { f: { cron: '0 4 * * 0' }, bad: { cron: 'nope' } } }, { f: { consecutive_failures: 3, last_exit: 2, started_at: now.toISOString() } }, now);
  assert.deepEqual(keys(ps), ['hcron:fail:f', 'hcron:cron:bad']);
  assert.match(ps[0].text, /3 in a row/);
});

test('firstmate: dead worker, idle window, old inbox notes', () => {
  const t = now.getTime(), s = Math.floor(t / 1000);
  const ps = firstmateProblems({
    sessionUp: true,
    metas: [{ id: 'mate', window: 'firstmate:fm-mate', last: 'working [corr=1]: busy' },
      { id: 'gone', window: 'firstmate:fm-gone', last: 'done [corr=2]: merged' },
      { id: 'live', window: 'firstmate:fm-live', last: 'working' }],
    windows: new Map([['fm-live', s - 30 * 60], ['fm-busy', s - 60 * 60], ['2.1.331', s - 999 * 60]]),
    stall: new Map([['fm-busy', s - 60]]),   // the stall watcher saw fm-busy change a minute ago
    notes: [{ path: 'state/inbox/1.note', mtimeMs: t - 11 * MIN }, { path: 'state/inbox/2.note', mtimeMs: t - 2 * MIN }],
    now: t,
  });
  assert.deepEqual(keys(ps), ['fm:dead:mate', `fm:idle:fm-live:${s - 1800}`, 'fm:inbox:state/inbox/1.note']);
});

test('firstmate: session down is one line, only when workers are registered', () => {
  assert.deepEqual(keys(firstmateProblems({ sessionUp: false, metas: [{ id: 'x' }] })), ['fm:session']);
  assert.deepEqual(firstmateProblems({ sessionUp: false }), []);
});

test('no-mistakes: parked or gated over 15 min, with id, branch and paths', () => {
  const t = now.getTime(), s = t / 1000;
  const ps = noMistakesProblems([
    { id: 'R1', branch: 'feat', awaiting_agent_since: s - 20 * 60, worktree_dir: '/w/R1', working_path: '/repo' },
    { id: 'R2', branch: 'new', awaiting_agent_since: s - 5 * 60 },
    { id: 'R3', branch: 'gate', gates: 'review', gate_since: s - 300 * 60, working_path: '/r3' },
    { id: 'R4', branch: 'busy' },
  ], t);
  assert.deepEqual(ps.map(p => p.key.split(':')[1]), ['R1', 'R3']);
  assert.match(ps[0].text, /R1 \(feat\) parked .* 20 min\. Checkout \/repo, worktree \/w\/R1/);
  assert.match(ps[1].text, /gate review for 300 min/);
});

test('PRs: green+mergeable for 30 min, conflicting, drafts and red skipped', () => {
  const t = now.getTime(), old = new Date(t - 45 * MIN).toISOString(), fresh = new Date(t - 5 * MIN).toISOString();
  const ok = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', updatedAt: old };
  const ps = prProblems('o/r', [
    { number: 1, title: 'a', ...ok, statusCheckRollup: [{ conclusion: 'SUCCESS', completedAt: old }, { state: 'SUCCESS' }] },
    { number: 2, title: 'b', ...ok, statusCheckRollup: [{ conclusion: 'SUCCESS', completedAt: fresh }] },
    { number: 3, title: 'c', ...ok, statusCheckRollup: [{ conclusion: 'FAILURE', completedAt: old }] },
    { number: 4, title: 'd', mergeable: 'CONFLICTING', updatedAt: old },
    { number: 5, title: 'e', ...ok, isDraft: true },
    { number: 6, title: 'f', ...ok, mergeStateStatus: 'BLOCKED' },
  ], t);
  assert.deepEqual(keys(ps), ['pr:green:o/r#1', 'pr:conflict:o/r#4']);
});

test('health and mac lines', () => {
  assert.deepEqual(keys(healthProblems([{ name: 'dev', ok: true }, { name: 'live', ok: false, detail: 'HTTP 502' }])), ['health:live']);
  const jobs = { jobs: { g: { needs: ['gui'] }, u: { needs: ['unlocked'], paused: true }, n: {} } };
  const states = { g: { skip_notified: 'screen is locked (unlock to let it run)' }, u: { skip_notified: 'screen is locked' }, n: { skip_notified: 'screen is locked' } };
  assert.deepEqual(keys(macProblems({ load: 20, loadMax: 16, jobs, states })), ['mac:load', 'mac:locked']);
  assert.deepEqual(macProblems({ load: 2, loadMax: 16, jobs: { ...jobs, paused: true }, states }), []);
});

test('dedupe: same key held for 60 min, then sent again; stale keys dropped', () => {
  const t = now.getTime(), p = [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }];
  const first = dedupe(p, { old: t - 2 * 1440 * MIN }, t);
  assert.deepEqual(keys(first.send), ['a', 'b']);
  assert.deepEqual(Object.keys(first.sent).sort(), ['a', 'b']);
  assert.deepEqual(dedupe(p, first.sent, t + 59 * MIN).send, []);
  assert.deepEqual(keys(dedupe([p[0]], first.sent, t + 61 * MIN).send), ['a']);
  assert.deepEqual(keys(dedupe([p[0], p[0]], {}, t).send), ['a']);   // one line per problem per sweep
});
