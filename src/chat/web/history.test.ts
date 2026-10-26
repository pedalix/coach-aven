import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { History, fromStored, toStored, visibleFor } from './history.js';
import type { MessageView } from '../views.js';

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 26, 10, 0, tick++));
const fresh = () => new History(mkdtempSync(join(tmpdir(), 'aven-web-hist-')), clock);

test('a room: posts, a thread with updates and marks, the thread list newest-activity first', () => {
  const h = fresh();
  const room = h.conversation('room:alpha');
  room.append({ t: 'post', id: 'm1', by: { id: 'u1', name: 'Ann' }, text: 'fix the bug' });
  room.append({ t: 'post', id: 'm2', thread: 'm1', view: { kind: 'status', line: 'Preparing…', turnId: 't1', notify: 'Working…' } });
  room.append({ t: 'mark', id: 'm1', mark: 'working', op: 'add' });
  room.append({ t: 'post', id: 'm3', by: { id: 'u2', name: 'Bo' }, text: '! a note' });
  room.append({ t: 'update', id: 'm2', view: { kind: 'answer', markdown: 'Done.' } });
  room.append({ t: 'mark', id: 'm1', mark: 'working', op: 'remove' });
  room.append({ t: 'mark', id: 'm1', mark: 'done', op: 'add' });
  room.append({ t: 'tally', id: 'm2', good: 1, bad: 0 });

  const t = room.thread('m1');
  assert.deepEqual(t.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(t[0].marks, ['done']);
  assert.equal((t[1].view as { kind: string }).kind, 'answer');
  assert.deepEqual(t[1].tally, { good: 1, bad: 0 });
  // The thread m1 saw activity after m3 was posted: it lists first.
  assert.deepEqual(room.threads().map((s) => [s.root.id, s.replies]), [['m1', 1], ['m3', 0]]);
  assert.equal(room.seq, 8);
  assert.equal(readFileSync(h.fileOf('room:alpha')!, 'utf8').split('\n').filter(Boolean).length, 8);
});

test('reopening the directory replays the file; a torn last line is dropped; replay from a sequence number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-hist-'));
  const h1 = new History(dir, clock);
  const pc = h1.conversation('pc:u1:alpha');
  pc.append({ t: 'post', id: 'm1', by: { id: 'u1' }, text: 'hi' });
  pc.append({ t: 'post', id: 'm2', view: { kind: 'text', text: 'hello' }, visibleTo: 'u1' });
  appendFileSync(h1.fileOf('pc:u1:alpha')!, '{"t":"post","id":"m3","at":"2026');
  const h2 = new History(dir, clock);
  const again = h2.conversation('pc:u1:alpha');
  assert.deepEqual(again.all().map((m) => m.id), ['m1', 'm2']);
  assert.equal(again.seq, 2);
  assert.deepEqual(again.since(1).map((e) => e.seq), [2]);
  assert.deepEqual(again.since(0).map((e) => e.seq), [1, 2]);
  assert.deepEqual(again.since(2), []);
  // The next append continues the sequence after the torn line was ignored.
  assert.equal(again.append({ t: 'post', id: 'm4', view: { kind: 'line', text: 'x' } }).seq, 3);
});

test('listeners see every append; unsubscribing stops them', () => {
  const room = fresh().conversation('room:alpha');
  const seen: number[] = [];
  const off = room.subscribe((e) => seen.push(e.seq));
  room.append({ t: 'post', id: 'm1', text: 'a', by: { id: 'u1' } });
  off();
  room.append({ t: 'post', id: 'm2', text: 'b', by: { id: 'u1' } });
  assert.deepEqual(seen, [1]);
});

test('views round-trip through storage: question picks and picker projects', () => {
  const q: MessageView = { kind: 'question', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] as never, picks: new Map([[0, new Set([1])]]), multi: false, qid: 'q1', done: false };
  const stored = JSON.parse(JSON.stringify(toStored(q)));
  const back = fromStored(stored) as Extract<MessageView, { kind: 'question' }>;
  assert.deepEqual([...back.picks.get(0)!], [1]);
  const picker: MessageView = { kind: 'projectPicker', pid: 'p1', projects: [{ slug: 'alpha', repos: ['Org/alpha'], systemPrompt: 'long…' } as never] };
  assert.deepEqual(toStored(picker), { kind: 'projectPicker', pid: 'p1', projects: [{ slug: 'alpha', repos: ['Org/alpha'] }] });
});

test('a conversation the web does not own has no file; visibility is everyone or the one person', () => {
  const h = fresh();
  assert.equal(h.fileOf('C123'), undefined);
  assert.throws(() => h.conversation('C123'), /not a web conversation/);
  assert.ok(h.fileOf('pc:ann.lee@corp.example:alpha')!.endsWith('/alpha/pc-ann.lee@corp.example.jsonl'));
  assert.equal(visibleFor('u1', undefined), true);
  assert.equal(visibleFor('u1', 'u1'), true);
  assert.equal(visibleFor('u2', 'u1'), false);
});
