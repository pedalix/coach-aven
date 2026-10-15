// The attribution layer end to end over a real store file: tenant inputs read from a checkout, the plan
// computed by the build and served by the sources table's `attribution` tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.js';
import { clearAttribution, localDay, plusDays, readAttributionInputs, recomputeAttribution } from './build.js';
import { hash } from './fragment.js';
import { runAttribution, runTimelog } from '../../../snapshot/plain/sources-mcp.mjs';
import { appendPinLines, readPins, unpinLines } from './pins.js';
import type { Person } from '../people.js';
import type { Fragment } from '../annotations.js';

const NOW = new Date('2026-10-15T16:00:00.000Z'); // 19:00 in Europe/Moscow

function tenant(files: Record<string, unknown>): { root: string; ann: string } {
  const root = mkdtempSync(join(tmpdir(), 'tenant-'));
  const ann = join(root, 'annotations');
  mkdirSync(ann, { recursive: true });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  return { root, ann };
}

const people: Person[] = [
  { person_id: 'owner', name: 'Olga Owner', identities: ['olga@example.com', 'slack:Olga Owner'], marker: { type: 'broad', initiatives: [] } },
  { person_id: 'hana', name: 'Hana Hill', identities: ['hana@example.com', 'slack:Hana Hill'], marker: { type: 'exclusive', initiatives: ['acme/p5'] } },
  { person_id: 'rui', name: 'Rui Rosa', identities: ['rui@example.com', 'slack:Rui Rosa'], marker: { type: 'narrow', initiatives: ['initech/a', 'initech/b'] } },
];

function store(): ReturnType<typeof openStore> {
  const db = openStore(join(mkdtempSync(join(tmpdir(), 'store-')), 'store.sqlite'));
  const pIns = db.prepare('INSERT INTO people(person_id, name, company, marker_type, marker_initiatives) VALUES (?, ?, NULL, ?, ?)');
  const iIns = db.prepare('INSERT INTO identities(identity, person_id, kind) VALUES (?, ?, ?)');
  for (const p of people) {
    pIns.run(p.person_id, p.name, p.marker!.type, JSON.stringify(p.marker!.initiatives));
    for (const id of p.identities) iIns.run(id.replace(/^slack:/, '').toLowerCase(), p.person_id, id.startsWith('slack:') ? 'slack' : 'email');
  }
  const m = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Olga in #shop (a registry channel) — decided by the registry
  m.run('slack:T/C1/1', 'slack', 'T', '#shop', 't1', '2026-10-15T07:00:00.000Z', 'owner', 'Olga Owner', '', 'The SH-12 import failed on staging again, looking into it');
  // Olga with Rui in a DM — narrow marker: open with Rui's two initiatives
  m.run('slack:T/D1/2', 'slack', 'T', 'dm:@Rui Rosa', 'd1', '2026-10-15T08:00:00.000Z', 'owner', 'Olga Owner', '', 'Can you send me the reconciliation numbers for last week?');
  m.run('slack:T/D1/3', 'slack', 'T', 'dm:@Rui Rosa', 'd1', '2026-10-15T08:05:00.000Z', 'rui', 'Rui Rosa', '', 'sure, tomorrow');
  // Olga with Hana — exclusive marker; but the ledger already judged it otherwise
  m.run('slack:T/C2/4', 'slack', 'T', '#general', 't2', '2026-10-15T09:00:00.000Z', 'owner', 'Olga Owner', '', 'Hana, the platform release notes need another pass before Friday');
  m.run('slack:T/C2/5', 'slack', 'T', '#general', 't2', '2026-10-15T09:01:00.000Z', 'hana', 'Hana Hill', '', 'on it');
  // a greeting-only run → dropped (no call to attach to)
  m.run('slack:T/C3/6', 'slack', 'T', '#random', 't3', '2026-10-15T11:00:00.000Z', 'owner', 'Olga Owner', '', 'Morning!');
  // someone else's message is never a fragment of Olga's
  m.run('slack:T/C1/7', 'slack', 'T', '#shop', 't1', '2026-10-15T07:30:00.000Z', 'rui', 'Rui Rosa', '', 'Looks like the mapping table changed');
  // a call with Hana: exclusive → decided by the marker
  db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'granola:me:n1', 'granola', 'me', 'n1', 'Platform sync', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', JSON.stringify([{ email: 'hana@example.com', name: 'Hana Hill' }]), 'Release plan for the platform, open risks and owners. '.repeat(4), 'x'.repeat(800),
  );
  // a work block in a repo the registry knows
  db.prepare('INSERT INTO activity(ref, source, account, id, container, start, "end", minutes, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'local:me:a1', 'git', 'me', 'a1', 'github.com/acme-tools/platform', '2026-10-15T12:00:00.000Z', '2026-10-15T13:00:00.000Z', 60, 'platform: 3 commits',
  );
  return db;
}

