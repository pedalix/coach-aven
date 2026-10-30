// The identity collector, ported from a tenant's own (2026-10-15): parsing, matching and the merge/ask rules.
// Names are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystem, parseIdentity } from './normalise.js';
import { guessPeople, localTokens, verdict, type KnownPerson } from './match.js';
import { collectIdentities, type Observation } from './collect.js';
import { attendeeForms, attendeeObservations, isDirect, knownForms, parseAttendees } from './observations.js';

const people: KnownPerson[] = [
  { person_id: 'olga-owner', name: 'Olga Owner', identities: ['olga@home.example', 'Olga Owner'] },
  { person_id: 'chris-dorn', name: 'Chris Dorn', identities: ['Chris Dorn'] },
  { person_id: 'tess-north', name: 'Tess North', identities: ['tess.north@partner.example'] },
  { person_id: 'vera-lindqvist', name: 'Vera Lindqvist', identities: ['vera.lindqvist@home.example'] },
  { person_id: 'rory-maple', name: 'Rory Maple', identities: ['slack:Rory'] },
  { person_id: 'alma-c', name: 'Alma C', identities: [] },
  { person_id: 'arto-agapov', name: 'Arto Agapov', company: 'tools', identities: ['arto.agapov@tools.example'] },
  { person_id: 'nikolai-brandt', name: 'Nikolai Brandt', identities: [] },
  { person_id: 'niko', name: 'Niko', identities: [] },
];
const o = (raw: string, source: string, container: string, withSubject = true, thread: string | null = null): Observation => ({ raw, source, container, thread, withSubject });

test('parseIdentity: Graph, prefixed and opaque forms; diacritics folded', () => {
  assert.deepEqual(parseIdentity('Olga Owner | Acme <Olga.Owner@acme.example>'), { raw: 'Olga Owner | Acme <Olga.Owner@acme.example>', email: 'olga.owner@acme.example', name: 'olga owner', kind: 'email' });
  assert.equal(parseIdentity('slack:Rory').name, 'rory');
  assert.equal(parseIdentity('U03D1FXGTFZ').kind, 'opaque');
  assert.equal(parseIdentity('jira:557058:1cb1588c-6f1d-456f-8555-713fde3ef7c1').kind, 'opaque');
  assert.equal(parseIdentity('wrike:KUAB2C09').kind, 'opaque', 'an unresolved Wrike contact id is no one-word name');
  assert.deepEqual(parseIdentity('Mira Talbot <mira.talbot@studio.example>'), { raw: 'Mira Talbot <mira.talbot@studio.example>', email: 'mira.talbot@studio.example', name: 'mira talbot', kind: 'email' }, 'how a Wrike person arrives');
  assert.equal(parseIdentity('Jürgen Müller').name, 'jurgen muller');
  assert.ok(isSystem(parseIdentity('noreply@md.example')));
  assert.ok(isSystem(parseIdentity('Intercom Convert')));
  assert.ok(isSystem(parseIdentity('shop-webhook')));
  assert.ok(!isSystem(parseIdentity('Rory')));
});

test('matching: glued mailbox, initials, first names, nicknames, conflicts; the subject is never a guess', () => {
  const g = (raw: string) => guessPeople(parseIdentity(raw), people, 'olga-owner');
  assert.deepEqual(localTokens('rory.maple+x@mail.example'), ['rory', 'maple']);
  assert.deepEqual(g('rorymaple@mail.example').map((x) => [x.person_id, x.certainty]), [['rory-maple', 'certain']]);
  assert.deepEqual(g('alma.c@team.example').map((x) => [x.person_id, x.certainty]), [['alma-c', 'certain']]);
  assert.equal(g('Alma C.')[0]?.person_id, 'alma-c');
  assert.deepEqual(g('vera').map((x) => [x.person_id, x.certainty]), [['vera-lindqvist', 'first']]);
  assert.deepEqual(g('Olga Petrova'), [], 'the subject is excluded and nobody else is called Olga');
  assert.deepEqual(g('Gabi D.S.'), []);
  assert.deepEqual(g('rui.rosa@example.com vera lindqvist'), [], 'a mangled attendee field: the name belongs to someone else');
  assert.deepEqual(g('nikol').map((x) => x.person_id), ['nikolai-brandt', 'niko'], 'a prefix both ways is a question with both');
  assert.equal(verdict(g('arto@tools.example'), (pid) => pid === 'arto-agapov').kind, 'merge');
  assert.equal(verdict(g('arto@tools.example'), () => false).kind, 'ask');
});

