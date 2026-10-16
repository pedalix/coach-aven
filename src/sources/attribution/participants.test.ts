// Who was at a call: the attribution layer's one resolver, the calendar link, the speakers and the two loaders. Names
// and addresses are fictional; the attendee shapes are the ones recorders store (granola pairs, gemini name-only and
// glued lines, wispr names with a company).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store.js';
import { buildResolver, callParticipants, formKey, formKeys, indexEvents, linkedEvent, loadEvents, normTitle, recipientsOf, speakerLabels, type CalEvent, type PersonLike } from './participants.js';

const PEOPLE: PersonLike[] = [
  { person_id: 'olga-owner', name: 'Olga Owner', identities: ['olga@home.example', 'slack:Olga Owner'] },
  { person_id: 'ana-berg', name: 'Ana Berg', identities: ['ana@acme.example'] }, // her name is listed nowhere
  { person_id: 'rui-rosa', name: 'Rui Rosa', identities: ['slack:Rui Rosa', 'youtrack:rrosa@ACMEORG'] },
  { person_id: 'jo-muller', name: 'Jo Müller', identities: ['jo@gamma.example'] },
  { person_id: 'kim-lee-1', name: 'Kim Lee', identities: ['kim.lee@one.example'] },
  { person_id: 'kim-lee-2', name: 'Kim Lee', identities: ['kim.lee@two.example'] },
];
const R = buildResolver(PEOPLE);

test('formKey: prefixes off, a tracker login@ORG is its login, <addr> wins, names folded', () => {
  assert.equal(formKey('slack:Rui Rosa'), 'rui rosa');
  assert.equal(formKey('youtrack:rrosa@ACMEORG'), 'rrosa');
  assert.equal(formKey('Ana Berg | Acme <Ana@Acme.Example>'), 'ana@acme.example');
  assert.equal(formKey('ANA@ACME.EXAMPLE'), 'ana@acme.example');
  assert.equal(formKey('Jo Mueller | Gamma'), formKey('Jo Müller'));
  assert.equal(formKey('@ana'), 'ana');
  assert.equal(formKey(''), '');
  assert.deepEqual(formKeys('Ana Berg <ana@acme.example>'), ['ana@acme.example', 'ana berg']);
  assert.deepEqual(formKeys('  '), []);
});

test('resolver: addresses, labels, a person\'s name as an implicit identity — a name two people share resolves nobody', () => {
  assert.equal(R.resolve('ana@acme.example'), 'ana-berg');
  assert.equal(R.resolve('Ana Berg'), 'ana-berg', 'the name was never listed as an identity');
  assert.equal(R.resolve('ana berg | Acme Hotels'), 'ana-berg');
  assert.equal(R.resolve('msgraph:Ana Berg'), 'ana-berg');
  assert.equal(R.resolve('Rui Rosa'), 'rui-rosa');
  assert.equal(R.resolve('Jo Mueller'), 'jo-muller', 'folded: ü = ue');
  assert.equal(R.resolve('Kim Lee'), null, 'two people are called Kim Lee');
  assert.equal(R.resolve('Kim Lee <kim.lee@two.example>'), 'kim-lee-2', 'the address settles it');
  assert.equal(R.resolve('Nobody Known'), null);
  assert.equal(R.resolve(null), null);
  // an explicit identity beats another person's name
  const r = buildResolver([{ person_id: 'a', name: 'Sam Field', identities: ['sam@one.example'] }, { person_id: 'b', name: 'Sam F', identities: ['Sam Field'] }]);
  assert.equal(r.resolve('Sam Field'), 'b');
});

test('resolver: the store\'s exact index is asked first — nothing it resolves moves, even where folding collides', () => {
  const people = [{ person_id: 'a', name: 'Lena Muller', identities: ['Lena Müller'] }, { person_id: 'b', name: 'Lena Mueller', identities: ['Lena Muller'] }];
  assert.equal(buildResolver(people).resolve('Lena Müller'), null, 'folded, the two identities collide');
  const exact = new Map([['lena müller', 'a'], ['lena muller', 'b']]);
  assert.equal(buildResolver(people, exact).resolve('Lena Müller'), 'a');
  assert.equal(buildResolver(people, exact).resolve('lena muller'), 'b');
});

