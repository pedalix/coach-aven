import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalTransport } from './local.js';
import type { Envelope, Payload } from './protocol.js';
import { memoryStore, type Delivery } from './transport.js';

const env = (id: string, to = 'home/caldora'): Envelope => ({ v: 1, id, from: 'home/nora', to, method: 'ask', task: '0f1e2d3c4b5a69788796a5b4' });
const payload: Payload = { domain: 'home', marks: {}, depth: 0, message: { text: 'hi' } };
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('LocalTransport — delivers in clear, keeps the record until acked', async () => {
  const store = memoryStore();
  const t = new LocalTransport(store, { installation: 'home' });
  const got: Delivery[] = [];
  t.onDeliver(async (d) => void got.push(d));
  assert.deepEqual(await t.send(env('5f0c1d2e3a4b59687a6b5c4d'), payload), { routed: true });
  assert.equal(store.records.length, 1, 'recorded before delivery');
  await tick();
  assert.deepEqual(got, [{ seq: 1, env: env('5f0c1d2e3a4b59687a6b5c4d'), payload }]);
  await t.ack(1);
  assert.equal(store.records.length, 0);
});

test('LocalTransport — a record never acked is handed over again after a restart, with seqs that keep counting', async () => {
  const store = memoryStore();
  const before = new LocalTransport(store, { installation: 'home' });
  before.onDeliver(async () => {
    throw new Error('the bot stopped before recording the effect');
  });
  await before.send(env('5f0c1d2e3a4b59687a6b5c4d'), payload);
  await tick();
  assert.equal(store.records.length, 1);
  const after = new LocalTransport(store, { installation: 'home' });
  const got: number[] = [];
  after.onDeliver(async (d) => {
    got.push(d.seq);
    await after.ack(d.seq);
  });
  await after.start();
  assert.deepEqual(got, [1]);
  assert.equal(store.records.length, 0);
  await after.send(env('5f0c1d2e3a4b59687a6b5c4e'), payload);
  await tick();
  assert.deepEqual(got, [1, 2]);
});

test('LocalTransport — an agent of another installation is not its to deliver', async () => {
  const t = new LocalTransport(memoryStore(), { installation: 'home' });
  assert.deepEqual(await t.send(env('5f0c1d2e3a4b59687a6b5c4d', 'bluefin/caldora'), payload), { rejected: 'not an agent of this installation' });
  assert.deepEqual(t.presence(), { online: ['home'], removed: [] });
});
