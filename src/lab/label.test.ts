import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonl, writeJsonl } from './dataset.js';
import {
  adjudicationPrompt,
  alertOf,
  batchPrompt,
  botSampled,
  buildContextPack,
  disputeText,
  goldRowsOf,
  labelSpaceOf,
  localTime,
  mergeGold,
  negativePairs,
  normaliseTenant,
  normText,
  pairCandidates,
  pairKey,
  parseAnswers,
  renderCtx,
  renderFragment,
  renderItem,
  renderMention,
  retryPrompt,
  runLabel,
  samplePairs,
  seededShuffle,
  selectUnits,
  settle,
  systemPrompt,
  templateOf,
  type Answer,
  type PairCandidate,
  type PairRow,
} from './label.js';
import type { DatasetMeta, FragmentUnit, GoldRow, ItemUnit, LlmLike, MentionUnit } from './types.js';

// --- a fictional tenant: a small studio with two clients -------------------------------------------------

const REGISTRY = {
  umbrellas: { orbit: { name: 'Orbit Labs', billing: 'monthly' }, lumen: { name: 'Lumen Books' } },
  companies: [{ id: 'orbit', umbrella: 'orbit', name: 'Orbit Labs' }],
  notes: { codes: 'O-codes are Orbit work packages.' },
  initiatives: [
    {
      id: 'orbit/app',
      name: 'Orbit mobile app',
      umbrella: 'orbit',
      company: 'orbit',
      status: 'active',
      billing_code: 'O1',
      notes: 'iOS and Android client.',
      people: [{ email_or_name: 'ada@orbit.example', role: 'client PM' }],
      sources: { repos: ['studio/orbit-app'], slack_channels: [{ id: 'C0FICT01', name: 'ext-orbit' }], youtrack_prefixes: ['ORB'], calendar_title_patterns: ['orbit sync'] },
    },
    { id: 'orbit/admin', name: 'Orbit admin', umbrella: 'orbit', sources: {} },
    { id: 'lumen/site', name: 'Lumen website', umbrella: 'lumen', status: 'done', sources: { slack_channels: ['lumen-dev'], youtrack_projects: { LUM: 'Lumen Web' } } },
    { id: 'lumen/old-site', alias_of: 'lumen/site', status: 'alias', sources: { slack_channels: ['lumen-legacy'] } },
    { id: 'studio/split', split_into: { 'orbit/app': 0.3, 'lumen/site': 0.7 }, sources: {} },
    { id: 'personal/personal', name: 'Private life', umbrella: 'personal', sources: {} },
  ],
};
const PEOPLE = [
  { person_id: 'mia-hart', name: 'Mia Hart', company: 'studio', identities: ['mia@studio.example', 'slack:Mia Hart'] },
  { person_id: 'ada-byrne', name: 'Ada Byrne', company: 'orbit', marker: { type: 'exclusive', initiatives: ['orbit/app'] }, identities: ['ada@orbit.example', 'slack:Ada Byrne'] },
  { person_id: 'bo-chen', name: 'Bo Chen', company: 'lumen', marker: { type: 'narrow', initiatives: ['lumen/site'] }, identities: ['bo.chen@lumen.example'] },
  { person_id: 'jorg-lang', name: 'Jörg Lang', company: 'studio', marker: { type: 'broad', initiatives: [] }, identities: ['slack:Jörg Lang'] },
];
const RULES = [
  { id: 'r1', when: { container: '#ext-orbit' }, then: { initiative: 'orbit/app' }, note: 'client channel' },
  { id: 'r2', when: { title_re: 'weekly', source: 'gmeet' }, then: { candidates: ['orbit/app', 'lumen/site'] } },
];
const ATTRIBUTION = { subject: 'mia-hart', admin: { orbit: 'orbit/admin' } };

const META: DatasetMeta = {
  name: 'bench-fiction',
  kind: 'synthetic',
  tenant: 'northwind',
  tz: 'Europe/Zurich',
  since: '2026-09-01',
  until: '2026-09-30',
  subject: 'mia-hart',
  createdAt: '2026-10-01T00:00:00Z',
  sourceStore: 'test',
  labelSpace: { initiatives: ['orbit/app', 'orbit/admin', 'lumen/site', 'personal/personal'], umbrellas: {}, people: ['mia-hart', 'ada-byrne', 'bo-chen', 'jorg-lang'] },
  counts: {},
};

const tenant = () => normaliseTenant({ registry: REGISTRY, people: PEOPLE, rules: RULES, attribution: ATTRIBUTION });
const space = () => labelSpaceOf(META, tenant());

const frag = (id: string, over: Partial<FragmentUnit>): FragmentUnit => ({
  id,
  day: '2026-09-14',
  kind: 'thread',
  start: '2026-09-14T07:00:00Z',
  end: '2026-09-14T07:30:00Z',
  minutes: 30,
  title: '',
  source: 'slack',
  container: null,
  participants: ['mia-hart'],
  projectKeys: [],
  repo: null,
  weight: 1,
  refs: [],
  text: '',
  ...over,
});

