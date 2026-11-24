#!/usr/bin/env node
// Finds rules that say the same thing twice, or may say opposite things, across the harness's rule
// files (AGENTS.md, CONTRIBUTING.md, docs/, commands/, skills/) and, with --profile, the profile's
// ABOUT.md, memory/ and skills/. It also flags skills with the same name or a near-identical
// description. The weekly retro (scripts/retro.sh) reads its output; it is safe to run anytime.
//
//   rule-lint.mjs [--harness DIR] [--profile DIR] [--json] [--strict] [--min N]
//
// --strict exits 1 when there are findings (default: always 0). --min sets the duplicate threshold
// (0-1, default 0.6). Skills copied from elsewhere (a folder with UPSTREAM.md) are left out: their
// text is not ours to change.
// Each finding: { kind: duplicate|conflict|skill-name|skill-desc, a: {file,line,text}, b: {...}, score }.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const harness = opt('--harness') ?? dirname(dirname(fileURLToPath(import.meta.url)));
const profile = opt('--profile');
const minDup = Number(opt('--min') ?? 0.6);
const minConflict = Math.max(0.4, minDup - 0.15);

const STOP = new Set(('a an and are as at be been but by can do does for from has have how i if in into is it its ' +
  'me my of on once one or our so than that the their them then there these they this to up us was we what ' +
  'when where which while who will with you your yours via per each any all only also just more most other ' +
  'same such use used using run runs get gets make makes own new first one two see').split(' '));
// Polarity: "never X" against "X" is a possible conflict. "not only" and "never only" don't negate.
const NEG = /\b(never|not|don't|doesn't|cannot|can't|mustn't)\b(?!\s+only\b)/i;

const md = dir => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f)) : [];
const skills = dir => existsSync(dir) ? readdirSync(dir)
  .map(d => join(dir, d))
  .filter(d => statSync(d).isDirectory() && existsSync(join(d, 'SKILL.md')) && !existsSync(join(d, 'UPSTREAM.md')))
  .map(d => join(d, 'SKILL.md')) : [];

const files = [
  ...['AGENTS.md', 'CONTRIBUTING.md'].map(f => join(harness, f)).filter(existsSync),
  ...md(join(harness, 'docs')), ...md(join(harness, 'commands')), ...skills(join(harness, 'skills')),
];
if (profile) files.push(...[join(profile, 'ABOUT.md')].filter(existsSync),
  ...md(join(profile, 'memory')).filter(f => basename(f) !== 'MEMORY.md'), ...skills(join(profile, 'skills')));

const label = f => profile && f.startsWith(profile + '/') ? 'profile/' + relative(profile, f) : relative(harness, f);
const words = s => s.toLowerCase().replace(/`[^`]*`/g, ' ').match(/[a-z][a-z'-]+/g)?.filter(w => !STOP.has(w) && w.length > 2) ?? [];
const jaccard = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / (a.size + b.size - n || 1); };

// Rule-like sentences: prose lines outside code fences and front matter, split on sentence ends.
function sentences(file) {
  const out = [];
  let fence = false, front = false;
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (i === 0 && raw === '---') { front = true; return; }
    if (front) { if (raw === '---') front = false; return; }
    if (/^\s*```/.test(raw)) { fence = !fence; return; }
    if (fence || /^\s*(#|\||<!--)/.test(raw) || /^\s*\*\*Why/.test(raw)) return;   // Why: lines quote people
    const line = raw.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/\*\*/g, '');
    for (const text of line.split(/(?<=[.!?])\s+(?=[A-Z`"(])/)) {
      const set = new Set(words(text));
      if (set.size >= 6) out.push({ file, line: i + 1, text: text.trim(), set });
    }
  });
  return out;
}

const findings = [];
const all = files.flatMap(sentences);
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
  const a = all[i], b = all[j];
  if (a.file === b.file && Math.abs(a.line - b.line) < 3) continue;   // one rule wrapped over lines
  const score = jaccard(a.set, b.set);
  if (score < minConflict) continue;
  const negA = NEG.test(a.text), negB = NEG.test(b.text);
  const kind = negA !== negB ? 'conflict' : score >= minDup ? 'duplicate' : null;
  if (kind) findings.push({ kind, score: +score.toFixed(2), a, b });
}

// Skills: a profile skill with a harness skill's name replaces it (by design, but worth knowing),
// and two skills whose descriptions mostly match will fight over the same requests.
const desc = file => (readFileSync(file, 'utf8').match(/^description:\s*(.+)$/m)?.[1] ?? '');
const skillFiles = files.filter(f => basename(f) === 'SKILL.md');
const byName = new Map();
for (const f of skillFiles) {
  const name = basename(dirname(f));
  if (byName.has(name)) findings.push({ kind: 'skill-name', score: 1,
    a: { file: byName.get(name), line: 1, text: name }, b: { file: f, line: 1, text: name } });
  else byName.set(name, f);
}
for (let i = 0; i < skillFiles.length; i++) for (let j = i + 1; j < skillFiles.length; j++) {
  const a = new Set(words(desc(skillFiles[i]))), b = new Set(words(desc(skillFiles[j])));
  if (a.size < 4 || b.size < 4) continue;
  const score = jaccard(a, b);
  if (score >= 0.5) findings.push({ kind: 'skill-desc', score: +score.toFixed(2),
    a: { file: skillFiles[i], line: 1, text: desc(skillFiles[i]) }, b: { file: skillFiles[j], line: 1, text: desc(skillFiles[j]) } });
}

const order = { conflict: 0, 'skill-name': 1, 'skill-desc': 2, duplicate: 3 };
findings.sort((x, y) => order[x.kind] - order[y.kind] || y.score - x.score);
const view = p => ({ file: label(p.file), line: p.line, text: p.text });
const result = findings.map(f => ({ kind: f.kind, score: f.score, a: view(f.a), b: view(f.b) }));

if (args.includes('--json')) print(JSON.stringify({ files: files.length, findings: result }, null, 2));
else {
  const cut = s => s.length > 110 ? s.slice(0, 107) + '...' : s;
  for (const f of result) print(`${f.kind.padEnd(10)} ${f.score.toFixed(2)}  ${f.a.file}:${f.a.line}  ~  ${f.b.file}:${f.b.line}\n` +
    `    a: ${cut(f.a.text)}\n    b: ${cut(f.b.text)}`);
  print(`${result.length} finding(s) in ${files.length} file(s).`);
}
process.exitCode = args.includes('--strict') && result.length ? 1 : 0;
function print(s) { process.stdout.write(s + '\n'); }
