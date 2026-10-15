// One attendee parser for every recorder shape, the glued-name splitter and the shared name fold. Names are fictional;
// the shapes are the ones the stores hold (W = a name word, E = an address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldName, foldTokens, GLUED_MIN_WORDS, parseAttendee, splitGlued } from './attendees.js';
import { normaliseName } from './normalise.js';
import { parseAttendees } from './observations.js';

test('foldName agrees with normaliseName on every case its tests cover', () => {
  const covered = ['Olga Owner | Acme <Olga.Owner@acme.example>', 'Olga Owner | Acme ', 'slack:Rory', 'Rory', 'Jürgen Müller', 'Intercom Convert', 'shop-webhook', 'Alma C.', 'Alma C', 'Gabi D.S.', 'vera lindqvist', 'Olga Petrova', 'nikol', 'Nikolai Brandt', 'Bo Dommer', 'Person Number0', 'Chris Dorn | Dorn GmbH ', 'Speaker 3', 'Olga', 'Nina Lomb', "Hana 'Hanni' Hill", 'Tess North', 'Arto Agapov', 'Rory Maple', ''];
  for (const s of covered) assert.equal(foldName(s), normaliseName(s), s);
});

test('foldName: German transliteration, letters NFKD keeps, parentheticals — the folds normaliseName lacks', () => {
  assert.equal(foldName('Juergen Mueller'), foldName('Jürgen Müller'));
  assert.equal(foldName('Schroeder'), foldName('Schröder'));
  assert.equal(foldName('Baecker'), foldName('Bäcker'));
  assert.equal(foldName('Strauss'), foldName('Strauß'));
  assert.equal(foldName('Bjorn Hoel'), foldName('Bjørn Høel'));
  assert.equal(foldName('Ana Berg (External)'), 'ana berg');
  assert.equal(foldName('Ana (Annie) Berg'), 'ana berg');
  assert.equal(foldName('Пётр Иванов'), normaliseName('Пётр Иванов'));
  // The documented trade-offs: "ue" after a vowel or q/g is no umlaut; a few names lose a letter on both sides.
  assert.equal(foldName('Bauer'), 'bauer');
  assert.equal(foldName('Miguel Enrique'), 'miguel enrique');
  assert.equal(foldName('Michael'), foldName('Michal'));
  assert.deepEqual(foldTokens('Anne-Marie B.'), ['anne', 'marie', 'b']);
  assert.deepEqual(foldTokens('ana@acme.example'), [], 'an address is not a name');
});

test('parseAttendee: structured pairs (Granola, Graph) are one person; a company suffix is not a name', () => {
  assert.deepEqual(parseAttendee({ email: 'Ana.Berg@Acme.example', name: 'Ana Berg' }), { emails: ['ana.berg@acme.example'], names: ['Ana Berg'], glued: false, raw: 'Ana Berg <ana.berg@acme.example>' });
  assert.deepEqual(parseAttendee({ email: 'ana.berg@acme.example', name: 'Ana Berg | Acme Holding Group' }).names, ['Ana Berg']);
  assert.deepEqual(parseAttendee({ emailAddress: { name: 'Rui Rosa', address: 'rui@partner.example' } }), { emails: ['rui@partner.example'], names: ['Rui Rosa'], glued: false, raw: 'Rui Rosa <rui@partner.example>' });
  assert.equal(parseAttendee({ email: 'maria@acme.example', name: 'Maria de la Cruz' }).glued, false, 'a long name with its own address is one person');
  assert.deepEqual(parseAttendee({ email: 'ana@acme.example' }), { emails: ['ana@acme.example'], names: [], glued: false, raw: 'ana@acme.example' });
});

test('parseAttendee: name-only entries (Gemini, Wispr) are kept — today `email ?? name` drops them', () => {
  const gemini = { email: '', name: 'Ana Berg' };
  assert.deepEqual(parseAttendees([gemini]), [], 'the current observation parser loses the name');
  assert.deepEqual(parseAttendee(gemini), { emails: [], names: ['Ana Berg'], glued: false, raw: 'Ana Berg' });
  assert.deepEqual(parseAttendee({ name: 'Ana Berg | Acme' }).names, ['Ana Berg'], 'Wispr "<First Last> | <Company>"');
  assert.equal(parseAttendee({ email: '', name: 'Ana Maria Berg' }).glued, false, 'three words stay one person');
  assert.equal(GLUED_MIN_WORDS, 4);
});

test('parseAttendee: Gemini glue — W W W W, and lines with addresses in the email field', () => {
  const p = (line: string, field: 'email' | 'name' = 'email') => parseAttendee(field === 'email' ? { email: line, name: '' } : { email: '', name: line });
  assert.deepEqual(p('Ana Berg Rui Rosa', 'name'), { emails: [], names: ['Ana Berg Rui Rosa'], glued: true, raw: 'Ana Berg Rui Rosa' }); // W W W W
  assert.deepEqual(p('ana berg rui@partner.example'), { emails: ['rui@partner.example'], names: ['ana berg'], glued: true, raw: 'ana berg rui@partner.example' }); // W W E
  assert.deepEqual(p('rui@partner.example ana berg').names, ['ana berg']); // E W W
  const ewwwwee = p('olga@home.example ana berg rui rosa tess@partner.example vera@home.example'); // E W W W W E E
  assert.deepEqual(ewwwwee.emails, ['olga@home.example', 'tess@partner.example', 'vera@home.example'], 'every address, not only the first');
  assert.deepEqual(ewwwwee.names, ['ana berg rui rosa']);
  assert.equal(ewwwwee.glued, true);
  assert.deepEqual(p('ana berg rui rosa tess@partner.example').names, ['ana berg rui rosa']); // W W W W E
  assert.deepEqual(p('ana berg a@x.example b@y.example rui rosa c@z.example').names, ['ana berg', 'rui rosa']); // W W E E W W E
  assert.deepEqual(p('ana berg a@x.example b@y.example c@z.example').emails.length, 3); // W W E E E
  assert.equal(p('tess@partner.example').glued, false, 'a single address is one person');
});

