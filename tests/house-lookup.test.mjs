import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHouseLookup } from '../public/house-lookup.mjs';

test('shares one request for the same selected street and preserves suffixed house numbers', async () => {
  let requests = 0;
  const lookup = createHouseLookup(async street => {
    requests++; assert.equal(street, 'вул. Хрещатик');
    return { houses: ['1', '2А', '7/1', '10-Б'] };
  });
  const [first, second] = await Promise.all([lookup('вул. Хрещатик'), lookup(' вул. Хрещатик ')]);
  assert.deepEqual(first, ['1', '2А', '7/1', '10-Б']);
  assert.deepEqual(second, first);
  assert.deepEqual(await lookup('вул. Хрещатик'), first);
  assert.equal(requests, 1);
});

test('keeps building lists separate for different streets and skips empty streets', async () => {
  const requested = [];
  const lookup = createHouseLookup(async street => { requested.push(street); return { houses: street === 'A' ? ['1'] : ['20А'] }; });
  assert.deepEqual(await lookup('  '), []);
  assert.deepEqual(await lookup('A'), ['1']);
  assert.deepEqual(await lookup('B'), ['20А']);
  assert.deepEqual(requested, ['A', 'B']);
});

test('retries failed and malformed building lookups instead of caching the error', async () => {
  let requests = 0;
  const lookup = createHouseLookup(async () => {
    if (++requests === 1) throw new Error('DTEK unavailable');
    if (requests === 2) return { houses: ['1', null] };
    return { houses: ['2А'] };
  });
  await assert.rejects(lookup('A'), /DTEK unavailable/);
  await assert.rejects(lookup('A'), /building list/);
  assert.deepEqual(await lookup('A'), ['2А']);
  assert.equal(requests, 3);
});
