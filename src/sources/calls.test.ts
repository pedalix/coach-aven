import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterMeetings, overlapShare, type MeetingForCall } from './calls.js';

const m = (ref: string, source: string, start: string, end: string, extra: Partial<MeetingForCall> = {}): MeetingForCall => ({
  ref,
  source,
  title: '',
  start,
  end,
  attendees: [],
  transcriptChars: 0,
  summaryChars: 0,
  ...extra,
});

test('overlapShare is relative to the shorter window', () => {
  assert.equal(overlapShare({ s: 0, e: 100 }, { s: 50, e: 60 }), 1);
  assert.equal(overlapShare({ s: 0, e: 100 }, { s: 100, e: 200 }), 0);
  assert.equal(overlapShare({ s: 0, e: 100 }, { s: 40, e: 140 }), 0.6);
});

test('two copies of one call merge; primary = longest transcript', () => {
  const calls = clusterMeetings([
    m('g1', 'granola', '2026-10-08T17:07:00Z', '2026-10-08T17:52:00Z', { transcriptChars: 900, title: 'FO Cloud incident' }),
    m('w1', 'wispr', '2026-10-08T17:08:30Z', '2026-10-08T17:50:00Z', { transcriptChars: 4000, title: 'Instant meeting' }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.primary_ref, 'w1');
  assert.equal(calls[0]!.call_id, 'call:g1');
  assert.equal(calls[0]!.title, 'FO Cloud incident', 'a real title beats the primary copy\'s placeholder');
  assert.deepEqual(calls[0]!.sources.map((s) => s.source), ['granola', 'wispr']);
});

test('three recorders on one call become one call; gmeet without end still joins', () => {
  const calls = clusterMeetings([
    m('g', 'granola', '2026-10-07T07:11:00Z', '2026-10-07T07:27:00Z', { summaryChars: 800 }),
    m('w', 'wispr', '2026-10-07T07:11:40Z', '2026-10-07T07:26:40Z', { summaryChars: 500 }),
    m('mt', 'gmeet', '2026-10-07T07:10:00Z', '', { summaryChars: 300 }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sources.length, 3);
  assert.equal(calls[0]!.primary_ref, 'g'); // no transcripts → richest summary
});

test('back-to-back calls from the same recorder are not merged', () => {
  const calls = clusterMeetings([
    m('a', 'granola', '2026-10-05T06:02:00Z', '2026-10-05T07:00:00Z'),
    m('b', 'granola', '2026-10-05T06:58:00Z', '2026-10-05T07:30:00Z'),
  ]);
  assert.equal(calls.length, 2);
});

test('a short side recording inside a long call joins it', () => {
  const calls = clusterMeetings([
    m('long', 'granola', '2026-10-06T09:00:00Z', '2026-10-06T11:00:00Z'),
    m('short', 'wispr', '2026-10-06T10:00:00Z', '2026-10-06T10:20:00Z'),
  ]);
  assert.equal(calls.length, 1);
});

test('several overlapping candidates: attendees decide', () => {
  const calls = clusterMeetings([
    m('g1', 'granola', '2026-10-06T09:00:00Z', '2026-10-06T10:00:00Z', { attendees: ['tobin@x.com'] }),
    m('m1', 'gmeet', '2026-10-06T09:05:00Z', '2026-10-06T10:00:00Z', { attendees: ['haki@y.com'] }),
    m('w1', 'wispr', '2026-10-06T09:10:00Z', '2026-10-06T09:50:00Z', { attendees: ['Tobin@x.com'] }),
  ]);
  const withW = calls.find((c) => c.sources.some((s) => s.ref === 'w1'))!;
  assert.ok(withW.sources.some((s) => s.ref === 'g1'));
});

test('unparseable start stays its own call', () => {
  const calls = clusterMeetings([m('x', 'gmeet', '', '')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.primary_ref, 'x');
});
