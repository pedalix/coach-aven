import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pendingFromJournal, QueueJournal, type QueuedTurn } from './queuejournal.js';

const entry = (turnId: string, over: Partial<QueuedTurn> = {}): QueuedTurn => ({
  turnId,
  key: 'thread:1.2',
  slug: 'caldora',
  channel: 'C1',
  statusTs: '3.4',
  question: 'why is checkout slow?',
  plain: true,
  ...over,
});

test('pendingFromJournal — add minus done, in enqueue order', () => {
  const text = [
    JSON.stringify({ op: 'add', ...entry('ta-1') }),
    JSON.stringify({ op: 'add', ...entry('ta-2', { key: 'dm:D1:caldora' }) }),
    JSON.stringify({ op: 'add', ...entry('ta-3') }),
    JSON.stringify({ op: 'done', turnId: 'ta-2' }),
  ].join('\n');
  const pending = pendingFromJournal(text);
  assert.deepEqual(pending.map((p) => p.turnId), ['ta-1', 'ta-3']);
  assert.equal(pending[0].question, 'why is checkout slow?');
  assert.equal(pending[0].plain, true);
});

test('pendingFromJournal — tolerates torn lines, blanks, and unknown ops', () => {
  const text = [
    JSON.stringify({ op: 'add', ...entry('ta-1') }),
    '',
    '{"op":"add","turnId":"ta-2","key":"thr', // torn mid-append by a crash
    JSON.stringify({ op: 'compact', turnId: 'ta-1' }), // future op → ignored
    JSON.stringify({ op: 'done' }), // missing turnId → ignored
  ].join('\n');
  assert.deepEqual(pendingFromJournal(text).map((p) => p.turnId), ['ta-1']);
});

test('pendingFromJournal — a line from a release with dispatch (origin {slug, proposalId}) next to a normal one: no crash, nothing lost (retire-agent-dispatch)', () => {
  const text = [
    JSON.stringify({ op: 'add', ...entry('ta-old'), origin: { slug: 'owen-ops', proposalId: 'p-abc' } }),
    JSON.stringify({ op: 'add', ...entry('ta-new') }),
  ].join('\n');
  const out = pendingFromJournal(text);
  assert.deepEqual(out.map((e) => e.turnId), ['ta-old', 'ta-new']);
  assert.deepEqual(out[1], entry('ta-new'), 'the normal item comes back whole');
});

test('QueueJournal — add/done round-trip; drain truncates so nothing replays twice', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aven-queue-')), 'queue.jsonl');
  const j = new QueueJournal(path);
  j.add(entry('ta-1'));
  j.add(entry('ta-2', { plain: false }));
  j.done('ta-1');

  const pending = j.drain();
  assert.deepEqual(pending.map((p) => p.turnId), ['ta-2']);
  assert.equal(pending[0].plain, false);
  assert.equal(readFileSync(path, 'utf8'), ''); // truncated
  assert.deepEqual(j.drain(), []); // second boot sees nothing
});

test('QueueJournal — drain on a missing file is empty, not an error', () => {
  const j = new QueueJournal(join(mkdtempSync(join(tmpdir(), 'aven-queue-')), 'nope.jsonl'));
  assert.deepEqual(j.drain(), []);
});
