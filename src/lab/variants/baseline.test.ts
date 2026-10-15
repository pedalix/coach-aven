import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDataset, saveMeta, writeJsonl } from '../dataset.js';
import { runTask } from '../run.js';
import type { DatasetMeta, DayCtx, FragmentUnit, ItemUnit, MentionUnit, Prediction, TaskId, Unit } from '../types.js';
import { baseline, itemDraft, tenantLadder } from './baseline.js';
import { VARIANTS } from './index.js';

// A fictional agency tenant: two clients, a registry with channels, keys and an alias, tenant rules, and
// people with markers. `admin` decides whether attribution.json (and with it the admin rung) exists.
function tenant(admin: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'lab-baseline-'));
  const t = join(dir, 'tenant');
  mkdirSync(join(t, 'annotations'), { recursive: true });
  writeFileSync(
    join(t, 'initiatives.json'),
    JSON.stringify({
      initiatives: [
        { id: 'acme/web', umbrella: 'acme', sources: { slack_channels: ['#acme-web'], youtrack_prefixes: ['WEB'] } },
        { id: 'acme/app', umbrella: 'acme', sources: { slack_channels: ['#acme-app'], jira_keys: ['APP'] } },
        { id: 'acme/admin', umbrella: 'acme', sources: {} },
        { id: 'acme/legacy', umbrella: 'acme', alias_of: 'acme/web', sources: { slack_channels: ['#acme-legacy'] } },
        // an object channel entry: production reads string entries only, so this channel routes nowhere
        { id: 'globex/ops', umbrella: 'globex', sources: { slack_channels: [{ id: 'C0GLOBEX', name: '#globex-ops' }] } },
      ],
    }),
  );
  writeFileSync(
    join(t, 'annotations', 'rules.json'),
    JSON.stringify([
      { id: 'r-alerts', when: { container: '#globex-alerts' }, then: { initiative: 'globex/ops' } },
      { id: 'r-ops-key', when: { project_key: 'OPS' }, then: { initiative: 'globex/ops' } },
      { id: 'r-broken' },
    ]),
  );
  writeFileSync(
    join(t, 'annotations', 'people.json'),
    JSON.stringify([
      { person_id: 'olive', name: 'Olive Owner', identities: ['olive@agency.example'] },
      { person_id: 'mara', name: 'Mara Quill', identities: ['mara@acme.example'], marker: { type: 'exclusive', initiatives: ['acme/app'] } },
      { person_id: 'tobias', name: 'Tobias Fenn', identities: ['tobias@globex.example'], marker: { type: 'broad', initiatives: ['globex/ops'] } },
    ]),
  );
  if (admin) writeFileSync(join(t, 'annotations', 'attribution.json'), JSON.stringify({ subject: 'olive', admin: { acme: 'acme/admin' } }));
  return dir;
}

const META: DatasetMeta = {
  name: 'agency-fixture',
  kind: 'synthetic',
  tenant: 'agency',
  tz: 'UTC',
  since: '2026-01-05',
  until: '2026-01-06',
  subject: 'olive',
  createdAt: '2026-01-07T00:00:00Z',
  sourceStore: 'test',
  labelSpace: { initiatives: ['acme/web', 'acme/app', 'acme/admin', 'globex/ops'], umbrellas: { 'acme/web': 'acme', 'acme/app': 'acme', 'acme/admin': 'acme', 'globex/ops': 'globex' }, people: ['olive', 'mara', 'tobias'] },
  counts: {},
};

const ctxFor = (dir: string, state = new Map<string, unknown>()): DayCtx => ({ dataset: META, dir, day: '2026-01-05', pool: [], memory: [], state, llm: null, log: () => {} });

const item = (id: string, extra: Partial<ItemUnit> = {}): ItemUnit => ({
  id,
  day: '2026-01-05',
  ts: '2026-01-05T09:00:00Z',
  type: 'message',
  source: 'slack',
  account: 'T0',
  container: '#random',
  thread: null,
  author: 'Tobias Fenn',
  authorPerson: 'tobias',
  isBot: false,
  participants: [],
  toPersons: [],
  subject: null,
  text: 'the staging build looks fine',
  keys: [],
  ...extra,
});

const decide = (task: TaskId, units: Unit[], ctx: DayCtx): Promise<Prediction[]> => baseline.decide(task, units, ctx);
const brief = (ps: Prediction[]) => ps.map((p) => [p.id, p.label, p.conf, p.rung]);