const registry = {
  initiatives: [
    { id: 'acme/p5', umbrella: 'acme', sources: { repos: ['github.com/acme-tools/platform'] } },
    { id: 'globex/shop', umbrella: 'globex', sources: { slack_channels: ['#shop'], youtrack_prefixes: ['SH'] } },
    { id: 'initech/a', umbrella: 'initech', sources: {} },
    { id: 'initech/b', umbrella: 'initech', sources: {} },
  ],
};

test('readAttributionInputs: off without the config; tenant files parsed; the bot zone fills a missing one; broken files throw', () => {
  const none = tenant({ 'initiatives.json': registry });
  assert.equal(readAttributionInputs({ tenantRoot: none.root, annotationsDir: none.ann }), undefined);
  const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner' }, 'annotations/rules.json': [{ id: 'r1', when: { container: '#ops' }, then: { initiative: 'globex/shop' } }, { bogus: true }] });
  const read = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!;
  assert.equal(read.inputs.timezone, 'Europe/Moscow', 'the tenant zone comes from the project, not the attribution file');
  assert.deepEqual(read.inputs.rules.map((r) => r.id), ['r1'], 'malformed rules are skipped, not fatal');
  assert.equal(read.inputs.registry.initiatives.length, 4);
  writeFileSync(join(t.ann, 'attribution.json'), '{ not json');
  assert.throws(() => readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann }));
  rmSync(t.root, { recursive: true, force: true });
});

test('recomputeAttribution: the subject\'s fragments with ledger precedence, ladder decisions and open ones; the tool serves them', () => {
  const db = store();
  try {
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-14' } });
    const { inputs } = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!;
    const judgedId = `frag-2026-10-15-thread-${hash('#general|slack:T/C2/4')}`;
    const ledger: Fragment[] = [{ id: judgedId, kind: 'thread', start: '2026-10-15T09:00:00.000Z', end: '2026-10-15T09:00:00.000Z', refs: ['slack:T/C2/4'], attributions: [{ initiative: 'initech/b', share: 1 }], decided_by: 'model', rule_id: null, rationale: 'release notes are initech work', decided_at: '2026-10-15T10:00:00.000Z', status: 'decided' }];
    const sum = recomputeAttribution(db, inputs, people, ledger, NOW);
    assert.deepEqual([sum.since, sum.until], ['2026-10-14', '2026-10-15']);
    assert.deepEqual(sum.states, { decided: 1, escalated: 0, rule: 3, open: 1 });
    const out = runAttribution(db, { since: '2026-10-15' }, NOW);
    assert.equal(out.subject, 'owner');
    assert.deepEqual(out.counts, { decided: 1, escalated: 0, rule: 3, open: 1 });
    const byKind = Object.fromEntries(out.fragments!.map((f) => [`${f.kind}:${f.state}`, f]));
    assert.deepEqual(byKind['thread:rule']!.attributions, [{ initiative: 'globex/shop', share: 1 }], '#shop is a registry channel');
    assert.equal(byKind['call:rule']!.rule_id, 'marker:hana', 'the call with an exclusive person');
    assert.deepEqual(byKind['work:rule']!.attributions, [{ initiative: 'acme/p5', share: 1 }], 'the repo routes it');
    assert.deepEqual(byKind['thread:open']!.candidates, ['initech/a', 'initech/b'], 'Rui narrows');
    assert.equal(byKind['thread:open']!.container, 'dm:@Rui Rosa', 'the conversation, for grouping questions by subject');
    assert.equal(byKind['work:rule']!.container, 'github.com/acme-tools/platform');
    assert.deepEqual(byKind['thread:decided']!.attributions, [{ initiative: 'initech/b', share: 1 }], 'the ledger beats Hana\'s exclusive marker');
    assert.equal(out.fragments!.some((f) => (f.refs as string[]).includes('slack:T/C3/6')), false, 'the greeting-only run is dropped');
    assert.equal(out.fragments!.some((f) => (f.refs as string[]).includes('slack:T/C1/7')), false, 'another author\'s message is not a fragment of the subject');
    assert.deepEqual(runAttribution(db, { since: '2026-10-15', state: 'open' }, NOW).fragments!.map((f) => f.state), ['open']);
    assert.match(String(runAttribution(db, { since: '2026-09-01', until: '2026-09-02' }, NOW).note), /outside the computed horizon 2026-10-14\.\.2026-10-15/);
    // recompute is idempotent: the same ids again
    const again = recomputeAttribution(db, inputs, people, ledger, NOW);
    assert.equal(again.fragments, sum.fragments);
    clearAttribution(db);
    assert.equal(runAttribution(db, {}, NOW).configured, false);
  } finally {
    db.close();
  }
});

