// The pre-model repeat key: templates, family keys, alert states and the fold. Bots, hosts and people are fictional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOf, familyKey, fold, headOf, senderKey, templateOf, type FoldItem, type FoldReason } from './fingerprint.js';

test('templateOf: values become typed placeholders, punctuation goes, k tokens stay', () => {
  assert.equal(templateOf('Cannot get lock for shop 12345!'), 'cannot get lock for shop <n>');
  assert.equal(templateOf('Cannot get lock for shop 67890'), templateOf('Cannot get lock for shop 12345'));
  assert.equal(templateOf('See https://shop.example/a?b=1 or <https://shop.example/x|the board>, ask ana@acme.example', { k: Infinity }), 'see <url> or <url> ask <email>');
  assert.equal(templateOf('job 3f9a2c1 run 550e8400-e29b-41d4-a716-446655440000 token ab12cd34ef56gh78', { k: Infinity }), 'job <hex> run <uuid> token <id>');
  assert.equal(templateOf('backup at 2026-10-15T03:00:00Z, next 16.10.2026 at 03:00 pm', { k: Infinity }), 'backup at <date> next <date> at <time>');
  assert.equal(templateOf('server12 is down, release 1.2.10', { k: Infinity }), 'server<n> is down release <n>', 'numbers in place; a version is no date');
  assert.equal(templateOf('the facade decade', { k: Infinity }), 'the facade decade', 'hex-looking words stay words');
  assert.equal(templateOf('<@U0ABC12345> pinged <#C0ABC12345|ops> about <b>bold</b>', { k: Infinity }), '<mention> pinged <mention> about b bold b', 'a literal <b> is never a placeholder');
  assert.equal(templateOf('Заказ №123 оплачен'), 'заказ <n> оплачен');
  assert.equal(templateOf('key [REDACTED:api_key:a1b2c3] and https://app.example/0/[REDACTED:card:d4e5f6]/7', { k: Infinity }), 'key <redacted> and <url>', 'a tag inside a link goes with the link');
  assert.equal(templateOf('[BODY WITHHELD: credential carrier — see vault 0a1b2c3d4e5f]'), '<withheld>');
  assert.equal(templateOf('one two three four five six seven eight'), 'one two three four five six');
  assert.equal(templateOf('one two three four', { k: 2 }), 'one two');
  assert.equal(templateOf(''), '');
});

test('familyKey: source + sender address + the template of the subject (reply prefixes dropped) or the text', () => {
  const a = { source: 'gmail', sender: 'Billing <billing@vendor.example>', subject: 'Re: Fwd: Invoice 1042 is ready', text: 'Hi Ana …' };
  const b = { source: 'gmail', sender: 'Vendor Billing Team <Billing@Vendor.example>', subject: 'Invoice 1043 is ready', text: 'Hello …' };
  assert.equal(familyKey(a), familyKey(b));
  assert.notEqual(familyKey(a), familyKey({ ...b, sender: 'billing@other.example' }));
  assert.equal(headOf({ subject: 'AW: WG: Angebot', text: 'x' }), 'Angebot');
  assert.equal(headOf({ subject: '', text: 'the text' }), 'the text');
  assert.equal(senderKey('Ana Berg | Acme <Ana@Acme.example>'), 'ana@acme.example');
  assert.equal(senderKey('Shop  Alert Bot'), 'shop alert bot');
});

