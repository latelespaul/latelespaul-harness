// node --test scripts/rule-lint.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINT = fileURLToPath(new URL('./rule-lint.mjs', import.meta.url));
const tree = files => {
  const root = mkdtempSync(join(tmpdir(), 'rule-lint-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const lint = (...args) => {
  const r = spawnSync(process.execPath, [LINT, '--json', ...args], { encoding: 'utf8' });
  return { status: r.status, ...JSON.parse(r.stdout) };
};
const RULE = 'Send long multi-step work to a background worker so the master session stays free for the user.';

test('finds the same rule in two harness files', () => {
  const h = tree({ 'AGENTS.md': `# Rules\n- ${RULE}\n`, 'docs/ops.md': `Always: ${RULE}\n` });
  const { findings } = lint('--harness', h);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'duplicate');
  assert.deepEqual([findings[0].a.file, findings[0].b.file].sort(), ['AGENTS.md', 'docs/ops.md']);
});

test('flags a rule and its negation as a possible conflict', () => {
  const h = tree({
    'AGENTS.md': 'Merge a pull request yourself once the review gate passes on its head commit.\n',
    'docs/ops.md': 'Never merge a pull request yourself once the review gate passes on its head commit.\n',
  });
  assert.deepEqual(lint('--harness', h).findings.map(f => f.kind), ['conflict']);
});

test('ignores code blocks, front matter, unrelated text and copied skills', () => {
  const h = tree({
    'AGENTS.md': `---\ndescription: ${RULE}\n---\nThe scheduler starts each job at its own time every minute of the day.\n`,
    'docs/a.md': '```\n' + RULE + '\n```\n',
    'skills/vendored/SKILL.md': `---\nname: vendored\n---\n${RULE}\n`,
    'skills/vendored/UPSTREAM.md': 'copied\n',
    'docs/b.md': `${RULE}\n`,
  });
  assert.deepEqual(lint('--harness', h).findings, []);
});

test('with --profile: memory duplicates and skill name clashes', () => {
  const h = tree({ 'AGENTS.md': `${RULE}\n`, 'skills/explain/SKILL.md': '---\nname: explain\ndescription: Explain things.\n---\nBody text.\n' });
  const p = tree({
    'memory/stay-free.md': `---\nname: stay-free\n---\n${RULE}\n**Why:** ${RULE}\n`,
    'memory/MEMORY.md': `- ${RULE}\n`,
    'skills/explain/SKILL.md': '---\nname: explain\ndescription: My own explain.\n---\nOther body.\n',
  });
  const kinds = lint('--harness', h, '--profile', p).findings.map(f => `${f.kind} ${f.b.file}`).sort();
  assert.deepEqual(kinds, ['duplicate profile/memory/stay-free.md', 'skill-name profile/skills/explain/SKILL.md']);
});

test('--strict exits 1 only when there are findings', () => {
  const dup = tree({ 'AGENTS.md': `${RULE}\n`, 'docs/a.md': `${RULE}\n` });
  const clean = tree({ 'AGENTS.md': `${RULE}\n` });
  assert.equal(lint('--harness', dup, '--strict').status, 1);
  assert.equal(lint('--harness', clean, '--strict').status, 0);
  assert.equal(lint('--harness', dup).status, 0);
});