const item = (id: string, over: Partial<ItemUnit>): ItemUnit => ({
  id,
  day: '2026-09-14',
  ts: '2026-09-14T08:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0FICT',
  container: '#general',
  thread: null,
  author: 'Ada Byrne',
  authorPerson: 'ada-byrne',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text: '',
  keys: [],
  fromSubject: false,
  ...over,
});

// --- tenant, label space, context pack ------------------------------------------------------------------

test('normaliseTenant — bare or wrapped lists, umbrellas as a map or a list', () => {
  const bare = normaliseTenant({ registry: [{ id: 'a/x', sources: {} }, { name: 'no id' }], people: { people: PEOPLE }, rules: { rules: RULES } });
  assert.deepEqual(bare.initiatives.map((i) => i.id), ['a/x']);
  assert.equal(bare.people.length, 4);
  assert.equal(bare.rules.length, 2);
  assert.equal(bare.attribution, null);
  const t = tenant();
  assert.deepEqual(t.umbrellas.map((u) => [u.id, u.name]), [['orbit', 'Orbit Labs'], ['lumen', 'Lumen Books']]);
  assert.deepEqual(normaliseTenant({ registry: { umbrellas: [{ id: 'u1', name: 'U' }], initiatives: [] } }).umbrellas, [{ id: 'u1', name: 'U' }]);
  assert.deepEqual(t.notes, [['codes', 'O-codes are Orbit work packages.']]);
});

test('labelSpaceOf — aliases resolve (a split to its parts, largest first), personal, admin, people', () => {
  const s = space();
  assert.deepEqual(s.initiatives, META.labelSpace.initiatives);
  assert.deepEqual(s.aliases, { 'lumen/old-site': ['lumen/site'], 'studio/split': ['lumen/site', 'orbit/app'] });
  assert.equal(s.personal, 'personal/personal');
  assert.deepEqual(s.admin, { orbit: 'orbit/admin' });
  assert.equal(s.subject, 'mia-hart');
  assert.deepEqual(s.people, ['mia-hart', 'ada-byrne', 'bo-chen', 'jorg-lang']);
  // No label space in meta → the registry's own non-alias ids.
  const bare = labelSpaceOf({ ...META, labelSpace: { initiatives: [], umbrellas: {}, people: [] } }, tenant());
  assert.deepEqual(bare.initiatives, ['orbit/app', 'orbit/admin', 'lumen/site', 'personal/personal']);
});

test('buildContextPack — registry routes in every layout, rules as sentences, roster, subject, zone', () => {
  const pack = buildContextPack(META, tenant(), space());
  assert.equal(pack, buildContextPack(META, tenant(), space()), 'deterministic — it is the cached system-prompt prefix');
  for (const want of [
    'Time zone: Europe/Zurich',
    'Subject — the owner whose stream this is: `mia-hart` — Mia Hart, studio; identities: mia@studio.example, slack:Mia Hart',
    '- `orbit/app` — "Orbit mobile app" · umbrella orbit · company orbit · billing O1 · status active',
    'repos: studio/orbit-app; slack channels: ext-orbit; youtrack keys: ORB; call titles: "orbit sync"',
    'people: ada@orbit.example (client PM)',
    'notes: iOS and Android client.',
    'youtrack projects: LUM (Lumen Web)',
    '- `lumen/old-site` — alias of `lumen/site` (answer that id)',
    '- `studio/split` — split into `orbit/app` 30% / `lumen/site` 70% (answer the parts)',
    '- umbrella orbit → `orbit/admin`',
    '- `orbit` — Orbit Labs · billing: monthly',
    '- codes: O-codes are Orbit work packages.',
    '- `ada-byrne` — Ada Byrne · company orbit · marker exclusive → orbit/app',
    '    identities: ada@orbit.example, slack:Ada Byrne',
    '- `mia-hart` — Mia Hart · company studio · THE SUBJECT',
    '- r1: container = "#ext-orbit" → orbit/app — client channel',
    '- r2: title ~ /weekly/i AND source = gmeet → one of orbit/app | lumen/site (content decides)',
    'Initiative labels: `orbit/app`, `orbit/admin`, `lumen/site`, `personal/personal`, `none`, `unregistered`',
    'Person ids: `mia-hart`, `ada-byrne`, `bo-chen`, `jorg-lang`',
  ]) {
    assert.ok(pack.includes(want), `pack lacks: ${want}`);
  }
  // A registry id the dataset left out of the label space is shown, but marked.
  const narrow = { ...META, labelSpace: { ...META.labelSpace, initiatives: ['orbit/app', 'lumen/site', 'personal/personal'] } };
  assert.ok(buildContextPack(narrow, tenant(), labelSpaceOf(narrow, tenant())).includes('- `orbit/admin` — not in the label list — "Orbit admin"'));
});