test('alertOf: state from a leading word or emoji; the identity keeps the rule and the target', () => {
  const w = alertOf('WARNING: DiskFull: *db1.shop.example* disk is 91% full (shop-infra)');
  const r = alertOf('RESOLVED: DiskFull: *db1.shop.example* disk is 91% full (shop-infra)');
  assert.deepEqual(w, { state: 'firing', key: 'diskfull db1.shop.example disk is <n> full shop-infra' });
  assert.deepEqual(r, { state: 'resolved', key: w!.key });
  assert.notEqual(alertOf('WARNING: DiskFull: *db2.shop.example* disk is 91% full')!.key, w!.key, 'another host is another alert');
  const t = alertOf(':rotating_light: Monitor triggered: Memory is running high: Memory Utilization Percent is currently at 93.10%');
  const s = alertOf(':sunglasses: Monitor resolved: Memory is running high: Memory Utilization Percent has returned to normal');
  assert.equal(t!.state, 'firing');
  assert.equal(s!.state, 'resolved');
  assert.equal(t!.key, s!.key);
  const f = alertOf('🚨 CloudWatch Alarm | api-prod-5xx-errors | eu-central-1 | Account: 123456789012');
  const o = alertOf('✅ CloudWatch Alarm | api-prod-5xx-errors | eu-central-1 | Account: 123456789012');
  assert.deepEqual([f!.state, o!.state], ['firing', 'resolved']);
  assert.equal(f!.key, o!.key);
  assert.equal(f!.key, 'cloudwatch api-prod-5xx-errors eu-central-1 account <n>', 'state words go whichever marker decided');
  assert.equal(alertOf('CRITICAL: Server down: db1.shop.example')!.key, alertOf('RESOLVED: Server down: db1.shop.example')!.key);
  assert.equal(alertOf('[FIRING:2] QueueBacklog worker-3')!.state, 'firing');
  assert.equal(alertOf('A user signed up, no preview available'), null);
  assert.equal(alertOf('Deploy to production succeeded'), null);
  assert.equal(alertOf(''), null);
});