test('collect: an exact identity is mapped; the same full name in another source merges; a first name alone is a yes/no; one-offs stay dormant', () => {
  const r = collectIdentities(people, [
    o('tess.north@partner.example', 'gmail', 'inbox'),
    o('Chris Dorn', 'slack', 'chat-x'),
    o('Chris Dorn | Dorn GmbH <chris.dorn@dorn.example>', 'msgraph', 'chat-x'),
    o('Vera', 'slack', 'dm:@vera'),
    o('Vera', 'slack', 'dm:@vera'),
    o('stranger@mail.example', 'gcal', 'evt9'),
    o('U02HT0SDRB4', 'slack', 'dm:U02HT0SDRB4'),
    o('Intercom Convert', 'slack', '#shop'),
  ], 'olga-owner');
  assert.deepEqual(r.merges, [{ person_id: 'chris-dorn', identity: 'chris.dorn@dorn.example', reason: 'same full name' }]);
  assert.equal(r.questions.length, 1);
  assert.deepEqual([r.questions[0]!.id, r.questions[0]!.question, r.questions[0]!.options[0], r.questions[0]!.seen], ['esc-identity-name-vera-yn', 'Is “vera” (slack) = Vera Lindqvist?', 'yes: vera-lindqvist', 2]);
  assert.deepEqual(r.counts, { mapped: 2, candidates: 3, dormant: 1, system: 1, unresolved: 1 });
});

test('collect: certain and domain merges; an unknown under five sightings is dormant; at five it is a "who is"; most-seen first, capped', () => {
  const n = (raw: string, source: string, container: string, k: number) => Array.from({ length: k }, () => o(raw, source, container));
  const r = collectIdentities(people, [
    ...n('rorymaple@mail.example', 'gcal', 'evt1', 3),
    ...n('arto@tools.example', 'gcal', 'evt2', 3),
    ...n('vera', 'slack', 'dm:@vera', 4),
    ...n('Bo Dommer', 'slack', 'mpdm-x', 4),
    ...n('Olga Petrova', 'slack', 'dm:@olga petrova', 6),
  ], 'olga-owner');
  assert.deepEqual(r.merges.map((m) => m.person_id).sort(), ['arto-agapov', 'rory-maple']);
  assert.deepEqual(r.questions.map((q) => q.id), ['esc-identity-name-olga-petrova', 'esc-identity-name-vera-yn'], 'six sightings before four');
  assert.equal(r.counts.dormant, 1, 'Bo Dommer: no match and only four sightings');
  const many: Observation[] = [];
  for (let i = 0; i < 5; i++) for (let k = 0; k <= i + 5; k++) many.push(o(`Person Number${i}`, 'slack', `dm:@p${i}`));
  const capped = collectIdentities(people, many, 'olga-owner', 2);
  assert.deepEqual(capped.questions.map((q) => q.seen), [10, 9]);
});

test('observations: attendee lists prefer addresses; a crowd is observed but never "with the subject"', () => {
  assert.deepEqual(parseAttendees(JSON.stringify([{ email: 'a@x.example', name: 'A' }, 'B', { name: 'C' }])), ['a@x.example', 'B', 'C']);
  // A glued name-only line that no known name covers is never a form to judge (it used to be dropped with every other
  // name-only entry; now only the glued remainder stays out — see the next test).
  assert.deepEqual(parseAttendees(JSON.stringify([{ email: '', name: 'ana berg rui rosa' }])), []);
  assert.ok(attendeeObservations(['a@x', 'b@x'], 'gcal', 'ev1').every((x) => x.withSubject));
  const crowd = attendeeObservations(Array.from({ length: 107 }, (_, i) => `p${i}@x`), 'gcal', 'webinar');
  assert.equal(crowd.length, 107);
  assert.ok(crowd.every((x) => !x.withSubject));
});

