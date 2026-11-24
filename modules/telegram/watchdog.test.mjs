// node --test modules/telegram/watchdog.test.mjs
// The watchdog's queue check, offline: a throwaway HOME and harness.env, and a fake transcript in the
// session's project folder. A small Python driver loads the real watchdog.py and runs check() once,
// with the process table, tmux, ACTIVE_HOST and the Telegram calls swapped for recorders, so nothing
// here touches launchd, a real session or the network. State (watchdog/state.json) carries over
// between runs in the same sandbox, as it does between watchdog runs; transcript times are relative to
// a base time fixed per sandbox, so the same entries keep the same timestamps from run to run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCHDOG = fileURLToPath(new URL('./watchdog.py', import.meta.url));
const PY = '/usr/bin/python3';
const skip = !(existsSync(PY) && existsSync('/bin/zsh')) && 'needs /usr/bin/python3 and /bin/zsh';

const DRIVER = String.raw`
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("watchdog", sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
sc = json.loads(sys.argv[2])
if "eval" in sc:
    print(json.dumps(eval(sc["eval"], {"w": w})))
    sys.exit(0)
def note(kind, text):
    with open(sc["record"], "a") as f:
        f.write(json.dumps([kind, text]) + "\n")
class Done:
    returncode, stdout = 0, ""
w.notify = lambda token, text: note("notify", text)
w.tmux = lambda *a: note("tmux", " ".join(a)) or Done()
w.LAUNCHD = False
w.this_host = lambda: "here"
w.owner = lambda state, now: "here"
w.agent_pid = lambda: (100, True)
w.processes = lambda: {100: (1, "/bin/zsh -il /h/telegram/run.sh"), 101: (100, "bun run server.ts")}
w.kill_strays = lambda procs, tree: []
w.screen_text = lambda: sc.get("screen", "")
w.read_env = lambda: {}
w.time.sleep = lambda s: None
now = sc["base"]  # fixed per sandbox, so a rerun writes the same transcript
os.makedirs(w.PROJECT_DIR, exist_ok=True)
with open(os.path.join(w.PROJECT_DIR, "session.jsonl"), "w") as f:
    f.write("{}\n")  # transcript_status skips the first line (it may be cut by the tail read)
    for e in sc["transcript"]:
        e = dict(e)
        e["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now - e.pop("ago"))) + ".000Z"
        if "resetsIn" in e:
            e["apiErrorParams"] = {"rate_limit_info": {"resetsAt": int(now + e.pop("resetsIn"))}}
        f.write(json.dumps(e) + "\n")
if "mtimeAgo" in sc:  # when the transcript was last written (a real one stops when its session dies)
    m = time.time() - sc["mtimeAgo"]
    os.utime(os.path.join(w.PROJECT_DIR, "session.jsonl"), (m, m))
w.check()
`;

function sandbox(t) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'tg-watchdog-test-')));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const home = join(d, 'home'), record = join(d, 'calls.jsonl');
  const envFile = join(d, 'harness.env');
  writeFileSync(envFile, `PROJECTS_DIR="${d}"\nPROFILE_DIR="${d}/profile"\nTELEGRAM_WORKDIR="${d}/work"\nLABEL_PREFIX="test"\n`);
  const env = { PATH: '/usr/bin:/bin', HOME: home, HARNESS_ENV: envFile };
  const py = sc => {
    const r = spawnSync(PY, ['-I', '-c', DRIVER, WATCHDOG, JSON.stringify(sc)], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout;
  };
  const base = Date.now() / 1000;
  const stateFile = join(home, '.claude/channels/telegram/watchdog/state.json');
  return {
    run(transcript, { screen = '', mtimeAgo } = {}) { writeFileSync(record, ''); py({ transcript, screen, record, base, mtimeAgo }); },
    calls: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
    restarts() { return this.calls().filter(([k, v]) => k === 'tmux' && v.startsWith('new ')).length; },
    notices() { return this.calls().filter(([k]) => k === 'notify').map(([, v]) => v); },
    log: () => readFileSync(join(home, '.claude/channels/telegram/logs/watchdog.log'), 'utf8'),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    setState: s => writeFileSync(stateFile, JSON.stringify(s)),
    eval: expr => JSON.parse(py({ eval: expr })),
  };
}

