// The ladder's stage-0 fixes (F1 admin, F2 short titles, F6 channels and work keys, F7 broad people, F12 graded
// confidences) on a fictional agency tenant — the ported half of the lab's stage-0 floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FragmentDraft } from './fragment.js';
import { adminWord, attribute, RUNG_CONF, type LadderCtx, type MarkedPerson } from './ladder.js';
import { parseRegistry, Registry } from './registry.js';

const reg = new Registry(parseRegistry({
  initiatives: [
    { id: 'acme/shop', umbrella: 'acme', sources: { repos: ['github.com/agency/acme-*'], youtrack_prefixes: ['SHOP'], slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }], calendar_title_patterns: ['ART', 'Checkout review'] } },
    { id: 'acme/retainer', umbrella: 'acme', sources: { repos: ['github.com/agency/acme-*'], youtrack_prefixes: ['SUP'], slack_channels: ['#ext-acme', '#acme-support'] } },
    { id: 'acme/admin', umbrella: 'acme', sources: {} },
    { id: 'globex/portal', umbrella: 'globex', sources: { jira_keys: ['GP'], local_paths: ['/work/globex'] } },
    { id: 'globex/admin', umbrella: 'globex', sources: {} },
  ],
}));
const P = (person_id: string, type: MarkedPerson['marker']['type'], initiatives: string[]): MarkedPerson => ({ person_id, name: person_id[0]!.toUpperCase() + person_id.slice(1), marker: { type, initiatives } });
const people = new Map([P('me', 'broad', []), P('eve', 'exclusive', ['globex/portal']), P('ivo', 'exclusive', ['acme/shop']), P('ana', 'narrow', ['acme/shop', 'acme/retainer']), P('bob', 'broad', ['acme/shop', 'globex/portal']), P('kim', 'broad', [])].map((p) => [p.person_id, p]));
const admin = { acme: 'acme/admin', globex: 'globex/admin' };
const ctx = (over: Partial<LadderCtx> = {}): LadderCtx => ({ rules: [], people, reg, self: 'me', admin, ...over });
const draft = (over: Partial<FragmentDraft>): FragmentDraft => ({ id: 'f1', kind: 'thread', start: '2026-10-08T10:00:00Z', end: '2026-10-08T10:30:00Z', refs: ['slack:T0TEAM0001:C0OTHER001:1'], title: 't', source: 'slack', container: null, participants: ['me'], projectKeys: [], repo: null, weight: 1, ...over });
const top = (f: FragmentDraft, c = ctx()) => {
  const r = attribute(f, c);
  return r.decided ? [r.decided.attributions[0]!.initiative, r.decided.rule_id, r.decided.conf] : [null, r.candidates, r.hint];
};

test('F1: admin words match whole words only, EN/DE/RU/IT — the substrings that decided wrongly no longer fire', () => {
  for (const miss of [
    'a private repo', 'fix the syntax', 'it is advisable', 'taxi to the airport', 'the contractor fixed it', 'innovation and activation', 'the taxonomy',
    'two disagreements', 'a reservation', 'built in SwiftUI', 'Steuerung der Pumpe', 'zeitgesteuert', 'das Steuergerät', 'Preisberechnung', 'Währungsumrechnung',
    'Aufenthalt in Bern', 'мы договорились', 'чеклист релиза', 'обновил чек-лист', 'аналогично', 'насчёт релиза', 'по счётчикам', 'расчёт сроков', 'визит клиента',
  ]) assert.equal(adminWord(miss), null, miss);
  for (const [hit, word] of [
    ['VAT for Q3', 'VAT'], ['the invoices are late', 'invoices'], ['still unpaid', 'unpaid'], ['send the NDA', 'NDA'],
    ['Rechnung Oktober', 'Rechnung'], ['die Lohnabrechnung', 'Lohnabrechnung'], ['Kreditkartenabrechnung fehlt', 'Kreditkartenabrechnung'], ['die Schlussrechnung', 'Schlussrechnung'],
    ['Bezahlung offen', 'Bezahlung'], ['neuer Rahmenvertrag', 'Rahmenvertrag'], ['die Umsatzsteuer', 'Umsatzsteuer'], ['zum Vorsteuerabzug', 'Vorsteuerabzug'], ['inkl. MwSt.', 'MwSt'],
    ['оплата прошла', 'оплата'], ['нужна предоплата', 'предоплата'], ['подписали договор', 'договор'], ['чек за такси', 'чек'], ['счёт-фактура', 'счёт-фактура'], ['налоговая', 'налоговая'],
    ['la fattura di ottobre', 'fattura'],
  ]) assert.equal(adminWord(hit), word, hit);
});

