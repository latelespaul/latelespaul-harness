// The mac-node allowlist: the only actions the Mac runs for the VM, and how each one's args are checked.
// Both sides use it. The VM checks a request before it queues it (so a typo is refused at once, not
// hours later); the Mac checks every request again and is the one that decides. A request is an argv
// array, never a shell string: the Mac runs one fixed program with checked arguments, without a shell.
//
// parse(argv, cfg) -> { ok: true, action, gui, run } | { ok: false, reason }
//   cfg null: check names and args only (the VM side).
//   cfg set:  also resolve the program, its args and folder from the Mac's harness.env (the Mac side).
//   run: { kind: 'exec', file, args, cwd, timeoutMs }, { kind: 'hands', calls, timeoutMs } or { kind: 'ping' }
// summary(argv): a short, log-safe description (no typed text, no tool output).

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;          // ids: hcron jobs, chrome profiles, repos
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:@\/=,+-]{0,199}$/;         // a plain argument
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]{0,39}(=[A-Za-z0-9._:@\/,+-]{0,160})?$/;
const COMPANY = /^[A-Za-z0-9][A-Za-z0-9 .&_'-]{0,63}$/;
const MAX_JSON = 16 * 1024;
const MAX_ARGS = 16;

const MIN = 60_000;
const refuse = reason => ({ ok: false, reason });
const words = list => list.every(a => (WORD.test(a) || FLAG.test(a)) && !a.split('/').includes('..'));

// The action table, in the order `mac-node help` lists it. use: the argument shape, for errors and docs.
export const ACTIONS = [
  { name: 'ping', use: 'ping', about: 'is the Mac there? (version, lock state)' },
  { name: 'eyes status', use: 'eyes status', about: 'Hammerspoon state: screen lock, grants, armed owners (hsx status)' },
  { name: 'hands call', use: 'hands call <port-cmd> [args-json]', about: 'one harness-port command, armed for this request only', gui: true },
  { name: 'hands batch', use: 'hands batch <[{"cmd":..,"args":{..}},..]>', about: 'several port commands under one arm, in order', gui: true },
  { name: 'chrome-mode', use: 'chrome-mode <profile> [agent|desktop]', about: 'read or record a browser profile mode' },
  { name: 'jobhunt', use: 'jobhunt <subcommand> [args..]', about: 'bin/jobhunt, subcommands in MACNODE_JOBHUNT_SUBS only' },
  { name: 'hcron', use: 'hcron status | list | pause <id|all> | resume <id|all> | run <id>', about: 'the Mac scheduler' },
  { name: 'gh-code', use: 'gh-code <company> [max-age-min]', about: 'the Greenhouse email code tool (MACNODE_GH_CODE)' },
  { name: 'portal-pass', use: 'portal-pass <portal-id> [--create]', about: 'type a portal password from the Keychain (MACNODE_PORTAL_PASS)', gui: true },
  { name: 'git pull', use: 'git pull <repo>', about: 'fast-forward pull of a repo named in MACNODE_REPOS' },
];
const byName = Object.fromEntries(ACTIONS.map(a => [a.name, a]));

// Which table entry argv starts with (two-word names first), and the args after it.
function lookup(argv) {
  const two = byName[`${argv[0]} ${argv[1]}`];
  if (two) return [two, argv.slice(2)];
  const one = byName[argv[0]];
  return one && !one.name.includes(' ') ? [one, argv.slice(1)] : [null, null];
}

function jsonArg(text, wantArray) {
  if (text.length > MAX_JSON) return [null, `JSON is over ${MAX_JSON} bytes`];
  let v;
  try { v = JSON.parse(text); } catch { return [null, 'not valid JSON']; }
  const okType = wantArray ? Array.isArray(v) : v !== null && typeof v === 'object' && !Array.isArray(v);
  return okType ? [v, null] : [null, wantArray ? 'want a JSON array' : 'want a JSON object'];
}

// A list of name=path pairs, as MACNODE_REPOS holds them.
export function repoMap(text) {
  const out = {};
  for (const pair of String(text || '').split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0 && NAME.test(pair.slice(0, i)) && pair.slice(i + 1).startsWith('/')) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export function parse(argv, cfg = null) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) return refuse('empty or malformed request');
  if (argv.length > MAX_ARGS + 2) return refuse(`too many arguments (max ${MAX_ARGS})`);
  const [act, args] = lookup(argv);
  if (!act) return refuse(`not on the allowlist: ${String(argv[0]).slice(0, 40)}`);
  const ok = run => ({ ok: true, action: act.name, gui: !!act.gui, run });
  const bad = why => refuse(`${act.name}: ${why} (use: ${act.use})`);
  const exec = (file, a, extra = {}) => ({ kind: 'exec', file, args: a, timeoutMs: 2 * MIN, ...extra });
  const node = cfg?.node || process.execPath;

  switch (act.name) {
    case 'ping':
    case 'eyes status':
      if (args.length) return bad('takes no arguments');
      return ok(act.name === 'ping' ? { kind: 'ping' } : exec('hsx', ['status'], { timeoutMs: 15_000 }));

    case 'hands call': {
      if (args.length < 1 || args.length > 2 || !NAME.test(args[0])) return bad('want a port command name');
      let a = {};
      if (args[1] !== undefined) { const [v, err] = jsonArg(args[1], false); if (err) return bad(`args ${err}`); a = v; }
      return ok({ kind: 'hands', calls: [{ cmd: args[0], args: a }], timeoutMs: 5 * MIN });
    }
    case 'hands batch': {
      if (args.length !== 1) return bad('want one JSON array');
      const [list, err] = jsonArg(args[0], true);
      if (err) return bad(err);
      if (!list.length || list.length > 50) return bad('want 1 to 50 calls');
      for (const c of list) {
        if (!c || typeof c !== 'object' || !NAME.test(String(c.cmd)) || Object.keys(c).some(k => k !== 'cmd' && k !== 'args')
          || (c.args !== undefined && (c.args === null || typeof c.args !== 'object' || Array.isArray(c.args))))
          return bad('each call is {"cmd": <name>, "args": {..}}');
      }
      return ok({ kind: 'hands', calls: list.map(c => ({ cmd: c.cmd, args: c.args || {} })), timeoutMs: 10 * MIN });
    }

    case 'chrome-mode': {
      if (args.length < 1 || args.length > 2 || !NAME.test(args[0])) return bad('want a profile id');
      if (args[1] !== undefined && !['agent', 'desktop'].includes(args[1])) return bad('mode is agent or desktop');
      const a = [args[0], ...(args[1] ? [args[1], '--writer', 'mac-node'] : [])];
      return ok(exec('/bin/zsh', cfg ? [`${cfg.HARNESS_DIR}/modules/browser/chrome-mode.sh`, ...a] : a));
    }

    case 'jobhunt': {
      if (!args.length || !NAME.test(args[0])) return bad('want a subcommand');
      if (!words(args.slice(1))) return bad('arguments must be plain words or --flags');
      if (!cfg) return ok(exec('jobhunt', args, { timeoutMs: 10 * MIN }));
      const subs = String(cfg.MACNODE_JOBHUNT_SUBS || '').split(/\s+/).filter(Boolean);
      if (!subs.includes(args[0])) return refuse(`jobhunt ${args[0]}: not enabled on this Mac (MACNODE_JOBHUNT_SUBS: ${subs.join(' ') || 'none'})`);
      return ok(exec(`${cfg.MACNODE_JOBHUNT_DIR}/bin/jobhunt`, args, { cwd: cfg.MACNODE_JOBHUNT_DIR, timeoutMs: 10 * MIN }));
    }

    case 'hcron': {
      const [sub, id, ...rest] = args;
      if (rest.length) return bad('too many arguments');
      if (['status', 'list'].includes(sub) && id === undefined) return ok(exec('hcron', [sub]));
      if (['pause', 'resume'].includes(sub) && id !== undefined && NAME.test(id)) return ok(exec('hcron', [sub, id]));
      if (sub === 'run' && id !== undefined && NAME.test(id) && id !== 'all') return ok(exec('hcron', ['run', id]));
      return bad('unknown subcommand or bad job id');
    }

    case 'gh-code': {
      if (args.length < 1 || args.length > 2 || !COMPANY.test(args[0])) return bad('want a company name');
      if (args[1] !== undefined && !(/^\d{1,4}$/.test(args[1]) && +args[1] >= 1 && +args[1] <= 1440)) return bad('max age is 1 to 1440 minutes');
      if (!cfg) return ok(exec('gh-code', args));
      if (!cfg.MACNODE_GH_CODE) return refuse('gh-code: not enabled on this Mac (set MACNODE_GH_CODE)');
      return ok(exec(node, [cfg.MACNODE_GH_CODE, ...args]));
    }

    case 'portal-pass': {
      if (args.length < 1 || args.length > 2 || !NAME.test(args[0])) return bad('want a portal id');
      if (args[1] !== undefined && args[1] !== '--create') return bad('the only option is --create');
      if (!cfg) return ok(exec('portal-pass', args));
      if (!cfg.MACNODE_PORTAL_PASS) return refuse('portal-pass: not enabled on this Mac (set MACNODE_PORTAL_PASS)');
      return ok(exec(node, [cfg.MACNODE_PORTAL_PASS, ...args]));
    }

    case 'git pull': {
      if (args.length !== 1 || !NAME.test(args[0])) return bad('want one repo name');
      if (!cfg) return ok(exec('git', ['pull', args[0]]));
      const path = repoMap(cfg.MACNODE_REPOS)[args[0]];
      if (!path) return refuse(`git pull ${args[0]}: not a repo named in MACNODE_REPOS on this Mac`);
      return ok(exec('git', ['-C', path, 'pull', '--ff-only', '-q'], { timeoutMs: 5 * MIN }));
    }
  }
  return refuse('not on the allowlist');
}

// summary(argv): what the logs record. hands calls keep only the command names (args can hold typed
// text); everything else is checked words already. Refused requests get their first word, cut short.
export function summary(argv) {
  const p = parse(argv);
  if (!p.ok) return `${String(Array.isArray(argv) ? argv[0] : '').replace(/[^\w.:/-]/g, '?').slice(0, 40)} (refused)`;
  if (p.run.kind === 'hands') return `${p.action} ${p.run.calls.map(c => c.cmd).join(',')}`;
  return argv.join(' ').slice(0, 200);
}