test('systemPrompt — shared prefix first, then the task; the label definitions are in it', () => {
  const s = space();
  const pack = buildContextPack(META, tenant(), s);
  const t1 = systemPrompt('t1-fragment', pack, s);
  const t4 = systemPrompt('t4', pack, s);
  const prefix = t1.slice(0, t1.indexOf(pack) + pack.length);
  assert.ok(t4.startsWith(prefix), 'every task shares the preamble + pack prefix');
  assert.ok(t1.includes('Private life (family, health, home, personal finance or shopping) → "personal/personal"'));
  assert.ok(t1.includes("that client umbrella's admin bucket"));
  for (const k of ['incident:', 'request:', 'question:', 'commitment:', 'info:', 'noise:']) assert.ok(t4.includes(`- ${k}`), k);
  assert.ok(t4.includes('addresses the account owner (the subject, `mia-hart`)'));
  assert.ok(systemPrompt('t3-identity', pack, s).includes('"ann-lee+bo-chen"'));
  assert.ok(systemPrompt('t2-pairs', pack, s).includes('so that deciding A also decides B?'));
});

// --- rendering ---------------------------------------------------------------------------------------------

test('renderers — local times, names, truncation, and never the production answer', () => {
  const ctx = renderCtx(META, tenant());
  assert.equal(localTime('2026-09-14T07:00:00Z', 'Europe/Zurich'), '2026-09-14 09:00');
  assert.equal(localTime('not a time', 'Europe/Zurich'), 'not a time');
  const f = renderFragment(
    frag('frag-1', { kind: 'call', title: 'Orbit sync', participants: ['mia-hart', 'ada-byrne'], weight: 0.4, text: 'x'.repeat(2500), ladder: { state: 'decided', initiative: 'leak-initiative' } }),
    'u1',
    ctx,
  );
  assert.ok(f.startsWith('[u1] call fragment · 2026-09-14 09:00 · 30 min · topic share 40%'));
  assert.ok(f.includes('participants: Mia Hart (mia-hart), Ada Byrne (ada-byrne)'));
  assert.ok(f.includes(`${'x'.repeat(2000)}…`) && !f.includes('x'.repeat(2001)));
  assert.ok(!f.includes('leak'));
  const i = renderItem(
    item('slack:T0FICT:C1:1', {
      container: 'dm:@ada',
      participants: ['Ada Byrne', 'Mia Hart'],
      toPersons: ['leak-addressee'],
      subject: 're: release',
      keys: ['ORB-12'],
      text: 'Can you review ORB-12 today?',
      context: [{ ref: 'r0', author: 'Mia Hart', ts: '2026-09-14T07:55:00Z', text: 'pushed the fix' }],
    }),
    'u2',
    ctx,
  );
  assert.ok(i.startsWith('[u2] message · 2026-09-14 10:00 · slack · dm:@ada'));
  assert.ok(i.includes('from: Ada Byrne (= ada-byrne)'));
  assert.ok(i.includes('participants: Mia Hart'));
  assert.ok(i.includes('earlier in the thread:\n  · 2026-09-14 09:55 Mia Hart: pushed the fix'));
  assert.ok(!i.includes('leak'));
  const m: MentionUnit = {
    id: 'mention:attendee:1',
    day: '2026-09-14',
    raw: 'Ada Byrne Bo Chen',
    field: 'attendee',
    source: 'gmeet',
    ref: 'meeting:gmeet:1',
    seen: 2,
    context: { title: 'Orbit sync', start: '2026-09-14T07:00:00Z', coMentions: ['mia@studio.example'], linkedEvent: { title: 'Orbit sync', start: '2026-09-14T07:00:00Z', attendees: ['ada@orbit.example', 'bo.chen@lumen.example'] }, speakers: ['Ada Byrne', 'Bo Chen'] },
    production: 'leak-person',
  };
  const r = renderMention(m, 'u3', ctx);
  assert.ok(r.includes('raw: "Ada Byrne Bo Chen"'));
  assert.ok(r.includes('linked calendar event: "Orbit sync" 2026-09-14 09:00 · attendees: ada@orbit.example, bo.chen@lumen.example'));
  assert.ok(r.includes('transcript speakers: Ada Byrne, Bo Chen'));
  assert.ok(!r.includes('leak'));
});

test('prompt builders — pass tag, retry names the errors, adjudication offers unsure and both answers', () => {
  const shown = [
    { id: 'a', handle: 'u1', text: '[u1] one' },
    { id: 'b', handle: 'u2', text: '[u2] two' },
  ];
  const p = batchPrompt('t1-item', shown, 'B');
  assert.ok(p.startsWith('Pass B. Label each of the 2 units below.'));
  assert.ok(p.includes('[u1] one\n\n---\n\n[u2] two'));
  assert.ok(p.endsWith('one object for each of u1, u2.'));
  const r = retryPrompt('t1-item', shown.slice(1), ['u2: label "orbit" is not in the closed list'], 'A');
  assert.ok(r.startsWith('Pass A, retry.') && r.includes('- u2: label "orbit" is not in the closed list') && !r.includes('[u1]'));
  const A: Answer = { label: 'orbit/app', confidence: 0.8, rationale: 'repo match' };
  const B: Answer = { label: 'lumen/site', alts: ['orbit/app'], confidence: 0.6, rationale: 'channel' };
  const d = disputeText('t1-item', '[u1] one', 'a', A, B, ['label']);
  assert.ok(d.includes('label orbit/app · confidence 0.80 — "repo match"'));
  assert.ok(d.includes('label lumen/site (also: orbit/app) · confidence 0.60 — "channel"'));
  assert.ok(disputeText('t1-item', 'x', 'a', A, 'invalid', ['label']).includes('(no valid answer)'));
  const adj = adjudicationPrompt('t4', [{ id: 'a', handle: 'u1', text: d }]);
  assert.ok(adj.startsWith('Adjudication.') && adj.includes('"kind" and "addressee" may each also be "unsure"'));
});

