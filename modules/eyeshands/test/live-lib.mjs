// The live fixture test's logic (design part 18, "Live fixture tests"), apart from the real world.
// Every outside call goes through `w` (live-world.mjs on a Mac; fakes in live-offline.test.mjs),
// so the gate, the preconditions, the run steps and the clean-up are testable without a screen.
//
//   gate(env, platform)        null when the live run may start, else why it skips
//   preflight(w)               preconditions 1-4: { holdFile, probe } or throws Skip(reason)
//   runLive(w, opts)           preflight, run steps 1-8, then the clean-up in a finally:
//                              { status: pass | skip | inconclusive | fail, reason, measured, problems }
//
// Rules this file keeps (the person and every other driver always win):
//   - every precondition is checked and skips with its reason; nothing is forced;
//   - the driver lock: the hold file must be configured and free (no manual hold, no live driver);
//     the test Spoon gets it as hold_file, so its hands lease takes the lock with the session's pid;
//   - the takeover nudge carries the run's own test tag, registered with harness.addEventTag for the
//     run: the awake watcher takes it for machine input (so it cannot lock the screen in away mode),
//     while the Spoon's guards do not know it and still take it for a person;
//   - job-hunt arming during the run aborts the job at once and ends the run as inconclusive, and so
//     does a takeover the test did not make (a real person);
//   - the clean-up runs in every case and only touches what the run made: its session, its Spoon
//     global, its test tag, its lock entry (exact pid, who and since), its Chrome (by pid, checked
//     against its profile path) and its temporary folder.
export const OWNER = 'eh-live-test';
export const TARGET = 'chrome-test';
export const GLOBAL = '__eyeshands_test';
export const DETECTOR = '__eyeshands_test_detector';
export const WHO = `eyeshands-${OWNER}`;
export const EVENT_TAG = 0x45484e44;
export const IDLE_BUFFER_S = 20;
// The run's test tag: "T" in the top byte and 24 random bits. It is none of the machine tags the
// Spoon knows (its own EVENT_TAG, harness.EVENT_TAG, job-hunt's), so the hands see a person.
export const TEST_TAG_BASE = 0x54000000;
export const testTagFrom = n => TEST_TAG_BASE + ((Number(n) >>> 0) & 0xffffff);

export class Skip extends Error {}
export class Inconclusive extends Error {}

// ---------- the gate ----------
export function gate(env = {}, platform = 'darwin') {
  if (env.CI) return 'CI is set: the live fixture test never runs on CI';
  if (env.EYESHANDS_LIVE !== '1') return 'set EYESHANDS_LIVE=1 to run the live fixture test (one Mac, never CI; see SETUP.md)';
  if (platform !== 'darwin') return 'the live fixture test needs macOS';
  return null;
}

// ---------- preconditions ----------
// The driver lock to use: EYESHANDS_HOLD_FILE, else the running Spoon's hold_file. Both set and
// different is a skip (one lock, or two tools could drive at once).
export function holdFileFrom(env, probe) {
  let mine = env.EYESHANDS_HOLD_FILE || null;
  if (mine && (mine === '~' || mine.startsWith('~/'))) mine = env.HOME ? env.HOME + mine.slice(1) : null;
  if (env.EYESHANDS_HOLD_FILE && (!mine || !mine.startsWith('/'))) throw new Skip('EYESHANDS_HOLD_FILE must be an absolute path (or start with ~/)');
  const live = probe?.production?.running ? probe.production.hold_file || null : null;
  if (mine && live && mine !== live) throw new Skip(`EYESHANDS_HOLD_FILE (${mine}) is not the running Spoon's hold_file (${live}); use one driver lock`);
  const file = mine || live;
  if (!file) throw new Skip('no driver hold file: set EYESHANDS_HOLD_FILE to the driver lock the other drivers share (every live run takes the driver lock)');
  return file;
}

const list = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

