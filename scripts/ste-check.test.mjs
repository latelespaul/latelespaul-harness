// node --test scripts/ste-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK = fileURLToPath(new URL('./ste-check.mjs', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [CHECK, ...args], { input, encoding: 'utf8' });
const json = (text, ...args) => { const r = run(['--json', ...args, '-'], text); return { ...r, out: JSON.parse(r.stdout) }; };
const rules = (text, ...args) => json(text, ...args).out.findings.map(f => f.rule);
const words = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

// A long concept answer with all eight parts, written to the standard.
const GOOD = `**Short answer.** The scheduler starts each job at its time. One background agent runs the scheduler every minute.

**Where it fits.** The scheduler replaces one launch agent per job. Every project adds its jobs to one jobs file.

**The whole flow**
\`\`\`
tick -> due? -> window? -> start -> log
\`\`\`

**Step by step**
1. The agent runs the tick command every minute.
2. The tick reads the jobs file and finds the due jobs.
3. The tick starts each due job in its own folder.
4. The job writes its output to its log file.

**Terms**
- **PID**: process identifier, the number the system gives a running program.
- Tick: one pass of the scheduler over all jobs.

**Example.** A backup job has the time 02:30. At 02:30 the tick starts the backup job. The job writes the line "exit 0" to its log.

**Edge cases and warnings.** A job never runs twice at the same time. The tick skips a job when its PID is still alive. A missed slot runs once after sleep only with the catch-up option.

**Next.** Run the status command to see each job and its next time.
`;

test('a long answer with every part and short active sentences passes with exit 0', () => {
  const r = json(GOOD);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.out.findings, []);
  assert.equal(r.out.long, true);
  assert.deepEqual(r.out.sections.sort(), ['edges', 'example', 'fits', 'flow', 'next', 'short', 'steps', 'terms']);
});

test('reads a file path as well as stdin, and prints file:line findings', () => {
  const d = mkdtempSync(join(tmpdir(), 'ste-check-'));
  const f = join(d, 'answer.md');
  writeFileSync(f, `Intro line.\n\nThe file was deleted by the cleanup job.\n`);
  const r = run([f]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3: passive-voice: .*was deleted`));
  assert.match(r.stdout, /1 finding\(s\)\./);
  assert.match(run([], undefined).stderr, /usage/);
});

test('descriptive sentences may have 25 words; numbered steps only 20', () => {
  assert.deepEqual(rules(`${words(25)}.`), []);
  assert.deepEqual(rules(`${words(26)}.`), ['sentence-length']);
  assert.deepEqual(rules(`1. ${words(20)}.`), []);
  const r = json(`1. ${words(21)}.`);
  assert.equal(r.out.findings[0].rule, 'sentence-length');
  assert.equal(r.out.findings[0].max, 20);
  assert.equal(r.out.findings[0].words, 21);
  assert.deepEqual(rules(`1. ${words(21)}.`, '--max-procedural', '25'), []);
});

test('word count follows STE: hyphenated words, code and parenthesized text count as one word', () => {
  const hyphens = Array.from({ length: 25 }, (_, i) => `a-b-c${i}`).join(' ');
  assert.deepEqual(rules(`${hyphens}.`), []);
  assert.deepEqual(rules(`${words(24)} \`one two three four\`.`), []);
  assert.deepEqual(rules(`${words(24)} (one two three four five).`), []);
});

test('abbreviations such as e.g. do not end a sentence; code blocks are not prose', () => {
  assert.deepEqual(rules(`${words(12)} e.g. ${words(12)}.`), []);
  assert.deepEqual(rules(`${words(13)} e.g. ${words(13)}.`), ['sentence-length']);
  assert.deepEqual(rules('```\n' + `${words(40)} was deleted by NASA.\n` + '```\n'), []);
});

test('flags likely passive voice, but not state adjectives such as "is locked"', () => {
  assert.deepEqual(rules('The job is started at login.'), ['passive-voice']);
  assert.deepEqual(rules('The message was sent.'), ['passive-voice']);
  assert.deepEqual(rules('The job is being restarted.'), ['passive-voice']);
  assert.deepEqual(rules('The job is not always started.'), ['passive-voice']);
  assert.deepEqual(rules('The scheduler starts the job.'), []);
  assert.deepEqual(rules('The tick skips the job while the screen is locked.'), []);
  assert.deepEqual(rules('The screen is locked by the screen saver.'), ['passive-voice']);
  assert.deepEqual(rules('You need more speed.'), []);
});

test('paragraphs may have 6 sentences; list items are not paragraphs', () => {
  assert.deepEqual(rules('One. Two. Three. Four. Five. Six.'), []);
  assert.deepEqual(rules('One. Two. Three.\nFour. Five. Six. Seven.'), ['paragraph-length']);
  assert.deepEqual(rules('One. Two. Three. Four.\n\nFive. Six. Seven.'), []);
  assert.deepEqual(rules('- One. Two. Three. Four. Five. Six. Seven.'), []);
});

