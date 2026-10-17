import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../state.js';
import { expireIdleTasks, TASK_EXPIRY_MS } from './expiry.js';
import type { InTask, OutTask } from './records.js';

test('task outlives the hub: no message for the hub’s expiry plus a day — each side ends it `failed: expired` on its own', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-expiry-')), 'state.json'));
  const asked = '2026-10-17T08:00:00.000Z';
  const out: OutTask = { id: 'a'.repeat(24), slug: 'owen-ops', key: 'thread:1.2', reply: { key: 'thread:1.2', driver: 'slack' }, target: 'bluefin/caldora', question: 'q', state: 'input-required', depth: 0, rounds: 1, replies: [], seen: [], createdAt: asked, updatedAt: asked };
  const inc: InTask = { id: 'b'.repeat(24), origin: 'northwind', from: 'northwind/ledger', fromDomain: 'northwind', slug: 'caldora', key: `a2a:northwind:${'b'.repeat(24)}:caldora`, question: 'q', state: 'input-required', awaitingInput: true, depth: 0, rounds: 1, seen: [], createdAt: asked, updatedAt: asked };
  store.putOutTask(out);
  store.putInTask(inc);
  store.putOutTask({ ...out, id: 'c'.repeat(24), updatedAt: '2026-10-24T08:00:00.000Z' }); // a reply came a week later
  assert.equal(TASK_EXPIRY_MS, 8 * 86_400_000);
  const early = expireIdleTasks(store, new Date('2026-10-25T07:59:00.000Z'));
  assert.deepEqual([early.out.length, early.in.length], [0, 0], 'a minute before: nothing yet — waiting for a person is no timeout');
  const ended = expireIdleTasks(store, new Date('2026-10-25T08:01:00.000Z'));
  assert.deepEqual(ended.out.map((t) => [t.id[0], t.state, t.reason]), [['a', 'failed', 'expired']]);
  assert.deepEqual(ended.in.map((t) => [t.id[0], t.state, t.reason]), [['b', 'failed', 'expired']]);
  assert.equal(store.getOutTask('c'.repeat(24))?.state, 'input-required');
  assert.deepEqual(expireIdleTasks(store, new Date('2026-10-26T08:01:00.000Z')).out, [], 'an ended task is not ended twice');
});