// Why the hold file stops the run, or null when it is free (no file, or a stale holder).
export function holdReason(hold, file) {
  if (!hold || hold.configured !== true) return `the hold file ${file} was not judged`;
  if (!hold.held) return null;
  const who = hold.who ? ` (${hold.who})` : '';
  const what = hold.kind === 'manual' ? `a manual hold${who}${hold.until ? ` until ${hold.until}` : ''}`
    : hold.kind === 'borrowed' ? `a borrowed manual hold${who}${hold.until ? ` until ${hold.until}` : ''}`
      : hold.kind === 'pid' ? `a live driver, pid ${hold.pid}${who}`
        : hold.kind === 'unwritable' ? 'a lock that cannot be written'
          : 'a lock that cannot be read (it counts as held)';
  return `the driver hold file ${file} holds ${what}; wait for it to end, never force`;
}

// The running hcron jobs that need the GUI, from the text `hcron status` prints.
export function guiJobsRunning(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\S*\s*(\S+)\s.*\bRUNNING pid \d+/);
    if (m && /\bneeds \S*\bgui\b/.test(line)) out.push(m[1]);
  }
  return out;
}

// Preconditions 1-3 and the hold file, in order, on one probe: the first reason to skip, or null.
export function judge(probe, { hcron, holdFile } = {}) {
  if (!probe) return 'Hammerspoon does not answer `hs -c` (the test loads its Spoon through it)';
  if (!probe.grants?.accessibility) return 'Hammerspoon has no Accessibility grant';
  if (probe.grants.screen_recording === false) return 'Hammerspoon has no Screen Recording grant';
  if (probe.session?.locked) return 'the screen is locked';
  if (probe.session?.on_console === false) return 'the session is not on the console';
  if (probe.awake && probe.add_event_tag !== true) return 'the harness has awake mode but no addEventTag: the test nudge would count as a person and could lock the screen';
  const foreign = list(probe.foreign);
  if (foreign.includes('jobhunt')) return 'job-hunt holds its hands (armed or busy); never run next to it';
  const port = foreign.filter(n => String(n).startsWith('harness:'));
  if (port.length) return `the harness port has an armed hands owner (${port.join(', ')})`;
  if (foreign.length) return `another driver holds hands (${foreign.join(', ')})`;
  const p = probe.production || {};
  if (p.running && (p.lease || p.busy)) return `the running Eyes & Hands Spoon is in use (lease ${p.lease || '-'}, job ${p.busy || '-'})`;
  if (p.running && list(p.armed).length) return `the running Eyes & Hands Spoon has an armed hands owner (${list(p.armed).join(', ')})`;
  const gui = guiJobsRunning(hcron);
  if (gui.length) return `hcron runs a --needs gui job (${gui.join(', ')})`;
  if (probe.test_loaded) return `${GLOBAL} is still loaded from an earlier run: unload it first (see SETUP.md, "Live fixture test")`;
  if (holdFile) return holdReason(probe.hold, holdFile);
  return null;
}

// Precondition 4: nobody used the Mac for the idle buffer. Waits up to timeoutS; null, or why not.
export async function waitIdle(w, { buffer = IDLE_BUFFER_S, timeoutS = 90, holdFile } = {}) {
  w.log(`Hands off the mouse and keyboard for about ${Math.max(60, buffer * 3)} s`);
  const end = w.now() + timeoutS * 1000;
  let idle = 0;
  for (;;) {
    const p = await w.probe(holdFile);
    idle = Number(p?.idle_s) || 0;
    if (idle >= buffer + 1) return null;
    if (w.now() >= end) return `someone is using the Mac (idle ${Math.floor(idle)} s, need ${buffer} s)`;
    await w.sleep(1000);
  }
}

// hcron's job states; a run that cannot read them cannot tell that no GUI job runs, so it skips.
async function hcronOf(w) {
  try { return await w.hcronStatus(); } catch (e) { throw new Skip(`cannot read hcron status (${e.message}); a GUI job may run`); }
}

export async function preflight(w, { buffer = IDLE_BUFFER_S, idleTimeoutS = 90 } = {}) {
  const first = await w.probe(w.env.EYESHANDS_HOLD_FILE ? holdFileFrom(w.env, null) : null).catch(() => null);
  const hcron = await hcronOf(w);
  let why = judge(first, { hcron });
  if (why) throw new Skip(why);
  const holdFile = holdFileFrom(w.env, first);
  const probe = await w.probe(holdFile);
  why = judge(probe, { hcron, holdFile });
  if (why) throw new Skip(why);
  why = await waitIdle(w, { buffer, timeoutS: idleTimeoutS, holdFile });
  if (why) throw new Skip(why);
  // The state may have changed while the person stepped away: look once more.
  const last = await w.probe(holdFile);
  why = judge(last, { hcron: await hcronOf(w), holdFile });
  if (why) throw new Skip(why);
  return { holdFile, probe: last };
}

