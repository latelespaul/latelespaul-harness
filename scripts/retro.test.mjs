// node --test scripts/retro.test.mjs
// Runs retro.sh against a throwaway HOME and profile, with a fake `claude` on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RETRO = fileURLToPath(new URL('./retro.sh', import.meta.url));
const HARNESS = fileURLToPath(new URL('..', import.meta.url));

function setup({ claudeExit = 0, extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retro-'));
  const home = join(root, 'home'), profile = join(root, 'profile'), bin = join(root, 'bin');
  for (const d of [home, bin, join(profile, 'knowledge/sessions'), join(profile, 'memory')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(profile, 'knowledge/sessions/2026-01.md'), '# Sessions 2026-01\n\n' +
    '## 2026-01-02 10:00 · ~ · Old work\n- old finding\n\n## 2026-01-09 10:00 · ~ · New work\n- new finding\n');
  writeFileSync(join(profile, 'knowledge/learnings.md'), '# Learnings\n\n- old tip _(2026-01-01)_\n- new tip _(2026-01-08)_\n' +
    '## Old topic (2026-01-01)\n- old detail\n## New topic (2026-01-08)\n- new detail\n');
  const oldMem = join(profile, 'memory/old.md'), newMem = join(profile, 'memory/new.md');
  writeFileSync(oldMem, 'old memory\n'); writeFileSync(newMem, 'new memory\n');
  writeFileSync(join(profile, 'memory/MEMORY.md'), '- index\n');
  utimesSync(oldMem, new Date('2026-01-01T00:00:00'), new Date('2026-01-01T00:00:00'));
  utimesSync(newMem, new Date('2026-01-08T00:00:00'), new Date('2026-01-08T00:00:00'));
  // The fake claude keeps its prompt and writes the summary file the prompt names.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > "${root}/prompt.txt"\nprintf '%s\\n' "$@" > "${root}/args.txt"\n` +
    `f=$(sed -n 's/^Write the summary (at most 3 lines) to \\(.*\\) as your last step\\.$/\\1/p' "${root}/prompt.txt")\n` +
    `[ ${claudeExit} = 0 ] && printf 'Retro: 2 PRs, 3 pruned\\n' > "$f"\nexit ${claudeExit}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const envFile = join(root, 'harness.env');
  writeFileSync(envFile, `PROFILE_DIR="${profile}"\n`);
  const run = (...args) => spawnSync('/bin/zsh', [RETRO, ...args], { encoding: 'utf8', env: {
    PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`, HOME: home, HARNESS_ENV: envFile, RETRO_WORK: join(root, "work"),
    RETRO_WT_ROOT: join(root, "wt"), ...extraEnv } });
  return { root, profile, run };
}

test('--collect takes only items since the given time', () => {
  const { run } = setup();
  const r = run('--collect', '--since', '2026-01-05 00:00');
  assert.equal(r.status, 0, r.stderr);
  const input = readFileSync(r.stdout.trim(), 'utf8');
  for (const s of ['new finding', 'new tip', 'new detail', '### new.md', '## Rule lint']) assert.match(input, new RegExp(s));
  for (const s of ['old finding', 'old tip', 'old detail', '### old.md', 'MEMORY.md']) assert.doesNotMatch(input, new RegExp(s));
});

test('a good run passes the command to claude, keeps the summary and moves the marker', () => {
  const { root, profile, run } = setup();
  const r = run('--since', '2026-01-05 00:00');
  assert.equal(r.status, 0, r.stderr);
  const prompt = readFileSync(join(root, 'prompt.txt'), 'utf8');
  assert.match(prompt, /PERSONAL/);
  assert.match(prompt, /Merging is not allowed/);
  assert.ok(prompt.includes(r.stdout.trim()), 'the prompt names the input file');
  assert.equal(readFileSync(join(profile, 'logs/retro-summary.txt'), 'utf8'), 'Retro: 2 PRs, 3 pruned\n');
  assert.match(readFileSync(join(profile, 'knowledge/retro/last-run'), 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d\n$/);
});

test('a failed run keeps the old marker', () => {
  const { profile, run } = setup({ claudeExit: 1 });
  mkdirSync(join(profile, 'knowledge/retro'), { recursive: true });
  writeFileSync(join(profile, 'knowledge/retro/last-run'), '2026-01-05 00:00\n');
  const r = run();
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(profile, 'knowledge/retro/last-run'), 'utf8'), '2026-01-05 00:00\n');
  assert.equal(existsSync(join(profile, 'logs/retro-summary.txt')), false);
});

// Claude Code permission rules: "Bash(prefix:*)" allows a command that starts with prefix.
function allows(argsFile, cmd) {
  const lines = readFileSync(argsFile, 'utf8').split('\n');
  const rules = lines.slice(lines.indexOf('--allowedTools') + 1, lines.indexOf('--add-dir'));
  return rules.some(r => { const m = /^Bash\((.*):\*\)$/.exec(r); return m && (cmd === m[1] || cmd.startsWith(m[1] + ' ')); });
}

test('without RETRO_MERGE the session cannot merge or push to main; with it, pr-merge.sh is allowed', () => {
  const merge = `${HARNESS.replace(/\/$/, '')}/scripts/pr-merge.sh harness 1`;
  const { root, run } = setup();
  assert.equal(run('--since', '2026-01-05 00:00').status, 0);
  const args = join(root, 'args.txt');
  for (const c of ['gh pr merge 1', 'gh-axi pr merge 1', 'git push origin HEAD:main', 'node -e 1', 'cp a b', merge]) assert.equal(allows(args, c), false, c);
  for (const c of ['git commit -m x', 'gh pr list', 'scripts/upstream.sh pr']) assert.equal(allows(args, c), true, c);
  const m = setup({ extraEnv: { RETRO_MERGE: '1' } });
  assert.equal(m.run('--since', '2026-01-05 00:00').status, 0);
  assert.equal(allows(join(m.root, 'args.txt'), merge), true);
});

test('a lock left by a dead run is taken over; a live one stops the run', () => {
  const { root, run } = setup();
  mkdirSync(join(root, 'work/lock'), { recursive: true });
  writeFileSync(join(root, 'work/lock/pid'), '999999\n');
  assert.equal(run('--since', '2026-01-05 00:00').status, 0);
  assert.equal(existsSync(join(root, 'work/lock')), false);
  mkdirSync(join(root, 'work/lock')); writeFileSync(join(root, 'work/lock/pid'), `${process.pid}\n`);
  const r = run('--since', '2026-01-05 00:00');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another retro is running/);
});
