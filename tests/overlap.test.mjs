import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDay, stateBetween, kyivDate, readAddresses } from '../public/overlap.mjs';

const date = '2026-10-29';
const schedule = slots => ({ days: [{ date, slots }] });
const on = (start, end) => ({ start, end, state: 'on' });

test('intersects three schedules and merges adjacent shared windows', () => {
  const result = compareDay([schedule([on(60, 180), on(180, 300)]), schedule([on(120, 250)]), schedule([on(150, 280)])], date);
  assert.deepEqual(result.windows, [{ start: 150, end: 250 }]);
});
test('missing schedules and missing dates never become available', () => {
  assert.deepEqual(compareDay([schedule([on(0, 1440)]), schedule([on(0, 1440)]), null], date).windows, []);
  assert.deepEqual(compareDay(Array(3).fill(schedule([on(0, 1440)])), '2026-10-30').windows, []);
});
test('gaps, unknown periods and conflicting off periods are excluded', () => {
  const a = schedule([on(0, 60), on(90, 180), { start: 120, end: 150, state: 'unknown' }]);
  assert.deepEqual(compareDay([a, schedule([on(0, 180)]), schedule([on(0, 180)])], date).windows, [{ start: 0, end: 60 }, { start: 90, end: 120 }, { start: 150, end: 180 }]);
  assert.equal(stateBetween([on(0, 60), { start: 30, end: 60, state: 'off' }], 0, 60), 'off');
});
test('half-hour boundaries and midnight are preserved', () => {
  assert.deepEqual(compareDay(Array(3).fill(schedule([on(1410, 1440)])), date).windows, [{ start: 1410, end: 1440 }]);
  assert.equal(kyivDate(new Date('2026-10-29T23:00:00Z')), '2026-10-30');
});
test('malformed browser storage is recoverable', () => {
  assert.equal(readAddresses({ getItem: () => '{' }), null);
  assert.equal(readAddresses({ getItem: () => '[]' }), null);
  assert.equal(readAddresses({ getItem() { throw Error('blocked'); } }), null);
  assert.equal(readAddresses({ getItem: () => JSON.stringify([{}, {}, {}]) })[0].street, '');
});