const at = (hhmm: string, day = 15): string => `2026-10-${day}T${hhmm}:00Z`;
const bot = (id: string, ts: string, sender: string, text: string, container = '#alerts', extra: Partial<FoldItem> = {}): FoldItem => ({ id, ts, source: 'slack', container, sender, text, isBot: true, ...extra });
const person = (id: string, ts: string, sender: string, text: string, container = '#general', extra: Partial<FoldItem> = {}): FoldItem => ({ id, ts, source: 'slack', container, sender, text, isBot: false, ...extra });
const families = (items: FoldItem[], r = fold(items)) => {
  const out = new Map<string, string[]>();
  for (const it of items) out.set(r.family.get(it.id)!, [...(out.get(r.family.get(it.id)!) ?? []), it.id]);
  return [...out.values()].map((ids) => ids.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
};

test('fold: a flapping alert and its resolved messages are one family; another host is another family', () => {
  const W = (host: string) => `WARNING: DiskFull: *${host}.shop.example* disk is 91% full (shop-infra)`;
  const R = (host: string) => `RESOLVED: DiskFull: *${host}.shop.example* disk is 91% full (shop-infra)`;
  const items = [
    bot('w1', at('10:00'), 'Shop Alert Bot', W('db1')),
    bot('r1', at('10:12'), 'Shop Alert Bot', R('db1')),
    bot('w2', at('10:30'), 'Shop Alert Bot', W('db1')),
    bot('r2', at('10:41'), 'Shop Alert Bot', R('db1')),
    bot('w3', at('11:00'), 'Shop Alert Bot', W('db2')),
    bot('r3', at('11:05'), 'Shop Alert Bot', R('db2')),
  ];
  const r = fold(items);
  assert.deepEqual(families(items, r), [['r1', 'r2', 'w1', 'w2'], ['r3', 'w3']], 'one rule, two hosts: two families');
  const why = Object.fromEntries(items.map((i) => [i.id, r.reason.get(i.id)]));
  assert.deepEqual(why, { w1: 'flap', r1: 'flap', w2: 'exact', r2: 'exact', w3: 'flap', r3: 'flap' });
  assert.deepEqual([r.canonical.get('r2'), r.canonical.get('r3')], ['w1', 'w3']);
  // The same alert with another reading later the same day still repeats the family (by its identity, not its text).
  const later = fold([...items, bot('w4', at('18:00'), 'Shop Alert Bot', W('db1').replace('91%', '97%'))]);
  assert.equal(later.family.get('w4'), later.family.get('w1'));
  assert.equal(later.reason.get('w4'), 'template');
  // Without the flap rule (a resolve hours later) the resolved messages are their own family.
  const late = fold([bot('w', at('10:00'), 'Shop Alert Bot', W('db1')), bot('r', at('13:00'), 'Shop Alert Bot', R('db1'))]);
  assert.notEqual(late.family.get('w'), late.family.get('r'));
});

test('fold: a habitual companion bot joins the alert it answers; a bot that only sometimes follows does not', () => {
  // Errors 0 and 2 share a shape (one template family); 1 and 3 are their own. Each analysis must land with ITS error.
  const errors = ['[checkout] TypeError: cannot read property total', '[search] RangeError: index out of bounds', '[checkout] TypeError: cannot read property total', '[auth] TimeoutError: upstream did not answer'];
  const items: FoldItem[] = [];
  for (const [i, h] of ['09', '11', '14', '16'].entries()) {
    items.push(bot(`e${i}`, at(`${h}:00`), 'Error Tracker', `${errors[i]} (event ${i}001)`, '#errors'));
    items.push(bot(`a${i}`, `2026-10-15T${h}:00:20Z`, 'Error Analyzer', `Error analysis for event ${i}001: likely cause ${['null cart', 'bad cursor', 'null cart', 'slow upstream'][i]}`, '#errors'));
  }
  // A deploy bot posts eight times, once right after an error: 1/8 is chance, not a habit.
  for (let i = 0; i < 8; i++) items.push(bot(`d${i}`, i === 0 ? '2026-10-15T09:01:00Z' : at(`${String(17 + (i % 6)).padStart(2, '0')}:${String(10 + i).padStart(2, '0')}`), 'Deploy Bot', `Deployed checkout build ${100 + i} to production`, '#errors'));
  const r = fold(items);
  assert.equal(r.family.get('e2'), r.family.get('e0'), 'errors of one shape fold by template');
  assert.equal(r.reason.get('e2'), 'template');
  assert.equal(new Set(['e0', 'e1', 'e3'].map((id) => r.family.get(id))).size, 3);
  for (let i = 0; i < 4; i++) {
    assert.equal(r.family.get(`a${i}`), r.family.get(`e${i}`), `analysis ${i} sits with error ${i}`);
    assert.equal(r.reason.get(`a${i}`), 'companion');
  }
  assert.equal(r.reason.get('e1'), 'companion', 'a canonical carries the reason its family formed by');
  assert.notEqual(r.family.get('d0'), r.family.get('e0'), 'the deploy bot is not the error tracker\'s companion');
  assert.equal(r.reason.get('d1'), 'template');
  assert.ok(['d0', 'd1', 'd7'].every((id) => r.family.get(id) === r.family.get('d0')), 'deploy notices of one day are one family');
  // Below the habit threshold nothing is a companion.
  assert.ok(![...fold(items, { companionMinShare: 1.01 }).reason.values()].includes('companion'));
});

test('fold: template families are windowed; a newsletter folds by its subject', () => {
  const items = [
    bot('m1', at('09:00'), 'shop-monitor', 'Cannot get lock for shop 101', '#monitor'),
    bot('m2', at('15:00'), 'shop-monitor', 'Cannot get lock for shop 202', '#monitor'),
    bot('m3', at('09:30', 16), 'shop-monitor', 'Cannot get lock for shop 303', '#monitor'),
    { id: 'n1', ts: at('08:00'), source: 'gmail', container: 'inbox', sender: 'Brand <news@brand.example>', subject: 'Autumn sale: 20% off everything', text: 'Big savings … unsubscribe', isBot: true },
    { id: 'n2', ts: at('18:00'), source: 'gmail', container: 'inbox', sender: 'Brand News <news@brand.example>', subject: 'Autumn sale: 30% off everything', text: 'Last chance … unsubscribe', isBot: true },
  ];
  const r = fold(items);
  assert.deepEqual(families(items, r), [['m1', 'm2'], ['m3'], ['n1', 'n2']]);
  assert.deepEqual([r.reason.get('m2'), r.reason.get('m3'), r.reason.get('n2')], ['template', 'single', 'template']);
  assert.equal(fold(items, { windowMinutes: 60 * 48 }).family.get('m3'), r.family.get('m1'), 'a longer window keeps the next day');
});

test('fold: people fold only on exact repeats of their own text, never into an integration family', () => {
  const items = [
    person('p1', at('10:00'), 'Ana Berg', 'Can someone restart the staging queue please?'),
    person('p2', at('10:20'), 'Ana Berg', 'can someone restart the staging   queue please?'),
    person('p3', at('10:30'), 'Rui Rosa', 'Can someone restart the staging queue please?'),
    person('p4', at('10:31'), 'Ana Berg', 'ok'),
    person('p5', at('10:40'), 'Ana Berg', 'ok'),
    person('p6', at('11:00'), 'Ana Berg', 'Cannot get lock for shop 404', '#monitor'),
    bot('b1', at('10:59'), 'shop-monitor', 'Cannot get lock for shop 404', '#monitor'),
    bot('b2', at('11:01'), 'shop-monitor', 'Cannot get lock for shop 405', '#monitor'),
    person('p7', at('12:00'), 'Ana Berg', 'Can someone restart the staging queue please?', '#ops'),
    person('p8', at('10:05'), 'Ana Berg', 'Deploy freeze starts Friday 18:00, please merge before then.', '#dev'),
    person('p9', at('10:06'), 'Ana Berg', 'Deploy freeze starts Friday 18:00, please merge before then.', '#qa'),
  ];
  const r = fold(items);
  assert.deepEqual(families(items, r), [['b1', 'b2'], ['p1', 'p2'], ['p3'], ['p4'], ['p5'], ['p6'], ['p7'], ['p8', 'p9']]);
  assert.equal(r.reason.get('p2'), 'exact');
  assert.equal(r.reason.get('p9'), 'crosspost', 'the same announcement in two channels within minutes');
  assert.equal(r.reason.get('p7'), 'single', 'the same text in another channel two hours later is a new message');
  // The property the bench checks: no family mixes people and integrations.
  for (const it of items) for (const other of items) if (r.family.get(it.id) === r.family.get(other.id)) assert.equal(it.isBot, other.isBot);
});

test('fold: an integration cross-posting to two channels; a withheld body never makes a cross-post', () => {
  const alarm = 'ALARM: checkout-api p99 latency above 2 seconds for 5 minutes in eu-central-1';
  const withheld = '[BODY WITHHELD: credential carrier — see vault 0a1b2c3d4e5f]';
  const items: FoldItem[] = [
    bot('x1', at('08:00'), 'Cloud Monitor', alarm, '#ops'),
    bot('x2', '2026-10-15T08:00:05Z', 'Cloud Monitor', alarm, '#checkout'),
    bot('x3', '2026-10-15T08:00:30Z', 'Ops Relay', alarm, '#incidents'),
    { id: 'm1', ts: at('09:00'), source: 'gmail', container: 'inbox', sender: 'ana.berg@acme.example', subject: 'access', text: withheld, isBot: false },
    { id: 'm2', ts: '2026-10-15T09:00:30Z', source: 'msgraph', container: 'mailbox:inbox', sender: 'rui.rosa@partner.example', subject: 'creds', text: withheld, isBot: false },
    { id: 'm3', ts: '2026-10-15T09:01:00Z', source: 'gmail', container: 'archive', sender: 'ana.berg@acme.example', subject: 'access', text: withheld, isBot: false },
    bot('m4', '2026-10-15T09:02:00Z', 'Vault Bot', withheld, '#ops'),
    bot('m5', '2026-10-15T09:02:30Z', 'Vault Bot', withheld, '#checkout'),
  ];
  const r = fold(items);
  assert.deepEqual(families(items, r), [['m1'], ['m2'], ['m3'], ['m4'], ['m5'], ['x1', 'x2', 'x3']]);
  assert.deepEqual([r.reason.get('x2'), r.reason.get('x3')], ['crosspost', 'crosspost']);
  assert.ok(['m1', 'm2', 'm3', 'm4', 'm5'].every((id) => r.reason.get(id) === 'single'));
});

test('fold: input order does not matter; an unparseable time never folds; defaults are explicit', () => {
  const items = [
    bot('a', at('10:00'), 'shop-monitor', 'Cannot get lock for shop 1', '#m'),
    bot('b', at('10:05'), 'shop-monitor', 'Cannot get lock for shop 2', '#m'),
    bot('c', 'not a time', 'shop-monitor', 'Cannot get lock for shop 3', '#m'),
    person('d', at('10:06'), 'Ana Berg', 'Looking at the lock problem in shop 2 now'),
  ];
  const fwd = fold(items);
  const rev = fold([...items].reverse());
  for (const it of items) assert.equal(fwd.family.get(it.id), rev.family.get(it.id));
  assert.equal(fwd.reason.get('c'), 'single');
  assert.equal(fwd.family.get('a'), 'fam:a');
  const reasons = new Set<FoldReason>([...fwd.reason.values()]);
  assert.deepEqual([...reasons].sort(), ['single', 'template']);
});
