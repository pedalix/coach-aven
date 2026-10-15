import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FragmentUnit, ItemUnit } from '../../types.js';
import { cuesOf, hasMention } from './cues.js';
import {
  appsOf,
  coworkOf,
  fragmentKeys,
  hostsOf,
  isActive,
  itemKeys,
  kindKeys,
  formOf,
  nameVocab,
  newPoolStats,
  notePool,
  seriesOf,
  subjectOf,
  topicTokens,
} from './extract.js';
import { typeOf, valueOf } from './spec.js';

const vocab = nameVocab([{ person_id: 'mara-quill', name: 'Mara Quill', identities: ['slack:Mara Q', 'mara@acme.example'] }, { person_id: 'tobi' }]);

const item = (extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id: 'slack:T0:C1:1',
  day: '2026-01-05',
  ts: '2026-01-05T09:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#acme-web',
  thread: 'slack:T0/C1/1',
  author: 'Mara Quill',
  authorPerson: 'mara-quill',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text: 'could you check the staging deploy?',
  keys: [],
  ...extra,
});

const frag = (extra: Partial<FragmentUnit> = {}): FragmentUnit => ({
  id: 'frag-2026-01-05-call-abc#1',
  day: '2026-01-05',
  kind: 'call',
  start: '2026-01-05T10:00:00Z',
  end: '2026-01-05T10:30:00Z',
  minutes: 30,
  title: 'Weekly Globex sync 12 — Checkout rewrite',
  source: 'granola',
  container: null,
  participants: ['owner', 'mara-quill'],
  projectKeys: [],
  repo: null,
  weight: 1,
  refs: [],
  text: 'notes',
  ...extra,
});

const byType = (keys: string[]) => {
  const out: Record<string, string[]> = {};
  for (const k of keys) (out[typeOf(k)] ??= []).push(valueOf(k));
  return out;
};

test('series: the title before the topic, values dropped', () => {
  assert.equal(seriesOf('Weekly Globex sync 12 — Checkout rewrite'), 'weekly globex sync');
  assert.equal(seriesOf('Weekly Globex sync 13 – Billing'), 'weekly globex sync');
  assert.equal(seriesOf('Standup 2026-01-05'), 'standup');
  assert.equal(seriesOf('42'), '');
});

test('mail subjects lose reply prefixes and values', () => {
  assert.equal(subjectOf('Re: AW: Invoice 2026-118 for March'), 'invoice <n> for march');
  assert.equal(subjectOf('WG: Angebot'), 'angebot');
});

test('topic tokens: rare-looking words only — no names, no function words, no short words', () => {
  assert.deepEqual(topicTokens('Mara and Tobi review the checkout rewrite for Globex', vocab), ['review', 'checkout', 'rewrite', 'globex']);
  assert.deepEqual(topicTokens('Встреча по оплате счета', vocab), ['оплате', 'счета']);
});

test('hosts skip platforms and the sender’s own domain; apps come from a leading bracket', () => {
  const u = { author: 'alerts@monitor.globex.example', subject: null, keys: ['https://github.com/acme/shop/pull/7'], text: 'DOWN https://shop.acme.example:8443/health and https://www.status.globex.example/x' };
  assert.deepEqual(hostsOf(u), ['shop.acme.example']);
  assert.deepEqual(appsOf({ subject: '[acme/shop-api] Build failed', text: '[checkout] Exception: boom' }), ['checkout', 'shop-api']);
  assert.deepEqual(appsOf({ subject: null, text: 'Deploying shop-api@3f2a9c1 to production (triggered by Mara)' }), ['shop-api']);
  assert.deepEqual(appsOf({ subject: null, text: 'deploy finished: booking-widget (production)' }), ['booking-widget']);
  assert.deepEqual(appsOf({ subject: null, text: 'write to mara@acme.example or ana@facade.example' }), [], 'an address is not a deploy');
  assert.deepEqual(appsOf({ subject: '[YouTrack] SHOP-12 Checkout', text: '[RESOLVED] Disk usage normal on shop.acme.example' }), [], 'a tool or a state is not an app');
});