// --- answers ------------------------------------------------------------------------------------------------

test('parseAnswers t1 — aliases and case resolve, splits become alts, bad labels are named', () => {
  const s = space();
  const text =
    'Sure:\n```json\n[{"id":"U1","label":"Lumen/Old-Site","confidence":0.9,"rationale":"legacy channel"},' +
    '{"id":"u2","label":"orbit","confidence":0.5},' +
    '{"id":"[u3]","label":"studio/split","alts":["nope","orbit/admin"],"confidence":85},' +
    '{"id":"u4","label":"unregistered:new-lead","rationale":"' +
    'w '.repeat(30) +
    '"},' +
    '{"id":"u9","label":"none"}]\n```';
  const { answers, errors } = parseAnswers(text, 't1-item', ['u1', 'u2', 'u3', 'u4', 'u5'], s);
  assert.deepEqual(answers.get('u1'), { label: 'lumen/site', confidence: 0.9, rationale: 'legacy channel' });
  assert.equal(answers.has('u2'), false);
  assert.deepEqual(answers.get('u3'), { label: 'lumen/site', alts: ['orbit/app', 'orbit/admin'], confidence: 0.85, rationale: '' });
  assert.equal(answers.get('u4')!.label, 'unregistered');
  assert.equal(answers.get('u4')!.rationale.split(' ').length, 20);
  assert.equal(answers.get('u4')!.confidence, 0.5, 'missing confidence → 0.5');
  assert.deepEqual(errors, ['u2: label "orbit" is not in the closed list (did you mean "orbit/app" or "orbit/admin"?)', 'u5: missing from the answer']);
  // 'unsure' only in adjudication; a map keyed by handle is accepted too.
  assert.equal(parseAnswers('[{"id":"u1","label":"unsure"}]', 't1-item', ['u1'], s).answers.size, 0);
  assert.equal(parseAnswers('{"u1":{"label":"unsure"}}', 't1-item', ['u1'], s, true).answers.get('u1')!.label, 'unsure');
  assert.deepEqual(parseAnswers('no json at all', 't1-item', ['u1'], s).errors, ['the answer was not a JSON array of objects']);
  assert.equal(parseAnswers('[{"id":"u01","label":"none"}]', 't1-item', ['u1'], s).answers.get('u1')!.label, 'none', 'zero-padded handle');
});

test('parseAnswers t3/t4/t2 — glued ids sorted, addressees in setKey form, same/different', () => {
  const s = space();
  const t3 = parseAnswers(
    JSON.stringify([
      { id: 'u1', label: 'Bo-Chen+ada-byrne' },
      { id: 'u2', label: 'ada-byrne+Unknown' },
      { id: 'u3', label: 'System' },
      { id: 'u4', label: 'zed' },
      { id: 'u5', label: 'system+ada-byrne' },
    ]),
    't3-identity',
    ['u1', 'u2', 'u3', 'u4', 'u5'],
    s,
  );
  assert.deepEqual([...t3.answers].map(([h, a]) => [h, a.label]), [['u1', 'ada-byrne+bo-chen'], ['u2', 'ada-byrne+unknown'], ['u3', 'system']]);
  assert.equal(t3.errors.length, 2);
  const t4 = parseAnswers(
    JSON.stringify([
      { id: 'u1', kind: 'Request', addressee: ['bo-chen', 'Ada-Byrne'], confidence: 0.9 },
      { id: 'u2', kind: 'noise', addressee: [] },
      { id: 'u3', kind: 'info', addressee: 'none' },
      { id: 'u4', kind: 'fyi', addressee: [] },
      { id: 'u5', kind: 'question' },
      { id: 'u6', kind: 'question', addressee: ['@mia-hart'] },
    ]),
    't4',
    ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
    s,
  );
  assert.deepEqual([...t4.answers].map(([h, a]) => [h, a.label, a.addressee]), [
    ['u1', 'request', 'ada-byrne|bo-chen'],
    ['u2', 'noise', 'none'],
    ['u3', 'info', 'none'],
    ['u6', 'question', 'mia-hart'],
  ]);
  assert.ok(t4.errors[0]!.startsWith('u4: kind "fyi" is not one of request'));
  assert.ok(t4.errors[1]!.startsWith('u5: addressee is missing'));
  const t2 = parseAnswers('[{"id":"p1","label":true},{"id":"p2","label":"Different"},{"id":"p3","label":"maybe"}]', 't2-pairs', ['p1', 'p2', 'p3'], s);
  assert.deepEqual([...t2.answers].map(([h, a]) => [h, a.label]), [['p1', 'same'], ['p2', 'different']]);
  assert.equal(t2.errors.length, 1);
});

