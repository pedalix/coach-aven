// Item mode: the T1-item rungs (pure), the T4 floor, the one-way bulk evidence, and the batch over a tiny store — the
// rows the build writes into att_items. A fictional agency tenant: every person, company, host and channel is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.js';
import type { Person } from '../people.js';
import type { AttributionInputs } from './build.js';
import { parseAttributionConfig } from './config.js';
import type { RuleRecord } from './ladder.js';
import { parseRegistry } from './registry.js';
import { addresseeOf, computeItems, dayEndMs, ITEM_CONF, itemFloor, itemTenant, itemWindow, kindOf, MailStats, recomputeItems, writeItems, type AddresseeInput, type ItemFacts, type KindInput } from './items.js';

const REGISTRY = parseRegistry({
  companies: [{ id: 'acme', umbrella: 'acme', name: 'Acme Hotels', domains: ['acme.example'] }],
  initiatives: [
    { id: 'acme/shop', umbrella: 'acme', company: 'acme', sources: { youtrack_prefixes: ['SHOP'], slack_channels: [{ id: 'C0SHOP0001', name: '#ext-acme' }], hosts: ['shop.acme.example'] } },
    { id: 'acme/retainer', umbrella: 'acme', company: 'acme', sources: { slack_channels: ['#ext-acme', '#acme-alerts'], youtrack_prefixes: ['SUP'] } },
    { id: 'beta/portal', umbrella: 'beta', sources: { jira_keys: ['BP'], slack_channels: [{ id: 'C0OPS00001', name: '#ops', closed: true }] } },
    { id: 'beta/legacy', umbrella: 'beta', alias_of: 'beta/portal', sources: {} },
  ],
});
const PEOPLE: Person[] = [
  { person_id: 'me', name: 'Lena Park', identities: ['lena@agency.example', 'slack:Lena Park'] },
  { person_id: 'eve', name: 'Eve Stone', identities: ['eve@beta.example'], marker: { type: 'exclusive', initiatives: ['beta/legacy'] } },
  { person_id: 'ana', name: 'Ana Berg', identities: ['ana@acme.example', 'slack:Ana Berg'], marker: { type: 'narrow', initiatives: ['acme/shop', 'acme/retainer'] } },
  { person_id: 'bob', name: 'Bob Rye', identities: ['bob@acme.example'], marker: { type: 'broad', initiatives: ['acme/shop', 'beta/portal'] } },
];
const tenant = (rules: RuleRecord[] = []) => itemTenant({ registry: REGISTRY, rules, people: PEOPLE, subject: 'me', tz: 'UTC' });
const item = (o: Partial<ItemFacts> = {}): ItemFacts => ({ type: 'message', source: 'slack', container: null, channelId: null, sender: 'human', ownKey: null, keys: [], hosts: [], apps: [], persons: [], title: '', domains: [], root: null, ...o });

test('T1-item: own key .98, a reply ×.99 under its root\'s rung, bulk → none .90, host .95, closed channel → unregistered .80', () => {
  const t = tenant();
  const own = itemFloor(item({ type: 'comment', ownKey: 'SHOP', keys: ['BP'] }), t);
  assert.deepEqual([own.label, own.conf, own.rung], ['acme/shop', ITEM_CONF.ownKey, 'key:SHOP']);
  const reply = itemFloor(item({ root: own }), t);
  assert.deepEqual([reply.label, reply.rung], ['acme/shop', 'key:SHOP']);
  assert.ok(Math.abs(reply.conf - ITEM_CONF.ownKey * ITEM_CONF.reply) < 1e-9);
  const bulk = itemFloor(item({ sender: 'bulk', source: 'gmail', keys: ['SHOP'] }), t);
  assert.deepEqual([bulk.label, bulk.conf, bulk.rung], ['none', ITEM_CONF.bulk, 'sender:bulk']);
  const host = itemFloor(item({ sender: 'bot', hosts: ['api.shop.acme.example'], container: '#ops' }), t);
  assert.deepEqual([host.label, host.conf, host.rung], ['acme/shop', ITEM_CONF.host, 'host:api.shop.acme.example'], 'a subdomain of a listed host');
  const unknown = itemFloor(item({ sender: 'bot', hosts: ['db.elsewhere.example'], container: '#ops', channelId: 'C0OPS00001' }), t);
  assert.deepEqual([unknown.label, unknown.conf, unknown.rung], ['unregistered', ITEM_CONF.closed, 'closed:C0OPS00001']);
  assert.equal(itemFloor(item({ sender: 'bot', hosts: ['db.elsewhere.example'], container: '#acme-alerts' }), t).label, 'acme/retainer', 'an open host list: the channel routes');
  assert.equal(itemFloor(item({ hosts: ['db.elsewhere.example'], container: '#ops' }), t).label, 'beta/portal', 'a person\'s item never takes the host rung');
});