test('item keys per sender class and source', () => {
  const human = byType(itemKeys(item(), { senderClass: 'human', family: '', hosts: [], apps: [] }, vocab));
  assert.deepEqual(Object.keys(human).sort(), ['container', 'sender', 'thread']);
  assert.deepEqual(human.container, ['#acme-web']);
  const slack = byType(itemKeys(item({ id: 'slack:T0ACME:C0ACMEWEB1:1767600000.000100' }), { senderClass: 'human', family: '', hosts: [], apps: [] }, vocab));
  assert.deepEqual(slack.container, ['C0ACMEWEB1'], 'a Slack channel is keyed by its id: a rename keeps its answers');
  assert.deepEqual(human.sender, ['mara-quill']);

  const bot = item({ id: 'b1', author: 'Uptime Watch', authorPerson: null, isBot: true, container: '#ops', text: '🚨 DOWN https://shop.acme.example is not responding' });
  const b = byType(itemKeys(bot, { senderClass: 'bot', family: 'b1', hosts: [], apps: [] }, vocab));
  assert.deepEqual(b.host, ['shop.acme.example']);
  assert.equal(b.family?.length, 1, 'a stub floor family (the unit id) is replaced by our own');
  assert.ok(!b.family![0]!.includes('b1'));
  assert.equal(b.container, undefined, 'integration items are keyed by family/host/app, not by channel');
  // The same alert resolving keeps the family (an alert's identity, not its state).
  const up = item({ id: 'b2', author: 'Uptime Watch', authorPerson: null, isBot: true, container: '#ops', text: '✅ UP https://shop.acme.example is not responding' });
  assert.deepEqual(byType(itemKeys(up, { senderClass: 'bot', family: 'b2', hosts: [], apps: [] }, vocab)).family, b.family);
  // A floor that knows the family and hosts wins; the sender's own domain is never a host key.
  const known = byType(itemKeys(bot, { senderClass: 'bot', family: 'fam-7', hosts: ['api.acme.example'], apps: ['shop'] }, vocab));
  assert.deepEqual([known.family, known.host, known.app], [['fam-7'], ['api.acme.example'], ['shop']]);
  const tracker = item({ id: 't1', source: 'gmail', container: 'inbox', author: 'tracker@acme.tracker.example', authorPerson: null, isBot: true, subject: '[Tracker] SHOP-12', text: 'Mara commented on SHOP-12' });
  const tr = byType(itemKeys(tracker, { senderClass: 'bot', family: 'fam-t', hosts: ['acme.tracker.example', 'shop.acme.example'], apps: [] }, vocab));
  assert.deepEqual(tr.host, ['shop.acme.example']);

  const mail = item({ id: 'gmail:x:1', source: 'gmail', container: 'inbox', author: 'Lena Hart <lena@globex.example>', authorPerson: null, subject: 'Re: Invoice 118 for March', text: 'see attached' });
  const m = byType(itemKeys(mail, { senderClass: 'human', family: '', hosts: [], apps: [] }, vocab));
  assert.deepEqual(m.subject, ['invoice <n> for march|globex.example']);
  assert.deepEqual(m.domain, ['globex.example']);
  assert.equal(m.container, undefined, 'an inbox is not a container key');
  const free = item({ id: 'gmail:x:2', source: 'gmail', container: 'inbox', author: 'Sam <sam.k@gmail.com>', authorPerson: null, subject: 'Hello', text: 'hi' });
  const fm = byType(itemKeys(free, { senderClass: 'human', family: '', hosts: [], apps: [] }, vocab));
  assert.equal(fm.domain, undefined, 'never a free-mail domain');
  assert.deepEqual(fm.subject, ['hello|sam.k@gmail.com'], 'a free-mail subject is tied to the address');
  // The subject's own mail: the counterpart is the recipient.
  const sent = item({ id: 'gmail:x:3', source: 'gmail', container: 'inbox', author: 'owner@acme.example', fromSubject: true, participants: ['owner@acme.example', 'Lena Hart <lena@globex.example>'], subject: 'Offer', text: 'x' });
  assert.deepEqual(byType(itemKeys(sent, { senderClass: 'human', family: '', hosts: [], apps: [] }, vocab)).domain, ['globex.example']);
});

