// The Eyes & Hands live fixture test (design part 18): real hands on a real Chrome, on one Mac.
// Never on CI: it skips when CI is set, and runs only with EYESHANDS_LIVE=1. A default run (CI's
// `node --test` over every *.test.mjs) skips here before it starts any process or reads any state.
//
// WARNING: Do not run it while job-hunt or another eyes and hands program runs or might start. It
// checks, skips with the reason, and never forces one; the hands share the one cursor.
//
//   EYESHANDS_LIVE=1 EYESHANDS_HOLD_FILE=<driver lock> awake run eh-live-test -- \
//     node --test modules/eyeshands/test/live.test.mjs
//
// Optional: EYESHANDS_LIVE_REPORT=<file> writes the outcome and the measurements as JSON. How and
// when: SETUP.md, "Live fixture test". The logic is live-lib.mjs (offline tests:
// ../live-offline.test.mjs); the real calls are live-world.mjs.
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { gate } from './live-lib.mjs';

const skip = gate(process.env, process.platform);

test('live fixture test: fill, takeover, stop and foreign hands on a throwaway Chrome', { skip: skip || false, timeout: 15 * 60 * 1000 }, async t => {
  const { runLive } = await import('./live-lib.mjs');
  const { realWorld } = await import('./live-world.mjs');
  const out = await runLive(realWorld(process.env));
  t.diagnostic(`eh-live outcome: ${JSON.stringify(out)}`);
  if (process.env.EYESHANDS_LIVE_REPORT) writeFileSync(process.env.EYESHANDS_LIVE_REPORT, JSON.stringify(out, null, 2) + '\n');
  if (out.status === 'skip' || out.status === 'inconclusive') return t.skip(out.reason);
  if (out.status !== 'pass') throw new Error(out.reason);
});
