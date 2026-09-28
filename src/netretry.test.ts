import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientNetworkError, withNetRetry, stackHead } from './netretry.js';

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

test('isTransientNetworkError: the 2026-09-28 Daytona TLS drop is transient', () => {
  assert.equal(
    isTransientNetworkError(named('DaytonaConnectionError', 'Client network socket disconnected before secure TLS connection was established')),
    true,
  );
  // same message without the SDK wrapper name (e.g. raw axios error)
  assert.equal(isTransientNetworkError(new Error('Client network socket disconnected before secure TLS connection was established')), true);
});

test('isTransientNetworkError: socket codes, including in the cause chain', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET']) {
    assert.equal(isTransientNetworkError(Object.assign(new Error('boom'), { code })), true, code);
  }
  assert.equal(isTransientNetworkError(new Error('outer', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
});

test('isTransientNetworkError: real answers are NOT transient', () => {
  assert.equal(isTransientNetworkError(named('DaytonaNotFoundError', 'Sandbox not found')), false);
  assert.equal(isTransientNetworkError(named('DaytonaConflictError', 'already exists')), false);
  assert.equal(isTransientNetworkError(Object.assign(new Error('Request failed with status code 502'), { status: 502 })), false);
  assert.equal(isTransientNetworkError(Object.assign(new Error('ECONNRESET-looking text'), { statusCode: 500 })), false);
  assert.equal(isTransientNetworkError(new Error('validation failed')), false);
  assert.equal(isTransientNetworkError('ECONNRESET'), false); // not an error object
  assert.equal(isTransientNetworkError(undefined), false);
});

test('withNetRetry: retries a transient failure and returns the later success', async () => {
  let calls = 0;
  const slept: number[] = [];
  const retries: number[] = [];
  const out = await withNetRetry(
    async () => {
      calls++;
      if (calls < 3) throw named('DaytonaConnectionError', 'Client network socket disconnected before secure TLS connection was established');
      return 'ok';
    },
    { sleep: async (ms) => void slept.push(ms), onRetry: (_e, n) => retries.push(n) },
  );
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [1000, 3000]);
  assert.deepEqual(retries, [1, 2]);
});

test('withNetRetry: gives up after the configured retries with the last error', async () => {
  let calls = 0;
  const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  await assert.rejects(
    withNetRetry(
      async () => {
        calls++;
        throw err;
      },
      { delaysMs: [1, 1], sleep: async () => {} },
    ),
    (e) => e === err,
  );
  assert.equal(calls, 3);
});

test('withNetRetry: a non-transient error propagates immediately, no retry', async () => {
  let calls = 0;
  const notFound = named('DaytonaNotFoundError', 'Sandbox not found');
  await assert.rejects(
    withNetRetry(
      async () => {
        calls++;
        throw notFound;
      },
      { sleep: async () => assert.fail('must not sleep') },
    ),
    (e) => e === notFound,
  );
  assert.equal(calls, 1);
});

test('stackHead: first frames joined, undefined without a stack', () => {
  const e = new Error('x');
  e.stack = 'Error: x\n    at a (/f.ts:1:1)\n    at b (/f.ts:2:2)\n    at c (/f.ts:3:3)';
  assert.equal(stackHead(e, 2), 'at a (/f.ts:1:1) | at b (/f.ts:2:2)');
  assert.equal(stackHead('nope'), undefined);
  const bare = new Error('y');
  bare.stack = 'Error: y';
  assert.equal(stackHead(bare), undefined);
});
