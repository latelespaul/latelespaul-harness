#!/usr/bin/env node
// ste-check: checks an explanation (Markdown or plain text) against the harness explaining standard
// (docs/explaining-standard.md). No dependencies.
//
//   ste-check <file|-> [--json] [--type concept|procedure|troubleshooting|decision]
//             [--structure | --no-structure] [--long-words 150] [--allow ACR,ACR]
//             [--max-procedural 20] [--max-descriptive 25] [--max-paragraph 6]
//
// Rules: sentence-length (numbered-list sentences are procedural: 20 words; others 25),
// passive-voice (likely, a heuristic), paragraph-length (6 sentences), undefined-acronym
// (first use with no "(ACR)", "ACR (...)" or "ACR: ..." anywhere), missing-section (an answer
// over --long-words words must have the eight parts of its type). Code blocks and `code` are skipped.
// Exit 0: no findings. Exit 1: findings. Exit 2: bad usage or unreadable input.

import { readFileSync } from 'node:fs';

const USAGE = 'usage: ste-check <file|-> [--json] [--type concept|procedure|troubleshooting|decision] [--structure|--no-structure]\n'
  + '                 [--long-words N] [--allow ACR,ACR] [--max-procedural N] [--max-descriptive N] [--max-paragraph N]';

// The eight parts. Each heading is matched to the first part whose pattern it contains, in this
// order, so "Next steps" is part 8 and never part 4.
const SECTIONS = [
  ['next', 'What to do next', /\bnext\b|check it worked|verify/],
  ['short', 'Short answer', /short answer|in short|tl;?dr|recommendation|the answer|^answer\b/],
  ['fits', 'Where it fits', /where it fits|big picture|context|before you start|what should happen|the decision/],
  ['flow', 'Diagram (the whole flow)', /diagram|flow|\bmap\b/],
  ['terms', 'Terms used', /\bterms\b|glossary|definitions/],
  ['example', 'Worked example', /example|evidence|scenario/],
  ['edges', 'Edge cases and warnings', /edge case|failure|warning|caution|caveat|gotcha|risk|if it fails|when .* wins/],
  ['steps', 'Step by step', /step|walk-?through|how it works|procedure|what happened|how it failed|options|compar/],
];
// Parts each type may leave out even when the answer is long.
const OPTIONAL = { concept: [], procedure: ['flow'], troubleshooting: [], decision: ['flow'] };

// All-caps words that are signal words or emphasis, not acronyms (STE 7.1 uses WARNING and CAUTION).
const NOT_ACRONYMS = new Set(['WARNING', 'CAUTION', 'NOTE', 'NOT', 'NEVER', 'ALWAYS', 'ONLY', 'MUST', 'IMPORTANT', 'TODO', 'OK', 'AM', 'PM', 'AND', 'OR']);
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|incl|fig|cf)\.$/i;
const BE = '(?:am|is|are|was|were|be|been|being|get|gets|got|gotten)';
const IRREGULAR = 'known|shown|given|taken|written|done|made|sent|set|kept|held|built|put|found|left|lost|seen|told|brought|bought|'
  + 'thought|caught|taught|chosen|driven|broken|spoken|stolen|frozen|hidden|begun|drawn|grown|thrown|worn|torn|split|cut|hit|shut|'
  + 'spent|paid|laid|said|sold|meant|heard|stuck|struck|understood|forgotten|eaten|fallen|forbidden|forgiven|ridden|shaken|woken|'
  + 'overridden|rewritten|undone|withdrawn|bound|fed|led|shot|lit|dealt|run|read|begun|spun|swept|sworn|beaten|bitten';
const PASSIVE = new RegExp(`\\b${BE}\\s+(?:(?:not|never|also|then|now|only|still|already|usually|always|often|automatically|just)\\s+)*`
  + `([a-z]+ed|${IRREGULAR})\\b`, 'gi');
const NOT_PARTICIPLES = new Set(['need', 'speed', 'indeed', 'hundred', 'red', 'bed', 'shed', 'feed', 'seed', 'bleed']);
// Past participles that usually name a state, not an action: STE 3.3 allows them as adjectives
// ("the screen is locked"). They count as passive only with a "by ..." agent.
const STATES = new Set(['locked', 'unlocked', 'closed', 'opened', 'finished', 'done', 'connected', 'disconnected', 'installed',
  'uninstalled', 'enabled', 'disabled', 'paused', 'stopped', 'signed', 'attached', 'detached', 'required', 'allowed', 'based',
  'named', 'called', 'located', 'logged', 'gone', 'set', 'missed', 'tired', 'interested', 'supposed', 'expired', 'broken', 'stuck']);