const MSG = '<channel source="plugin:telegram:telegram" chat_id="1" message_id="7">did you get my message?</channel>';
const queued = (ago, content = MSG) => ({ type: 'queue-operation', operation: 'enqueue', ago, content });
const reply = ago => ({ type: 'assistant', ago, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
const toolCall = ago => ({ type: 'assistant', ago, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
const turnEnd = ago => ({ type: 'system', subtype: 'turn_duration', ago });
const userMsg = ago => ({ type: 'user', ago, message: { role: 'user', content: MSG } });
const LIMIT_TEXT = "You've hit your weekly limit · resets Nov 20 at 11:30pm (Asia/Calcutta)";
const limitHit = (ago, resetsIn) => ({
  type: 'assistant', ago, isApiErrorMessage: true, apiError: 'usage_limit_reached', resetsIn,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: LIMIT_TEXT }] },
});
const idleSession = [reply(3600), turnEnd(3599)];

test('a message waiting 5+ min with no reply restarts (resume) once, and asks to resend', { skip }, t => {
  const s = sandbox(t);
  s.run([...idleSession, queued(400)]);
  assert.equal(s.restarts(), 1, JSON.stringify(s.calls()));
  assert.match(s.log(), /RESTART \(resume\): 1 message\(s\) waited 6 min with no reply/);
  assert.match(s.notices().join('\n'), /send it again/);
  // The queued message died with the old process: it never counts again, so no loop.
  s.setState({ ...s.state(), restarts: [] });
  s.run([...idleSession, queued(400)]);
  assert.equal(s.restarts(), 0);
});

test('a stuck batch after an earlier restart restarts again (gap and storm rules still apply)', { skip }, t => {
  const s = sandbox(t);
  s.run([...idleSession, queued(400)]);
  assert.equal(s.restarts(), 1);
  // A new message queued 2 min after that restart, still unanswered: but the last restart was <3 min ago.
  const st = s.state();
  s.setState({ ...st, last_restart_at: st.last_restart_at - 120, restarts: [st.restarts[0] - 120] });
  s.run([...idleSession, queued(400), queued(30)]);
  assert.equal(s.restarts(), 0, 'not before the batch has waited 5 min');
  s.setState({ ...s.state(), last_restart_at: st.last_restart_at - 700, restarts: [st.restarts[0] - 700] });
  s.run([...idleSession, queued(400)]);
  assert.equal(s.restarts(), 1);
});

test('the oldest waiting message counts, so resending every few minutes still triggers it', { skip }, t => {
  const s = sandbox(t);
  s.run([...idleSession, queued(620), queued(400), queued(200), queued(20)]);
  assert.equal(s.restarts(), 1);
  assert.match(s.log(), /4 message\(s\) waited 10 min/);
});

test('healthy states never restart', { skip }, t => {
  const cases = {
    'message waiting under 5 min': [[...idleSession, queued(240)]],
    'message answered': [[...idleSession, queued(600), reply(590), turnEnd(580)]],
    'a long tool call is running': [[...idleSession, toolCall(900), queued(600)]],
    'only a slash command queued': [[...idleSession, queued(600, '/rate-limit-options')]],
    'nothing queued': [idleSession],
    'a turn is live on screen': [[...idleSession, userMsg(700), queued(600)], { screen: '✻ Thinking… (esc to interrupt)' }],
  };
  for (const [name, args] of Object.entries(cases)) {
    const s = sandbox(t);
    s.run(...args);
    assert.equal(s.restarts(), 0, `${name}: ${JSON.stringify(s.calls())}`);
  }
});

test('a stale "esc to interrupt" on an idle screen is not a frozen turn', { skip }, t => {
  const s = sandbox(t);
  const screen = 'Done.\n· esc to interrupt';
  s.run(idleSession, { screen });
  s.setState({ ...s.state(), screen_changed: s.state().screen_changed - 1200 });
  s.run(idleSession, { screen });
  assert.equal(s.restarts(), 0, JSON.stringify(s.calls()));
});

test('a turn with a frozen screen still restarts, and the plugin channel tag counts as busy', { skip }, t => {
  const s = sandbox(t);
  const screen = '✻ Thinking… (esc to interrupt)';
  const live = [...idleSession, userMsg(1300)];
  s.run(live, { screen });
  s.setState({ ...s.state(), screen_changed: s.state().screen_changed - 1200 });
  s.run(live, { screen });
  assert.equal(s.restarts(), 1, JSON.stringify(s.calls()));
  assert.match(s.log(), /stuck on a reply for \d+ min/);
  assert.equal(s.eval('w.CHANNEL_TAG.search(\'<channel source="plugin:telegram:telegram" chat_id="1">\') is not None'), true);
});

test('after a restart, the old unanswered transcript is not a stuck turn (no restart loop)', { skip }, t => {
  const s = sandbox(t);
  // The old session hung on a message 25 min ago; its transcript stopped 25 min ago too.
  const hung = [...idleSession, userMsg(1500)];
  s.run(hung, { mtimeAgo: 1500 });
  assert.equal(s.restarts(), 1, JSON.stringify(s.calls()));
  // The fresh session has written nothing yet, so the newest transcript is still the old one.
  const st = s.state();
  s.setState({ ...st, last_restart_at: st.last_restart_at - 400, restarts: [st.restarts[0] - 400] });
  s.run(hung, { mtimeAgo: 1500 });
  assert.equal(s.restarts(), 0, JSON.stringify(s.calls()));
});

test('usage limit: no restart before the reset, one notice with the reset time', { skip }, t => {
  const s = sandbox(t);
  const transcript = [...idleSession, limitHit(3000, 3600), turnEnd(2999), queued(900), queued(60)];
  s.run(transcript);
  assert.equal(s.restarts(), 0, 'an API error used to restart at once; a usage limit must not');
  assert.equal(s.notices().length, 1);
  assert.match(s.notices()[0], /usage limit \(resets .+\)\. Your messages wait/);
  assert.match(s.log(), /usage limit until .*; not restarting before then/);
  s.run(transcript);
  assert.equal(s.restarts(), 0);
  assert.equal(s.notices().length, 0, 'told once');
  // Hit again after a resume (a new error entry, same limit): still not told twice.
  s.run([...transcript, limitHit(30, 3600)]);
  assert.equal(s.notices().length, 0);
});

test('usage limit: once it has reset, still-waiting messages restart the session once', { skip }, t => {
  const s = sandbox(t);
  const transcript = [...idleSession, limitHit(20000, -600), turnEnd(19999), queued(900)];
  s.run(transcript);
  assert.equal(s.restarts(), 1, JSON.stringify(s.calls()));
  assert.match(s.log(), /waited 15 min with no reply after the usage limit reset/);
  s.setState({ ...s.state(), restarts: [] });
  s.run(transcript);
  assert.equal(s.restarts(), 0, 'once, not every run');
});

test('usage limit: within a minute of the reset it still waits', { skip }, t => {
  const s = sandbox(t);
  s.run([...idleSession, limitHit(20000, -30), turnEnd(19999), queued(900)]);
  assert.equal(s.restarts(), 0);
});

test('reset time read from the error text when the entry has no resetsAt', { skip }, t => {
  const s = sandbox(t);
  const at = iso => Date.parse(iso) / 1000;
  const r = (text, since) => s.eval(`w.reset_from_text(${JSON.stringify(text)}, ${at(since)})`);
  assert.equal(r(LIMIT_TEXT, '2026-11-19T16:04:42Z'), at('2026-11-20T18:00:00Z'));
  assert.equal(r("You've hit your session limit · resets 3pm (UTC)", '2026-11-19T16:00:00Z'), at('2026-11-20T15:00:00Z'));
  assert.equal(r('resets 9:15am (Europe/London)', '2026-11-19T08:00:00Z'), at('2026-11-19T09:15:00Z'));
  assert.equal(r('resets Jan 2 at 1am (UTC)', '2026-12-30T00:00:00Z'), at('2027-01-02T01:00:00Z'));
  assert.equal(r('limit reached, try later', '2026-11-19T08:00:00Z'), at('2026-11-19T09:00:00Z'), 'unreadable: an hour later');
  const entry = { timestamp: '2026-11-19T16:04:42.234Z', apiError: 'usage_limit_reached' };
  assert.equal(s.eval(`w.limit_reset(${JSON.stringify(entry)}, ${JSON.stringify(LIMIT_TEXT)})`), at('2026-11-20T18:00:00Z'));
  assert.equal(s.eval(`w.limit_reset({"timestamp": "2026-11-19T16:04:42Z"}, "API Error: 500")`), null, 'other errors are not limits');
});
