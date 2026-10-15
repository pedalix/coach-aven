// The learning loop's loader end to end over a real store file (fictional tenant): what the learner is handed — units
// with the floor's own say, keys, cases and texts; evidence from people only; the registry's siblings and cues — and
// what lands in att_learn. Shadow: the plan, the index and the readout without `learn` stay exactly as they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, recomputeCalls } from '../store.js';
import { readAttributionInputs, recomputeAttribution } from './build.js';
import { hash } from './fragment.js';
import { Registry } from './registry.js';
import { parseAttributionConfig } from './config.js';
import { parseFragments, type Fragment } from '../annotations.js';
import type { Person } from '../people.js';
import { runAttribution } from '../../../snapshot/plain/sources-mcp.mjs';
import {
  activeKeys,
  clearLearn,
  fragmentRung,
  initiativesOf,
  isStructural,
  itemKeys,
  keyRecord,
  labelOf,
  loadLearnInputs,
  nameVocab,
  parseLabels,
  recomputeLearn,
  ruleTrigger,
  seriesOf,
  subjectOf,
  topicTokens,
  type Learner,
} from './learn-load.js';
import type { Evidence, LearnOpts, LearnResult, LearnUnit } from './learn.js';
import type { ItemIn } from './items-load.js';

const NOW = new Date('2026-10-15T16:00:00.000Z'); // 19:00 in Europe/Moscow
const TZ = 'Europe/Moscow';

const people: Person[] = [
  { person_id: 'owner', name: 'Olga Owner', identities: ['olga@example.com', 'slack:Olga Owner'], marker: { type: 'broad', initiatives: [] } },
  { person_id: 'ana', name: 'Ana Berg', identities: ['ana@northwind.example', 'slack:Ana Berg'], marker: { type: 'broad', initiatives: [] } },
  { person_id: 'rui', name: 'Rui Rosa', identities: ['rui@example.com', 'slack:Rui Rosa'], marker: { type: 'narrow', initiatives: ['northwind/shop', 'northwind/erp-sync'] } },
];

// One client with two running initiatives (siblings), an alias, an ended one and an admin bucket; one other client.
const registry = {
  initiatives: [
    { id: 'northwind/shop', umbrella: 'northwind', company: 'northwind', name: 'Northwind shop relaunch', status: 'active', sources: { slack_channels: [{ id: 'C0NWSHOP01', name: '#nw-shop' }], youtrack_prefixes: ['NW'], hosts: ['shop.northwind.example'], calendar_title_patterns: ['Shop weekly'] } },
    { id: 'northwind/erp-sync', umbrella: 'northwind', company: 'northwind', name: 'Northwind ERP sync', status: 'active', sources: { repos: ['github.com/northwind/erp-bridge'] } },
    { id: 'northwind/legacy', alias_of: 'northwind/shop', status: 'alias', sources: { calendar_title_patterns: ['Legacy shop'] } },
    { id: 'northwind/archive', umbrella: 'northwind', status: 'done', sources: {} },
    { id: 'northwind/admin', umbrella: 'northwind', sources: {} },
    { id: 'globex/portal', umbrella: 'globex', sources: { slack_channels: ['#portal'] } },
  ],
};

const REF = {
  shop: 'slack:T1:C0NWSHOP01:1760511600.000100', // 07:00Z, the owner in #nw-shop
  dm: 'slack:T1:D0RUI00001:1760515200.000100', // 08:00Z, the owner to Rui
  dmReply: 'slack:T1:D0RUI00001:1760515500.000100', // 08:05Z, Rui answers
  bot: 'slack:T1:C0OPS00001:1760518800.000100', // 09:00Z, a monitor in #ops
};