test('T1-item: text keys .95 (several: candidates), rules (container .95 person / .85 bot, project_key .97), channel id first, domain prior, markers', () => {
  const t = tenant([
    { id: 'c1', when: { container: '#acme-alerts' }, then: { initiative: 'acme/retainer' } },
    { id: 'k1', when: { project_key: 'XYZ' }, then: { initiative: 'beta/portal' } },
  ]);
  assert.equal(itemFloor(item({ keys: ['SUP'] }), t).conf, ITEM_CONF.textKey);
  const two = itemFloor(item({ keys: ['SUP', 'BP'] }), t);
  assert.equal(two.label, null);
  assert.deepEqual(two.candidates.sort(), ['acme/retainer', 'beta/portal']);
  const human = itemFloor(item({ container: '#acme-alerts' }), t);
  const bot = itemFloor(item({ container: '#acme-alerts', sender: 'bot' }), t);
  assert.deepEqual([human.conf, bot.conf, bot.rung], [ITEM_CONF.ruleContainer, ITEM_CONF.ruleContainerBot, 'rule:c1']);
  assert.equal(itemFloor(item({ keys: ['XYZ'] }), t).conf, ITEM_CONF.ruleKey);
  const byId = itemFloor(item({ container: '#renamed', channelId: 'C0SHOP0001' }), t);
  assert.deepEqual([byId.label, byId.conf, byId.rung], ['acme/shop', ITEM_CONF.channel, 'channel:C0SHOP0001'], 'a renamed channel still routes by its id');
  const shared = itemFloor(item({ container: '#ext-acme' }), t);
  assert.equal(shared.label, null, 'by name #ext-acme is listed twice');
  assert.deepEqual(shared.candidates.sort(), ['acme/retainer', 'acme/shop']);
  assert.equal(itemFloor(item({ container: '#ops', channelId: 'C0OPS00001', sender: 'bot' }), t).conf, ITEM_CONF.channelBot);
  const mail = itemFloor(item({ source: 'gmail', domains: ['mail.acme.example'] }), t);
  assert.equal(mail.label, null);
  assert.deepEqual(mail.candidates.sort(), ['acme/retainer', 'acme/shop']);
  assert.match(mail.hint, /domain mail\.acme\.example → acme/);
  const excl = itemFloor(item({ persons: ['eve'] }), t);
  assert.deepEqual([excl.label, excl.conf, excl.rung], ['beta/portal', ITEM_CONF.excl, 'excl:eve'], 'the marker names an alias: its target');
  const narrow = itemFloor(item({ persons: ['ana', 'bob'] }), t);
  assert.equal(narrow.label, null);
  assert.deepEqual(narrow.candidates.sort(), ['acme/retainer', 'acme/shop']);
  assert.equal(itemFloor(item({ persons: ['me'] }), tenant()).hint, 'no signals', 'the subject is no marker');
});

