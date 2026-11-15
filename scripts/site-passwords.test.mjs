// node --test scripts/site-passwords.test.mjs
// Runs the password generator from docs/site-passwords.md under a parent that ignores SIGPIPE.
// The 3 s timeout fails the test if the generator does not end by itself there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../docs/site-passwords.md', import.meta.url));
const hasZsh = !spawnSync('zsh', ['-fc', 'true']).error;

test('the generator makes 20 allowed characters and ends promptly with SIGPIPE ignored', { skip: !hasZsh && 'zsh not installed' }, () => {
  const block = readFileSync(DOC, 'utf8').match(/# make-password: start\n([\s\S]*?)\n\s*# make-password: end/);
  assert.ok(block, 'make-password markers missing');
  const script = `${block[1]}\nprint -rn -- "$pw"`;
  // `trap '' PIPE` makes every child inherit an ignored SIGPIPE, as under Node or some agent shells.
  // `ulimit -t 5` caps CPU time, so a runaway `tr` left by the timeout dies instead of lingering.
  for (let i = 0; i < 5; i++) {
    const r = spawnSync('zsh', ['-fc', `ulimit -t 5; trap '' PIPE; ${script}`], { encoding: 'utf8', timeout: 3_000 });
    assert.equal(r.error, undefined, `generator did not finish: ${r.error}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^[A-Za-z0-9._%+=!?*@-]{20}$/);
  }
});