function store(): ReturnType<typeof openStore> {
  const db = openStore(join(mkdtempSync(join(tmpdir(), 'learn-store-')), 'store.sqlite'));
  const pIns = db.prepare('INSERT INTO people(person_id, name, company, marker_type, marker_initiatives) VALUES (?, ?, NULL, ?, ?)');
  const iIns = db.prepare('INSERT INTO identities(identity, person_id, kind) VALUES (?, ?, ?)');
  for (const p of people) {
    pIns.run(p.person_id, p.name, p.marker!.type, JSON.stringify(p.marker!.initiatives));
    for (const id of p.identities) iIns.run(id.replace(/^slack:/, '').toLowerCase(), p.person_id, id.startsWith('slack:') ? 'slack' : 'email');
  }
  const m = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  m.run(REF.shop, 'slack', 'T1', '#nw-shop', 'slack:T1/C0NWSHOP01/1760511600.000100', '2026-10-15T07:00:00.000Z', 'owner', 'Olga Owner', '', 'The NW-12 import failed on staging again, looking into it', 0);
  m.run(REF.dm, 'slack', 'T1', 'dm:@Rui Rosa', 'slack:T1/D0RUI00001/1760515200.000100', '2026-10-15T08:00:00.000Z', 'owner', 'Olga Owner', '', 'Can you send me the reconciliation numbers for the ERP export?', 0);
  m.run(REF.dmReply, 'slack', 'T1', 'dm:@Rui Rosa', 'slack:T1/D0RUI00001/1760515500.000100', '2026-10-15T08:05:00.000Z', 'rui', 'Rui Rosa', '', 'sure, tomorrow', 0);
  m.run(REF.bot, 'slack', 'T1', '#ops', 'slack:T1/C0OPS00001/1760518800.000100', '2026-10-15T09:00:00.000Z', null, 'Uptime Watch', '', 'DOWN https://shop.northwind.example is not responding', 1);
  // A call with Rui (narrow): its title routes it (.80) — two topics, so two fragments of one call.
  db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'granola:me:n1', 'granola', 'me', 'n1', 'Shop weekly 12', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', JSON.stringify([{ email: 'rui@example.com', name: 'Rui Rosa' }]),
    '## ERP export\nThe nightly ERP export to the shop failed twice; the bridge needs a retry.\n## Checkout copy\nNew copy for the checkout page and the banner.', 'x'.repeat(800),
  );
  // Work in the ERP bridge repo just before the call (repo .99): the call's cowork signal.
  db.prepare('INSERT INTO activity(ref, source, account, id, container, start, "end", minutes, title, items_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'local:me:a1', 'git', 'me', 'a1', 'github.com/northwind/erp-bridge', '2026-10-15T09:00:00.000Z', '2026-10-15T09:50:00.000Z', 50, 'erp-bridge: 2 commits', 'retry the export',
  );
  recomputeCalls(db);
  return db;
}

function tenant(attribution: object, extra: Record<string, string> = {}): { root: string; ann: string } {
  const root = mkdtempSync(join(tmpdir(), 'learn-tenant-'));
  const ann = join(root, 'annotations');
  mkdirSync(ann, { recursive: true });
  writeFileSync(join(root, 'initiatives.json'), JSON.stringify(registry));
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify(attribution));
  for (const [path, body] of Object.entries(extra)) writeFileSync(join(root, path), body);
  return { root, ann };
}

const id = {
  shop: `frag-2026-10-15-thread-${hash(`#nw-shop|${REF.shop}`)}`,
  dm: `frag-2026-10-15-thread-${hash(`dm:@Rui Rosa|${REF.dm}`)}`,
  call: `frag-2026-10-15-call-granola-${hash('n1')}`,
  work: `frag-2026-10-15-work-${hash('activity:git:a1@2026-10-15T09:00:00.000Z')}`,
};

