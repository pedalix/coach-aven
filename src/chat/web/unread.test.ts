import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { History } from './history.js';
import { CARD_NEWS, SIDEBAR_THREADS, cardNews, newsAt, roomNews, sidebarThreads, threadSeenKey } from './unread.js';

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 26, 10, 0, tick++));
const room = () => new History(mkdtempSync(join(tmpdir(), 'aven-web-unread-')), clock).conversation('room:alpha');
const status = { kind: 'status' as const, line: 'Working…', turnId: 't1', notify: 'Working…' };

test('newsAt: a person\'s post is news for others, never for its author', () => {
  const r = room();
  r.append({ t: 'post', id: 'm1', by: { id: 'u1', name: 'Ann' }, text: 'fix the bug' });
  const m = r.message('m1')!;
  assert.equal(newsAt(m, 'u2'), m.at);
  assert.equal(newsAt(m, 'u1'), undefined);
});

test('newsAt: a running status is not news; the answer that replaces it counts once, when it lands', () => {
  const r = room();
  r.append({ t: 'post', id: 'm1', by: { id: 'u1' }, text: 'q' });
  r.append({ t: 'post', id: 'm2', thread: 'm1', view: status });
  r.append({ t: 'update', id: 'm2', view: { ...status, line: 'Working… 4s' } });
  assert.equal(newsAt(r.message('m2')!, 'u1'), undefined, 'every tick of the clock stays quiet');
  r.append({ t: 'update', id: 'm2', view: { kind: 'background', turnId: 't1', elapsedMs: 1 } });
  assert.equal(newsAt(r.message('m2')!, 'u1'), undefined, 'the background card is progress too');
  const answer = r.append({ t: 'update', id: 'm2', view: { kind: 'answer', markdown: 'Done.' } });
  assert.equal(newsAt(r.message('m2')!, 'u1'), answer.at);
  r.append({ t: 'post', id: 'm3', thread: 'm1', view: { kind: 'backgroundDone', label: '✅ Done', steps: 3, elapsedMs: 9 } });
  assert.equal(newsAt(r.message('m3')!, 'u1'), undefined, 'the epitaph of a background card');
});

test('newsAt: a routine\'s headline counts when posted, not at its rewrites; a notice is news', () => {
  const r = room();
  const posted = r.append({ t: 'post', id: 'm1', view: { kind: 'line', text: '🛠 Weekly report · running…' } });
  r.append({ t: 'update', id: 'm1', view: { kind: 'line', text: '🛠 Weekly report — all green' } });
  assert.equal(newsAt(r.message('m1')!, 'u1'), posted.at);
  const q = r.append({ t: 'post', id: 'm2', thread: 'm1', view: { kind: 'text', text: 'Cancelled.' } });
  assert.equal(newsAt(r.message('m2')!, 'u1'), q.at);
});

test('newsAt: a message only one person sees (a typed command, a private reply) is never news', () => {
  const r = room();
  r.append({ t: 'post', id: 'm1', by: { id: 'u1' }, text: '/status', cmd: true, visibleTo: 'u1' });
  r.append({ t: 'post', id: 'm2', priv: { kind: 'text', text: 'all fine' }, visibleTo: 'u1' });
  assert.equal(newsAt(r.message('m1')!, 'u2'), undefined);
  assert.equal(newsAt(r.message('m2')!, 'u1'), undefined);
});

test('roomNews: per thread, oldest first, in one pass; a thread rooted in someone else\'s private post is left out', () => {
  const r = room();
  r.append({ t: 'post', id: 'a', by: { id: 'u1' }, text: 'first' });
  r.append({ t: 'post', id: 'a1', thread: 'a', view: status });
  r.append({ t: 'post', id: 'b', by: { id: 'u2' }, text: 'second' });
  r.append({ t: 'update', id: 'a1', view: { kind: 'answer', markdown: 'A.' } });
  r.append({ t: 'post', id: 'p', by: { id: 'u3' }, text: '/help', cmd: true, visibleTo: 'u3' });
  r.append({ t: 'post', id: 'p1', thread: 'p', view: { kind: 'text', text: 'help text' } });
  const news = roomNews(r.all(), 'u1');
  assert.deepEqual([...news.keys()].sort(), ['a', 'b']);
  assert.deepEqual(news.get('a'), [r.message('a1')!.updatedAt], 'u1\'s own root is not news, the answer is');
  assert.deepEqual(news.get('b'), [r.message('b')!.at]);
  assert.equal(roomNews(r.all(), 'u3').get('p')?.length, 1, 'the private root\'s own person still gets its thread');
});

test('cardNews keeps the newest CARD_NEWS times; sidebarThreads lists the SIDEBAR_THREADS threads with the newest news', () => {
  const times = Array.from({ length: CARD_NEWS + 5 }, (_, i) => `2026-11-18T10:${String(i).padStart(2, '0')}:00.000Z`);
  const card = cardNews(times).split(' ');
  assert.equal(card.length, CARD_NEWS);
  assert.equal(card.at(-1), times.at(-1));
  assert.equal(cardNews(undefined), '');

  const news = new Map<string, string[]>();
  for (let i = 0; i < SIDEBAR_THREADS + 3; i++) news.set(`t${i}`, [`2026-11-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}.000Z`]);
  news.set('old', ['2026-01-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z']);
  const pairs = sidebarThreads(news).split(' ');
  assert.equal(pairs.length, SIDEBAR_THREADS);
  assert.equal(pairs[0], 'old@2026-11-30T00:00:00.000Z', 'a thread counts by its newest news');
  assert.equal(sidebarThreads(new Map()), '');
  assert.equal(threadSeenKey('room:alpha', 'a'), 'room:alpha#a');
});