test('a candidates rule narrows every rung below it; a deciding rung outside it only joins the candidates', () => {
  const t = tenant([{ id: 'n1', when: { container: '#ext-acme' }, then: { candidates: ['acme/retainer', 'beta/portal'] } }]);
  const d = itemFloor(item({ container: '#ext-acme', persons: ['eve'] }), t);
  assert.deepEqual([d.label, d.rung], ['beta/portal', 'excl:eve']);
  const out = itemFloor(item({ container: '#ext-acme', channelId: 'C0SHOP0001' }), t);
  assert.equal(out.label, null);
  assert.deepEqual(out.candidates.sort(), ['acme/retainer', 'beta/portal']);
  assert.match(out.hint, /outside the rule's candidates/);
});

const k = (o: Partial<KindInput>) => kindOf({ cls: 'human', human: true, cues: [], alert: null, smallTalk: false, ...o });

test('kind: integrations are noise unless they fire, report an error, ask or relay somebody; small talk is noise; the rest abstains', () => {
  assert.deepEqual([k({ cls: 'bot', human: false, alert: { state: 'resolved', key: 'x' } }).label, k({ cls: 'bot', human: false, alert: { state: 'resolved', key: 'x' } }).conf], ['noise', 0.95]);
  const firing = k({ cls: 'bot', human: false, alert: { state: 'firing', key: 'x' }, cues: ['I'] });
  assert.deepEqual([firing.label, firing.rung, firing.candidates], [null, 'auto:firing', ['incident', 'noise']], 'incident or routine: the tenant decides');
  assert.deepEqual([k({ cls: 'bot', human: false, cues: ['I'] }).rung, k({ cls: 'bot', human: false, cues: ['R'] }).rung, k({ cls: 'bot', human: false, relay: true }).rung], ['auto:incident?', 'auto:asks', 'auto:relay']);
  assert.deepEqual([k({ cls: 'bot', human: false }).label, k({ cls: 'bot', human: false }).conf], ['noise', 0.9]);
  assert.deepEqual([k({ cls: 'bulk', human: false, cues: ['Q'] }).label, k({ cls: 'bulk', human: false }).conf], ['noise', 0.95]);
  assert.equal(k({ cls: 'bulk', human: false, cues: ['R'] }).rung, 'bulk:asks', 'cold outreach asks for something');
  assert.deepEqual([k({ cls: 'system', human: false }).label, k({ cls: 'system', human: false }).conf], ['noise', 0.85]);
  assert.deepEqual([k({ smallTalk: true }).label, k({ smallTalk: true }).conf, k({ smallTalk: true }).rung], ['noise', 0.85, 'smalltalk']);
  assert.deepEqual([k({ cues: ['Q', 'R'] }).label, k({ cues: ['Q', 'R'] }).hint], [null, 'cues QR']);
});

const a = (o: Partial<AddresseeInput>) =>
  addresseeOf({ human: true, type: 'message', author: 'omar', subject: 'lena', where: 'channel', asks: false, mentions: [], members: [], assignee: null, vocative: null, parent: null, smallTalk: false, ...o });

test('addressee: an integration addresses nobody (unless a machine mail asks the owner); mentions; DM; first To; assignee; vocative; reply', () => {
  assert.deepEqual([a({ human: false }).label, a({ human: false }).conf, a({ human: false }).rung], ['none', 0.95, 'auto:none']);
  assert.deepEqual([a({ human: false, where: 'mail', asks: true }).label, a({ human: false, where: 'mail', asks: true }).candidates], [null, ['lena']]);
  assert.equal(a({ smallTalk: true, mentions: [{ pid: 'lena', conf: 0.95 }] }).rung, 'smalltalk');
  const m = a({ mentions: [{ pid: 'nina', conf: 0.95 }, { pid: 'lena', conf: 0.9 }, { pid: 'omar', conf: 0.95 }] });
  assert.deepEqual([m.label, m.conf, m.rung, m.candidates], ['lena|nina', 0.9, 'explicit:mention', ['lena', 'nina']], 'never the author; the weakest mention');
  assert.deepEqual([a({ where: 'dm', members: ['lena', 'omar'] }).label, a({ where: 'dm', members: ['lena', 'omar'] }).conf], ['lena', 0.9]);
  assert.equal(a({ where: 'group', members: ['lena', 'omar', 'nina'] }).conf, 0.6, 'in a group chat the owner is a guess');
  assert.equal(a({ where: 'dm', subject: null, members: ['nina', 'omar'] }).label, 'nina', 'a team tenant: the counterpart');
  assert.deepEqual([a({ where: 'mail', members: ['lena', ''] }).rung, a({ where: 'mail', members: ['', 'lena'] }).rung], ['explicit:to', 'explicit:to?']);
  assert.deepEqual([a({ type: 'task', where: 'tracker', assignee: 'nina' }).label, a({ type: 'task', where: 'tracker', assignee: 'omar' }).label], ['nina', 'none']);
  assert.deepEqual([a({ vocative: { pid: 'nina', conf: 0.85 }, parent: 'lena' }).label, a({ vocative: { pid: 'nina', conf: 0.8 } }).rung], ['nina', 'vocative~']);
  assert.deepEqual([a({ parent: 'lena' }).label, a({ parent: 'lena' }).conf], ['lena', 0.65]);
  assert.deepEqual([a({}).label, a({}).conf, a({}).rung], ['none', 0.7, 'none']);
});

test('one-way bulk evidence: three mails, none answered — counted up to a moment, never ahead of it; a local day ends at local midnight', () => {
  const s = new MailStats([
    { thread: 't1', t: 1, sender: 'a@x.example', subjectWrote: false },
    { thread: 't2', t: 2, sender: 'a@x.example', subjectWrote: false },
    { thread: 't3', t: 3, sender: 'a@x.example', subjectWrote: false },
    { thread: 't4', t: 1, sender: 'b@x.example', subjectWrote: false },
    { thread: 't4', t: 5, sender: 'me', subjectWrote: true },
    { thread: 't5', t: 2, sender: 'b@x.example', subjectWrote: false },
    { thread: 't6', t: 3, sender: 'b@x.example', subjectWrote: false },
  ]);
  assert.deepEqual([s.oneWay('a@x.example', 2), s.oneWay('a@x.example', 3)], [false, true]);
  assert.deepEqual([s.oneWay('b@x.example', 4), s.oneWay('b@x.example', 6)], [true, false], 'answered at 5');
  assert.equal(new Date(dayEndMs('2026-10-14', 'Europe/Zurich')).toISOString(), '2026-10-14T22:00:00.000Z');
  assert.equal(new Date(dayEndMs('2026-10-25', 'Europe/Zurich')).toISOString(), '2026-10-25T23:00:00.000Z', 'the day the clocks go back');
});

test('attribution.json "items": absent = off (the parsed config is unchanged), {} = 30 days, days in [1, 90]', () => {
  assert.equal('items' in parseAttributionConfig({ subject: 'me' }), false);
  assert.deepEqual(parseAttributionConfig({ subject: 'me', items: {} }).items, { days: 30 });
  assert.deepEqual(parseAttributionConfig({ subject: 'me', items: { days: 7 } }).items, { days: 7 });
  for (const bad of [true, [], { days: 0 }, { days: 91 }, { days: 1.5 }]) assert.throws(() => parseAttributionConfig({ subject: 'me', items: bad }), /"items/, JSON.stringify(bad));
  const inputs = (items?: unknown) => ({ config: parseAttributionConfig({ subject: 'me', ...(items ? { items } : {}) }), timezone: 'Europe/Zurich' });
  assert.equal(itemWindow(inputs(), new Date('2026-10-15T23:30:00Z')), null);
  assert.deepEqual(itemWindow(inputs({ days: 7 }), new Date('2026-10-15T23:30:00Z')), { since: '2026-10-10', until: '2026-10-16', days: 7 }, 'days are the tenant zone\'s');
});

// --- the batch over a store ---------------------------------------------------------------------------------

const NOW = new Date('2026-10-15T16:00:00.000Z');
const inputs = (items?: { days: number }): AttributionInputs => ({ config: parseAttributionConfig({ subject: 'me', ...(items ? { items } : {}) }), registry: REGISTRY, rules: [], timezone: 'Europe/Zurich', versionText: '' });

function store(): ReturnType<typeof openStore> {
  const db = openStore(join(mkdtempSync(join(tmpdir(), 'items-')), 'store.sqlite'));
  const m = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, participants, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const slack = (ref: string, container: string, thread: string, ts: string, person: string | null, author: string, text: string, bot = 0, participants = [author]) =>
    m.run(ref, 'slack', 'T1', container, thread, ts, person, author, '', text, JSON.stringify(participants), bot);
  const mail = (ref: string, thread: string, ts: string, author: string, person: string | null, subject: string, text: string) =>
    m.run(ref, 'gmail', 'lena@agency.example', 'inbox', thread, ts, person, author, subject, text, JSON.stringify([author, 'lena@agency.example']), 0);
  // #ops (its host list is closed): a site alert, its resolve ten minutes later, and an alert for a host nobody lists.
  const alert = (state: string, host: string) => `${state}: SiteDown: *https://${host}*: Domain https://${host} is down (probe)`;
  slack('slack:T1:C0OPS00001:100.1', '#ops', 'slack:T1/C0OPS00001/100.1', '2026-10-14T08:00:00.000Z', null, 'Shop Alert Bot', alert('CRITICAL', 'shop.acme.example'), 1);
  slack('slack:T1:C0OPS00001:100.2', '#ops', 'slack:T1/C0OPS00001/100.2', '2026-10-14T08:10:00.000Z', null, 'Shop Alert Bot', alert('RESOLVED', 'shop.acme.example'), 1);
  slack('slack:T1:C0OPS00001:100.3', '#ops', 'slack:T1/C0OPS00001/100.3', '2026-10-14T09:00:00.000Z', null, 'Shop Alert Bot', alert('CRITICAL', 'db.elsewhere.example'), 1);
  // A thread in a channel listed by id; the reply names the root's author.
  slack('slack:T1:C0SHOP0001:200.1', '#ext-acme', 'slack:T1/C0SHOP0001/200.1', '2026-10-14T10:00:00.000Z', 'ana', 'Ana Berg', 'The checkout totals look wrong since this morning');
  slack('slack:T1:C0SHOP0001:200.2', '#ext-acme', 'slack:T1/C0SHOP0001/200.1', '2026-10-14T10:05:00.000Z', 'me', 'Lena Park', 'Ana, I will check the import after lunch');
  // A DM to the subject.
  slack('slack:T1:D0DM000001:300.1', 'dm:@Ana Berg', 'slack:T1/D0DM000001/300.1', '2026-10-14T11:00:00.000Z', 'ana', 'Ana Berg', 'Can you send me the October numbers?', 0, ['Ana Berg', 'Lena Park']);
  // A sender mailing three days running, never answered (one-way from the third on) — and one the subject answered.
  for (const [i, day] of ['12', '13', '14'].entries()) mail(`gmail:a:p${i}`, `gmail:a/p${i}`, `2026-10-${day}T07:00:00.000Z`, 'Mara Lind <mara@offers.example>', null, `Autumn news ${i}`, 'Our autumn collection is here.');
  mail('gmail:a:q0', 'gmail:a/q0', '2026-10-12T08:00:00.000Z', 'ivo@partner.example', null, 'Draft', 'The draft is attached.');
  mail('gmail:a:q1', 'gmail:a/q0', '2026-10-12T09:00:00.000Z', 'lena@agency.example', 'me', 'Re: Draft', 'Thanks, reading it today.');
  mail('gmail:a:q2', 'gmail:a/q2', '2026-10-13T08:00:00.000Z', 'ivo@partner.example', null, 'Draft v2', 'The second draft.');
  mail('gmail:a:q3', 'gmail:a/q3', '2026-10-14T08:00:00.000Z', 'ivo@partner.example', null, 'Draft v3', 'The third draft.');
  // A ticket and its comment.
  db.prepare('INSERT INTO tasks(ref, source, account, key, title, assignee_raw, assignee_person, reporter_raw, reporter_person, created, updated, project, url, text, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'youtrack:acme:2-7', 'youtrack', 'acme', 'SHOP-7', 'Checkout totals wrong', 'Lena Park', 'me', 'Ana Berg', 'ana', '2026-10-13T09:00:00.000Z', '2026-10-14T12:00:00.000Z', 'SHOP',
    'https://tracker.example/issue/SHOP-7', 'Totals differ from the cart', JSON.stringify([{ id: 'c1', author: 'Lena Park', ts: '2026-10-14T11:30:00.000Z', text: 'Looking into it' }]),
  );
  // Two recordings of one call.
  const mt = db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  mt.run('granola:me:g1', 'granola', 'me', 'g1', 'Acme weekly', '2026-10-14T14:00:00.000Z', '2026-10-14T14:30:00.000Z', JSON.stringify([{ email: 'ana@acme.example', name: 'Ana Berg' }]), 'Checkout totals and the import', 'call:granola:me:g1');
  mt.run('gmeet:me:m1', 'gmeet', 'me', 'm1', 'Acme weekly', '2026-10-14T14:01:00.000Z', '2026-10-14T14:01:00.000Z', JSON.stringify([{ email: '', name: 'Ana Berg Lena Park' }]), 'Checkout totals', 'call:granola:me:g1');
  // Before the window: never an item.
  slack('slack:T1:C0SHOP0001:50.1', '#ext-acme', 'slack:T1/C0SHOP0001/50.1', '2026-10-01T10:00:00.000Z', 'ana', 'Ana Berg', 'An older note about the shop');
  return db;
}

test('computeItems: sender classes, clusters, initiatives, kinds, addressees and case keys over a store; off without the key', () => {
  const db = store();
  try {
    assert.deepEqual(computeItems(db, inputs(), PEOPLE, NOW), [], 'a tenant without "items": no rows');
    const rows = computeItems(db, inputs({ days: 7 }), PEOPLE, NOW);
    const by = new Map(rows.map((r) => [r.ref, r]));
    assert.equal(rows.length, 17);
    assert.equal(by.has('slack:T1:C0SHOP0001:50.1'), false, 'before the window');
    assert.deepEqual(rows.map((r) => r.ts), [...rows.map((r) => r.ts)].sort(), 'in time order');

    // sender classes: the bot, the one-way sender's third mail, the answered correspondent
    assert.deepEqual(['slack:T1:C0OPS00001:100.1', 'gmail:a:p0', 'gmail:a:p1', 'gmail:a:p2', 'gmail:a:q3', 'granola:me:g1'].map((r) => by.get(r)!.sender_class), ['bot', 'human', 'human', 'bulk', 'human', 'human']);

    // the alert episode: one cluster (flap), named by its firing; the other host's alert stands alone
    const resolved = by.get('slack:T1:C0OPS00001:100.2')!;
    assert.deepEqual([resolved.cluster, resolved.cluster_conf, resolved.cluster_via], ['slack:T1:C0OPS00001:100.1', 0.95, 'flap']);
    assert.equal(by.get('slack:T1:C0OPS00001:100.3')!.cluster, 'slack:T1:C0OPS00001:100.3');
    assert.match(resolved.family, /^fam-[0-9a-f]{12}$/);
    assert.notEqual(by.get('slack:T1:C0OPS00001:100.1')!.family, by.get('slack:T1:C0OPS00001:100.3')!.family, 'the host is part of the family');
    const copy = by.get('gmeet:me:m1')!;
    assert.deepEqual([copy.cluster, copy.cluster_via, copy.case_key], ['granola:me:g1', 'recorder', 'call:granola:me:g1'], 'two recordings of one call');

    // initiatives
    const t1 = (ref: string) => [by.get(ref)!.initiative, by.get(ref)!.rung, Math.round(by.get(ref)!.conf * 1e4) / 1e4];
    assert.deepEqual(t1('slack:T1:C0OPS00001:100.1'), ['acme/shop', 'host:shop.acme.example', 0.95]);
    assert.deepEqual(t1('slack:T1:C0OPS00001:100.3'), ['unregistered', 'closed:C0OPS00001', 0.8]);
    assert.deepEqual(t1('slack:T1:C0SHOP0001:200.1'), ['acme/shop', 'channel:C0SHOP0001', 0.95]);
    assert.deepEqual(t1('slack:T1:C0SHOP0001:200.2'), ['acme/shop', 'channel:C0SHOP0001', 0.9405], 'a reply inherits its root');
    assert.deepEqual(t1('gmail:a:p2'), ['none', 'sender:bulk', 0.9]);
    assert.deepEqual(t1('youtrack:acme:2-7#cc1'), ['acme/shop', 'key:SHOP', 0.98]);
    assert.deepEqual(t1('youtrack:acme:2-7'), ['acme/shop', 'key:SHOP', 0.98]);
    const dm = by.get('slack:T1:D0DM000001:300.1')!;
    assert.deepEqual([dm.initiative, dm.candidates.sort()], [null, ['acme/retainer', 'acme/shop']], 'Ana narrows');

    // kinds
    assert.deepEqual([resolved.kind, resolved.kind_conf, resolved.kind_rung], ['noise', 0.95, 'auto:resolved']);
    assert.deepEqual([by.get('slack:T1:C0OPS00001:100.1')!.kind, by.get('slack:T1:C0OPS00001:100.1')!.kind_rung], [null, 'auto:firing']);
    assert.deepEqual([by.get('gmail:a:p2')!.kind, by.get('gmail:a:p2')!.kind_rung], ['noise', 'sender:bulk']);
    assert.equal(dm.kind, null);

    // addressees
    const to = (ref: string) => [by.get(ref)!.addressee, by.get(ref)!.addressee_rung];
    assert.deepEqual(to('slack:T1:C0OPS00001:100.1'), [[], 'auto:none']);
    assert.deepEqual(to('slack:T1:D0DM000001:300.1'), [['me'], 'explicit:dm']);
    assert.deepEqual(to('slack:T1:C0SHOP0001:200.2'), [['ana'], 'vocative']);
    assert.deepEqual(to('gmail:a:q3'), [['me'], 'explicit:to']);
    assert.deepEqual(to('youtrack:acme:2-7'), [['me'], 'explicit:assignee']);
    assert.deepEqual(to('youtrack:acme:2-7#cc1'), [['ana'], 'implicit'], 'a comment answers the ticket\'s reporter');

    // case keys: the question unit
    assert.equal(by.get('slack:T1:C0OPS00001:100.1')!.case_key, `family:${by.get('slack:T1:C0OPS00001:100.1')!.family}:2026-10-14`);
    assert.equal(by.get('slack:T1:C0SHOP0001:200.2')!.case_key, 'thread:slack:T1/C0SHOP0001/200.1');
    assert.equal(by.get('youtrack:acme:2-7#cc1')!.case_key, 'ticket:youtrack:acme:2-7');
    assert.equal(by.get('gmail:a:p0')!.day, '2026-10-12', 'days are the tenant zone\'s');
  } finally {
    db.close();
  }
});

test('writeItems / recomputeItems: the rows and the "att:items" meta the readout keys on; switched off, both go', () => {
  const db = store();
  try {
    const meta = () => db.prepare("SELECT value FROM sync_state WHERE key = 'att:items'").get() as { value: string } | undefined;
    const count = () => (db.prepare('SELECT count(*) AS n FROM att_items').get() as { n: number }).n;
    const sum = recomputeItems(db, inputs({ days: 7 }), PEOPLE, NOW)!;
    assert.deepEqual([sum.since, sum.until, sum.items, sum.senders, sum.clusters], ['2026-10-09', '2026-10-15', 17, { human: 13, bot: 3, bulk: 1, system: 0 }, 2]);
    assert.equal(count(), 17);
    assert.deepEqual(JSON.parse(meta()!.value), { ...sum, days: 7 });
    const row = db.prepare("SELECT addressee, candidates FROM att_items WHERE ref = 'slack:T1:D0DM000001:300.1'").get() as { addressee: string; candidates: string };
    assert.deepEqual([JSON.parse(row.addressee), JSON.parse(row.candidates).sort()], [['me'], ['acme/retainer', 'acme/shop']]);
    assert.equal(recomputeItems(db, inputs({ days: 7 }), PEOPLE, NOW)!.items, 17, 'idempotent');
    assert.equal(recomputeItems(db, inputs(), PEOPLE, NOW), null, 'the key removed: item mode off');
    assert.deepEqual([count(), meta()], [0, undefined]);
    writeItems(db, computeItems(db, inputs({ days: 7 }), PEOPLE, NOW));
    assert.deepEqual([count(), JSON.parse(meta()!.value).since], [17, '2026-10-12'], 'without a window the rows\' own days stand for it');
  } finally {
    db.close();
  }
});