test('settle — agreement, adjudication, unsure, invalid and error per field', () => {
  const a = (label: string, extra: Partial<Answer> = {}): Answer => ({ label, confidence: 0.8, rationale: 'r', ...extra });
  const agreed = settle('t1-item', a('orbit/app', { alts: ['lumen/site', 'orbit/admin'] }), a('orbit/app', { alts: ['lumen/site'], confidence: 0.6 }));
  assert.equal(agreed.label!.outcome, 'agreed');
  assert.deepEqual(agreed.label!.alts, ['lumen/site'], 'alts both passes gave');
  assert.ok(Math.abs(agreed.label!.confidence! - 0.7) < 1e-9);
  const adj = settle('t1-item', a('orbit/app'), a('lumen/site'), a('lumen/site', { alts: ['orbit/app'], rationale: 'both topics' }));
  assert.deepEqual(adj.label, { outcome: 'adjudicated', label: 'lumen/site', alts: ['orbit/app'], confidence: 0.8, rationale: 'both topics' });
  assert.equal(settle('t1-item', a('orbit/app'), a('lumen/site'), a('unsure')).label!.outcome, 'unsure');
  assert.equal(settle('t1-item', a('orbit/app'), 'invalid', a('orbit/app')).label!.outcome, 'adjudicated');
  assert.equal(settle('t1-item', 'invalid', 'invalid').label!.outcome, 'invalid');
  assert.equal(settle('t1-item', a('orbit/app'), 'error').label!.outcome, 'error');
  assert.equal(settle('t1-item', a('orbit/app'), a('lumen/site'), 'invalid').label!.outcome, 'invalid');
  // t4: the agreed field keeps the passes' value even if the adjudicator says otherwise.
  const t4 = settle('t4', a('request', { addressee: 'mia-hart' }), a('request', { addressee: 'none' }), a('question', { addressee: 'ada-byrne|mia-hart' }));
  assert.deepEqual([t4.label!.outcome, t4.label!.label, t4.addressee!.outcome, t4.addressee!.label], ['agreed', 'request', 'adjudicated', 'ada-byrne|mia-hart']);
  const rows = goldRowsOf('t4', 'i1', t4);
  assert.deepEqual(rows.map((r) => [r.task, r.label, r.agree, r.tier]), [['t4-kind', 'request', 1, 'opus'], ['t4-addressee', 'ada-byrne|mia-hart', 0.5, 'opus']]);
  assert.deepEqual(goldRowsOf('t1-item', 'x', settle('t1-item', a('orbit/app'), a('lumen/site'), a('unsure'))), []);
});

test('seededShuffle — a deterministic permutation that depends on the seed', () => {
  const xs = Array.from({ length: 10 }, (_, i) => i);
  const a = seededShuffle(xs, 'B:batch');
  assert.deepEqual(a, seededShuffle(xs, 'B:batch'));
  assert.deepEqual([...a].sort((x, y) => x - y), xs);
  assert.notDeepEqual(a, seededShuffle(xs, 'B:other'));
  assert.deepEqual(xs, Array.from({ length: 10 }, (_, i) => i), 'input untouched');
});

test('selectUnits — incoming human items plus the ~10% bot sample, in a stable hash order', () => {
  const bots = Array.from({ length: 200 }, (_, i) => item(`bot-${i}`, { isBot: true }));
  const humans = Array.from({ length: 5 }, (_, i) => item(`human-${i}`, {}));
  const own = [item('own-1', { fromSubject: true }), item('own-2', { fromSubject: true, isBot: true })];
  const all = [...bots, ...humans, ...own];
  const sel = selectUnits('t4', all);
  const sampled = bots.filter((b) => botSampled(b.id)).length;
  assert.ok(sampled > 5 && sampled < 40, `~10% of 200, got ${sampled}`);
  assert.equal(sel.length, 5 + sampled);
  assert.ok(!sel.some((u) => u.id.startsWith('own')));
  assert.deepEqual(selectUnits('t4', [...all].reverse()).map((u) => u.id), sel.map((u) => u.id), 'order does not depend on the input order');
  assert.deepEqual(selectUnits('t4', all, 3).map((u) => u.id), sel.slice(0, 3).map((u) => u.id), '--limit takes a prefix of the same order');
  assert.equal(selectUnits('t1-fragment', [frag('f1', {}), frag('f2', {})]).length, 2);
});

// --- t2 pairs -----------------------------------------------------------------------------------------------

