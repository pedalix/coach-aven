import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminWord, CONF, fragmentFloor, itemFloor, keyPrefixes, type FloorTenant, type FragFacts, type ItemFacts } from './floor.js';
import { Reg } from './registry.js';
import type { Marker, Rule } from './tenant.js';

// A fictional agency tenant.
const REG = new Reg({
  companies: [{ id: 'acme', umbrella: 'acme', name: 'Acme Hotels', domains: ['acme.example'] }],
  initiatives: [
    { id: 'acme/shop', umbrella: 'acme', company: 'acme', sources: { repos: ['agency/acme-shop'], youtrack_prefixes: ['SHOP'], slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }], calendar_title_patterns: ['Acme', 'ART'], hosts: ['shop.acme.example'] } },
    { id: 'acme/retainer', umbrella: 'acme', company: 'acme', sources: { slack_channels: ['#ext-acme', '#acme-alerts'], youtrack_prefixes: ['SUP'], calendar_title_patterns: ['Support'] } },
    { id: 'acme/admin', umbrella: 'acme', sources: {} },
    { id: 'beta/portal', umbrella: 'beta', sources: { jira_keys: ['BP'], slack_channels: [{ id: 'C0OPS00001', name: '#ops', closed: true }], local_paths: ['/work/beta'] } },
    { id: 'beta/admin', umbrella: 'beta', sources: {} },
  ],
});
const MARKERS = new Map<string, Marker>([
  ['eve', { type: 'exclusive', initiatives: ['beta/portal'] }],
  ['ana', { type: 'narrow', initiatives: ['acme/shop', 'acme/retainer'] }],
  ['bob', { type: 'broad', initiatives: ['acme/shop', 'beta/portal'] }],
  ['cat', { type: 'narrow', initiatives: ['beta/portal'] }],
]);
const tenant = (rules: Rule[] = []): FloorTenant => ({ reg: REG, rules, markers: MARKERS, subject: 'me', admin: { acme: 'acme/admin', beta: 'beta/admin' }, nameOf: (p) => p.toUpperCase(), companyOf: () => null });

const frag = (o: Partial<FragFacts> = {}): FragFacts => ({ kind: 'thread', title: '', meetingTitle: '', source: 'slack', container: null, channelId: null, repo: null, participants: ['me'], keys: [], adminText: '', ...o });
const item = (o: Partial<ItemFacts> = {}): ItemFacts => ({ type: 'message', source: 'slack', container: null, channelId: null, sender: 'human', ownKey: null, keys: [], hosts: [], apps: [], persons: [], title: '', domains: [], root: null, ...o });

test('F1: admin words match whole words only, in EN/DE/RU/IT', () => {
  for (const miss of ['a private repo', 'fix the syntax', 'it is advisable', 'мы договорились', 'чеклист релиза', 'Steuerung der Pumpe', 'визит клиента', 'taxi to the airport']) assert.equal(adminWord(miss), null, miss);
  for (const [hit, word] of [
    ['VAT for Q3', 'VAT'],
    ['the invoices are late', 'invoices'],
    ['оплата прошла', 'оплата'],
    ['подписали договор', 'договор'],
    ['Rechnung Oktober', 'Rechnung'],
    ['la fattura di ottobre', 'fattura'],
    ['nuovo contratto', 'contratto'],
    ['send the NDA', 'NDA'],
    ['чек за такси', 'чек'],
  ]) assert.equal(adminWord(hit), word, hit);
});

test('rung 1: a tenant rule decides at .97; a candidates rule narrows every rung below it', () => {
  const decide: Rule = { id: 'r1', when: { container: '#acme-dev' }, then: { initiative: 'acme/shop' } };
  const d = fragmentFloor(frag({ container: '#acme-dev' }), tenant([decide]));
  assert.deepEqual([d.label, d.conf, d.rung], ['acme/shop', CONF.rule, 'rule:r1']);
  const narrow: Rule = { id: 'r2', when: { container: '#ext-acme' }, then: { candidates: ['acme/retainer', 'acme/admin'] } };
  // the channel is shared (shop + retainer): with the rule's narrowing, only the retainer is left — but a shared channel never decides
  const n = fragmentFloor(frag({ container: '#ext-acme' }), tenant([narrow]));
  assert.equal(n.label, null);
  assert.deepEqual(n.candidates, ['acme/retainer']);
  // a key inside the rule's set decides; one outside it does not
  assert.equal(fragmentFloor(frag({ container: '#ext-acme', keys: ['SUP'] }), tenant([narrow])).label, 'acme/retainer');
  assert.equal(fragmentFloor(frag({ container: '#ext-acme', keys: ['SHOP'] }), tenant([narrow])).label, null);
});

