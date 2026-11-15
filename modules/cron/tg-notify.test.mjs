// node --test modules/cron/tg-notify.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TG = fileURLToPath(new URL('./tg-notify.py', import.meta.url));

// Offline sandbox: alerts go to the master log (a fake `screen` says the master is up), and HOME has no bot token.
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'tgn-'));
  const prof = join(d, 'profile'), bin = join(d, 'bin');
  mkdirSync(join(prof, 'telegram'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(prof, 'telegram', 'ALERTS_TO_MASTER'), '');
  writeFileSync(join(bin, 'screen'), '#!/bin/sh\necho "123.claude-tg (Detached)"\n');
  chmodSync(join(bin, 'screen'), 0o755);
  const env = { ...process.env, HOME: d, PROFILE_DIR: prof, PATH: `${bin}:${process.env.PATH}` };
  delete env.TG_NOTIFY_DIRECT;
  const log = join(prof, 'logs', 'master-alerts.log');
  const run = (...a) => spawnSync('python3', [TG, ...a], { env, encoding: 'utf8' });
  return { run, log };
}

test('--help, -h and no text print usage and exit 2 without logging', () => {
  const s = sandbox();
  for (const a of [['--help'], ['-h'], [], ['   '], ['job failed', '--help']]) {
    const r = s.run(...a);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.match(r.stderr, /usage: tg-notify\.py/);
    assert.equal(r.stdout, '');
  }
  assert.ok(!existsSync(s.log));
});

test('a normal alert is still queued for the master session', () => {
  const s = sandbox();
  const r = s.run('job', 'x', 'failed');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(s.log, 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ job x failed\n$/);
});