test('days are local: the horizon ends today in the tenant\'s zone', () => {
  assert.equal(localDay('2026-10-15T22:30:00.000Z', 'Europe/Moscow'), '2026-10-16');
  assert.equal(localDay('2026-10-15T22:30:00.000Z', 'UTC'), '2026-10-15');
  assert.equal(plusDays('2026-10-01', -1), '2026-09-30');
});

test('pins end to end: a closed day\'s rule decisions are pinned once, survive a rule change, and a redo releases them; the timelog reads the plan', () => {
  const db = store();
  try {
    // an older message in #shop: on 10-12 (closed), decided by the registry channel
    db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'slack:T/C1/0', 'slack', 'T', '#shop', 't0', '2026-10-12T07:00:00.000Z', 'owner', 'Olga Owner', '', 'Checked the SH-11 export, all rows are there now',
    );
    // a second message of Olga's in the DM with Rui: the run lasts 20 minutes (a single message has no duration)
    db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'slack:T/D1/9', 'slack', 'T', 'dm:@Rui Rosa', 'd1', '2026-10-15T08:20:00.000Z', 'owner', 'Olga Owner', '', 'and the open invoices list too please, by Friday',
    );
    const pinsPath = join(mkdtempSync(join(tmpdir(), 'pins-')), 'attribution', 'pins.jsonl');
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-12' } });
    const read = () => readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow', pinsPath })!.inputs;
    const first = recomputeAttribution(db, read(), people, [], NOW);
    const pins = readPins(pinsPath);
    assert.deepEqual([...pins.values()].map((p) => [p.attributions[0]!.initiative, p.rule_id]), [['globex/shop', 'registry:channel']], 'only the closed day (10-12) is pinned; 10-14 and 10-15 stay live');
    assert.equal(first.states.decided, 1);
    // the tenant moves #shop to another initiative: the pinned day keeps its decision, today follows the new rule
    writeFileSync(join(t.ann, 'rules.json'), JSON.stringify([{ id: 'r-move', when: { container: '#shop' }, then: { initiative: 'initech/a' } }]));
    recomputeAttribution(db, read(), people, [], NOW);
    const old = runAttribution(db, { since: '2026-10-12' }, NOW).fragments!.find((f) => (f.refs as string[]).includes('slack:T/C1/0'))!;
    assert.deepEqual([old.state, (old.attributions as { initiative: string }[])[0]!.initiative, (old.pinned as { rules_version: string }).rules_version.length], ['decided', 'globex/shop', 12]);
    const today = runAttribution(db, { since: '2026-10-15', state: 'rule' }, NOW).fragments!.find((f) => (f.refs as string[]).includes('slack:T/C1/1'))!;
    assert.equal((today.attributions as { initiative: string }[])[0]!.initiative, 'initech/a');
    // redo releases the day; the next build decides it with the current rule and pins it again
    appendPinLines(pinsPath, unpinLines(readPins(pinsPath), [old.id as string], 'redo'));
    recomputeAttribution(db, read(), people, [], NOW);
    const redone = runAttribution(db, { since: '2026-10-12' }, NOW).fragments!.find((f) => f.id === old.id)!;
    assert.deepEqual([redone.state, (redone.attributions as { initiative: string }[])[0]!.initiative], ['decided', 'initech/a']);
    // the timelog: today's call (exclusive Hana → acme/p5), the work block (repo → acme/p5), runs by their decisions
    const tl = runTimelog(db, { since: '2026-10-15' }, NOW);
    assert.equal(tl.policy, 'sum');
    const day = tl.days!.find((d) => d.day === '2026-10-15')!;
    const p5 = day.entries.find((e) => e.initiative === 'acme/p5') as { minutes: number };
    assert.equal(p5.minutes, 30 + 60, 'the 30-minute call and the 60-minute work block');
    const open = day.entries.find((e) => e.initiative === null && e.confidence === 'open') as { minutes: number; candidates: string[] };
    assert.deepEqual([open.minutes, open.candidates], [20, ['initech/a', 'initech/b']], 'the DM with Rui stays unattributed with candidates');
  } finally {
    db.close();
  }
});