test('rungs 2–3: exclusive markers (.95), repo/path (.99), channel by id (.95), keys (.97), a single title hit (.80)', () => {
  const t = tenant();
  const excl = fragmentFloor(frag({ participants: ['me', 'eve', 'bob'] }), t);
  assert.deepEqual([excl.label, excl.conf, excl.rung], ['beta/portal', CONF.excl, 'excl:eve']);
  const repo = fragmentFloor(frag({ kind: 'work', repo: 'git@github.com:agency/acme-shop.git' }), t);
  assert.deepEqual([repo.label, repo.conf, repo.rung], ['acme/shop', CONF.repo, 'repo:agency/acme-shop']);
  const path = fragmentFloor(frag({ kind: 'work', repo: '/work/beta/api' }), t);
  assert.deepEqual([path.label, path.rung], ['beta/portal', 'path:/work/beta']);
  // the channel was renamed since the registry was written: its id still routes it (only the shop lists the id)…
  const ch = fragmentFloor(frag({ container: '#renamed', channelId: 'C0SHOP0001' }), t);
  assert.deepEqual([ch.label, ch.conf, ch.rung], ['acme/shop', CONF.channel, 'channel:C0SHOP0001']);
  // …while its name is listed by two initiatives: candidates, not a fall-through
  const shared = fragmentFloor(frag({ container: '#ext-acme' }), t);
  assert.equal(shared.label, null);
  assert.deepEqual(shared.candidates.sort(), ['acme/retainer', 'acme/shop']);
  const key = fragmentFloor(frag({ keys: ['BP'] }), t);
  assert.deepEqual([key.label, key.conf, key.rung], ['beta/portal', CONF.key, 'key:BP']);
  const title = fragmentFloor(frag({ kind: 'call', meetingTitle: 'Acme weekly', title: 'Acme weekly — Checkout' }), t);
  assert.deepEqual([title.label, title.conf, title.rung], ['acme/shop', CONF.title, 'title:acme']);
  const two = fragmentFloor(frag({ kind: 'call', meetingTitle: 'Acme support' }), t);
  assert.equal(two.label, null);
  assert.deepEqual(two.candidates.sort(), ['acme/retainer', 'acme/shop']);
  assert.equal(fragmentFloor(frag({ kind: 'call', meetingTitle: 'Karte und Plan' }), t).label, null); // "ART" is a word, not a substring
});

test('rung 1 beats rung 2, the registry beats admin, admin needs one umbrella (.75)', () => {
  const rule: Rule = { id: 'r1', when: { person: 'eve' }, then: { initiative: 'acme/shop' } };
  assert.equal(fragmentFloor(frag({ participants: ['me', 'eve'] }), tenant([rule])).rung, 'rule:r1');
  assert.equal(fragmentFloor(frag({ keys: ['SHOP'], adminText: 'the invoice for the shop', participants: ['me', 'ana'] }), tenant()).rung, 'key:SHOP');
  const admin = fragmentFloor(frag({ adminText: 'the invoice for October', participants: ['me', 'ana'] }), tenant());
  assert.deepEqual([admin.label, admin.conf, admin.rung], ['acme/admin', CONF.admin, 'admin']);
  // the 'private' bug: no admin word, no admin decision
  assert.equal(fragmentFloor(frag({ adminText: 'a private repo', participants: ['me', 'ana'] }), tenant()).rung, 'abstain');
  const two = fragmentFloor(frag({ adminText: 'contract renewal', participants: ['me', 'ana', 'cat'] }), tenant());
  assert.equal(two.label, null);
  assert.ok(['acme/admin', 'beta/admin'].every((b) => two.candidates.includes(b)), two.candidates.join());
  assert.match(two.hint, /umbrella unclear/);
  // the subject's own marker never counts
  assert.equal(fragmentFloor(frag({ participants: ['me'] }), { ...tenant(), markers: new Map([['me', { type: 'exclusive', initiatives: ['acme/shop'] }]]) }).label, null);
});