test('attendee: one person by address, else by name; name-only and company-suffixed entries are kept', () => {
  assert.deepEqual(R.attendee({ email: 'ana@acme.example', name: 'Ana Berg' }), ['ana-berg']);
  assert.deepEqual(R.attendee({ email: 'ana.b@elsewhere.example', name: 'Ana Berg' }), ['ana-berg'], 'an unknown address: the name decides');
  assert.deepEqual(R.attendee({ email: '', name: 'Rui Rosa' }), ['rui-rosa'], 'gemini name-only — `email ?? name` dropped it');
  assert.deepEqual(R.attendee({ name: 'Rui Rosa | Partner AG' }), ['rui-rosa'], 'wispr');
  assert.deepEqual(R.attendee('Ana Berg | Acme <ana@acme.example>'), ['ana-berg']);
  assert.deepEqual(R.attendee({ email: '', name: 'Tess North' }), [], 'an unknown person');
  assert.deepEqual(R.attendee(null), []);
});

test('attendee: a glued line splits against the known names and counts only when the split covers all of it', () => {
  assert.deepEqual(R.attendee({ email: '', name: 'Ana Berg Rui Rosa' }).sort(), ['ana-berg', 'rui-rosa']);
  assert.deepEqual(R.attendee({ email: 'olga@home.example ana berg rui rosa tess@partner.example', name: '' }).sort(), ['ana-berg', 'olga-owner', 'rui-rosa'], 'every address, then the names between them');
  assert.deepEqual(R.attendee({ email: '', name: 'Ana Berg Tess North' }), [], 'a partial cover resolves nobody');
  // the linked event's attendees and the speakers fill the gap — and a cover name that IS a roster name changes nothing
  assert.deepEqual(R.attendee({ email: '', name: 'Ana Berg Tess North' }, ['Tess North']), ['ana-berg']);
  assert.deepEqual(R.attendee({ email: '', name: 'Ana Berg Tess North' }, ['Ana Berg', 'Tess North <tess@partner.example>']), ['ana-berg']);
  assert.deepEqual(R.attendee({ email: '', name: 'Kim Lee Ana Berg' }, ['Kim Lee']), [], 'a name two people share covers nothing');
  assert.deepEqual(R.attendee({ email: '', name: 'Ana Berg & Rui Rosa' }).sort(), ['ana-berg', 'rui-rosa']);
});

test('speakerLabels: distinct "Name:" labels; timestamps, URLs and long phrases are not speakers', () => {
  const t = ['Ana Berg: morning', 'Rui Rosa: hi', 'Ana Berg: so', '00:01:02 Rui: later', 'https://x.example: link', 'The plan for the next quarter: fine', 'Me: ok', '', '  Speaker 3: yes'].join('\n');
  assert.deepEqual(speakerLabels(t), ['Ana Berg', 'Rui Rosa', 'Me', 'Speaker 3']);
  assert.deepEqual(speakerLabels(t, 2), ['Ana Berg', 'Rui Rosa']);
  assert.deepEqual(speakerLabels(null), []);
});

const ev = (title: string, start: string, attendees: string[] = [], organizer = ''): CalEvent => ({ title, start, attendees, organizer });

test('linkedEvent: the same normalised title within ±15 min, the closest one; all-day events never link', () => {
  assert.equal(normTitle('  Weekly Sync — Acme! '), 'weekly sync acme');
  const events = indexEvents([ev('Weekly sync | Acme', '2026-10-08T09:50:00Z', ['a']), ev('Weekly sync | Acme', '2026-10-08T10:05:00+00:00', ['b']), ev('Other', '2026-10-08T10:00:00Z'), ev('Weekly sync - Acme', '2026-10-08')]);
  assert.deepEqual(linkedEvent({ title: 'weekly sync acme', start: '2026-10-08T10:02:00Z' }, events)?.attendees, ['b'], 'the closer of two');
  assert.equal(linkedEvent({ title: 'Weekly sync acme', start: '2026-10-08T10:21:00Z' }, events), null, '16 minutes away');
  assert.equal(linkedEvent({ title: 'Weekly sync acme', start: '2026-10-08T00:00:00Z' }, events), null, 'the all-day event');
  assert.equal(linkedEvent({ title: 'Something else', start: '2026-10-08T10:00:00Z' }, events), null);
  assert.equal(linkedEvent({ title: 'Weekly sync acme', start: 'not a date' }, events), null);
});