// ---------- the fixture checks ----------
export const FILL = {
  name: 'Ada Lovelace',
  accented: 'Zoë Ångström-Façade',
  email: 'ada@example.com',
  city: 'Zürich',
  notes: 'A short note.',
  long: 'Eyes and hands fill this long text through the clipboard. '.repeat(7).trim(),
};
export const SELECT = { id: 'size', value: 'medium', label: 'Medium' };
export const UPLOAD = { name: 'eh-upload.txt', text: 'Eyes & Hands fixture upload\n' };

// What differs between the page's own report (DOM) and the eyes' field records (AX), and the
// values the run typed. A list of problems; empty when all agree.
export function compareFill(report, fields) {
  const out = [];
  if (!report) return ['the page sent no report'];
  const ax = dom => list(fields).find(f => f && f.dom === dom);
  for (const [id, want] of Object.entries(FILL)) {
    const got = report.values?.[id];
    if (got !== want) out.push(`DOM ${id} is ${JSON.stringify(got)}, typed ${JSON.stringify(want)}`);
    const f = ax(id);
    if (!f) out.push(`the eyes found no field with dom ${id}`);
    else if (f.value !== got) out.push(`AX ${id} is ${JSON.stringify(f.value)}, DOM ${JSON.stringify(got)}`);
  }
  if (report.values?.[SELECT.id] !== SELECT.value) out.push(`DOM ${SELECT.id} is ${JSON.stringify(report.values?.[SELECT.id])}, want ${SELECT.value}`);
  const sel = ax(SELECT.id);
  if (!sel) out.push(`the eyes found no field with dom ${SELECT.id}`);
  else if (sel.value !== SELECT.label && sel.value !== SELECT.value) out.push(`AX ${SELECT.id} is ${JSON.stringify(sel.value)}, DOM ${SELECT.value}`);
  if (report.contact !== 'phone') out.push(`DOM contact is ${JSON.stringify(report.contact)}, want phone`);
  const radio = ax('contact-phone');
  if (!radio || radio.checked !== true) out.push('AX contact-phone is not checked');
  if (report.agree !== true) out.push('DOM agree is not checked');
  const box = ax('agree');
  if (!box || box.checked !== true) out.push('AX agree is not checked');
  if (report.file?.name !== UPLOAD.name || report.file?.size !== Buffer.byteLength(UPLOAD.text)) {
    out.push(`DOM file is ${JSON.stringify(report.file)}, want ${UPLOAD.name} (${Buffer.byteLength(UPLOAD.text)} bytes)`);
  }
  return out;
}

// The page's event log: every event trusted, and a mouse move after each mouseup before the next
// mousedown (the hands move to a target; they never jump and click).
export function eventProblems(log) {
  const out = [];
  let moved = false;
  for (const e of list(log)) {
    if (e.trusted !== true) out.push(`an untrusted ${e.type} on ${e.id}`);
    if (e.type === 'mousemove') moved = true;
    if (e.type === 'mousedown') {
      if (!moved) out.push(`a mousedown on ${e.id} with no mouse move before it`);
      moved = false;
    }
  }
  return [...new Set(out)];
}

// ---------- the run ----------
const sleepFor = (w, ms) => w.sleep(ms);