test('observations: name-only invitees are kept; a glued line gives every address and the known full names, the rest is co-occurrence only', () => {
  const known = knownForms(people);
  // Gemini and Wispr write an EMPTY email: the name is the identity (display form, company and parentheticals off).
  assert.deepEqual(attendeeForms([{ email: '', name: 'Tess North' }, { email: '', name: 'Bo Dommer | Dommer AG' }, { email: '', name: 'Ana Berg (External)' }], known), [{ raw: 'Tess North' }, { raw: 'Bo Dommer' }, { raw: 'Ana Berg' }]);
  assert.deepEqual(attendeeForms([{ name: 'Bo Dommer | Dommer AG' }], known), [{ raw: 'Bo Dommer | Dommer AG' }], 'no email at all was always kept, as stored');
  assert.deepEqual(attendeeForms([{ email: '', name: 'tess@partner.example' }], known), [{ raw: 'tess@partner.example' }], 'an address in the name field');
  // One person with an address: the stored address, as before.
  assert.deepEqual(attendeeForms([{ email: 'Tess.North@partner.example', name: 'Tess North' }, 'Rory <rory@mail.example>'], known), [{ raw: 'Tess.North@partner.example' }, { raw: 'Rory <rory@mail.example>' }]);
  // Glued chips split against the roster's full names (each observed as that person's own form); the unknown rest is kept apart.
  assert.deepEqual(attendeeForms([{ email: '', name: 'Chris Dorn Vera Lindqvist Bo Dommer' }], known), [{ raw: 'Chris Dorn' }, { raw: 'Vera Lindqvist' }, { raw: 'bo dommer', glued: true }]);
  // A line in the email field: every address (not only the first), then the names between them.
  assert.deepEqual(attendeeForms([{ email: 'olga@home.example nikolai brandt rui@x.example', name: '' }], known), [{ raw: 'olga@home.example' }, { raw: 'rui@x.example' }, { raw: 'Nikolai Brandt' }]);
  assert.deepEqual(attendeeForms('not json'), []);
  assert.deepEqual(knownForms([{ person_id: 'a', name: 'Ana Berg', identities: ['slack:Ana Berg', 'ana@x.example', 'Ana B'] }]).map((k) => k.names[0]), ['Ana Berg', 'Ana B'], 'one form per folded name, addresses never');
});

test('collect: a split full name merges as that person\'s name; a glued remainder is never asked or merged; group DMs are direct', () => {
  const obs = [
    ...attendeeObservations(attendeeForms([{ email: '', name: 'Nikolai Brandt Tess Norton' }], knownForms(people)), 'gmeet', 'doc1'),
    // seen with the subject many times, but only as the remainder of glued lines: still never a question
    ...Array.from({ length: 6 }, (_, i) => attendeeObservations(attendeeForms([{ email: '', name: 'Olga Owner Tess Norton Hal' }], knownForms(people)), 'gmeet', `doc${i + 2}`)).flat(),
  ];
  const r = collectIdentities(people, obs, 'olga-owner');
  assert.deepEqual(r.merges, [{ person_id: 'nikolai-brandt', identity: 'Nikolai Brandt', reason: 'same full name' }]);
  assert.deepEqual(r.questions, []);
  assert.equal(r.counts.unresolved, 2, 'two distinct glued remainders');
  assert.equal(r.counts.mapped, 1, 'the subject, split off the line');
  assert.ok(isDirect('mpim:@vera+@olga'), 'the store writes Slack group DMs as mpim:');
  const dm = collectIdentities(people, [o('Vera', 'slack', 'mpim:@vera+@olga')], 'olga-owner');
  assert.equal(dm.questions.length, 1, 'once in a group DM is enough for a yes/no');
});

test('collect: the subject\'s own full name is the subject, even unlisted — never a "who is <you>?"', () => {
  const roster: KnownPerson[] = [{ person_id: 'mia', name: 'Mia Maple', identities: ['mia@home.example'] }, { person_id: 'rui', name: 'Rui Rosa', identities: ['rui@x.example'] }];
  const seen = Array.from({ length: 6 }, (_, i) => attendeeObservations(attendeeForms([{ email: '', name: 'Mia Maple' }, { email: '', name: 'Rui Rosa' }]), 'gmeet', `doc${i}`)).flat();
  const r = collectIdentities(roster, seen, 'mia');
  assert.deepEqual([r.questions, r.counts.mapped], [[], 1]);
  assert.deepEqual(r.merges, [{ person_id: 'rui', identity: 'Rui Rosa', reason: 'same full name' }], 'anyone else\'s name still merges as before');
  assert.equal(collectIdentities(roster, [o('Mia', 'slack', 'dm:@mia')], 'mia').counts.mapped, 0, 'a first name alone is not the subject');
});