test('pairCandidates — template families, cross-posts, alert flaps; placeholders and short chatter make none', () => {
  const at = (min: number) => new Date(Date.parse('2026-09-14T08:00:00Z') + min * 60_000).toISOString();
  const items = [
    item('d1', { author: 'Deploy Bot', isBot: true, ts: at(0), text: 'Deploy of orbit-app 1.2.3 finished on prod' }),
    item('d2', { author: 'Deploy Bot', isBot: true, ts: at(60), text: 'Deploy of orbit-app 1.2.4 finished on prod' }),
    item('x1', { author: 'Cloud Bot', isBot: true, container: '#ops', ts: at(1), text: 'ALARM: api-5xx high in prod cluster, threshold crossed for 5 minutes' }),
    item('x2', { author: 'Cloud Bot', isBot: true, container: '#general', ts: at(2), text: 'ALARM: api-5xx high in prod cluster, threshold crossed for 5 minutes' }),
    item('w1', { author: 'Alert Bot', isBot: true, container: '#alerts', ts: at(3), text: 'warning BlackboxDomainFlapping <https://shop.orbit.example|shop>' }),
    item('r1', { author: 'Alert Bot', isBot: true, container: '#alerts', ts: at(8), text: 'resolved BlackboxDomainFlapping <https://shop.orbit.example|shop>' }),
    item('r2', { author: 'Alert Bot', isBot: true, container: '#alerts', ts: at(9), text: 'resolved BlackboxDomainFlapping <https://www.lumen.example|www>' }),
    item('s1', { container: '#a', ts: at(4), text: '[BODY WITHHELD: credential carrier — see vault v1]' }),
    item('s2', { container: '#b', ts: at(5), text: '[BODY WITHHELD: credential carrier — see vault v1]' }),
    item('k1', { ts: at(6), text: 'ok' }),
    item('k2', { ts: at(7), text: 'ok' }),
  ];
  assert.equal(templateOf(items[0]!), 'deploy of orbit app <n> finished');
  assert.deepEqual(alertOf(items[4]!), { state: 'bad', rule: 'blackboxdomainflapping', host: 'shop.orbit.example' });
  assert.equal(normText('Ping ada@orbit.example at https://x.example/a?b=1 re 3fa9c2e81b, id 42!'), 'ping <email> at <url> re <hex> id <n>');
  const c = pairCandidates(items);
  const got = c.map((p) => [p.a, p.b, p.type, p.cls]);
  assert.deepEqual(got, [
    ['x1', 'x2', 'prefix', 'bot'],
    ['w1', 'r1', 'alert', 'bot'],
    ['d1', 'd2', 'template', 'bot'],
    ['r1', 'r2', 'template', 'bot'],
  ]);
});

test('samplePairs — equal strata, leftovers redistributed, round-robin over families', () => {
  const mk = (type: PairCandidate['type'], cls: PairCandidate['cls'], fam: string, n: number): PairCandidate[] =>
    Array.from({ length: n }, (_, i) => ({ a: `${type}-${cls}-${fam}-${i}`, b: `${type}-${cls}-${fam}-${i}b`, type, cls, family: fam }));
  const cands = [...mk('template', 'bot', 'big', 100), ...mk('template', 'bot', 'small', 2), ...mk('alert', 'bot', 'flap', 50), ...mk('template', 'human', 'h', 3)];
  const s = samplePairs(cands, 30);
  assert.equal(s.length, 30);
  assert.deepEqual(samplePairs(cands, 30), s, 'deterministic');
  const count = (f: (p: PairCandidate) => boolean) => s.filter(f).length;
  assert.equal(count((p) => p.cls === 'human'), 3, 'a small stratum gives all it has');
  assert.equal(count((p) => p.type === 'alert'), 14);
  assert.equal(count((p) => p.type === 'template' && p.cls === 'bot'), 13);
  assert.equal(count((p) => p.family === 'small'), 2, 'every family is visited before a big one repeats');
  assert.equal(samplePairs(cands, 1000).length, cands.length);
});

test('negativePairs — same day, different template, never a candidate, deterministic', () => {
  const items = Array.from({ length: 12 }, (_, i) =>
    item(`n${i}`, { day: i < 6 ? '2026-09-14' : '2026-09-15', ts: `2026-09-${i < 6 ? 14 : 15}T0${i % 6}:00:00Z`, author: `Person ${i % 3}`, text: `topic ${String.fromCharCode(97 + i)} about something different` }),
  );
  const exclude = new Set([pairKey('n0', 'n1')]);
  const neg = negativePairs(items, 8, exclude);
  assert.equal(neg.length, 8);
  assert.deepEqual(negativePairs(items, 8, exclude), neg);
  const byId = new Map(items.map((u) => [u.id, u]));
  for (const p of neg) {
    assert.equal(byId.get(p.a)!.day, byId.get(p.b)!.day);
    assert.ok(byId.get(p.a)!.ts <= byId.get(p.b)!.ts);
    assert.notEqual(templateOf(byId.get(p.a)!), templateOf(byId.get(p.b)!));
    assert.ok(!exclude.has(pairKey(p.a, p.b)));
    assert.equal(p.type, 'negative');
  }
});