// One run's context: the session, the job polling, and the job-hunt watch.
function driver(w, st) {
  const watch = async () => {
    const p = await w.probe(null).catch(() => null);
    if (p && list(p.foreign).includes('jobhunt')) {
      st.jobhuntStarted = true;
      if (st.session) await st.session.call('eh.hands.abort', null).catch(() => {});
      throw new Inconclusive('inconclusive: job-hunt started');
    }
  };
  const call = async (cmd, args) => {
    const rep = await st.session.call(cmd, args);
    if (!rep || rep.ok !== true) throw new Error(`${cmd}: the port refused: ${JSON.stringify(rep)}`);
    return rep.result;
  };
  // Starts a hands command and polls its job to the end, watching job-hunt between polls.
  // expect: the refusal reasons (or final states) the step wants; anything else ends the run.
  const act = async (cmd, args, expect = []) => {
    await watch();
    let res = await call(cmd, { target: TARGET, ...args });
    const end = w.now() + 60000;
    while (res && res.state === 'running') {
      await sleepFor(w, 150);
      await watch();
      res = await call('eh.hands.job', { id: res.job });
      if (res.state === 'running' && w.now() > end) {
        await call('eh.hands.abort', null).catch(() => {});
        throw new Error(`${cmd}: the job ran over 60 s`);
      }
    }
    const why = res && res.ok === false ? res.reason || res.state : null;
    if (!why || expect.includes(why)) return res;
    if (why === 'interrupted') throw new Inconclusive('inconclusive: a person took over');
    if (why === 'present') throw new Inconclusive('inconclusive: someone used the Mac');
    if (why === 'held') throw new Inconclusive(`inconclusive: the driver hold file became held (${res.kind || '?'})`);
    if (why === 'foreign_hands') { st.jobhuntStarted = list(res.by).includes('jobhunt') || st.jobhuntStarted; throw new Inconclusive(`inconclusive: another driver started (${list(res.by).join(', ')})`); }
    throw new Error(`${cmd}: ${why}: ${res.hint || JSON.stringify(res)}`);
  };
  const fields = async () => {
    const res = await call('eh.eyes.fields', { target: TARGET });
    if (res.ok === false) throw new Error(`eyes fields: ${res.reason}: ${res.hint || ''}`);
    return list(res.fields);
  };
  // Clicks a field by its HTML id; scrolls it into view first when the hands say offscreen.
  const clickField = async (dom, expect = []) => {
    for (let i = 0; i < 4; i++) {
      const f = (await fields()).find(x => x.dom === dom);
      if (!f) throw new Error(`the eyes found no field with dom ${dom}`);
      const res = await act('eh.hands.click', { to: { field: f.id } }, ['offscreen', ...expect]);
      if (res.reason !== 'offscreen') return res;
      await act('eh.hands.scroll', { dy: Number(res.dy) || 200 });
    }
    throw new Error(`could not scroll ${dom} into view`);
  };
  return { watch, call, act, fields, clickField };
}

async function fillForm(w, st, d) {
  for (const id of Object.keys(FILL)) {
    await d.clickField(id);
    await d.act('eh.hands.type', { text: FILL[id], ...(id === 'long' ? { paste: true } : { paste: false }) });
    if (id === 'city') await d.act('eh.hands.key', { combo: 'escape' });   // closes the suggestions
  }
  // The select opens a native menu: type the label (type-ahead), then enter.
  await d.clickField(SELECT.id);
  await sleepFor(w, 400);
  await d.act('eh.hands.type', { text: SELECT.label, paste: false });
  await d.act('eh.hands.key', { combo: 'enter' });
  await d.clickField('contact-phone');
  await d.clickField('agree');
  // The file input opens the native open panel: go to the file's path, select it, open it.
  await d.clickField('upload');
  const end = w.now() + 8000;
  for (;;) {
    const dlg = await d.call('eh.eyes.dialog', { target: TARGET });
    if (dlg && dlg.open) break;
    if (w.now() > end) throw new Error('the open panel did not show');
    await sleepFor(w, 250);
  }
  await d.act('eh.hands.key', { combo: 'cmd+shift+g' });
  await sleepFor(w, 700);
  await d.act('eh.hands.type', { text: st.uploadPath, paste: false });
  await sleepFor(w, 400);
  await d.act('eh.hands.key', { combo: 'enter' });
  await sleepFor(w, 900);
  await d.act('eh.hands.key', { combo: 'enter' });

  const report = await st.fx.waitFor(r => r.file && r.file.name === UPLOAD.name && r.values?.[SELECT.id] === SELECT.value, 10000)
    || st.fx.report();
  const problems = [...compareFill(report, await d.fields()), ...eventProblems(report?.log)];
  if (problems.length) throw new Error(`fill: ${problems.join('; ')}`);
}