test('fragment keys: series and counterparts for calls, run for threads, cowork from decided work nearby', () => {
  const call = byType(fragmentKeys(frag(), { participants: ['owner', 'mara-quill', 'lena'], cowork: ['acme/web'] }, 'owner', vocab));
  assert.deepEqual(call.series, ['weekly globex sync']);
  assert.deepEqual(call.cpset, ['lena,mara-quill']);
  assert.deepEqual(call.cowork, ['acme/web']);
  assert.ok(call.token!.includes('checkout'));
  const run = byType(fragmentKeys(frag({ kind: 'thread', container: 'DM:@Mara', title: 'dm:@mara — re: deploy' }), { participants: [], cowork: [] }, 'owner', vocab));
  assert.deepEqual(run.run, ['dm:@mara']);
  assert.equal(run.series, undefined);
  const work = [
    { start: '2026-01-05T09:00:00Z', end: '2026-01-05T09:20:00Z', label: 'acme/web' }, // ends 40 min before the call
    { start: '2026-01-05T12:00:00Z', end: '2026-01-05T13:00:00Z', label: 'acme/app' }, // starts 90 min after it
  ];
  assert.deepEqual(coworkOf(frag(), work), ['acme/web']);
  assert.deepEqual(coworkOf(frag({ kind: 'work' }), work), []);
});

test('a series is active once seen on two calls; a token while it stays rare', () => {
  const stats = newPoolStats();
  const s = 'series=weekly globex sync';
  notePool(stats, 'f1#1', [s], 'call-1');
  notePool(stats, 'f1#2', [s], 'call-1');
  assert.equal(isActive(stats, s), false, 'two topics of one call are one sighting');
  notePool(stats, 'f2#1', [s], 'call-2');
  assert.equal(isActive(stats, s), true);
  notePool(stats, 'f2#1', [s], 'call-3');
  assert.equal(stats.series.get('weekly globex sync')!.size, 2, 'a unit counts once');
  for (let i = 0; i < 40; i++) notePool(stats, `u${i}`, i < 2 ? ['token=checkout'] : [], 'c');
  assert.equal(isActive(stats, 'token=checkout'), true, '2 of 43 units');
  for (let i = 40; i < 44; i++) notePool(stats, `u${i}`, ['token=checkout'], 'c');
  assert.equal(isActive(stats, 'token=checkout'), false, '6 of 47 units is not rare');
});

test('t4 keys: an integration item is its family, a person’s item its cue signature', () => {
  const bot = byType(kindKeys(item({ isBot: true, author: 'Build Bot', text: '[shop] build failed' }), { senderClass: 'bot', family: 'fam-1', hosts: [], apps: [] }));
  assert.deepEqual(bot, { family: ['fam-1'] });
  const human = byType(kindKeys(item({ text: 'Could you please restart it? <@U123>', context: [{ ref: 'r', author: 'x', ts: 't', text: 'y' }] }), { senderClass: 'human', family: '', hosts: [], apps: [] }));
  assert.deepEqual(human, { cue: ['Q,R|reply|mention'] });
  assert.equal(formOf({ raw: 'Müller, Jörg (External)' }), formOf({ raw: 'muller, jorg' }));
  assert.equal(formOf({ raw: ' Mara.Quill@Acme.example ' }), 'mara.quill@acme.example');
});

test('cues in four languages', () => {
  assert.deepEqual(cuesOf('Wann ist das Deployment fertig'), ['Q']);
  assert.deepEqual(cuesOf('можешь посмотреть, пожалуйста'), ['Q', 'R']);
  assert.deepEqual(cuesOf("I'll send it tomorrow"), ['C']);
  assert.deepEqual(cuesOf('Il checkout non funziona, errore 500'), ['I']);
  assert.deepEqual(cuesOf('сайт упал'), ['I']);
  assert.deepEqual(cuesOf('download the report'), [], '"down" is a whole word');
  assert.equal(hasMention('ping @mara'), true);
  assert.equal(hasMention('mail mara@acme.example'), false);
});