test('F1: the admin rung runs after exclusive markers and the registry; alone it still decides (.75) or narrows to the buckets', () => {
  const invoice = { text: 'please send the invoice for October' };
  assert.deepEqual(top(draft({ ...invoice, participants: ['me', 'eve'] })), ['globex/portal', 'marker:eve', RUNG_CONF.exclusive], 'an exclusive person outranks one word');
  assert.deepEqual(top(draft({ ...invoice, container: '#acme-support', participants: ['me', 'ana'] })), ['acme/retainer', 'registry:channel', RUNG_CONF.channel]);
  assert.deepEqual(top(draft({ ...invoice, projectKeys: ['GP'], participants: ['me', 'ana'] })), ['globex/portal', 'registry:key', RUNG_CONF.key]);
  const alone = attribute(draft({ ...invoice, participants: ['me', 'ana'] }), ctx()).decided!;
  assert.deepEqual([alone.attributions, alone.rule_id, alone.conf], [[{ initiative: 'acme/admin', share: 1 }], 'admin', RUNG_CONF.admin]);
  assert.match(alone.rationale, /^admin chatter \("invoice"\) with Ana$/);
  assert.deepEqual(top(draft({ ...invoice, participants: ['me', 'ana', 'bob'] })), [null, ['acme/admin', 'globex/admin'], 'admin chatter, umbrella unclear']);
  assert.deepEqual(top(draft({ text: 'a private repo for the shop', participants: ['me', 'ana'] }))[0], null, 'the "private" bug');
  assert.equal(top(draft({ kind: 'call', title: 'Contract renewal', refs: ['meeting:granola:n1'], participants: ['me', 'ana'] }))[1], 'admin', 'a call by its title');
});

test('F2 + F12: one short title pattern decides only as a whole word, at .80; a repo route at .99, a rule at .97', () => {
  const call = (title: string) => draft({ kind: 'call', title, refs: ['meeting:granola:n1'] });
  assert.deepEqual(top(call('ART weekly — Topic')), ['acme/shop', 'registry:title', RUNG_CONF.title]);
  assert.deepEqual(top(call('Karte und Plan')), [null, [], 'no signals']);
  assert.deepEqual(top(draft({ kind: 'work', container: '/work/globex/api', route: reg.routePath('/work/globex/api') })), ['globex/portal', 'registry:repo/path', RUNG_CONF.repo]);
  assert.deepEqual(top(draft({ container: '#acme-support' }), ctx({ rules: [{ id: 'r1', when: { container: '#ACME-support' }, then: { initiative: 'acme/shop' } }] })), ['acme/shop', 'r1', RUNG_CONF.rule]);
});

test('F6: a renamed channel routes by the id in its refs; a shared channel gives candidates instead of falling through', () => {
  assert.deepEqual(top(draft({ container: '#acme-renamed', refs: ['slack:T0TEAM0001:C0SHOP0001:1'] })), ['acme/shop', 'registry:channel', RUNG_CONF.channel]);
  const shared = attribute(draft({ container: '#ext-acme' }), ctx());
  assert.equal(shared.decided, null);
  assert.deepEqual(shared.candidates, ['acme/shop', 'acme/retainer']);
  assert.match(shared.hint, /channel #ext-acme is shared by acme\/shop \| acme\/retainer/);
  assert.deepEqual(top(draft({ container: '#ext-acme', projectKeys: ['SUP'] })), ['acme/retainer', 'registry:key', RUNG_CONF.key], 'a key below still decides');
  assert.deepEqual(attribute(draft({ container: '#ext-acme', participants: ['me', 'ana'] }), ctx()).candidates, ['acme/shop', 'acme/retainer'], 'a narrow person keeps them');
});

test('F6: a work block in a repo several initiatives share is routed by its own tracker key; without one it stays their candidates', () => {
  const route = reg.routeRepo('git@github.com:agency/acme-web.git');
  assert.equal(route.confidence, 'ambiguous');
  const work = (projectKeys: string[]) => draft({ kind: 'work', refs: ['activity:claude:s1'], container: 'github.com/agency/acme-web', repo: 'github.com/agency/acme-web', route, projectKeys });
  assert.deepEqual(top(work(['SUP'])), ['acme/retainer', 'registry:key', RUNG_CONF.key]);
  const open = attribute(work([]), ctx());
  assert.deepEqual([open.decided, open.candidates, open.hint], [null, ['acme/shop', 'acme/retainer'], route.reason]);
});

test('F7: a broad person no longer switches the narrow rung off — they join the hint; exclusive people who disagree still do', () => {
  const r = attribute(draft({ participants: ['me', 'ana', 'bob', 'kim'] }), ctx());
  assert.deepEqual([r.decided, r.candidates, r.hint], [null, ['acme/shop', 'acme/retainer'], 'narrow:acme via ana; broad via bob']);
  assert.equal(attribute(draft({ participants: ['me', 'ana'] }), ctx()).hint, 'narrow:acme via ana', 'the hint without broad people is unchanged');
  const disagree = attribute(draft({ participants: ['me', 'ana', 'eve', 'ivo'] }), ctx());
  assert.deepEqual([disagree.decided, disagree.candidates], [null, ['acme/shop', 'acme/retainer', 'globex/portal']]);
  assert.match(disagree.hint, /^broad via/);
});
