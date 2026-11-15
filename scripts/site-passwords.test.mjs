// node --test scripts/site-passwords.test.mjs
// Runs the password generator from docs/site-passwords.md under a parent that ignores SIGPIPE.
// zsh resets SIGPIPE to default inside `$( … | … )`, so each random-read pipe also runs under sh,
// which keeps the ignore. The 3 s timeout fails the test if a pipe does not end by itself there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../docs/site-passwords.md', import.meta.url));
const hasZsh = !spawnSync('zsh', ['-fc', 'true']).error;

// Each run gets its own process group. On timeout the whole group is killed, so a runaway `tr`
// is not left behind (`ulimit -t` does not stop it on macOS: its time is mostly system calls).
function run(shell, args, timeout = 3_000) {
  return new Promise((resolve) => {
    const child = spawn(shell, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGKILL'); }, timeout);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, timedOut }); });
  });
}

test('the generator makes 20 allowed characters and ends promptly with SIGPIPE ignored', { skip: !hasZsh && 'zsh not installed' }, async () => {
  const block = readFileSync(DOC, 'utf8').match(/# make-password: start\n([\s\S]*?)\n\s*# make-password: end/);
  assert.ok(block, 'make-password markers missing');
  const script = `${block[1]}\nprint -rn -- "$pw"`;
  // `trap '' PIPE` makes every child inherit an ignored SIGPIPE, as under Node or some agent shells.
  const pipes = [...block[1].matchAll(/\$\((.+)\)\s*$/gm)].map((m) => m[1]);
  assert.ok(pipes.length > 0, 'no random-read pipe in the make-password block');
  for (const pipe of pipes) {
    const r = await run('sh', ['-c', `trap '' PIPE; ${pipe}`]);
    assert.equal(r.timedOut, false, `pipe did not finish with SIGPIPE ignored: ${pipe}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^[A-Za-z0-9._%+=!?*@-]+$/);
  }
  for (let i = 0; i < 5; i++) {
    const r = await run('zsh', ['-fc', `trap '' PIPE; ${script}`]);
    assert.equal(r.timedOut, false, 'generator did not finish');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^[A-Za-z0-9._%+=!?*@-]{20}$/);
  }
});