function parseArgs(argv) {
  const o = { type: 'concept', structure: 'auto', longWords: 150, allow: [], maxProcedural: 20, maxDescriptive: 25, maxParagraph: 6, json: false };
  const num = (k, v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${k} needs a whole number`); return n; };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--json') o.json = true;
    else if (a === '--structure') o.structure = 'always';
    else if (a === '--no-structure') o.structure = 'never';
    else if (a === '--type') { o.type = v(); if (!(o.type in OPTIONAL)) throw new Error(`unknown --type "${o.type}"`); }
    else if (a === '--long-words') o.longWords = num(a, v());
    else if (a === '--max-procedural') o.maxProcedural = num(a, v());
    else if (a === '--max-descriptive') o.maxDescriptive = num(a, v());
    else if (a === '--max-paragraph') o.maxParagraph = num(a, v());
    else if (a === '--allow') o.allow.push(...v().split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else files.push(a);
  }
  if (!o.help && files.length !== 1) throw new Error('give exactly one file, or - for stdin');
  o.file = files[0];
  return o;
}

// ---------- reading the text into blocks ----------
// Inline code, links and URLs become one word each (STE 8.6 counts such elements as one word);
// text in parentheses counts as one word (STE 8.5).
const plain = s => s.replace(/`[^`]*`/g, 'CODE_')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, 'URL_')
  .replace(/\*\*?|~~/g, '');
const countable = s => { let t = s; for (let i = 0; i < 5 && /\([^()]*\)/.test(t); i++) t = t.replace(/\([^()]*\)/g, ' PAREN_ '); return t; };
const words = s => countable(s).split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));

function sentences(text) {
  const out = [];
  let cur = '';
  const parts = text.split(/(?<=[.!?])\s+/);
  for (const p of parts) {
    cur = cur ? `${cur} ${p}` : p;
    if (ABBREVIATIONS.test(cur)) continue;
    out.push(cur); cur = '';
  }
  if (cur) out.push(cur);
  return out.map(s => s.trim()).filter(s => words(s).length);
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING = /^\s*(?:\d+[.)]\s*)?\*\*([^*]+?)\*\*\s*:?\s*$/;
const BOLD_LEAD = /^\s*(?:\d+[.)]\s*)?\*\*([^*]+?)[.:]?\*\*[.:]?\s+\S/;
const LIST = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/;