test('parseAttendee: plain strings — RFC display form, Teams company and parentheticals, separators, junk', () => {
  assert.deepEqual(parseAttendee('Ana Berg | Acme <ana.berg@acme.example>'), { emails: ['ana.berg@acme.example'], names: ['Ana Berg'], glued: false, raw: 'Ana Berg | Acme <ana.berg@acme.example>' });
  assert.deepEqual(parseAttendee('Ana Berg (External) <ana.berg@acme.example>').names, ['Ana Berg']);
  assert.deepEqual(parseAttendee('"Berg, Ana" <ana.berg@acme.example>'), { emails: ['ana.berg@acme.example'], names: ['Berg Ana'], glued: false, raw: '"Berg, Ana" <ana.berg@acme.example>' });
  const two = parseAttendee('Ana Berg | Acme <ana@acme.example> Rui Rosa | Partner <rui@partner.example>');
  assert.deepEqual([two.emails, two.names, two.glued], [['ana@acme.example', 'rui@partner.example'], ['Ana Berg', 'Rui Rosa'], true]);
  assert.deepEqual(parseAttendee('Ana Berg & Rui Rosa').names, ['Ana Berg', 'Rui Rosa']);
  assert.equal(parseAttendee('Ana Berg & Rui Rosa').glued, true);
  assert.deepEqual(parseAttendee('mailto:ana@acme.example'), { emails: ['ana@acme.example'], names: [], glued: false, raw: 'mailto:ana@acme.example' });
  for (const junk of [null, undefined, 42, '', '   ', {}, { email: '', name: '' }, [] as unknown]) assert.deepEqual(parseAttendee(junk), { emails: [], names: [], glued: false, raw: '' });
});

const known = [
  { person_id: 'olga-owner', names: ['Olga Owner'] },
  { person_id: 'ana-berg', names: ['Ana Berg', 'Ana'] },
  { person_id: 'rui-rosa', names: ['Rui Rosa'] },
  { person_id: 'juergen-mueller', names: ['Jürgen Müller'] },
  { person_id: 'maria-cruz', names: ['Maria de la Cruz', 'Maria'] },
  { person_id: 'mark-stone-a', names: ['Mark Stone'] },
  { person_id: 'mark-stone-b', names: ['Mark Stone'] },
];

test('splitGlued: greedy longest match on known full names; leftovers stay in rest, never guessed', () => {
  assert.deepEqual(splitGlued('Ana Berg Rui Rosa', known), { persons: ['ana-berg', 'rui-rosa'], rest: [] });
  assert.deepEqual(splitGlued('olga owner tess north', known), { persons: ['olga-owner'], rest: ['tess north'] });
  assert.deepEqual(splitGlued('tess north ana berg', known), { persons: ['ana-berg'], rest: ['tess north'] });
  assert.deepEqual(splitGlued('juergen mueller ana berg', known), { persons: ['juergen-mueller', 'ana-berg'], rest: [] }, 'transliteration folds');
  assert.deepEqual(splitGlued('Maria de la Cruz Rui Rosa', known), { persons: ['maria-cruz', 'rui-rosa'], rest: [] }, 'the longest known name wins');
  assert.deepEqual(splitGlued('ana rui rosa', known), { persons: ['rui-rosa'], rest: ['ana'] }, 'a first name alone is never a match');
  assert.deepEqual(splitGlued('mark stone ana berg', known), { persons: ['ana-berg'], rest: ['mark stone'] }, 'a full name two people share matches neither');
  assert.deepEqual(splitGlued('ana berz rui rosa', known), { persons: ['rui-rosa'], rest: ['ana berz'] }, 'no partial-token match');
  assert.deepEqual(splitGlued(['Ana', 'Berg', 'Ana', 'Berg'], known), { persons: ['ana-berg'], rest: [] }, 'tokens in; persons once');
  assert.deepEqual(splitGlued(['ana berg', 'x', 'rui rosa'], known), { persons: ['ana-berg', 'rui-rosa'], rest: ['x'] });
  assert.deepEqual(splitGlued('olga owner tess@partner.example ana berg', known), { persons: ['olga-owner', 'ana-berg'], rest: [] }, 'a whole stored line');
  assert.deepEqual(splitGlued('tess north a@x.example vera lind', known), { persons: [], rest: ['tess north', 'vera lind'] }, 'an address ends a leftover run');
  assert.deepEqual(splitGlued('', known), { persons: [], rest: [] });
  assert.deepEqual(splitGlued('ana berg', []), { persons: [], rest: ['ana berg'] });
});

test('a Gemini line end to end: every address plus the people in the glued run', () => {
  const p = parseAttendee({ email: 'olga@home.example ana berg rui rosa tess@partner.example', name: '' });
  assert.deepEqual(p.emails, ['olga@home.example', 'tess@partner.example']);
  const split = p.names.map((run) => splitGlued(run, known));
  assert.deepEqual(split, [{ persons: ['ana-berg', 'rui-rosa'], rest: [] }]);
});