const ITEMS = [
  item('m-rule', { container: '#globex-alerts' }),
  item('m-key', { text: 'see OPS-12 for the rollback' }),
  item('m-channel', { container: '#acme-web' }),
  item('m-alias', { container: '#acme-legacy' }),
  item('m-marker', { author: 'Mara Quill', authorPerson: 'mara' }),
  item('youtrack:acme:WEB-7', { type: 'task', source: 'youtrack', container: null, text: 'header overlaps the menu' }),
  item('m-object-channel', { container: '#globex-ops' }),
  item('m-admin', { author: 'Mara Quill', authorPerson: 'mara', text: 'Could you send the invoice for March?' }),
];

test('t1-item, tenant without attribution.json — rules, keys, channels, aliases, markers; object channels route nowhere', async () => {
  const out = await decide('t1-item', ITEMS, ctxFor(tenant(false)));
  assert.deepEqual(brief(out), [
    ['m-rule', 'globex/ops', 1, 'rule:r-alerts'],
    ['m-key', 'globex/ops', 1, 'rule:r-ops-key'],
    ['m-channel', 'acme/web', 1, 'rule:registry:channel'],
    ['m-alias', 'acme/web', 1, 'rule:registry:channel'],
    ['m-marker', 'acme/app', 1, 'rule:marker:mara'],
    ['youtrack:acme:WEB-7', 'acme/web', 1, 'rule:registry:key'],
    // tobias is a broad marker: candidates, no decision
    ['m-object-channel', null, 0, 'ladder:open'],
    // no attribution.json → no admin rung: the exclusive marker decides
    ['m-admin', 'acme/app', 1, 'rule:marker:mara'],
  ]);
});

test('t1-item, tenant with attribution.json — the admin rung reads the item text before the markers', async () => {
  const out = await decide('t1-item', ITEMS.filter((u) => u.id === 'm-admin' || u.id === 'm-marker'), ctxFor(tenant(true)));
  assert.deepEqual(brief(out), [
    ['m-marker', 'acme/app', 1, 'rule:marker:mara'],
    ['m-admin', 'acme/admin', 1, 'rule:admin'],
  ]);
});

test('itemDraft — tracker prefixes like the fragmenter, participants from author and recipients, the subject as title', () => {
  const d = itemDraft(item('youtrack:acme:WEB-7', { type: 'task', subject: 'Fix APP-3 too', keys: ['https://tracker.example/issue/OPS-1'], toPersons: ['olive', 'tobias'] }));
  assert.deepEqual(d.projectKeys.sort(), ['APP', 'OPS', 'WEB']);
  assert.deepEqual(d.participants, ['tobias', 'olive']);
  assert.equal(d.title, 'Fix APP-3 too');
  assert.equal(d.kind, 'thread');
  // a message's id is never read for keys
  assert.deepEqual(itemDraft(item('slack:T0:C0:ABC-123')).projectKeys, []);
});

test('tenantLadder — reads what the build reads; a tenant without attribution.json has no subject or admin rung', () => {
  const on = tenantLadder(join(tenant(true), 'tenant'), 'UTC');
  assert.equal(on.self, 'olive');
  assert.deepEqual(on.admin, { acme: 'acme/admin' });
  assert.equal(on.rules.length, 2, 'the build drops the rule without when/then');
  const off = tenantLadder(join(tenant(false), 'tenant'), 'UTC', 'olive');
  assert.equal(off.self, 'olive');
  assert.equal(off.admin, undefined);
  assert.deepEqual(
    off.rules.map((r) => r.id),
    ['r-alerts', 'r-ops-key'],
    'a rule without when/then is dropped, as the build drops it',
  );
  assert.equal(off.people.get('olive')!.marker.type, 'broad');
});

test('t1-fragment — the frozen ladder: a rule state decides (alias-resolved), anything else asks', async () => {
  const frag = (id: string, ladder?: FragmentUnit['ladder']): FragmentUnit => ({
    id,
    day: '2026-01-05',
    kind: 'call',
    start: '2026-01-05T10:00:00Z',
    end: '2026-01-05T10:30:00Z',
    minutes: 30,
    title: 'Weekly sync',
    source: 'gmeet',
    container: null,
    participants: [],
    projectKeys: [],
    repo: null,
    weight: 1,
    refs: [`meeting:gmeet:${id}`],
    text: '',
    ...(ladder ? { ladder } : {}),
  });
  const out = await decide(
    't1-fragment',
    [frag('f1', { state: 'rule', initiative: 'acme/legacy', rule: 'registry:title' }), frag('f2', { state: 'open', candidates: ['acme/web', 'acme/app'] }), frag('f3'), frag('f4', { state: 'rule' })],
    ctxFor(tenant(false)),
  );
  assert.deepEqual(brief(out), [
    ['f1', 'acme/web', 1, 'rule:registry:title'],
    ['f2', null, 0, 'ladder:open'],
    ['f3', null, 0, 'abstain'],
    ['f4', null, 0, 'ladder:rule'],
  ]);
});