// Step 8: does posted input reset hs.host.idleTime()? Read it right after a tagged job ends.
async function measureIdle(w, st, d) {
  const f = (await d.fields()).find(x => x.dom === 'notes');
  await d.act('eh.hands.move', { to: { field: f.id } });
  const p = await w.probe(null);
  st.measured.idle_after_tagged_s = Number(p.idle_s);
  st.measured.tagged_resets_idle = Number(p.idle_s) < 2;
}

// Step 6: one nudge with the run's test tag (a person to the hands) stops the hands; the next call is refused; resume only after the
// present rule passes.
async function takeover(w, st, d, buffer) {
  await d.clickField('notes');
  await d.watch();
  const started = await d.call('eh.hands.type', { target: TARGET, text: ' The quick brown fox jumps over the lazy dog.'.repeat(4), paste: false });
  if (started.state !== 'running') throw new Error(`takeover: the typing job did not start: ${JSON.stringify(started)}`);
  await sleepFor(w, 500);
  await w.nudge(st.testTag);
  const q = await w.probe(null);
  st.measured.idle_after_untagged_s = Number(q.idle_s);
  st.measured.untagged_resets_idle = Number(q.idle_s) < 2;
  let res = started;
  const end = w.now() + 5000;
  while (res.state === 'running') {
    if (w.now() > end) throw new Error('takeover: the nudge did not stop the job within 5 s');
    await sleepFor(w, 100);
    res = await d.call('eh.hands.job', { id: started.job });
  }
  if (res.state !== 'interrupted') throw new Error(`takeover: the job ended ${res.state}, not interrupted`);
  const next = await d.act('eh.hands.key', { combo: 'tab' }, ['present', 'interrupted']);
  if (next.ok !== false) throw new Error('takeover: the call after the nudge was not refused');
  const early = await d.call('eh.hands.resume', null);
  if (early.reason !== 'present') throw new Error(`takeover: an early hands_resume was not refused present: ${JSON.stringify(early)}`);
  st.measured.present_refusal = true;
  const until = w.now() + (buffer * 3 + 10) * 1000;
  await sleepFor(w, (buffer + 1) * 1000);
  for (;;) {
    const r = await d.call('eh.hands.resume', null);
    if (r.ok !== false && r.interrupted === false) break;
    if (r.reason !== 'present') throw new Error(`takeover: hands_resume: ${JSON.stringify(r)}`);
    if (w.now() > until) throw new Inconclusive('inconclusive: someone used the Mac');
    await sleepFor(w, 1000);
  }
  await d.clickField('notes');
}

// Step 7: a fake detector in the test's own namespace refuses foreign_hands; the stop command ends
// the job and disarms the owner; the stop switch drops the driver lock.
async function foreignAndStop(w, st, d) {
  await w.setDetector(true);
  st.detectorOn = true;
  const f = (await d.fields()).find(x => x.dom === 'notes');
  const r = await d.call('eh.hands.click', { target: TARGET, to: { field: f.id } });
  await w.setDetector(false);
  st.detectorOn = false;
  if (r.reason !== 'foreign_hands' || !list(r.by).includes(DETECTOR)) throw new Error(`foreign: want foreign_hands by ${DETECTOR}: ${JSON.stringify(r)}`);

  await d.watch();
  const started = await d.call('eh.hands.type', { target: TARGET, text: ' Stop me.'.repeat(12), paste: false });
  if (started.state !== 'running') throw new Error(`stop: the typing job did not start: ${JSON.stringify(started)}`);
  await sleepFor(w, 400);
  const stop = await w.stopCommand(st.port);
  if (stop?.stopped !== true || !list(stop.disarmed).includes(OWNER)) throw new Error(`stop: ${JSON.stringify(stop)}`);
  const after = await st.session.call('eh.hands.status', null);
  if (after && after.ok === true) throw new Error('stop: the owner still answers after the stop command');
  const t = await w.testStatus();
  if (t?.hands?.lease || t?.hands?.busy) throw new Error(`stop: the hands still hold a lease or job: ${JSON.stringify(t.hands)}`);
  if (lockIsOurs(await w.readFile(st.holdFile), st.session.pid)) throw new Error('stop: the stop switch left the driver lock');
}

