// node --test modules/cron/hcron.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, inWindow, dueSlots, parseDuration } from './hcron.mjs';

const at = (h, m, day = 10) => new Date(2026, 10, day, h, m, 0); // Nov 2026, local time (10th = Tue)

test('cron fields: lists, ranges, steps, names', () => {
  const f = parseCron('7,37 20-23/2 * * mon-fri');
  assert.ok(cronMatches(f, at(20, 7)));
  assert.ok(cronMatches(f, at(22, 37)));
  assert.ok(!cronMatches(f, at(21, 7)));          // step skips 21
  assert.ok(!cronMatches(f, at(20, 8)));
  assert.ok(!cronMatches(f, at(20, 7, 15)));      // Sunday
  assert.ok(cronMatches(parseCron('@hourly'), at(3, 0)));
  assert.ok(cronMatches(parseCron('*/15 * * * *'), at(3, 45)));
  assert.ok(cronMatches(parseCron('0 9 * * 7'), at(9, 0, 15)));   // 7 = Sunday
});

test('cron rejects bad input', () => {
  for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', 'x * * * *', '*/0 * * * *'])
    assert.throws(() => parseCron(bad), bad);
});

test('day-of-month OR day-of-week when both are set', () => {
  const f = parseCron('0 0 1 * mon');
  assert.ok(cronMatches(f, at(0, 0, 1)));   // the 1st (Sunday)
  assert.ok(cronMatches(f, at(0, 0, 9)));   // a Monday
  assert.ok(!cronMatches(f, at(0, 0, 10)));
});

test('windows, including across midnight', () => {
  assert.ok(inWindow('20:00-05:00', at(23, 59)));
  assert.ok(inWindow('20:00-05:00', at(2, 0)));
  assert.ok(!inWindow('20:00-05:00', at(5, 0)));
  assert.ok(!inWindow('20:00-05:00', at(12, 0)));
  assert.ok(inWindow('09:00-17:30', at(17, 29)));
  assert.ok(!inWindow('09:00-17:30', at(17, 30)));
  assert.ok(inWindow(undefined, at(1, 1)));
  assert.throws(() => inWindow('9-5', at(1, 1)));
});

test('due slots: this minute, and missed slots after sleep', () => {
  const f = parseCron('7 * * * *');
  assert.deepEqual(dueSlots(f, at(20, 6), at(20, 7)).map(d => d.getHours()), [20]);
  assert.equal(dueSlots(f, at(20, 7), at(20, 8)).length, 0);            // already handled
  const slept = dueSlots(f, at(20, 0), at(23, 30));                     // asleep 20:00-23:30
  assert.deepEqual(slept.map(d => d.getHours()), [20, 21, 22, 23]);
  assert.equal(dueSlots(f, null, at(20, 7)).length, 1);                 // first run ever
  assert.equal(dueSlots(f, null, at(20, 8)).length, 0);
});

test('durations', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('50m'), 3_000_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('15'), 900_000);
  assert.throws(() => parseDuration('soon'));
});