test('F7: a broad person no longer switches the narrow rung off', () => {
  const d = fragmentFloor(frag({ participants: ['me', 'ana', 'bob'] }), tenant());
  assert.equal(d.label, null);
  assert.deepEqual(d.candidates.sort(), ['acme/retainer', 'acme/shop']);
  assert.match(d.hint, /narrow via ana/);
  const broad = fragmentFloor(frag({ participants: ['me', 'bob'] }), tenant());
  assert.deepEqual(broad.candidates.sort(), ['acme/shop', 'beta/portal']);
  assert.match(broad.hint, /broad via bob/);
});

test('items: own key .98, reply ×.99, bulk → none .90, host .95, closed channel → unregistered .80', () => {
  const t = tenant();
  const own = itemFloor(item({ type: 'comment', ownKey: 'SHOP', keys: ['BP'] }), t);
  assert.deepEqual([own.label, own.conf, own.rung], ['acme/shop', CONF.item.ownKey, 'key:SHOP']);
  const reply = itemFloor(item({ root: own }), t);
  assert.equal(reply.label, 'acme/shop');
  assert.equal(reply.rung, 'key:SHOP'); // the root's instance: an answer on the reply calibrates the rung that decided it
  assert.ok(Math.abs(reply.conf - CONF.item.ownKey * CONF.item.reply) < 1e-9);
  const bulk = itemFloor(item({ sender: 'bulk', source: 'gmail', keys: ['SHOP'] }), t);
  assert.deepEqual([bulk.label, bulk.conf, bulk.rung], ['none', CONF.item.bulk, 'sender:bulk']);
  const host = itemFloor(item({ sender: 'bot', hosts: ['api.shop.acme.example'], container: '#ops' }), t);
  assert.deepEqual([host.label, host.conf, host.rung], ['acme/shop', CONF.item.host, 'host:api.shop.acme.example']);
  const unknown = itemFloor(item({ sender: 'bot', hosts: ['db.elsewhere.example'], container: '#ops', channelId: 'C0OPS00001' }), t);
  assert.deepEqual([unknown.label, unknown.conf, unknown.rung], ['unregistered', CONF.item.closed, 'closed:C0OPS00001']);
  // a human item never takes the host rung
  assert.equal(itemFloor(item({ hosts: ['db.elsewhere.example'], container: '#ops' }), t).label, 'beta/portal');
});

test('items: keys in the text (.95), rules (container .95 human / .85 bot), channel (.95 / .85), domain prior, exclusive .90', () => {
  const t = tenant([{ id: 'c1', when: { container: '#acme-alerts' }, then: { initiative: 'acme/retainer' } }, { id: 'k1', when: { project_key: 'XYZ' }, then: { initiative: 'beta/portal' } }]);
  assert.deepEqual(itemFloor(item({ keys: ['SUP'] }), t).conf, CONF.item.textKey);
  assert.equal(itemFloor(item({ keys: ['SUP', 'BP'] }), t).label, null);
  const human = itemFloor(item({ container: '#acme-alerts' }), t);
  const bot = itemFloor(item({ container: '#acme-alerts', sender: 'bot' }), t);
  assert.deepEqual([human.conf, bot.conf, bot.rung], [CONF.item.ruleContainer, CONF.item.ruleContainerBot, 'rule:c1']);
  assert.equal(itemFloor(item({ keys: ['XYZ'] }), t).conf, CONF.item.ruleKey);
  const ch = itemFloor(item({ container: '#x', channelId: 'C0OPS00001', sender: 'bot' }), tenant());
  assert.deepEqual([ch.label, ch.conf, ch.rung], ['beta/portal', CONF.item.channelBot, 'channel:C0OPS00001']);
  const mail = itemFloor(item({ source: 'gmail', domains: ['mail.acme.example'] }), tenant());
  assert.equal(mail.label, null);
  assert.equal(mail.umbrella, 'acme');
  assert.deepEqual(mail.candidates.sort(), ['acme/retainer', 'acme/shop']);
  const excl = itemFloor(item({ persons: ['eve'] }), tenant());
  assert.deepEqual([excl.label, excl.conf], ['beta/portal', CONF.item.excl]);
  const narrow = itemFloor(item({ persons: ['ana', 'bob'] }), tenant());
  assert.equal(narrow.label, null);
  assert.deepEqual(narrow.candidates.sort(), ['acme/retainer', 'acme/shop']);
});

test('keyPrefixes reads tracker keys out of any text', () => {
  assert.deepEqual(keyPrefixes('fixes SHOP-12 and BP-3', null, 'see https://x.example/issue/SUP-9'), ['SHOP', 'BP', 'SUP']);
  assert.deepEqual(keyPrefixes('no keys here, utf-8'), []);
});
