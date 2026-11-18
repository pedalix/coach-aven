import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eachLimit } from './pool.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('eachLimit: every item runs once, never more than `limit` at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  await eachLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(5);
    seen.push(n);
    inFlight--;
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(peak, 4);
});

test('eachLimit: a failure lets the others finish, then the first failure in list order is thrown', async () => {
  const done: string[] = [];
  await assert.rejects(
    eachLimit(['a', 'b', 'c', 'd'], 2, async (s) => {
      // 'c' fails first in time, 'b' later: the caller still sees 'b' (list order, not timing).
      await tick(s === 'b' ? 20 : 1);
      if (s === 'b' || s === 'c') throw new Error(`fail ${s}`);
      done.push(s);
    }),
    /fail b/,
  );
  assert.deepEqual(done.sort(), ['a', 'd']);
});

test('eachLimit: an empty list or a limit below one still settles; limit 1 is today\'s sequential order', async () => {
  await eachLimit([], 4, async () => assert.fail('no step'));
  const order: number[] = [];
  await eachLimit([3, 1, 2], 0, async (n) => {
    await tick(n);
    order.push(n);
  });
  assert.deepEqual(order, [3, 1, 2]);
});