// The lock entry this run's Spoon wrote (the session's pid and WHO), from the hold file's text.
export function lockIsOurs(text, pid) {
  try {
    const j = JSON.parse(text);
    return !!j && typeof j === 'object' && j.pid === pid && j.who === WHO;
  } catch { return false; }
}

async function body(w, st, opts) {
  const pre = await preflight(w, { buffer: opts.buffer, idleTimeoutS: opts.idleTimeoutS });
  st.holdFile = pre.holdFile;
  st.jobhuntBefore = pre.probe.jobhunt?.info ?? null;
  st.restoreTag = !!(pre.probe.production?.running && pre.probe.production.tag_registered);

  // The run's test tag counts as machine input for the harness until the clean-up removes it. With
  // no harness addEventTag there is no awake watcher either (judge skips otherwise): the nudge goes
  // untagged.
  if (pre.probe.add_event_tag) {
    st.testTag = testTagFrom(await w.random24());   // set first: an add that fails half-way is still removed
    const added = await w.addEventTag(st.testTag);
    if (!added || added.ok !== true) throw new Skip(`harness.addEventTag refused the test tag: ${added?.why || JSON.stringify(added)}`);
  }

  // 1. A temporary folder with an access file, a targets file and the file to upload.
  st.dir = await w.mkTemp();
  st.profile = `${st.dir}/chrome-profile`;
  st.uploadPath = `${st.dir}/${UPLOAD.name}`;
  await w.mkdir(st.profile);
  await w.writeFile(`${st.dir}/access.json`, JSON.stringify({ owners: { [OWNER]: {
    enabled: true, capabilities: ['eyes', 'hands'], apps: [TARGET], max_arm_minutes: 30 } } }));
  await w.writeFile(`${st.dir}/targets.json`, JSON.stringify({ targets: { [TARGET]: {
    bundle: 'com.google.Chrome', profile: st.profile, refuse_debug_port: true } } }));
  await w.writeFile(st.uploadPath, UPLOAD.text);

  // 3. The fixture form on 127.0.0.1 at a random port.
  st.fx = await w.startFixture();

  // 4. The Spoon under its own global and port, with the driver lock as its hold file.
  st.port = w.portName();
  st.loaded = true;   // set first: a start that fails half-way is still unloaded
  await w.loadSpoon({ port: st.port, dir: st.dir, holdFile: st.holdFile, buffer: opts.buffer });

  // 2. A throwaway Chrome, found by its profile path (never by app name).
  await w.startChrome(st.profile, st.fx.url);
  const end = w.now() + 20000;
  while (!st.chromePid) {
    st.chromePid = (await w.chromePids(st.profile))[0] || null;
    if (!st.chromePid) {
      if (w.now() > end) throw new Error('the throwaway Chrome did not start');
      await sleepFor(w, 250);
    }
  }
  if (!(await st.fx.waitFor(r => r.seq >= 1, 20000))) throw new Error('the fixture page did not load');

  // The session: one signer for the run; its pid is the armed pid that the driver lock names.
  st.session = await w.openSession(st.port);
  const d = driver(w, st);
  await d.watch();
  const focus = await d.call('eh.hands.focus', { target: TARGET });
  if (focus.ok === false) {
    if (['held', 'foreign_hands', 'present', 'lease_held'].includes(focus.reason)) {
      throw new Inconclusive(`inconclusive: hands_focus refused ${focus.reason}${focus.kind ? ` (${focus.kind})` : ''}`);
    }
    throw new Error(`hands_focus: ${focus.reason}: ${focus.hint || ''}`);
  }
  const lock = await w.readFile(st.holdFile);
  if (!lockIsOurs(lock, st.session.pid)) throw new Error(`the hands lease did not take the driver lock (the hold file holds ${JSON.stringify(lock)})`);
  st.lockEntry = JSON.parse(lock);
  st.measured.driver_lock = true;
  await sleepFor(w, 600);

  await fillForm(w, st, d);             // 5
  await measureIdle(w, st, d);          // 8
  await takeover(w, st, d, opts.buffer); // 6
  await foreignAndStop(w, st, d);       // 7
}