// Blocks: { kind: 'heading'|'para'|'item'|'code'|'table', line, text, numbered }
function blocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = null, fence = null;
  const flush = () => { if (para) out.push(para); para = null; };
  lines.forEach((raw, i) => {
    const line = i + 1;
    const f = /^\s*(```|~~~)/.exec(raw);
    if (fence) { fence.text += raw + '\n'; if (f && raw.trim().startsWith(fence.mark)) { out.push(fence); fence = null; } return; }
    if (f) { flush(); fence = { kind: 'code', line, text: '', mark: f[1] }; return; }
    if (!raw.trim()) { flush(); return; }
    if (/^\s*\|/.test(raw)) { flush(); out.push({ kind: 'table', line, text: raw }); return; }
    let m;
    if ((m = HEADING.exec(raw)) || (m = BOLD_HEADING.exec(raw))) { flush(); out.push({ kind: 'heading', line, text: m[1] }); return; }
    if ((m = BOLD_LEAD.exec(raw))) {   // "**Short answer.** The text": a heading, then its text
      flush(); out.push({ kind: 'heading', line, text: m[1] });
      raw = raw.replace(/\*\*[^*]+?\*\*[.:]?\s+/, '');
    }
    if ((m = LIST.exec(raw))) { flush(); para = { kind: 'item', line, text: m[2], numbered: !!m[1] }; return; }
    if (para && para.kind === 'item' && /^\s{2,}\S/.test(raw)) { para.text += ' ' + raw.trim(); return; }
    if (para && para.kind === 'para') { para.text += ' ' + raw.trim(); return; }
    flush(); para = { kind: 'para', line, text: raw.trim() };
  });
  flush();
  if (fence) out.push(fence);
  return out;
}

// ---------- the checks ----------
export function check(src, opts = {}) {
  const o = { type: 'concept', structure: 'auto', longWords: 150, allow: [], maxProcedural: 20, maxDescriptive: 25, maxParagraph: 6, ...opts };
  const bs = blocks(src);
  const findings = [];
  const add = (rule, line, message, extra = {}) => findings.push({ rule, line, message, ...extra });
  const prose = bs.filter(b => b.kind === 'para' || b.kind === 'item');
  let total = 0;

  for (const b of prose) {
    const text = plain(b.text);
    const ss = sentences(text);
    for (const s of ss) {
      const n = words(s).length;
      total += n;
      const max = b.numbered ? o.maxProcedural : o.maxDescriptive;
      if (n > max) add('sentence-length', b.line, `${n} words in a ${b.numbered ? 'procedural' : 'descriptive'} sentence (max ${max})`, { words: n, max, sentence: s });
      for (const m of s.matchAll(PASSIVE)) {
        const p = m[1].toLowerCase();
        if (NOT_PARTICIPLES.has(p)) continue;
        if (STATES.has(p) && !/^\s+by\b/i.test(s.slice(m.index + m[0].length))) continue;
        add('passive-voice', b.line, `likely passive voice: "${m[0]}" (say who does it)`, { phrase: m[0] });
      }
    }
    if (b.kind === 'para' && ss.length > o.maxParagraph)
      add('paragraph-length', b.line, `${ss.length} sentences in one paragraph (max ${o.maxParagraph})`, { sentences: ss.length, max: o.maxParagraph });
  }

  // Acronyms: defined when written as "(ACR)", "(expansion, ACR)", "ACR (expansion)", "ACR: ..." / "ACR = ..." / "ACR - ..."
  // at the start of a line or list item, or as the first cell of a table row.
  const textNoCode = src.replace(/(```|~~~)[\s\S]*?\1/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
  const defined = new Set(o.allow);
  for (const m of textNoCode.matchAll(/\(\s*([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\s*[),;]/g)) defined.add(m[1]);
  for (const m of textNoCode.matchAll(/\([^()]*,\s*([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\s*\)/g)) defined.add(m[1]);   // "(full name, ACR)"
  for (const m of textNoCode.matchAll(/\b([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\**\s+\((?!\s*[A-Z0-9]+s?\s*\))/g)) defined.add(m[1]);
  for (const m of textNoCode.matchAll(/^\s*(?:[-*+]|\d+[.)])?\s*\**([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\**\s*(?:[:=]|\s[-–—]\s)/gm)) defined.add(m[1]);
  for (const m of textNoCode.matchAll(/^\s*\|\s*\**([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\**\s*\|/gm)) defined.add(m[1]);
  const seen = new Set();
  textNoCode.split('\n').forEach((l, i) => {
    if (/^\s*(#|https?:)/.test(l)) return;
    for (const m of l.replace(/https?:\/\/\S+/g, '').matchAll(/\b([A-Z][A-Z0-9]*[A-Z][A-Z0-9]*)s?\b/g)) {
      const a = m[1];
      if (a.length > 6 || NOT_ACRONYMS.has(a) || defined.has(a) || seen.has(a)) continue;
      seen.add(a);
      add('undefined-acronym', i + 1, `${a} is not defined (write it out once: "full name (${a})", or list it under Terms)`, { acronym: a });
    }
  });

  // Structure: a long answer shows all eight parts (some optional per type).
  const long = o.structure === 'always' || (o.structure === 'auto' && total > o.longWords);
  const found = new Set();
  for (const b of bs.filter(b => b.kind === 'heading')) {
    const h = plain(b.text).toLowerCase().replace(/^\d+[.)]?\s*/, '');
    const s = SECTIONS.find(([, , re]) => re.test(h));
    if (s) found.add(s[0]);
  }
  if (bs.some(b => b.kind === 'code' && /->|→|─|│|├|└|▶|▼|=>/.test(b.text))) found.add('flow');
  const missing = long ? SECTIONS.filter(([k]) => !found.has(k) && !OPTIONAL[o.type].includes(k)) : [];
  for (const [k, name] of missing) add('missing-section', 1, `long ${o.type} answer has no "${name}" part`, { section: k });

  findings.sort((a, b) => a.line - b.line);
  return { words: total, long, sections: SECTIONS.filter(([k]) => found.has(k)).map(([k]) => k), findings };
}

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`ste-check: ${e.message}\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  let src;
  try { src = readFileSync(o.file === '-' ? 0 : o.file, 'utf8'); } catch (e) { console.error(`ste-check: cannot read ${o.file}: ${e.message}`); return 2; }
  const r = check(src, o);
  const name = o.file === '-' ? '<stdin>' : o.file;
  if (o.json) console.log(JSON.stringify({ file: name, type: o.type, ...r }, null, 2));
  else {
    for (const f of r.findings) console.log(`${name}:${f.line}: ${f.rule}: ${f.message}`);
    console.log(r.findings.length ? `${r.findings.length} finding(s).` : 'No findings.');
  }
  return r.findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/ste-check')) process.exitCode = main(process.argv.slice(2));