test('t2-dedup — exact repeats only, across days: same source, author and text after case and spaces', async () => {
  const state = new Map<string, unknown>();
  const ctx = ctxFor(tenant(false), state);
  const day1 = [
    item('a2', { author: 'alertbot', ts: '2026-01-05T09:05:00Z', text: 'deploy  finished OK' }),
    item('a1', { author: 'alertbot', ts: '2026-01-05T09:00:00Z', text: 'Deploy finished ok' }),
    item('a3', { author: 'otherbot', text: 'deploy finished ok' }),
    item('a4', { author: 'alertbot', source: 'gmail', text: 'deploy finished ok' }),
    item('a5', { author: 'alertbot', text: '   ' }),
    item('a6', { author: 'alertbot', text: '   ' }),
  ];
  const d1 = await decide('t2-dedup', day1, ctx);
  // the earliest member names the family, whatever order the units came in
  assert.deepEqual(brief(d1), [
    ['a2', 'a1', 1, 'exact-repeat'],
    ['a1', 'a1', 1, 'singleton'],
    ['a3', 'a3', 1, 'singleton'],
    ['a4', 'a4', 1, 'singleton'],
    ['a5', 'a5', 1, 'singleton'],
    ['a6', 'a6', 1, 'singleton'],
  ]);
  const d2 = await decide('t2-dedup', [item('b1', { day: '2026-01-06', ts: '2026-01-06T08:00:00Z', author: 'alertbot', text: 'DEPLOY finished ok ' })], { ...ctx, day: '2026-01-06' });
  assert.deepEqual(brief(d2), [['b1', 'a1', 1, 'exact-repeat']]);
});

test('t3, t4 — the store resolution, is_bot as noise, role=to as the addressee', async () => {
  const ctx = ctxFor(tenant(false));
  const mention = (id: string, production: string | null): MentionUnit => ({ id, day: '2026-01-05', raw: 'Mara Q.', field: 'attendee', source: 'gmeet', ref: 'meeting:gmeet:x', seen: 1, context: {}, production });
  assert.deepEqual(brief(await decide('t3-identity', [mention('n1', 'mara'), mention('n2', null)], ctx)), [
    ['n1', 'mara', 1, 'production'],
    ['n2', null, 0, 'unresolved'],
  ]);
  assert.deepEqual(brief(await decide('t4-kind', [item('k1', { isBot: true }), item('k2')], ctx)), [
    ['k1', 'noise', 0.99, 'rule:is_bot'],
    ['k2', null, 0, 'abstain'],
  ]);
  assert.deepEqual(brief(await decide('t4-addressee', [item('t1', { toPersons: ['tobias', 'mara'] }), item('t2')], ctx)), [
    ['t1', 'mara|tobias', 0.9, "rule:role='to'"],
    ['t2', null, 0, 'abstain'],
  ]);
});

test('registered and runnable — through the runner, on a dataset directory', async () => {
  const dir = tenant(false);
  saveMeta(dir, META);
  writeJsonl(join(dir, 'units', 'item.jsonl'), ITEMS);
  writeJsonl(
    join(dir, 'gold', 't1-item.jsonl'),
    ITEMS.map((u) => ({ id: u.id, task: 't1-item', label: u.id === 'm-object-channel' ? 'globex/ops' : 'acme/web', tier: 'synthetic' })),
  );
  const v = await VARIANTS.baseline!();
  assert.equal(v, baseline);
  const r = await runTask(loadDataset(dir), v, 't1-item', { mode: 'static', memory: 'none', llm: null, runName: 'baseline-test', log: () => {}, labDir: join(dir, 'lab') });
  assert.equal(r.predictions.length, ITEMS.length);
  assert.equal(r.perDay[0].decided, 7);
  assert.equal(r.perDay[0].correctDecided, 3); // m-channel, m-alias, the WEB ticket
});