test('mergeGold — other tiers stay, re-labelled opus rows are replaced, other opus rows stay', () => {
  const g = (id: string, tier: GoldRow['tier'], label: string): GoldRow => ({ id, task: 't1-item', label, tier });
  const merged = mergeGold([g('a', 'human', 'x'), g('a', 'opus', 'old'), g('b', 'opus', 'old'), g('c', 'opus', 'keep')], [g('a', 'opus', 'new')], new Set(['a', 'b']), (r) => r.id);
  assert.deepEqual(merged.map((r) => [r.id, r.tier, r.label]), [['a', 'human', 'x'], ['c', 'opus', 'keep'], ['a', 'opus', 'new']]);
});

// --- end to end with a fake model ----------------------------------------------------------------------------

type Ask = { kind: 'A' | 'B' | 'adj'; retry: boolean; handle: string; block: string };

// Answers per unit block, the way the real model sees them: the handle in brackets, the unit text after it.
function fakeLlm(answer: (q: Ask) => Record<string, unknown> | null): { llm: LlmLike; prompts: string[] } {
  const prompts: string[] = [];
  const llm: LlmLike = {
    async call({ prompt }) {
      prompts.push(prompt);
      const head = prompt.split('\n')[0]!;
      const kind = head.startsWith('Adjudication') ? 'adj' : head.startsWith('Pass B') ? 'B' : 'A';
      const rows: Record<string, unknown>[] = [];
      for (const part of prompt.split('\n\n---\n\n')) {
        const m = /\[([up]\d+)\]/.exec(part);
        const r = m ? answer({ kind, retry: head.includes('retry'), handle: m[1]!, block: part }) : null;
        if (r) rows.push({ id: m![1], confidence: 0.9, rationale: 'fake', ...r });
      }
      return { text: JSON.stringify(rows), costUsd: 0.01, cached: false };
    },
  };
  return { llm, prompts };
}

