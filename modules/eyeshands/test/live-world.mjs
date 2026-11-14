// The live fixture test's real world (design part 18): `hs -c`, the throwaway Chrome, the
// `eyeshands session` that arms the test owner, and the files of one run. live-lib.mjs holds the
// logic and calls only what this object offers; live.test.mjs imports this file only after the gate
// passed (EYESHANDS_LIVE=1, no CI), so a default run starts no process at all.
//
// What it touches, and nothing else: Hammerspoon through `hs -c` (the read-only probe, the test
// Spoon under the global __eyeshands_test on its own port eyeshands-test-<random>, the fake
// detector __eyeshands_test_detector, one untagged 1-point mouse nudge), a Chrome started with a
// temporary --user-data-dir, and a temporary folder. It never calls hs.loadSpoon or hs.reload(),
// never writes in ~/.hammerspoon, and never touches job-hunt, its lock or the real ports.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture-server.mjs';
import { DETECTOR, EVENT_TAG, GLOBAL, OWNER, WHO } from './live-lib.mjs';

const here = p => fileURLToPath(new URL(p, import.meta.url));
const SPOON = here('../EyesHands.spoon');
const PROBE = here('./live-probe.lua');
const EYESHANDS = here('../bin/eyeshands');
const TMP_PREFIX = 'eh-live-';

