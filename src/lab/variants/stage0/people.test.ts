import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolver, containerForms, formKey, formKeys, isDirectContainer, type PersonLike } from './people.js';

// A fictional roster: one person known by address only, one by a Slack label, two who share a name.
const PEOPLE: PersonLike[] = [
  { person_id: 'ana-berg', name: 'Ana Berg', company: 'acme', identities: ['ana@acme.example'] },
  { person_id: 'rui-rosa', name: 'Rui Rosa', company: 'beta', identities: ['slack:Rui Rosa', 'youtrack:rrosa'] },
  { person_id: 'jo-muller', name: 'Jo Müller', identities: ['jo@gamma.example'] },
  { person_id: 'kim-lee-1', name: 'Kim Lee', identities: ['kim.lee@one.example'] },
  { person_id: 'kim-lee-2', name: 'Kim Lee', identities: ['kim.lee@two.example'] },
  { person_id: 'lena-vogt', name: 'Lena Vogt', identities: ['Lena Vogt'] },
];

test('formKey: prefixes off, login@ORG → login, <addr> wins, names folded', () => {
  assert.equal(formKey('slack:Rui Rosa'), 'rui rosa');
  assert.equal(formKey('youtrack:rrosa@ACMEORG'), 'rrosa');
  assert.equal(formKey('Ana Berg | Acme <Ana@Acme.Example>'), 'ana@acme.example');
  assert.equal(formKey('ANA@ACME.EXAMPLE'), 'ana@acme.example');
  assert.equal(formKey('Jo Mueller | Gamma'), formKey('Jo Müller'));
  assert.equal(formKey('JO MÜLLER'), formKey('jo muller'));
  assert.equal(formKey('@lena'), 'lena');
  assert.equal(formKey(''), '');
  assert.deepEqual(formKeys('Ana Berg <ana@acme.example>'), ['ana@acme.example', 'ana berg']);
});

test('one resolver: addresses, labels, the name as an implicit identity — a shared name resolves nobody', () => {
  const r = buildResolver(PEOPLE);
  assert.equal(r.resolve('ana@acme.example'), 'ana-berg');
  assert.equal(r.resolve('Ana Berg'), 'ana-berg'); // her name was never listed as an identity
  assert.equal(r.resolve('ana berg | Acme Hotels'), 'ana-berg');
  assert.equal(r.resolve('msgraph:Ana Berg'), 'ana-berg');
  assert.equal(r.resolve('Rui Rosa'), 'rui-rosa');
  assert.equal(r.resolve('youtrack:rrosa@ACMEORG'), 'rui-rosa');
  assert.equal(r.resolve('Jo Mueller'), 'jo-muller'); // folded: ü = ue
  assert.equal(r.resolve('Kim Lee'), null);
  assert.deepEqual(r.lookup('Kim Lee'), { pid: null, ambiguous: true });
  assert.equal(r.resolve('Kim Lee <kim.lee@two.example>'), 'kim-lee-2'); // the address settles it
  assert.equal(r.resolve('Nobody Known'), null);
  assert.equal(r.resolve(null), null);
});

test('an explicit identity beats another person’s implicit name', () => {
  const r = buildResolver([
    { person_id: 'a', name: 'Sam Field', identities: ['sam@one.example'] },
    { person_id: 'b', name: 'Sam F', identities: ['Sam Field'] },
  ]);
  assert.equal(r.resolve('Sam Field'), 'b');
});

test('attendee entries: structured pairs, name-only chips, glued runs split only on a full cover', () => {
  const r = buildResolver(PEOPLE);
  assert.deepEqual(r.attendee({ email: 'ana@acme.example', name: 'Ana Berg' }), ['ana-berg']);
  assert.deepEqual(r.attendee({ email: '', name: 'Rui Rosa' }), ['rui-rosa']); // production's `email ?? name` drops this
  assert.deepEqual(r.attendee({ email: '', name: 'Ana Berg Rui Rosa' }).sort(), ['ana-berg', 'rui-rosa']);
  // a glued run with a stranger in it: no full cover → nobody (never a partial guess)…
  assert.deepEqual(r.attendee({ email: '', name: 'Ana Berg Tom Hale' }), []);
  // …unless the linked event or the transcript names the stranger
  assert.deepEqual(r.attendee({ email: '', name: 'Ana Berg Tom Hale' }, ['Tom Hale']), ['ana-berg']);
  assert.deepEqual(r.attendee({ email: 'ana berg rui@x.example', name: '' }), ['ana-berg']);
  assert.deepEqual(r.attendee('Ana Berg | Acme <ana@acme.example>'), ['ana-berg']);
  assert.deepEqual(r.attendee({ email: '', name: 'Kim Lee' }), []);
});

test('container forms: DMs, Teams chats and group DMs (mpim counts as direct)', () => {
  assert.deepEqual(containerForms('mpim:@ana+@rui.rosa'), ['ana', 'rui.rosa']);
  assert.deepEqual(containerForms('chat:@Ana Berg | Acme'), ['Ana Berg | Acme']);
  assert.deepEqual(containerForms('dm:@U0ABCDEFGH1'), []);
  assert.deepEqual(containerForms('#general'), []);
  assert.equal(isDirectContainer('mpim:@ana+@rui'), true);
  assert.equal(isDirectContainer('#general'), false);
});