// ---------- abort and clean-up ----------
// Undoes what the run made, every step in its own try, in this order: the session (abort, then
// disarm by closing it), the fake detector, the test tag (harness.removeEventTag), the Spoon (unload, then check the global is gone and
// the port closed), a left awake hold, a left lock entry (only the run's exact entry), the throwaway
// Chrome (by pid, only while its command line still names the run's profile), the fixture server,
// the temporary folder, and last the jobhunt.info() check. Returns the problems it found.
export async function cleanup(w, st) {
  const problems = [];
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { problems.push(`clean-up ${name}: ${e.message || e}`); }
  };
  await step('session', async () => {
    if (!st.session) return;
    await st.session.call('eh.hands.abort', null).catch(() => {});
    await st.session.close();
  });
  await step('detector', async () => { if (st.loaded || st.detectorOn) await w.setDetector(false); });
  await step('tag', async () => {
    if (st.testTag == null) return;
    const r = await w.removeEventTag(st.testTag);
    if (!r || r.ok !== true) throw new Error(`harness.removeEventTag refused the test tag: ${r?.why || JSON.stringify(r)}`);
  });
  await step('spoon', async () => {
    if (!st.loaded) return;
    const r = await w.unloadSpoon({ restoreTag: st.restoreTag });
    if (!r || r.gone !== true) problems.push(`clean-up spoon: ${GLOBAL} is still loaded`);
    if (st.port && await w.portOpen(st.port)) problems.push(`clean-up spoon: the port ${st.port} still answers`);
  });
  await step('awake', async () => {
    if (!st.loaded) return;
    const p = await w.probe(null);
    if (list(p?.awake?.owners).includes(WHO)) {
      await w.releaseAwake(WHO);
      problems.push(`clean-up awake: the awake hold ${WHO} was left; released it`);
    }
  });
  await step('lock', async () => {
    if (!st.holdFile || !st.session) return;
    const text = await w.readFile(st.holdFile);
    if (text === null) return;
    let j = null;
    try { j = JSON.parse(text); } catch { return; }
    const exact = st.lockEntry ? j?.pid === st.lockEntry.pid && j?.who === st.lockEntry.who && j?.since === st.lockEntry.since
      : lockIsOurs(text, st.session.pid);
    if (exact) {
      await w.unlink(st.holdFile);
      problems.push('clean-up lock: the run\'s driver lock entry was left; removed it');
    }
  });
  await step('chrome', async () => {
    if (!st.profile) return;
    const pids = new Set([st.chromePid, ...(await w.chromePids(st.profile))].filter(Boolean));
    for (const pid of pids) if (await w.ownsProfile(pid, st.profile)) await w.kill(pid, 'SIGTERM');
    const end = w.now() + 10000;
    for (const pid of pids) {
      while (await w.ownsProfile(pid, st.profile)) {
        if (w.now() > end) { await w.kill(pid, 'SIGKILL'); break; }
        await sleepFor(w, 200);
      }
    }
  });
  await step('fixture', async () => { if (st.fx) await st.fx.close(); });
  await step('folder', async () => { if (st.dir) await w.rmTemp(st.dir); });
  await step('jobhunt', async () => {
    if (!st.loaded || st.jobhuntStarted) return;
    const p = await w.probe(null);
    const after = p?.jobhunt?.info ?? null;
    if (after !== st.jobhuntBefore) problems.push('jobhunt.info() changed during the run');
  });
  return problems;
}

export async function runLive(w, opts = {}) {
  opts = { buffer: IDLE_BUFFER_S, idleTimeoutS: 90, ...opts };
  const st = { measured: {} };
  let outcome;
  try {
    await body(w, st, opts);
    outcome = { status: 'pass' };
  } catch (e) {
    outcome = e instanceof Skip ? { status: 'skip', reason: e.message }
      : e instanceof Inconclusive ? { status: 'inconclusive', reason: e.message }
        : { status: 'fail', reason: e.message || String(e) };
  } finally {
    st.problems = await cleanup(w, st);
  }
  if (st.problems.length && outcome.status !== 'fail') outcome = { status: 'fail', reason: st.problems.join('; ') };
  return { ...outcome, measured: st.measured, problems: st.problems };
}