// A Lua string literal (no control characters are allowed in the paths this file passes).
export function lua(s) {
  s = String(s);
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('a control character in a Lua string');
  return '"' + s.replace(/[\\"]/g, c => '\\' + c) + '"';
}

function run(file, args, { timeout = 15000, input } = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: err?.code === 'ENOENT', stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const firstFile = list => list.find(p => p && existsSync(p));

// The token --user-data-dir=<profile> on a command line, as one whole argument.
const hasProfile = (command, profile) => String(command).split(/\s+/).includes(`--user-data-dir=${profile}`);

export function realWorld(env = process.env) {
  const HS = firstFile(['/opt/homebrew/bin/hs', '/usr/local/bin/hs']) || 'hs';
  const HCRON = firstFile([join(homedir(), '.local/bin/hcron')]) || 'hcron';
  const hs = async (code, timeout = 10000) => {
    const r = await run(HS, ['-c', code], { timeout });
    if (r.code !== 0) throw new Error(`hs -c failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.stdout.trim();
  };
  const hsJson = async (code, timeout) => {
    const out = await hs(code, timeout);
    try { return JSON.parse(out); } catch { throw new Error(`hs -c gave no JSON: ${out.slice(0, 300)}`); }
  };
  const ps = async args => (await run('/bin/ps', args)).stdout;

  return {
    env,
    log: msg => console.log(`eh-live: ${msg}`),
    now: () => Date.now(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),

    probe: holdFile => hsJson(`return hs.json.encode(dofile(${lua(PROBE)})({ spoon = ${lua(SPOON)}, ` +
      `hold_file = ${holdFile ? lua(holdFile) : 'nil'}, test = ${lua(GLOBAL)} }))`),
    // `hcron status` text, or null when hcron is not installed (then no hcron job can run).
    hcronStatus: async () => {
      const r = await run(HCRON, ['status']);
      if (r.missing) return null;
      if (r.code !== 0) throw new Error(`hcron status failed: ${r.stderr.trim().slice(0, 200)}`);
      return r.stdout;
    },

    mkTemp: async () => realpathSync(mkdtempSync(join(tmpdir(), TMP_PREFIX))),
    mkdir: async p => { mkdirSync(p, { recursive: true, mode: 0o700 }); },
    writeFile: async (p, text) => { writeFileSync(p, text, { mode: 0o600 }); },
    readFile: async p => { try { return readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    unlink: async p => { unlinkSync(p); },
    // Removes only a folder this world made: under the temp folder, with the run's prefix.
    rmTemp: async dir => {
      if (dirname(dir) !== realpathSync(tmpdir()) || !basename(dir).startsWith(TMP_PREFIX)) throw new Error(`not a run folder: ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    },

    startFixture: () => startFixture(),
    portName: () => `eyeshands-test-${randomBytes(4).toString('hex')}`,

    // Run step 4: dofile the Spoon (never hs.loadSpoon or hs.reload) as the test global, with its
    // own port, the run's files, the driver lock as hold_file, no hotkey and no menu bar item.
    loadSpoon: async ({ port, dir, holdFile, buffer }) => {
      const r = await hsJson(`local eh = dofile(${lua(SPOON + '/init.lua')}); ${GLOBAL} = eh
        eh:start({ port = ${lua(port)}, access_file = ${lua(dir + '/access.json')}, targets_file = ${lua(dir + '/targets.json')},
          log_file = ${lua(dir + '/eyeshands.log')}, shot_dir = ${lua(dir + '/shots')}, hold_file = ${lua(holdFile)},
          idle_buffer_s = ${Math.floor(buffer)}, stop_hotkey = false, menubar = false, detectors = { ${lua(DETECTOR)} },
          alert = function(t) print("eh-live-test alert: " .. tostring(t)) end })
        return hs.json.encode({ port_open = eh._s ~= nil and eh._s.port ~= nil })`, 20000);
      if (r.port_open !== true) throw new Error(`the test Spoon did not open its port ${port}`);
    },
    // Unloads the test Spoon. Its stop() removes the Eyes & Hands event tag from the harness; when
    // the running Spoon had it registered, it goes back in the same call, so that Spoon's input
    // stays machine input for the awake watcher.
    unloadSpoon: ({ restoreTag }) => hsJson(`local t = rawget(_G, ${lua(GLOBAL)})
      if t then pcall(function() t:stop() end) end
      ${GLOBAL} = nil; ${DETECTOR} = nil
      local h = rawget(_G, "harness")
      if ${restoreTag ? 'true' : 'false'} and type(h) == "table" and type(rawget(h, "addEventTag")) == "function" then h.addEventTag(${EVENT_TAG}) end
      return hs.json.encode({ gone = rawget(_G, ${lua(GLOBAL)}) == nil })`),
    // Exit 3 means Hammerspoon has no such port.
    portOpen: async port => (await run(EYESHANDS, ['--port', port, '--timeout', '3', 'status'])).code !== 3,
    testStatus: () => hsJson(`local t = rawget(_G, ${lua(GLOBAL)}); return hs.json.encode(t and t:status() or { running = false })`),
    setDetector: on => hs(`${DETECTOR} = ${on ? '{ hands = { status = function() return { armed = true } end } }' : 'nil'}; return "ok"`),
    // One untagged mouse move of 1 point: a stand-in for a person touching the mouse.
    nudge: () => hs(`local p = hs.mouse.absolutePosition()
      hs.eventtap.event.newMouseEvent(hs.eventtap.event.types.mouseMoved, { x = p.x + 1, y = p.y }):post(); return "ok"`),
    releaseAwake: who => hs(`local h = rawget(_G, "harness")
      if type(h) == "table" and type(rawget(h, "awake")) == "function" then h.awake(false, { owner = ${lua(who)} }) end; return "ok"`),

    // Run step 2: a throwaway Chrome with no debugging port, found later by its profile path.
    startChrome: async (profile, url) => {
      const r = await run('/usr/bin/open', ['-na', 'Google Chrome', '--args', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', url]);
      if (r.code !== 0) throw new Error(`open Chrome failed: ${r.stderr.trim()}`);
    },
    // The Chrome main processes (no --type=) started with exactly this profile.
    chromePids: async profile => (await ps(['-axww', '-o', 'pid=,command='])).split('\n')
      .map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
      .filter(([, , cmd]) => hasProfile(cmd, profile) && !/(^|\s)--type=/.test(cmd) && /Google Chrome/.test(cmd))
      .map(([, pid]) => Number(pid)),
    // Whether pid still runs with this profile on its command line (so a reused pid is never killed).
    ownsProfile: async (pid, profile) => hasProfile(await ps(['-p', String(pid), '-o', 'command=']), profile),
    kill: async (pid, sig) => { try { process.kill(pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } },

    // The test owner's session: one signer for the run. Its pid is the armed pid, so the driver
    // lock entry names it, and a crash leaves a dead pid that the next taker treats as stale.
    openSession: async port => {
      const child = spawn(EYESHANDS, ['--port', port, 'session', '--owner', OWNER, '--max-wait', '60'],
        { stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = createInterface({ input: child.stdout });
      const waiting = [];
      let exited = false;
      lines.on('line', l => { const w = waiting.shift(); if (w) w.resolve(l); });
      child.on('exit', () => { exited = true; for (const w of waiting.splice(0)) w.reject(new Error('the session ended')); });
      child.stdin.on('error', () => {});
      let chain = Promise.resolve();
      const call = (cmd, args) => {
        const p = chain.then(() => new Promise((resolve, reject) => {
          if (exited) return reject(new Error('the session ended'));
          const timer = setTimeout(() => reject(new Error(`${cmd}: no reply in 30 s`)), 30000);
          waiting.push({ resolve: l => { clearTimeout(timer); try { resolve(JSON.parse(l)); } catch { reject(new Error(`${cmd}: not JSON`)); } },
            reject: e => { clearTimeout(timer); reject(e); } });
          child.stdin.write(JSON.stringify({ cmd, args }) + '\n');
        }));
        chain = p.catch(() => {});
        return p;
      };
      const close = () => new Promise(resolve => {
        if (exited) return resolve();
        const timer = setTimeout(() => { child.kill('SIGTERM'); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
      // The first call proves the arm: a failed arm prints its refusal and exits.
      const first = await call('eh.hands.status', null).catch(e => ({ ok: false, error: e.message }));
      if (first.ok !== true) { await close(); throw new Error(`the session did not arm ${OWNER}: ${JSON.stringify(first)}`); }
      return { pid: child.pid, call, close, who: WHO };
    },
    // The stop command (no secret): stops every job and disarms every owner of the test port.
    stopCommand: async port => {
      const r = await run(EYESHANDS, ['--port', port, 'stop']);
      try { return JSON.parse(r.stdout); } catch { return { error: r.stdout || r.stderr }; }
    },
  };
}
