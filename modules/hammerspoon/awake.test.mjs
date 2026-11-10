// node --test modules/hammerspoon/awake.test.mjs   (uses a fake `hs`; never touches the real screen)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AWAKE = fileURLToPath(new URL('./awake.sh', import.meta.url));
function sandbox(answer = '{"on":true}') {
  const d = mkdtempSync(join(tmpdir(), 'awake-test-'));
  const calls = join(d, 'calls.txt');
  writeFileSync(join(d, 'hs'), `#!/bin/sh\nprintf '%s\\n' "$4" >> ${calls}\n${answer ? `echo '${answer}'` : 'exit 1'}\n`, { mode: 0o755 });
  const run = (...a) => spawnSync('/bin/zsh', [AWAKE, ...a], { env: { ...process.env, PATH: `${d}:/usr/bin:/bin` }, encoding: 'utf8' });
  const lines = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { d, run, lines };
}

test('run holds awake mode around the command, passes its exit code, then releases with a lock', () => {
  const s = sandbox();
  const r = s.run('run', 'apply', '--minutes', '30', '--', 'sh', '-c', 'exit 7');
  assert.equal(r.status, 7);
  const [on, off] = s.lines();
  assert.match(on, /harness\.awake\(true, \{owner='apply', minutes=30, pid=\d+\}\)/);
  assert.match(off, /harness\.awake\(false, \{owner='apply', lock=true/);
});

test('the command still runs when Hammerspoon does not answer', () => {
  const s = sandbox(null);
  const r = s.run('run', 'x', '--', 'sh', '-c', 'echo ran');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran');
  assert.match(r.stderr, /running without awake mode/);
});

test('names that could inject Lua are refused', () => {
  const s = sandbox();
  assert.equal(s.run('on', "x'}) os.execute('id") .status, 2);
  assert.equal(s.lines().length, 0);
});

test('on, off and status call Hammerspoon and print its answer', () => {
  const s = sandbox();
  assert.match(s.run('on', 'job', '--pid', '42').stdout, /"on":true/);
  assert.match(s.lines()[0], /pid=42/);
  assert.equal(s.run('off', 'job').status, 0);
  assert.equal(s.run('status').status, 0);
  assert.equal(s.run('bogus').status, 2);
});

test('on without --pid ties the hold to the caller, not to the short-lived awake process', () => {
  const s = sandbox();
  const r = spawnSync('/bin/zsh', ['-c', `${AWAKE} on job; print -r -- $$`], { env: { ...process.env, PATH: `${s.d}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const callerPid = r.stdout.trim().split('\n').pop();
  assert.match(s.lines()[0], new RegExp(`pid=${callerPid}\\}`));
});

test('run warns when Hammerspoon refuses awake mode, and still runs the command', () => {
  const s = sandbox('{"on":false,"reason":"screen already locked"}');
  const r = s.run('run', 'x', '--', 'sh', '-c', 'echo ran');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'ran');
  assert.match(r.stderr, /refused \(screen already locked\)/);
});

test('run stays quiet when awake mode is granted', () => {
  const s = sandbox();
  assert.equal(s.run('run', 'x', '--', 'true').stderr, '');
});

test('with the generic hs port closed, awake talks to the harness port through hsx', () => {
  const s = sandbox(null);   // `hs` fails, as it does with HS_IPC_GENERIC=0
  const calls = join(s.d, 'hsx-calls.txt');
  writeFileSync(join(s.d, 'hsx'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${calls}\necho '{"on":true,"owners":["x"]}'\n`, { mode: 0o755 });
  const r = s.run('run', 'x', '--minutes', '9', '--', 'true');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const [on, off] = readFileSync(calls, 'utf8').trim().split('\n');
  assert.match(on, /^--timeout 5 call awake\.on \{"owner":"x","minutes":9,"pid":\d+\}$/);
  assert.match(off, /^--timeout 5 call awake\.off \{"owner":"x","lock":true,"reason":"x finished"\}$/);
  assert.equal(s.run('status').status, 0);
  assert.match(readFileSync(calls, 'utf8'), /call awake\.status\n$/);
});