test('callParticipants: attendees ∪ the event\'s attendees and organiser ∪ the speakers', () => {
  const event = ev('Sync', '2026-10-08T10:00:00Z', ['jo@gamma.example', 'stranger@x.example'], 'olga@home.example');
  assert.deepEqual(callParticipants({ attendees: [{ email: 'olga@home.example', name: 'Olga Owner' }], speakers: ['Me', 'Them'] }, null, R), ['olga-owner'], 'granola: the subject alone');
  assert.deepEqual(callParticipants({ attendees: [{ email: 'olga@home.example', name: 'Olga Owner' }], speakers: ['Me', 'Rui Rosa'] }, event, R).sort(), ['jo-muller', 'olga-owner', 'rui-rosa']);
  // the event's names and the speakers cover a glued run the roster alone cannot
  assert.deepEqual(callParticipants({ attendees: [{ email: '', name: 'Ana Berg Tess North' }], speakers: ['Tess North'] }, null, R), ['ana-berg']);
});

test('callParticipants: a crowd event (an all-hands: more than MASS_ATTENDEES invitees) adds nobody and covers no glued run', () => {
  const invitees = (n: number) => ['jo@gamma.example', ...Array.from({ length: n - 1 }, (_, i) => `guest${i}@x.example`)];
  const granola = { attendees: [{ email: 'olga@home.example', name: 'Olga Owner' }], speakers: [] as string[] };
  assert.deepEqual(callParticipants(granola, ev('All hands', '2026-10-08T10:00:00Z', invitees(7), 'olga@home.example'), R).sort(), ['jo-muller', 'olga-owner'], 'seven invitees and the organiser: a meeting');
  assert.deepEqual(callParticipants(granola, ev('All hands', '2026-10-08T10:00:00Z', invitees(8), 'olga@home.example'), R), ['olga-owner'], 'nine people: a crowd');
  assert.deepEqual(callParticipants(granola, ev('All hands', '2026-10-08T10:00:00Z', invitees(30), 'olga@home.example'), R), ['olga-owner'], 'thirty: nobody from the event');
  assert.deepEqual(callParticipants({ attendees: [{ email: '', name: 'Ana Berg Tess North' }], speakers: [] }, ev('All hands', '2026-10-08T10:00:00Z', [...invitees(29), 'Tess North <tess@partner.example>']), R), [], 'its names fill no gap');
});

test('loaders: events around the window (a day of margin for zone offsets); recipients are message_people \'to\'', () => {
  const db = openStore(':memory:');
  try {
    const ins = db.prepare('INSERT INTO events(ref, source, account, start, title, attendees, organizer) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run('gcal:me:1', 'gcal', 'me', '2026-10-08T10:00:00+02:00', 'Sync', JSON.stringify(['ana@acme.example', 7]), 'olga@home.example');
    ins.run('gcal:me:2', 'gcal', 'me', '2026-09-20T10:00:00Z', 'Old', '[]', '');
    ins.run('gcal:me:3', 'gcal', 'me', '2026-10-07T23:30:00-01:00', 'Late', 'not json', '');
    assert.deepEqual(loadEvents(db, '2026-10-08', '2026-10-09').map((e) => [e.title, e.attendees]), [['Late', []], ['Sync', ['ana@acme.example']]]);
    db.prepare('INSERT INTO message_people(ref, person_id, role) VALUES (?, ?, ?)').run('slack:T/D1/1', 'olga-owner', 'from');
    db.prepare('INSERT INTO message_people(ref, person_id, role) VALUES (?, ?, ?)').run('slack:T/D1/1', 'rui-rosa', 'to');
    db.prepare('INSERT INTO message_people(ref, person_id, role) VALUES (?, ?, ?)').run('slack:T/D1/1', 'ana-berg', 'to');
    const to = recipientsOf(db);
    assert.deepEqual(to('slack:T/D1/1'), ['ana-berg', 'rui-rosa']);
    assert.deepEqual(to('slack:T/D1/2'), []);
  } finally {
    db.close();
  }
});