const L = (o: object) => JSON.stringify(o);
// The ledger: a person's answers (one with what the machine said before it, one an audit), a call answered as a whole
// (two topic lines, one decided_at), the model's judgment (never evidence) and a person's line outside the horizon.
const ledgerText = [
  L({ id: id.dm, kind: 'thread', start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T08:00:00.000Z', refs: [REF.dm], attributions: [{ initiative: 'northwind/erp-sync', share: 1 }], decided_by: 'human:ana', decided_at: '2026-10-15T14:00:00.000Z', status: 'decided', answer: 'q-1', guess: 'northwind/shop', conf: 0.3, rung: 'guess:candidate' }),
  L({ id: `${id.call}#1`, kind: 'call', start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T10:30:00.000Z', refs: ['meeting:granola:n1'], attributions: [{ initiative: 'northwind/erp-sync', share: 0.6 }], decided_by: 'owen', decided_at: '2026-10-15T15:00:00.000Z', status: 'decided' }),
  L({ id: `${id.call}#2`, kind: 'call', start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T10:30:00.000Z', refs: ['meeting:granola:n1'], attributions: [{ initiative: 'northwind/legacy', share: 0.4 }], decided_by: 'owen', decided_at: '2026-10-15T15:00:00.000Z', status: 'decided' }),
  L({ id: id.work, kind: 'work', start: '2026-10-15T09:00:00.000Z', end: '2026-10-15T09:50:00.000Z', refs: ['activity:git:a1'], attributions: [{ initiative: 'northwind/erp-sync', share: 1 }], decided_by: 'owen', decided_at: '2026-10-15T15:30:00.000Z', status: 'decided', audit: true, guess: 'northwind/erp-sync', conf: 0.99, rung: 'repo:github.com/northwind/erp-bridge' }),
  L({ id: id.shop, kind: 'thread', start: '2026-10-15T07:00:00.000Z', end: '2026-10-15T07:00:00.000Z', refs: [REF.shop], attributions: [{ initiative: 'globex/portal', share: 1 }], decided_by: 'model', decided_at: '2026-10-15T12:00:00.000Z', status: 'decided' }),
  L({ id: 'frag-2026-09-01-thread-old', kind: 'thread', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:00:00.000Z', refs: ['slack:T1:C0OLD00001:1'], attributions: [{ initiative: 'globex/portal', share: 1 }], decided_by: 'owen', decided_at: '2026-09-02T09:00:00.000Z', status: 'decided' }),
].join('\n');
const ledger = (): Fragment[] => parseFragments(ledgerText).fragments;

// labels.jsonl: a person's audit of a bot item, an answer through an alias, a model's line (never evidence), a line
// about an item outside the window, a withdrawn answer and junk.
const labelsText = [
  L({ ref: REF.bot, task: 't1-item', label: 'northwind/shop', by: 'human:ana', answer: 'qi-1', audit: true, guess: 'northwind/shop', conf: 0.95, rung: 'host:shop.northwind.example', at: '2026-10-15T15:00:00.000Z' }),
  L({ ref: REF.dm, task: 't1-item', label: 'northwind/legacy', by: 'human:ana', at: '2026-10-15T15:10:00.000Z' }),
  L({ ref: REF.shop, task: 't1-item', label: 'globex/portal', by: 'model', at: '2026-10-15T15:20:00.000Z' }),
  L({ ref: 'slack:T1:C0GONE0001:1', task: 't1-item', label: 'globex/portal', by: 'human:ana', at: '2026-10-15T15:30:00.000Z' }),
  L({ ref: REF.dmReply, task: 't1-item', label: 'globex/portal', by: 'human:ana', at: '2026-10-15T15:40:00.000Z' }),
  L({ ref: REF.dmReply, task: 't1-item', status: 'superseded', at: '2026-10-15T15:45:00.000Z' }),
  'not json',
].join('\n');

/** A stand-in learner: the floor as it is, a question for anything below τ, one audit — and what it was handed. */
function stub(): { learner: Learner; seen: { units: LearnUnit[]; evidence: Evidence[]; opts: LearnOpts } | null } {
  const box: { learner: Learner; seen: { units: LearnUnit[]; evidence: Evidence[]; opts: LearnOpts } | null } = { learner: () => ({}) as LearnResult, seen: null };
  box.learner = (units, evidence, opts) => {
    box.seen = { units, evidence, opts };
    const decided = units.filter((u) => u.label !== null && u.conf >= opts.tau);
    return {
      units: units.map((u) =>
        u.label !== null && u.conf >= opts.tau
          ? { id: u.id, label: u.label, conf: u.conf, rung: u.rung, ...(u.id === decided[0]?.id ? { audit: true } : {}) }
          : { id: u.id, label: u.label, conf: u.conf, rung: u.rung, ask: { group: u.caseKey, value: 1 - u.conf, guess: u.label, form: u.label ? ('confirm' as const) : ('choose' as const) } },
      ),
      calibration: [{ instance: 'title:Shop weekly', a: 16, b: 4, mean: 0.8, demoted: false }],
      keyTypes: [{ type: 'host', a: 19, b: 1, mean: 0.95, deciding: true }],
      questions: [{ group: 'call:x', units: ['u1'], value: 1.23456, guess: null, form: 'choose' }],
      audits: decided.slice(0, 1).map((u) => u.id),
      ruleCandidates: [],
    };
  };
  return box;
}

test('recomputeAttribution with learn shadow: the learner gets the floor, people\'s evidence and the registry; att_learn holds what it would do', () => {
  const db = store();
  try {
    const t = tenant({ subject: 'owner', since: '2026-10-14', admin: { northwind: 'northwind/admin' }, items: { days: 2 }, learn: { mode: 'shadow' } }, { 'annotations/labels.jsonl': labelsText });
    const read = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: TZ })!;
    assert.equal(read.inputs.labelsText, labelsText, 'labels.jsonl is read while the loop is on');
    const box = stub();
    // The build's own call with a stand-in learner: the same loader, the same writes.
    const sum = recomputeAttribution(db, read.inputs, people, ledger(), NOW);
    assert.ok(sum.learn && !('error' in sum.learn), `the loop ran: ${JSON.stringify(sum.learn)}`);
    const out = recomputeLearn(db, read.inputs, people, ledger(), NOW, { learner: box.learner });
    const { units, evidence, opts } = box.seen!;

    // --- units: the floor's own say (the ledger's decisions do not hide it), cases, keys, texts
    const u = new Map(units.map((x) => [x.id, x]));
    assert.deepEqual(units.filter((x) => x.unit === 'fragment').map((x) => x.id).sort(), [id.shop, id.dm, `${id.call}#1`, `${id.call}#2`, id.work].sort());
    const shop = u.get(id.shop)!;
    assert.deepEqual([shop.label, shop.conf, shop.rung, shop.structural, shop.caseKey], ['northwind/shop', 0.95, 'channel:C0NWSHOP01', true, 'run:#nw-shop:2026-10-15'], 'the channel by its id, though the model judged it otherwise');
    assert.equal(shop.keys.run, '#nw-shop');
    const dm = u.get(id.dm)!;
    assert.deepEqual([dm.label, dm.conf, dm.rung, dm.structural, dm.candidates], [null, 0, 'abstain', false, ['northwind/shop', 'northwind/erp-sync']], 'Rui narrows; nothing decided');
    assert.deepEqual([dm.keys.run, dm.keys.cpset], ['dm:@rui rosa', 'rui']);
    assert.match(dm.text!, /reconciliation numbers/, 'a run carries its messages for cue matching');
    const topic = u.get(`${id.call}#1`)!;
    assert.deepEqual([topic.label, topic.conf, topic.rung, topic.structural], ['northwind/shop', 0.8, 'title:Shop weekly', true]);
    assert.equal(topic.caseKey, 'call:granola:me:n1', 'both topics are one case: the store\'s call (calls.ts ids already read call:…)');
    assert.equal(u.get(`${id.call}#2`)!.caseKey, topic.caseKey);
    assert.equal(topic.keys.cowork, 'northwind/erp-sync', 'the repo-decided work block 10 minutes before the call');
    assert.equal(topic.keys.series, undefined, 'a series seen on one call does not speak yet');
    assert.match(topic.text!, /ERP export[\s\S]*bridge needs a retry/);
    assert.doesNotMatch(topic.text!, /Checkout copy/, 'a topic carries its own section only');
    assert.ok(topic.minutes! > 15 && Math.abs(topic.minutes! + u.get(`${id.call}#2`)!.minutes! - 30) <= 0.1, 'minutes are wall time × the topic\'s weight');
    const work = u.get(id.work)!;
    assert.deepEqual([work.label, work.conf, work.rung, work.structural, work.caseKey, work.minutes], ['northwind/erp-sync', 0.99, 'repo:github.com/northwind/erp-bridge', false, 'work:github.com/northwind/erp-bridge:2026-10-15', 50]);
    const items = units.filter((x) => x.unit === 'item');
    assert.ok(items.length >= 4, 'item mode is on: the window\'s items are units too');
    const bot = u.get(REF.bot)!;
    assert.deepEqual([bot.label, bot.conf, bot.rung, bot.structural], ['northwind/shop', 0.95, 'host:shop.northwind.example', false]);
    assert.equal(bot.keys.host, 'shop.northwind.example');
    assert.ok(bot.keys.family?.startsWith('fam-'), 'the floor\'s family');
    assert.deepEqual([u.get(REF.shop)!.rung, u.get(REF.shop)!.structural], ['key:NW', true], 'the item floor: a key in the text outranks the channel');
    assert.equal(u.get(REF.shop)!.keys.container, 'C0NWSHOP01', 'a person\'s chat item is keyed by its channel id');

    // --- evidence: people only; one call answered as a whole is one answer; the alias resolves; what the machine said rides along
    const ev = new Map(evidence.map((e) => [e.id, e]));
    assert.deepEqual(evidence.map((e) => e.id).sort(), [id.dm, `${id.call}#1`, `${id.call}#2`, id.work, REF.bot, REF.dm].sort(), 'no model line, nothing outside, nothing withdrawn');
    assert.ok(evidence.every((e) => e.source === 'human'));
    assert.deepEqual(ev.get(id.dm), { id: id.dm, day: '2026-10-15', label: 'northwind/erp-sync', source: 'human', answer: 'q-1', guess: 'northwind/shop' });
    assert.equal(ev.get(`${id.call}#1`)!.answer, ev.get(`${id.call}#2`)!.answer, 'the call\'s topic lines decided together are one answer');
    assert.equal(ev.get(`${id.call}#1`)!.answer, `${id.call}@2026-10-15T15:00:00.000Z`);
    assert.equal(ev.get(`${id.call}#2`)!.label, 'northwind/shop', 'an alias answer is its target');
    assert.deepEqual([ev.get(id.work)!.audit, ev.get(id.work)!.guess], [true, 'northwind/erp-sync']);
    assert.deepEqual(ev.get(REF.bot), { id: REF.bot, day: '2026-10-15', label: 'northwind/shop', source: 'human', answer: 'qi-1', audit: true, guess: 'northwind/shop' });
    assert.deepEqual([ev.get(REF.dm)!.label, ev.get(REF.dm)!.answer], ['northwind/shop', `${REF.dm}@2026-10-15T15:10:00.000Z`]);

    // --- options and the registry as the sibling-aware learner reads it
    assert.deepEqual([opts.tau, opts.today, opts.questionsPerDay, opts.auditShare, opts.siblingAware, opts.seed], [0.95, '2026-10-15', 3, 0.15, true, 'att:owner']);
    const ini = new Map(opts.initiatives.map((i) => [i.id, i]));
    assert.deepEqual([...ini.keys()], ['northwind/shop', 'northwind/erp-sync', 'northwind/archive', 'northwind/admin', 'globex/portal'], 'a plain alias is no label');
    assert.deepEqual([ini.get('northwind/shop')!.active, ini.get('northwind/archive')!.active, ini.get('northwind/admin')!.admin], [true, false, true]);
    assert.equal(ini.get('northwind/shop')!.company, 'northwind');
    assert.deepEqual(ini.get('northwind/shop')!.cues, ['Northwind', 'shop', 'relaunch', 'title:Shop weekly', '#nw-shop', 'C0NWSHOP01', 'host:shop.northwind.example', 'title:Legacy shop'], 'typed, the alias\'s pattern on its target');
    assert.deepEqual(ini.get('northwind/erp-sync')!.cues, ['Northwind', 'ERP', 'repo:github.com/northwind/erp-bridge'], 'meeting words ("sync") are no topic; the id\'s segments the learner adds');

    // --- the writes: one row per unit, the meta, the summary
    const rows = db.prepare('SELECT * FROM att_learn ORDER BY id').all() as { id: string; unit: string; day: string; label: string | null; conf: number; rung: string; ask: string | null; audit: number }[];
    assert.equal(rows.length, units.length);
    const dmRow = rows.find((r) => r.id === id.dm)!;
    assert.deepEqual([dmRow.unit, dmRow.day, dmRow.label, JSON.parse(dmRow.ask!)], ['fragment', '2026-10-15', null, { group: 'run:dm:@Rui Rosa:2026-10-15', value: 1, guess: null, form: 'choose' }]);
    assert.equal(rows.filter((r) => r.audit === 1).length, 1);
    const meta = JSON.parse((db.prepare("SELECT value FROM sync_state WHERE key = 'att:learn'").get() as { value: string }).value);
    assert.deepEqual([meta.mode, meta.today, meta.tau, meta.questions_ranked[0].value, meta.calibration_table[0].instance], ['shadow', '2026-10-15', 0.95, 1.2346, 'title:Shop weekly']);
    assert.deepEqual(out.evidence, { units: 6, answers: 5, audits: 2, outside: 2, malformed: 1 }, 'six rows, five answers (the call is one), two outside (a ledger line, a label line), one junk line');
    assert.equal(out.floor_decided, units.filter((x) => x.label !== null && x.conf >= 0.95).length);
    assert.deepEqual([out.promoted, out.held, out.relabelled], [0, 0, 0], 'the stand-in only echoes the floor');

    // --- the readout: `learn: true` adds the section; without it nothing changed
    const plain = runAttribution(db, { since: '2026-10-15' }, NOW);
    assert.equal('learn' in plain, false);
    const withLearn = runAttribution(db, { since: '2026-10-15', learn: true }, NOW);
    const { learn: section, ...rest } = withLearn;
    assert.deepEqual(rest, plain, 'the plan part is the same answer');
    assert.equal(section!.mode, 'shadow');
    assert.deepEqual(section!.units!.map((x) => x.id).sort(), units.filter((x) => x.unit === 'fragment').map((x) => x.id).sort(), 'the fragments of the day');
    assert.deepEqual(section!.units!.find((x) => x.id === id.dm), { id: id.dm, day: '2026-10-15', label: null, rung: 'abstain', ask: { group: 'run:dm:@Rui Rosa:2026-10-15', value: 1, guess: null, form: 'choose' } });
    const itemSection = runAttribution(db, { unit: 'item', since: '2026-10-15', learn: true }, NOW).learn!;
    assert.ok(itemSection.units!.some((x) => x.id === REF.bot), 'unit item: the items\' rows');
    assert.deepEqual(itemSection.calibration, [{ instance: 'title:Shop weekly', a: 16, b: 4, mean: 0.8, demoted: false }]);
  } finally {
    db.close();
  }
});

test('shadow means shadow: the plan, the index and the readout are the same with the loop on or off; switching it off clears it', () => {
  const on = store();
  const off = store();
  try {
    const tOn = tenant({ subject: 'owner', since: '2026-10-14', items: { days: 2 }, learn: { mode: 'shadow', questionsPerDay: 5, siblingAware: false } }, { 'annotations/labels.jsonl': labelsText });
    const tOff = tenant({ subject: 'owner', since: '2026-10-14', items: { days: 2 } }, { 'annotations/labels.jsonl': labelsText });
    const rOn = readAttributionInputs({ tenantRoot: tOn.root, annotationsDir: tOn.ann, timezone: TZ })!;
    const rOff = readAttributionInputs({ tenantRoot: tOff.root, annotationsDir: tOff.ann, timezone: TZ })!;
    assert.equal(rOff.inputs.labelsText, undefined, 'without the loop labels.jsonl is not even read');
    assert.equal(rOff.text.split('\0').length, 5, 'and the fingerprint is the one it always was');
    const sOn = recomputeAttribution(on, rOn.inputs, people, ledger(), NOW);
    const sOff = recomputeAttribution(off, rOff.inputs, people, ledger(), NOW);
    assert.equal('learn' in sOff, false, 'no loop, no summary key');
    const { learn, ...restOn } = sOn;
    assert.deepEqual(restOn, sOff, 'the plan\'s summary is untouched');
    assert.ok(learn && !('error' in learn) && learn.units.fragment === 5);
    const index = (db: typeof on) => db.prepare('SELECT ref, initiative, share, fragment_id, decided_by FROM attributions ORDER BY ref, initiative, fragment_id').all();
    assert.deepEqual(index(on), index(off), 'the initiative index is the plan\'s alone');
    for (const unit of ['fragment', 'item'] as const) assert.deepEqual(runAttribution(on, { unit, since: '2026-10-14', until: '2026-10-15' }, NOW), runAttribution(off, { unit, since: '2026-10-14', until: '2026-10-15' }, NOW), `${unit}: byte-identical without the param`);
    assert.equal((off.prepare('SELECT count(*) AS n FROM att_learn').get() as { n: number }).n, 0);
    assert.deepEqual(runAttribution(off, { since: '2026-10-15', learn: true }, NOW).learn, { mode: 'off', note: 'the learning loop is off for this project: annotations/attribution.json has no "learn" key (e.g. "learn": {"mode": "shadow"})' });
    assert.ok((on.prepare('SELECT count(*) AS n FROM att_learn').get() as { n: number }).n > 0);
    // the tenant drops the key: the next build clears rows and meta
    recomputeAttribution(on, rOff.inputs, people, ledger(), NOW);
    assert.equal((on.prepare('SELECT count(*) AS n FROM att_learn').get() as { n: number }).n, 0);
    assert.equal(on.prepare("SELECT 1 FROM sync_state WHERE key = 'att:learn'").get(), undefined);
    clearLearn(on); // idempotent
  } finally {
    on.close();
    off.close();
  }
});

test('a failing loop costs the plan nothing: the summary carries the error, the plan its tables', () => {
  const db = store();
  try {
    const t = tenant({ subject: 'owner', since: '2026-10-14', learn: { mode: 'shadow' } });
    const { inputs } = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: TZ })!;
    assert.throws(() => recomputeLearn(db, inputs, people, ledger(), NOW, { learner: () => { throw new Error('boom'); } }), /boom/);
    db.exec('DROP TABLE att_learn'); // a store that cannot take the rows
    const sum = recomputeAttribution(db, inputs, people, ledger(), NOW);
    assert.match(String((sum.learn as { error: string }).error), /att_learn/);
    assert.equal(sum.fragments, 5);
    assert.equal((db.prepare('SELECT count(*) AS n FROM att_fragments').get() as { n: number }).n, 5, 'the plan is written');
  } finally {
    db.close();
  }
});

test('config: "learn" needs mode shadow; budgets bounded; absent = off', () => {
  assert.equal(parseAttributionConfig({ subject: 'owner' }).learn, undefined);
  assert.deepEqual(parseAttributionConfig({ subject: 'owner', learn: { mode: 'shadow' } }).learn, { mode: 'shadow', questionsPerDay: 3, auditShare: 0.15, siblingAware: true });
  assert.deepEqual(parseAttributionConfig({ subject: 'owner', learn: { mode: 'shadow', questionsPerDay: 0, auditShare: 1, siblingAware: false } }).learn, { mode: 'shadow', questionsPerDay: 0, auditShare: 1, siblingAware: false });
  assert.throws(() => parseAttributionConfig({ subject: 'owner', learn: { mode: 'live' } }), /"learn.mode" must be "shadow"/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', learn: true }), /"learn" must be an object/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', learn: { mode: 'shadow', questionsPerDay: 51 } }), /questionsPerDay/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', learn: { mode: 'shadow', auditShare: 1.5 } }), /auditShare/);
  assert.throws(() => parseAttributionConfig({ subject: 'owner', learn: { mode: 'shadow', siblingAware: 'yes' } }), /siblingAware/);
});

test('the ledger: a person\'s line parses its decider, answer, guess, conf, rung and audit; an older line parses as before', () => {
  const { fragments } = parseFragments(
    [
      L({ id: 'a', refs: ['r'], attributions: [{ initiative: 'x' }], decided_by: 'human:ana', answer: 'q-7', guess: null, conf: 0.6, rung: 'cue:key:NW', audit: true, decided_at: '2026-10-15T10:00:00Z' }),
      L({ id: 'b', refs: ['r'], attributions: [{ initiative: 'x' }], decided_by: 'owen', guess: 'y', conf: 7, rung: '', audit: 'yes' }),
      L({ id: 'c', refs: ['r'], attributions: [{ initiative: 'x' }], decided_by: 'human:Not An Id' }),
      L({ id: 'd', refs: ['r'], attributions: [{ initiative: 'x' }], decided_by: 'rule' }),
    ].join('\n'),
  );
  const [a, b, c, d] = fragments;
  assert.deepEqual([a!.decided_by, a!.decider, a!.answer, a!.guess, a!.conf, a!.rung, a!.audit], ['model', 'human:ana', 'q-7', null, 0.6, 'cue:key:NW', true], 'the plan still reads it as before; the loop reads the decider');
  assert.deepEqual(b, { id: 'b', kind: 'thread', start: '', end: '', refs: ['r'], attributions: [{ initiative: 'x', share: 1 }], decided_by: 'owen', status: 'decided', guess: 'y' }, 'out-of-range conf, empty rung and a non-boolean audit are dropped');
  assert.deepEqual([c!.decided_by, c!.decider], ['model', undefined], 'not a person id');
  assert.deepEqual(Object.keys(d!), ['id', 'kind', 'start', 'end', 'refs', 'attributions', 'decided_by', 'status'], 'an older line: exactly the fields it always had');
});

test('labels.jsonl: last line per task × ref wins, superseded withdraws, junk is counted', () => {
  const { labels, malformed } = parseLabels(labelsText);
  assert.equal(malformed, 1);
  assert.deepEqual(labels.map((l) => [l.ref, l.by]), [[REF.bot, 'human:ana'], [REF.dm, 'human:ana'], [REF.shop, 'model'], ['slack:T1:C0GONE0001:1', 'human:ana']]);
  assert.deepEqual(labels[0], { ref: REF.bot, task: 't1-item', label: 'northwind/shop', by: 'human:ana', at: '2026-10-15T15:00:00.000Z', answer: 'qi-1', audit: true, guess: 'northwind/shop', conf: 0.95, rung: 'host:shop.northwind.example' });
  const again = parseLabels([L({ ref: 'r', label: 'a', by: 'human:ana', at: '2026-10-15T01:00:00Z' }), L({ ref: 'r', label: 'b', by: 'human:ana', at: '2026-10-15T02:00:00Z' }), L({ ref: 'r', task: 't4-kind', label: 'noise', by: 'human:ana', at: '2026-10-15T03:00:00Z' }), L({ ref: 'r', label: 'c', at: '2026-10-15T04:00:00Z' })].join('\n'));
  assert.deepEqual([again.labels.map((l) => [l.task, l.label]), again.malformed], [[['t1-item', 'b'], ['t4-kind', 'noise']], 1], 'a task defaults to t1-item; a line without `by` is junk');
});

test('rung instances, structure, labels and triggers', () => {
  const reg = new Registry({ initiatives: registry.initiatives as never });
  const d = { kind: 'thread' as const, title: '#nw-shop — x', container: '#nw-shop', refs: [REF.shop], projectKeys: ['ZZ', 'NW'] };
  assert.equal(fragmentRung('registry:channel', d, reg), 'channel:C0NWSHOP01');
  assert.equal(fragmentRung('registry:channel', { ...d, refs: ['slack:T1:C0OTHER001:1'], container: '#Portal' }, reg), 'channel:portal', 'an id the registry does not list: the name');
  assert.equal(fragmentRung('registry:key', d, reg), 'key:NW', 'the prefix the registry knows');
  assert.equal(fragmentRung('registry:title', { ...d, kind: 'call', title: 'Legacy shop review — Q4' }, reg), 'title:Legacy shop');
  assert.equal(fragmentRung('registry:repo/path', { ...d, kind: 'work', container: 'https://github.com/Northwind/erp-bridge.git', route: { initiative: 'x', confidence: 'exact', candidates: [], reason: 'repo github.com/northwind/erp-bridge' } }, reg), 'repo:github.com/northwind/erp-bridge');
  assert.equal(fragmentRung('registry:repo/path', { ...d, kind: 'work', container: '/home/me/notes', route: { initiative: 'x', confidence: 'exact', candidates: [], reason: 'path /home/me/notes' } }, reg), 'path:/home/me/notes');
  assert.equal(fragmentRung('marker:ana', d, reg), 'excl:ana');
  assert.equal(fragmentRung('admin', d, reg), 'admin');
  assert.equal(fragmentRung('r-ops', d, reg), 'rule:r-ops');
  assert.deepEqual(['rule:r', 'excl:a', 'channel:C1', 'key:NW', 'title:x', 'repo:r', 'path:p', 'host:h', 'app:a', 'admin', 'sender:bulk', 'closed:c', 'abstain'].map(isStructural), [true, true, true, true, true, false, false, false, false, false, false, false, false]);
  assert.equal(labelOf([{ initiative: 'northwind/legacy', share: 0.2 }, { initiative: 'globex/portal', share: 0.1 }], reg), 'northwind/shop');
  assert.deepEqual(ruleTrigger('rule:r1', [{ id: 'r1', when: { container: '#ext-nw', project_key: 'NW' }, then: { initiative: 'northwind/shop' } }]), ['channel:#ext-nw', 'key:NW']);
  assert.deepEqual(ruleTrigger('key:NW', []), []);
});

test('keys: the bench\'s shapes — series, subjects, tokens, item keys per sender class, activity over the pool', () => {
  const vocab = nameVocab(people);
  assert.equal(seriesOf('Weekly Globex sync 12 — Checkout rewrite'), 'weekly globex sync');
  assert.equal(subjectOf('Re: AW: Invoice 2026-118 for March'), 'invoice <n> for march');
  assert.deepEqual(topicTokens('Rui and Ana review the checkout rewrite', vocab), ['review', 'checkout', 'rewrite'], 'names are people, not topics');
  const item = (o: Partial<ItemIn>): ItemIn => ({ ref: 'r', day: '2026-10-15', ts: '2026-10-15T09:00:00Z', type: 'message', source: 'slack', container: '#ops', thread: 't', author: 'x', authorPerson: null, isBot: false, participants: [], toPersons: [], subject: null, text: '', body: '', keys: [], context: [], fromSubject: false, ...o });
  const rec = (keys: string[]) => keyRecord(keys);
  assert.deepEqual(rec(itemKeys(item({ author: 'alerts@uptime.example', isBot: true, text: 'DOWN https://shop.northwind.example and https://status.uptime.example/x' }), { senderClass: 'bot', family: 'fam-1' }, vocab)), { thread: 't', family: 'fam-1', host: 'shop.northwind.example' }, 'the sender\'s own domain is the tool, not the target');
  const mail = rec(itemKeys(item({ ref: 'gmail:x:1', source: 'gmail', container: 'inbox', author: 'Lena Hart <lena@globex.example>', subject: 'Re: Invoice 118 for March' }), { senderClass: 'human', family: 'fam-2' }, vocab));
  assert.deepEqual([mail.subject, mail.domain, mail.container, mail.sender], ['invoice <n> for march|globex.example', 'globex.example', undefined, 'lena@globex.example']);
  assert.deepEqual(rec(['token=alpha', 'token=beta', 'host=h', 'token=gamma']), { token: 'alpha', 'token#2': 'beta', host: 'h', 'token#3': 'gamma' }, 'several values of a type: suffixed');
  const pool = [
    { keys: ['series=standup', 'token=checkout'], caseKey: 'call:1' },
    { keys: ['series=standup'], caseKey: 'call:1' },
    ...Array.from({ length: 38 }, (_, i) => ({ keys: i < 2 ? ['series=standup', 'token=common'] : ['token=common'], caseKey: `call:${i + 2}` })),
  ];
  const active = activeKeys(pool);
  assert.deepEqual(active[0], ['series=standup', 'token=checkout'], 'a series on three calls speaks; a rare token too');
  assert.deepEqual(active[2], ['series=standup'], 'a token on 38 of 40 units does not');
});

test('the real learner runs over the loader\'s units end to end (smoke)', () => {
  const db = store();
  try {
    const t = tenant({ subject: 'owner', since: '2026-10-14', admin: { northwind: 'northwind/admin' }, items: { days: 2 }, learn: { mode: 'shadow' } }, { 'annotations/labels.jsonl': labelsText });
    const { inputs } = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: TZ })!;
    const sum = recomputeAttribution(db, inputs, people, ledger(), NOW);
    assert.ok(sum.learn && !('error' in sum.learn), JSON.stringify(sum.learn));
    const li = loadLearnInputs(db, inputs, people, ledger(), NOW);
    const rows = db.prepare('SELECT count(*) AS n FROM att_learn').get() as { n: number };
    assert.equal(rows.n, li.units.length);
    assert.equal(sum.learn.agreement.answered, 6, 'every answered unit is checked against what the loop said before the answer');
    // A route of a client with siblings decides the initiative only with a cue of its own: the #nw-shop run names NW-12.
    const section = runAttribution(db, { since: '2026-10-15', learn: true }, NOW).learn!;
    const shop = section.units!.find((x) => x.id === id.shop)!;
    assert.deepEqual([shop.label, shop.rung], ['northwind/shop', 'channel:C0NWSHOP01']);
    assert.ok(shop.conf! >= 0.95, JSON.stringify(shop));
    assert.ok(section.units!.every((x) => x.conf === undefined || (x.conf >= 0 && x.conf <= 1)));
  } finally {
    db.close();
  }
});
