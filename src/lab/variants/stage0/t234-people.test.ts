// Stage 0 T3: the one resolver and its graded rungs. A fictional roster; every name and domain is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Person } from '../../../sources/people.js';
import { formKey, identityForm, resolveMention, roster, translit } from './t234-people.js';

const people: Person[] = [
  { person_id: 'lena-park', name: 'Lena Park', identities: ['lena@acme.example', 'slack:Lena Park'] },
  { person_id: 'jurg-muller', name: 'Jürg Müller', identities: ['jurg@globex.example'] },
  { person_id: 'omar-haddad', name: 'Omar Haddad', identities: ['omar.h@initech.example', 'youtrack:ohaddad'] },
  { person_id: 'nina', name: 'Nina', identities: ['nina@acme.example'] },
  { person_id: 'tomas-berg', name: 'Tomas Berg', identities: ['tomas@acme.example'] },
  { person_id: 'tomas-vale', name: 'Tomas Vale', identities: ['tvale@umbrella.example'] },
  { person_id: 'kim-roe-1', name: 'Kim Roe', identities: ['kim1@acme.example'] },
  { person_id: 'kim-roe-2', name: 'Kim Roe', identities: ['kim2@globex.example'] },
];
const R = roster(people);
const r = (raw: string, ctx = {}) => resolveMention(R, raw, ctx);

test('identityForm and formKey: prefixes off, tracker logins without their org, addresses kept, names folded', () => {
  assert.equal(identityForm('youtrack:OHaddad@ACME'), 'ohaddad');
  assert.equal(identityForm('slack:Lena Park'), 'lena park');
  assert.equal(formKey('Jürg  Müller'), 'jurg muller');
  assert.equal(formKey('Lena@Acme.example'), 'lena@acme.example');
});

test('exact folded identity .99, the address inside "Name <addr>" .99, a plus-address .97', () => {
  assert.deepEqual([r('LENA@acme.example').label, r('LENA@acme.example').conf, r('LENA@acme.example').rung], ['lena-park', 0.99, 'exact']);
  assert.equal(r('slack:Lena Park').label, 'lena-park');
  assert.equal(r('youtrack:ohaddad@INITECH').label, 'omar-haddad', 'login@ORG → login');
  const addr = r('Someone Else <jurg@globex.example>');
  assert.deepEqual([addr.label, addr.conf, addr.rung], ['jurg-muller', 0.99, 'addr']);
  const plus = r('lena+billing@acme.example');
  assert.deepEqual([plus.label, plus.conf, plus.rung], ['lena-park', 0.97, 'plus']);
});

test('the name as an identity .97 (folded, "| Company" off); swapped .95; a handle .95; a shared name decides nothing', () => {
  const name = r('Jurg Mueller | Globex');
  assert.deepEqual([name.label, name.conf, name.rung], ['jurg-muller', 0.97, 'name']);
  assert.equal(r('Omar Haddad (External)').label, 'omar-haddad');
  const swapped = r('Haddad, Omar');
  assert.deepEqual([swapped.label, swapped.conf, swapped.rung], ['omar-haddad', 0.95, 'name:swapped']);
  assert.deepEqual([r('omar.haddad').label, r('omar.haddad').rung], ['omar-haddad', 'name:handle']);
  assert.equal(r('omar_haddad').label, 'omar-haddad', 'an underscore is a space to the attendee parser');
  const kim = r('Kim Roe');
  assert.equal(kim.label, null);
  assert.equal(kim.rung, 'ambiguous');
  assert.deepEqual(kim.candidates.sort(), ['kim-roe-1', 'kim-roe-2']);
});

test('a mailbox that spells a roster name .95; a first-name mailbox .95 at the person’s own domain, .85 elsewhere', () => {
  assert.deepEqual([r('lena.park@newco.example').label, r('lena.park@newco.example').conf, r('lena.park@newco.example').rung], ['lena-park', 0.95, 'mailbox']);
  assert.equal(r('lpark@newco.example').label, 'lena-park');
  assert.equal(r('park.lena@newco.example').label, 'lena-park');
  assert.equal(r('nina@other.example').label, 'nina', 'a one-word name is a full name');
  const own = r('omar@initech.example');
  assert.deepEqual([own.label, own.conf, own.rung], ['omar-haddad', 0.95, 'mailbox:first']);
  const away = r('omar@elsewhere.example');
  assert.deepEqual([away.label, away.conf], ['omar-haddad', 0.85]);
  assert.equal(r('tomas@newco.example').label, null, 'two Tomases: no first-name mailbox');
  assert.equal(r('zed@nowhere.example').label, null);
});

test('a glued line: a full cover decides (.95 when every person is in the linked event, else .90); a partial one asks', () => {
  const glued = r('Lena Park Omar Haddad');
  assert.deepEqual([glued.label, glued.conf, glued.rung], ['lena-park+omar-haddad', 0.9, 'glued']);
  assert.deepEqual(glued.split, ['lena-park', 'omar-haddad']);
  const seen = r('Lena Park Omar Haddad', { eventPeople: new Set(['lena-park', 'omar-haddad']) });
  assert.deepEqual([seen.conf, seen.rung], [0.95, 'glued:event']);
  const withMail = r('lena park jurg@globex.example');
  assert.equal(withMail.label, 'jurg-muller+lena-park', 'an address glued to a name: both resolve');
  const partial = r('Lena Park Zed Zorn Ivo');
  assert.equal(partial.label, null);
  assert.equal(partial.rung, 'glued:partial');
  assert.deepEqual(partial.candidates, ['lena-park']);
});

test('a first name alone .85 only when exactly one present person carries it', () => {
  const t = r('Tomas', { coPresent: new Set(['tomas-vale', 'lena-park']) });
  assert.deepEqual([t.label, t.conf, t.rung], ['tomas-vale', 0.85, 'first']);
  assert.equal(r('Tomas').label, null, 'nobody present: a question');
  assert.equal(r('Tomas').rung, 'first:ambiguous');
  assert.deepEqual([r('Omar').label, r('Omar').rung, r('Omar').candidates], [null, 'first:absent', ['omar-haddad']]);
  assert.deepEqual(r('Tomas').candidates.sort(), ['tomas-berg', 'tomas-vale']);
  assert.equal(r('Tomas B.', { coPresent: new Set(['tomas-berg', 'tomas-vale']) }).label, 'tomas-berg', 'the initial picks the surname');
});

test('a tracker login that spells a name .95; Cyrillic transliterated; a typo of a roster name is a .85 guess', () => {
  const login = r('youtrack:lpark@ACME');
  assert.deepEqual([login.label, login.conf, login.rung], ['lena-park', 0.95, 'login']);
  assert.equal(r('youtrack:ohaddad').label, 'omar-haddad', 'an exact identity first');
  assert.equal(translit('Лена Парк'), 'Lena Park');
  assert.deepEqual([r('Лена Парк').label, r('Лена Парк').rung], ['lena-park', 'name']);
  assert.deepEqual([r('Lnea Park').label, r('Lnea Park').rung], ['lena-park', 'name:fuzzy'], 'a swap of two letters is one edit');
  assert.equal(r('Ana Park').label, null, 'a first name under four letters is no basis for a guess');
  const typo2 = r('Tomsa Berg');
  assert.deepEqual([typo2.label, typo2.conf, typo2.rung], ['tomas-berg', 0.85, 'name:fuzzy']);
  assert.equal(r('Tomas Bergman').label, null, 'another surname is another person');
});
