import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseShadowKey, shadowDriver, shadowKey } from './driver.js';

const T = '0a1b2c3d4e5f60718293a4b5';

test('shadow keys — the tenant first, the slug last; a peer’s ids go into keys and paths only once valid', () => {
  assert.equal(shadowKey({ origin: 'home', taskId: T, slug: 'caldora' }), `a2a:home:${T}:caldora`);
  assert.equal(shadowKey({ tenantId: 'T0CLIENT01', origin: 'home', taskId: T, slug: 'caldora' }), `T0CLIENT01:a2a:home:${T}:caldora`);
  assert.deepEqual(parseShadowKey(`T0CLIENT01:a2a:home:${T}:caldora`), { tenantId: 'T0CLIENT01', origin: 'home', taskId: T, slug: 'caldora' });
  assert.equal(parseShadowKey(`a2a:../etc:${T}:caldora`), undefined);
  assert.equal(parseShadowKey('a2a:home:not-an-id:caldora'), undefined);
  assert.equal(parseShadowKey('thread:1.2'), undefined);
});

test('nothing in the channel: the shadow driver posts nothing, journals every view, and returns synthetic ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-shadow-'));
  const d = shadowDriver({ dir, now: () => new Date('2026-10-17T08:00:00.000Z') });
  const key = `a2a:home:${T}:caldora`;
  const status = await d.post({ conv: key }, { kind: 'status', line: '🛠 Preparing…', turnId: 't1', notify: 'Working…' });
  await d.update(status, { kind: 'answer', markdown: 'Orders dropped because …' });
  assert.match(status.id, /^shadow-/);
  const j = d.read('home', T);
  assert.deepEqual(j.map((e) => [e.op, e.view.kind]), [['post', 'status'], ['update', 'answer']]);
  assert.equal(await d.permalink(status), undefined);
  assert.deepEqual(d.capabilities, { reactions: false, privateReplies: 'fallback', threadRepliesNeedMention: false });
  assert.deepEqual(d.read('home', 'ffffffffffffffffffffffff'), []);
  utimesSync(join(dir, 'home', `${T}.jsonl`), new Date('2026-09-01'), new Date('2026-09-01'));
  assert.equal(d.prune(30 * 86_400_000, Date.parse('2026-10-17')), 1);
  assert.deepEqual(d.read('home', T), []);
});