test('acronyms need a definition once; every way of defining one counts', () => {
  const r = json('The TCC check runs. The TCC check runs again.');
  assert.deepEqual(r.out.findings.map(f => [f.rule, f.acronym]), [['undefined-acronym', 'TCC']]);
  assert.deepEqual(rules('Transparency, Consent, and Control (TCC) holds grants. TCC runs.'), []);
  assert.deepEqual(rules('TCC (Transparency, Consent, and Control) holds grants.'), []);
  assert.deepEqual(rules('The privacy system (Transparency, Consent, and Control, TCC) holds grants. TCC runs.'), []);
  assert.deepEqual(rules('Formats such as JSON, YAML, TOML need parsers.').length, 3);
  assert.deepEqual(rules('**TCC** (Transparency, Consent, and Control) holds grants.'), []);
  assert.deepEqual(rules('TCC holds grants.\n\n**Terms**\n- **TCC**: Transparency, Consent, and Control.'), []);
  assert.deepEqual(rules('TCC holds grants.\n\n| Term | Meaning |\n|---|---|\n| TCC | Transparency, Consent, and Control |'), []);
  assert.deepEqual(rules('The PIDs are numbers.\n\n- PID = process identifier.'), []);
  assert.deepEqual(rules('TCC holds grants.', '--allow', 'TCC,GUI'), []);
  assert.deepEqual(rules('Run `JSON.parse` on the API_KEY-free text. WARNING: it is NOT safe.'), []);
  assert.deepEqual(rules('See https://example.com/ABC/DEF for more.'), []);
});

test('a long answer must show all eight parts; a short one needs none', () => {
  const long = `${words(20)}.\n\n`.repeat(9);
  const r = json(long);
  assert.equal(r.status, 1);
  assert.equal(r.out.long, true);
  assert.deepEqual(r.out.findings.map(f => f.section), ['next', 'short', 'fits', 'flow', 'terms', 'example', 'edges', 'steps']);
  assert.deepEqual(rules(`${words(20)}.`), []);
  assert.deepEqual(rules(`${words(20)}.`, '--structure').filter(x => x === 'missing-section').length, 8);
  assert.deepEqual(rules(long, '--no-structure'), []);
  assert.deepEqual(rules(long, '--long-words', '1000'), []);
});

test('"Next steps" counts as the last part, not as the step-by-step part', () => {
  const r = json(GOOD.replace('**Step by step**', '**Details**').replace('**Next.**', '**Next steps.**'));
  assert.deepEqual(r.out.findings.map(f => f.section), ['steps']);
});

test('procedure and decision answers may leave out the diagram', () => {
  const noDiagram = GOOD.replace(/\*\*The whole flow\*\*\n```\n.*\n```\n/, '');
  assert.deepEqual(json(noDiagram).out.findings.map(f => f.section), ['flow']);
  assert.deepEqual(json(noDiagram, '--type', 'procedure').out.findings, []);
  assert.deepEqual(json(noDiagram, '--type', 'decision').out.findings, []);
  assert.deepEqual(json(noDiagram, '--type', 'troubleshooting').out.findings.map(f => f.section), ['flow']);
});

test('a fenced diagram counts as the diagram part even without a heading', () => {
  const r = json(GOOD.replace('**The whole flow**\n', ''));
  assert.deepEqual(r.out.findings, []);
});

test('markdown headings work like bold labels', () => {
  const md = GOOD.replace(/^\*\*(.+?)\.?\*\*\.? ?/gm, '## $1\n\n');
  assert.deepEqual(json(md).out.findings, []);
});

test('bold text inside list items does not count as a part', () => {
  const r = json(GOOD
    .replace('**Where it fits.** The scheduler', 'The scheduler')
    .replace('**Next.** Run', '1. **Verify** the backup. Run')
    .replace('- Tick:', '- **Context**: the folder of a job.\n- Tick:'));
  assert.equal(r.status, 1);
  assert.deepEqual(r.out.findings.map(f => f.section), ['next', 'fits']);
});

test('the CLI runs from a path with a space and through a symlink with another name', () => {
  const d = join(mkdtempSync(join(tmpdir(), 'ste-check-')), 'a b');
  mkdirSync(d);
  const copy = join(d, 'ste-check.mjs');
  copyFileSync(CHECK, copy);
  const link = join(d, 'stc.mjs');
  symlinkSync(CHECK, link);
  for (const script of [copy, link]) {
    const r = spawnSync(process.execPath, [script, '-'], { input: 'The file was deleted.\n', encoding: 'utf8' });
    assert.equal(r.status, 1, script);
    assert.match(r.stdout, /passive-voice/);
  }
});

test('bad usage exits 2 with a message', () => {
  for (const args of [['--type', 'poem', '-'], ['--long-words', 'many', '-'], ['--bogus', '-'], ['a', 'b'], ['/no/such/file.md']]) {
    const r = run(args, '');
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /ste-check:/);
  }
  assert.equal(run(['--help']).status, 0);
});
