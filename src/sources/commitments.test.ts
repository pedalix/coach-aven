// Next steps → proposed commitments, ported from a tenant's extractor (2026-10-15). Recorder shapes as the store
// holds them: Granola "step (Owner)" + detail lines, Wispr "(Owner) step", Gemini "[Owner] step" then "Details".
// Names are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendeeNames, extractCommitments, parseNextSteps, subjectNames } from './commitments.js';
import { hash } from './attribution/fragment.js';

const granola = ['Stop the cron and coordinate the hotel migration with Nina (Olga)', 'Nina pings at 9:00 on the 14th; Olga stops the cron first.', 'Send the booking id mapping to Olga (Nina)', 'Include the old id for reference.', 'Obtain API access to the billing system', 'Needed to automate ticket reconciliation (2026).'];
const wispr = ['(Olga Owner) Stop the crons when the 9:00 ping arrives, then restart after the migration', '(Speaker 3) Ping at 9:00 and run the hotel migration script', 'no owner here'];
const gmeet = ['[Olga Owner] Share the review method: send the draft to Vera.', '[Vera Lindqvist] Review the method.', 'Details', '[Olga Owner] narrative after Details is ignored'];

test('parseNextSteps understands the three recorders and skips detail and narrative lines', () => {
  assert.deepEqual(parseNextSteps('granola', granola), [
    { text: 'Stop the cron and coordinate the hotel migration with Nina', owner: 'Olga' },
    { text: 'Send the booking id mapping to Olga', owner: 'Nina' },
  ]);
  assert.deepEqual(parseNextSteps('wispr', wispr).map((s) => s.owner), ['Olga Owner', 'Speaker 3']);
  assert.deepEqual(parseNextSteps('gmeet', gmeet).map((s) => s.owner), ['Olga Owner', 'Vera Lindqvist']);
});

test('extractCommitments: copies unioned, deduped by text; the subject by any of their names; `to` = the single other attendee; stable ids', () => {
  const names = subjectNames({ name: 'Olga Owner', identities: ['olga@home.example', 'slack:Olga Owner'] });
  assert.ok(names.has('olga') && names.has('olga owner') && names.has('olga@home.example') && names.has('me'));
  const call = { call_id: 'call:1', start: '2026-10-13T12:00:00Z', title: 'Sync', copies: [
    { source: 'granola', ref: 'granola:me:a', next_steps: granola, attendees: ['Olga Owner', 'Nina Lomb'] },
    { source: 'wispr', ref: 'wispr:me:b', next_steps: wispr, attendees: ['olga@home.example', 'Nina Lomb'] },
  ] };
  const rows = extractCommitments([call], names, 'olga-owner');
  assert.equal(rows.length, 4, 'two Granola steps and two Wispr steps with owners');
  const mine = rows.filter((r) => r.owner === 'olga-owner');
  assert.equal(mine.length, 2);
  assert.ok(mine.every((r) => r.to === 'nina-lomb'), 'exactly one other attendee — the subject\'s address is not "other"');
  assert.equal(rows.find((r) => r.owner === 'nina')!.to, null);
  assert.equal(rows.find((r) => r.owner === 'speaker-3')!.to, null);
  assert.ok(rows.every((r) => r.provenance.length === 2 && r.call === 'call:1'));
  assert.equal(mine[0]!.id, `c-${hash('call:1|stop the cron and coordinate the hotel migration with nina')}`, 'the tenant extractor\'s id');
  const twice = extractCommitments([{ ...call, copies: [call.copies[0]!, { ...call.copies[0]!, ref: 'granola:me:c' }] }], names, 'olga-owner');
  assert.equal(twice.length, 2, 'the same step from two copies is one row');
});

test('attendeeNames: names win, addresses when a recorder has none', () => {
  assert.deepEqual(attendeeNames(JSON.stringify([{ name: 'Olga Owner', email: 'olga@home.example' }, { email: 'nina@x.example' }, 'Nina Lomb'])), ['Olga Owner', 'Nina Lomb']);
  assert.deepEqual(attendeeNames(JSON.stringify([{ email: 'nina@x.example' }])), ['nina@x.example']);
  assert.deepEqual(attendeeNames('not json'), []);
});