function fixtureDataset(): string {
  const dir = mkdtempSync(join(tmpdir(), 'label-test-'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(META));
  mkdirSync(join(dir, 'tenant', 'annotations'), { recursive: true });
  writeFileSync(join(dir, 'tenant', 'initiatives.json'), JSON.stringify(REGISTRY));
  writeFileSync(join(dir, 'tenant', 'annotations', 'people.json'), JSON.stringify(PEOPLE));
  writeFileSync(join(dir, 'tenant', 'annotations', 'rules.json'), JSON.stringify(RULES));
  writeFileSync(join(dir, 'tenant', 'annotations', 'attribution.json'), JSON.stringify(ATTRIBUTION));
  writeJsonl(join(dir, 'units', 'fragment.jsonl'), [
    frag('frag-1', { kind: 'call', title: 'Orbit sync', participants: ['mia-hart', 'ada-byrne'], text: 'ORBIT release planning for the store submission' }),
    frag('frag-2', { container: '#lumen-dev', participants: ['mia-hart', 'bo-chen'], text: 'LUMEN homepage hero copy review' }),
    frag('frag-3', { container: 'dm:@jorg', participants: ['mia-hart', 'jorg-lang'], text: 'DENTIST appointment moved to Friday' }),
  ]);
  writeJsonl(join(dir, 'units', 'item.jsonl'), [
    item('i1', { container: 'dm:@ada', text: 'Can you review the ORB-12 fix today?' }),
    item('i2', { container: '#lumen-dev', author: 'Bo Chen', authorPerson: 'bo-chen', text: 'FYI the staging site is updated' }),
    item('i3', { fromSubject: true, author: 'Mia Hart', authorPerson: 'mia-hart', text: 'own message' }),
  ]);
  return dir;
}

test('runLabel t1-fragment — retry, alias agreement, adjudication, idempotent gold', async () => {
  const dir = fixtureDataset();
  try {
    writeJsonl(join(dir, 'gold', 't1-fragment.jsonl'), [
      { id: 'frag-1', task: 't1-fragment', label: 'orbit/app', tier: 'human' },
      { id: 'frag-2', task: 't1-fragment', label: 'stale', tier: 'opus', agree: 1 },
      { id: 'frag-9', task: 't1-fragment', label: 'orbit/app', tier: 'opus', agree: 1 },
    ]);
    const { llm, prompts } = fakeLlm(({ kind, retry, block }) => {
      if (block.includes('ORBIT')) return { label: kind === 'A' && !retry ? 'orbit' : 'orbit/app' };
      if (block.includes('LUMEN')) return { label: kind === 'B' ? 'lumen/old-site' : 'lumen/site' };
      if (block.includes('DENTIST')) return { label: kind === 'B' ? 'none' : 'personal/personal' };
      return null;
    });
    const sum = await runLabel({ dir, task: 't1-fragment', batchSize: 16 }, llm);
    assert.equal(sum.selected, 3);
    const f = sum.stats!.fields.label!;
    assert.deepEqual([f.bothValid, f.agreed, f.adjudicated, f.unsure, f.invalid, f.error], [3, 2, 1, 0, 0, 0]);
    assert.equal(sum.stats!.retries, 1);
    assert.equal(sum.stats!.calls, 4, 'A, its retry, B, one adjudication');
    assert.ok(prompts.some((p) => p.startsWith('Pass A, retry.') && p.includes('label "orbit" is not in the closed list')));
    assert.ok(prompts.some((p) => p.startsWith('Adjudication.') && p.includes('DENTIST') && !p.includes('ORBIT')));
    const rows = () => readJsonl<GoldRow>(join(dir, 'gold', 't1-fragment.jsonl'));
    const want = [
      ['frag-1', 'human', 'orbit/app', undefined],
      ['frag-9', 'opus', 'orbit/app', 1],
      ['frag-1', 'opus', 'orbit/app', 1],
      ['frag-2', 'opus', 'lumen/site', 1],
      ['frag-3', 'opus', 'personal/personal', 0.5],
    ];
    const shape = () => rows().map((r) => [r.id, r.tier, r.label, r.agree]).sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    const sorted = [...want].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    assert.deepEqual(shape(), sorted);
    await runLabel({ dir, task: 't1-fragment', batchSize: 16 }, llm);
    assert.deepEqual(shape(), sorted, 'a re-run replaces its own rows, nothing doubles');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLabel t4 — one call per pass, two gold files, the subject’s own items skipped; dry run calls nothing', async () => {
  const dir = fixtureDataset();
  try {
    const { llm, prompts } = fakeLlm(({ kind, block }) => {
      if (block.includes('ORB-12')) return { kind: 'request', addressee: kind === 'B' ? [] : ['mia-hart'] };
      if (block.includes('staging')) return { kind: 'info', addressee: [] };
      return null;
    });
    const sum = await runLabel({ dir, task: 't4' }, llm);
    assert.equal(sum.selected, 2);
    assert.ok(!prompts.some((p) => p.includes('own message')));
    assert.deepEqual(sum.files.map((f) => [f.task, f.rows]), [['t4-kind', 2], ['t4-addressee', 2]]);
    const kinds = readJsonl<GoldRow>(join(dir, 'gold', 't4-kind.jsonl'));
    const addr = readJsonl<GoldRow>(join(dir, 'gold', 't4-addressee.jsonl'));
    assert.deepEqual(kinds.map((r) => [r.id, r.label, r.agree]).sort(), [['i1', 'request', 1], ['i2', 'info', 1]]);
    // The adjudicator (fake: the 'A' branch) settles i1's addressee.
    assert.deepEqual(addr.map((r) => [r.id, r.label, r.agree]).sort(), [['i1', 'mia-hart', 0.5], ['i2', 'none', 1]]);
    let called = false;
    const dry = await runLabel({ dir, task: 't3-identity', dryRun: true }, { call: async () => ((called = true), { text: '', costUsd: 0, cached: false }) }).catch((e: Error) => e);
    assert.ok(dry instanceof Error && /no units/.test(dry.message), 'no mention units in the fixture');
    const dry2 = await runLabel({ dir, task: 't1-item', dryRun: true, log: () => {} }, null);
    assert.equal(dry2.stats, null);
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLabel t2-pairs — candidates and negatives judged, rows keyed by pair', async () => {
  const dir = fixtureDataset();
  try {
    const at = (min: number) => new Date(Date.parse('2026-09-14T08:00:00Z') + min * 60_000).toISOString();
    writeJsonl(join(dir, 'units', 'item.jsonl'), [
      item('w1', { author: 'Alert Bot', isBot: true, ts: at(0), text: 'warning BlackboxDomainFlapping https://shop.orbit.example' }),
      item('r1', { author: 'Alert Bot', isBot: true, ts: at(5), text: 'resolved BlackboxDomainFlapping https://shop.orbit.example' }),
      item('h1', { ts: at(7), text: 'Lunch plans for Friday with the whole team?' }),
      item('h2', { author: 'Bo Chen', ts: at(9), text: 'The Lumen staging build is green again' }),
    ]);
    writeJsonl(join(dir, 'gold', 't2-pairs.jsonl'), [{ a: 'x', b: 'y', same: true, tier: 'synthetic' } satisfies PairRow]);
    const { llm } = fakeLlm(({ block }) => ({ label: block.includes('BlackboxDomainFlapping') && block.includes('resolved') ? 'same' : 'different' }));
    const sum = await runLabel({ dir, task: 't2-pairs', pairs: 1, negatives: 2 }, llm);
    assert.equal(sum.selected, 3);
    const rows = readJsonl<PairRow>(join(dir, 'gold', 't2-pairs.jsonl'));
    assert.deepEqual(rows[0], { a: 'x', b: 'y', same: true, tier: 'synthetic' });
    const alert = rows.find((r) => r.a === 'w1' && r.b === 'r1');
    assert.deepEqual(alert && [alert.same, alert.type, alert.agree], [true, 'alert', 1]);
    assert.equal(rows.filter((r) => r.type === 'negative' && !r.same).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
