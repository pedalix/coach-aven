// The attribution layer end to end over a real store file: tenant inputs read from a checkout, the plan
// computed by the build and served by the sources table's `attribution` tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, recomputeCalls } from '../store.js';
import { attributionLine, clearAttribution, localDay, pinnedIdsBetween, plusDays, readAttributionInputs, recomputeAttribution, versionConfig, type AttributionSummary } from './build.js';
import { hash } from './fragment.js';
import { runAttribution, runCommitments, runIdentities, runTimelog } from '../../../snapshot/plain/sources-mcp.mjs';
import { appendPinLines, readPins, unpinLines } from './pins.js';
import type { Person } from '../people.js';
import type { Fragment } from '../annotations.js';
import type { LearnSummary } from './learn-load.js';

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
    // the initiative index follows the plan: rule and judged fragments over the platform's refs, never open ones;
    // a ledger line the plan does not hold keeps its own rows
    const index = () => db.prepare('SELECT ref, initiative, fragment_id, decided_by FROM attributions ORDER BY ref, initiative').all() as { ref: string; initiative: string; fragment_id: string; decided_by: string }[];
    const rows = index();
    assert.deepEqual(rows.filter((r) => r.ref === 'slack:T/C1/1').map((r) => [r.initiative, r.decided_by]), [['globex/shop', 'rule']], 'a live rule decision is searchable by initiative');
    assert.deepEqual(rows.filter((r) => r.ref === 'slack:T/C2/4').map((r) => [r.initiative, r.fragment_id, r.decided_by]), [['initech/b', judgedId, 'model']], 'the judgment, under its ledger id');
    assert.ok(rows.some((r) => r.ref === 'activity:git:a1' && r.initiative === 'acme/p5'), 'the work block by its repo');
    assert.equal(rows.some((r) => r.ref.startsWith('slack:T/D1/')), false, 'the open DM is in no initiative');
    const outside: Fragment = { ...ledger[0]!, id: 'frag-2026-09-01-thread-old', start: '2026-09-01T09:00:00.000Z', end: '2026-09-01T09:00:00.000Z', refs: ['slack:T/C9/0'], attributions: [{ initiative: 'acme/p5', share: 1 }] };
    recomputeAttribution(db, inputs, people, [...ledger, outside], NOW);
    assert.deepEqual(index().filter((r) => r.ref === 'slack:T/C9/0').map((r) => [r.initiative, r.fragment_id]), [['acme/p5', 'frag-2026-09-01-thread-old']], 'before the horizon: the ledger line\'s own rows');
    assert.match(String(runAttribution(db, { since: '2026-09-01', until: '2026-09-02' }, NOW).note), /outside the computed horizon 2026-10-14\.\.2026-10-15/);
    // recompute is idempotent: the same ids again
    const again = recomputeAttribution(db, inputs, people, ledger, NOW);
    assert.equal(again.fragments, sum.fragments);
    // the layer switched off: not configured, and the index is the ledger's alone again
    clearAttribution(db, ledger);
    assert.equal(runAttribution(db, {}, NOW).configured, false);
    assert.deepEqual(index().map((r) => [r.ref, r.initiative]), [['slack:T/C2/4', 'initech/b']]);
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

test('budgets: the timelog reconciles the month of `until` from its first day, whatever the window', () => {
  const db = store();
  try {
    const billed = { initiatives: registry.initiatives.map((i) => (i.id === 'acme/p5' ? { ...i, billing_code: 'P5' } : i.id === 'globex/shop' ? { ...i, billing_code: 'shop' } : i)) };
    const t = tenant({
      'initiatives.json': billed,
      'annotations/attribution.json': { subject: 'owner', since: '2026-10-14', budgets: [{ umbrella: 'acme', unit: 'half_day', perMonth: 24, by: 'billing_code' }, { umbrella: 'globex', unit: 'hour', perMonth: 10, overrides: { '2026-10': 8 } }] },
    });
    recomputeAttribution(db, readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!.inputs, people, [], NOW);
    const day = runTimelog(db, { since: '2026-10-15' }, NOW);
    const month = runTimelog(db, { since: '2026-10-01' }, NOW);
    const rec = day.reconciliation as { month: string; since: string; budgets: Array<Record<string, unknown>>; unrouted: unknown };
    assert.deepEqual([rec.month, rec.since], ['2026-10', '2026-10-01']);
    assert.deepEqual(rec, month.reconciliation, 'a one-day window and the whole month give one month');
    assert.deepEqual(rec.budgets[0], { umbrella: 'acme', unit: 'half_day', minutes: 90, used: 0.5, cap: 24, cap_source: 'default', remaining: 23.5, by: { P5: { minutes: 90, units: 0.5 } } });
    assert.deepEqual([rec.budgets[1]!.cap, rec.budgets[1]!.cap_source], [8, 'override']);
    // without budgets there is no reconciliation
    const plain = store();
    const t2 = tenant({ 'initiatives.json': billed, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-14' } });
    recomputeAttribution(plain, readAttributionInputs({ tenantRoot: t2.root, annotationsDir: t2.ann, timezone: 'Europe/Moscow' })!.inputs, people, [], NOW);
    assert.equal(runTimelog(plain, {}, NOW).reconciliation, undefined);
    plain.close();
  } finally {
    db.close();
  }
});

test('calls and runs get their people: copies of one call are one fragment; name-only and glued invitees, the calendar event, the speakers and a run\'s recipients count', () => {
  const db = store();
  try {
    const mt = db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const notes = 'Walked through the release checklist, the open risks and who owns which follow-up. '.repeat(3);
    // One call, two recorders: Gemini (no end, its invitees glued into one name) and Granola (only the subject listed).
    // Overlap alone kept them apart — two calls, and nobody but the subject at either.
    mt.run('gmeet:me:doc1', 'gmeet', 'me', 'doc1', 'Platform review', '2026-10-15T13:00:00.000Z', '2026-10-15T13:00:00.000Z', JSON.stringify([{ email: '', name: 'Olga Owner Hana Hill' }]), notes, '');
    mt.run('granola:me:n3', 'granola', 'me', 'n3', 'Platform review', '2026-10-15T13:02:00.000Z', '2026-10-15T13:40:00.000Z', JSON.stringify([{ email: 'olga@example.com', name: 'Olga Owner' }]), notes, 'Me: so\nThem: yes\n'.repeat(50));
    // Granola lists only the subject; the calendar event (same title, 5 minutes off) has Rui's address.
    mt.run('granola:me:n4', 'granola', 'me', 'n4', 'Reconciliation', '2026-10-15T14:00:00.000Z', '2026-10-15T14:30:00.000Z', JSON.stringify([{ email: 'olga@example.com', name: 'Olga Owner' }]), notes, 'x'.repeat(800));
    db.prepare('INSERT INTO events(ref, source, account, start, title, attendees, organizer) VALUES (?, ?, ?, ?, ?, ?, ?)').run('gcal:me:e1', 'gcal', 'me', '2026-10-15T17:05:00+03:00', 'Reconciliation', JSON.stringify(['rui@example.com', 'olga@example.com']), 'olga@example.com');
    // Wispr writes no attendees here; the transcript's speaker labels name Hana.
    mt.run('wispr:me:w1', 'wispr', 'me', 'w1', 'Quick check', '2026-10-15T15:00:00.000Z', '2026-10-15T15:20:00.000Z', '[]', notes, 'Hana Hill: the release is ready\nOlga Owner: great\n'.repeat(20));
    recomputeCalls(db);
    // A DM in a channel whose id names nobody: Rui never wrote back, but the message was addressed to him.
    db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('slack:T/D9/1', 'slack', 'T', 'dm:U0ABCDEFGH1', 'd9', '2026-10-15T11:30:00.000Z', 'owner', 'Olga Owner', '', 'Could you check the reconciliation numbers for last week by Friday?');
    db.prepare('INSERT INTO message_people(ref, person_id, role) VALUES (?, ?, ?)').run('slack:T/D9/1', 'rui', 'to');

    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-15' } });
    recomputeAttribution(db, readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!.inputs, people, [], NOW);
    const frags = db.prepare('SELECT id, kind, start, "end", refs, participants, state, attributions, candidates, rule_id FROM att_fragments').all() as Record<string, string>[];
    const of = (ref: string) => frags.filter((f) => (JSON.parse(f.refs!) as string[]).includes(ref));

    const review = of('meeting:granola:n3');
    assert.equal(review.length, 1, 'one call, not two');
    assert.deepEqual(of('meeting:gmeet:doc1'), review);
    const call = review[0]!;
    assert.equal(call.id, `frag-2026-10-15-call-granola-${hash('n3')}`, 'named by its first copy (recorder priority, then start): Granola, though the Gemini doc starts earlier');
    assert.deepEqual(JSON.parse(call.refs!), ['meeting:granola:n3', 'meeting:gmeet:doc1']);
    assert.deepEqual([call.start, call.end], ['2026-10-15T13:02:00.000Z', '2026-10-15T13:40:00.000Z'], 'the naming copy\'s window; the Gemini doc has no end to add');
    assert.deepEqual(JSON.parse(call.participants!).sort(), ['hana', 'owner'], 'the glued Gemini invitees, split against the people file');
    assert.deepEqual([call.state, call.rule_id], ['rule', 'marker:hana']);
    const indexed = db.prepare("SELECT ref, initiative FROM attributions WHERE fragment_id = ? ORDER BY ref").all(call.id!) as { ref: string; initiative: string }[];
    assert.deepEqual(indexed.map((r) => [r.ref, r.initiative]), [['meeting:gmeet:doc1', 'acme/p5'], ['meeting:granola:n3', 'acme/p5']], 'the decision indexes both copies');

    const recon = of('meeting:granola:n4')[0]!;
    assert.deepEqual(JSON.parse(recon.participants!).sort(), ['owner', 'rui'], 'the linked calendar event names Rui');
    assert.deepEqual([recon.state, JSON.parse(recon.candidates!)], ['open', ['initech/a', 'initech/b']]);

    const quick = of('meeting:wispr:w1')[0]!;
    assert.deepEqual(JSON.parse(quick.participants!).sort(), ['hana', 'owner'], 'the transcript\'s speakers');
    assert.equal(quick.rule_id, 'marker:hana');

    const dm = of('slack:T/D9/1')[0]!;
    assert.deepEqual(JSON.parse(dm.participants!).sort(), ['owner', 'rui'], 'the recipient, though he never wrote back');
    assert.deepEqual([dm.state, JSON.parse(dm.candidates!)], ['open', ['initech/a', 'initech/b']]);
  } finally {
    db.close();
  }
});

test('identities and commitments: computed with the plan, served by their tools; not configured without the config', () => {
  const db = store();
  try {
    // a known person under an address the people file does not list (their glued full name), and a call with next steps
    db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'gmail:me:m9', 'gmail', 'me', 'inbox', 'gmail:me/t9', '2026-10-15T06:00:00.000Z', null, 'hanahill@mail.example', 'Re: plan', 'Sounds good, see you at the sync',
    );
    db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, next_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'granola:me:n2', 'granola', 'me', 'n2', 'Planning', '2026-10-15T13:00:00.000Z', '2026-10-15T13:30:00.000Z',
      JSON.stringify([{ name: 'Olga Owner', email: 'olga@example.com' }, { name: 'Rui Rosa', email: 'rui@example.com' }]), 'Plan.',
      JSON.stringify(['Send the invoices list to Rui (Olga)', 'Details for the list.', 'Check the export (Rui)']),
    );
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-14' } });
    assert.deepEqual(runIdentities(db), { configured: false, note: 'no attribution layer for this project: the tenant repo has no annotations/attribution.json (or the store predates it)' });
    const sum = recomputeAttribution(db, readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!.inputs, people, [], NOW);
    assert.deepEqual([sum.identities, sum.commitments], [{ merges: 1, questions: 0 }, 2]);
    const ids = runIdentities(db);
    assert.deepEqual(ids.merges, [{ person_id: 'hana', identity: 'hanahill@mail.example', reason: 'mailbox is the glued full name' }]);
    assert.equal(ids.subject, 'owner');
    const all = runCommitments(db, { since: '2026-10-15' }, NOW).commitments!;
    assert.deepEqual(all.map((r) => [r.owner, r.to, r.what, r.day]), [['owner', 'rui-rosa', 'Send the invoices list to Rui', '2026-10-15'], ['rui', null, 'Check the export', '2026-10-15']]);
    assert.deepEqual(all[0]!.provenance, [{ kind: 'meeting', ref: 'granola:me:n2' }]);
    assert.deepEqual(runCommitments(db, { since: '2026-10-15', owner: 'subject' }, NOW).commitments!.map((r) => r.owner), ['owner']);
    assert.equal(runCommitments(db, { since: '2026-10-14', until: '2026-10-14' }, NOW).commitments!.length, 0);
    clearAttribution(db);
    assert.equal(runCommitments(db, {}, NOW).configured, false);
  } finally {
    db.close();
  }
});

test('judged, then a twin copy lands (earlier start, zero length): the judgment stays attached, nothing new is pinned', () => {
  const db = store();
  try {
    const mt = db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const notes = 'Walked through the release checklist, the open risks and who owns which follow-up. '.repeat(3);
    // 10-13, a closed day at NOW: Granola's copy lists only the subject — the ladder cannot decide it; the evening review did.
    mt.run('granola:me:n3', 'granola', 'me', 'n3', 'Platform review', '2026-10-13T13:02:00.000Z', '2026-10-13T13:40:00.000Z', JSON.stringify([{ email: 'olga@example.com', name: 'Olga Owner' }]), notes, 'Me: so\nThem: yes\n'.repeat(50));
    recomputeCalls(db);
    const judged = `frag-2026-10-13-call-granola-${hash('n3')}`;
    const ledger: Fragment[] = [{ id: judged, kind: 'call', start: '2026-10-13T13:02:00.000Z', end: '2026-10-13T13:40:00.000Z', refs: ['meeting:granola:n3'], attributions: [{ initiative: 'initech/a', share: 1 }], decided_by: 'owen', status: 'decided' }];
    const pinsPath = join(mkdtempSync(join(tmpdir(), 'pins-')), 'pins.jsonl');
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-13' } });
    const inputs = readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow', pinsPath })!.inputs;
    const pins = () => (existsSync(pinsPath) ? readFileSync(pinsPath, 'utf8') : '');
    recomputeAttribution(db, inputs, people, ledger, NOW);
    const before = pins();
    // The Gemini notes doc lands later: its start is the scheduled 13:00 (before Granola's), it has no end, and its glued
    // invitee line names Hana (exclusive → acme/p5) — renamed after it, the call would be re-decided and pinned that way.
    mt.run('gmeet:me:doc1', 'gmeet', 'me', 'doc1', 'Platform review', '2026-10-13T13:00:00.000Z', '2026-10-13T13:00:00.000Z', JSON.stringify([{ email: '', name: 'Olga Owner Hana Hill' }]), notes, '');
    recomputeCalls(db);
    recomputeAttribution(db, inputs, people, ledger, NOW);
    const calls = db.prepare("SELECT id, refs, state, decided_by, attributions, ledger_id FROM att_fragments WHERE kind = 'call' AND start LIKE '2026-10-13%'").all() as Record<string, string>[];
    assert.deepEqual(calls.map((c) => [c.id, c.state, c.decided_by, c.ledger_id, (JSON.parse(c.attributions!) as { initiative: string }[])[0]!.initiative]), [[judged, 'decided', 'owen', judged, 'initech/a']], 'one call: the judged id, the judgment');
    assert.deepEqual(JSON.parse(calls[0]!.refs!), ['meeting:granola:n3', 'meeting:gmeet:doc1']);
    assert.equal(pins(), before, 'nothing new is pinned');
    const indexed = db.prepare("SELECT ref, initiative FROM attributions WHERE ref IN ('meeting:granola:n3', 'meeting:gmeet:doc1') ORDER BY ref, initiative").all() as { ref: string; initiative: string }[];
    assert.deepEqual(indexed.map((r) => [r.ref, r.initiative]), [['meeting:gmeet:doc1', 'initech/a'], ['meeting:granola:n3', 'initech/a']], 'both copies under the judgment, and no second initiative');
  } finally {
    db.close();
  }
});

test('a pin under a copy\'s own id stays attached when a later copy that started earlier renames the call; a redo releases it too', () => {
  const db = store();
  try {
    const mt = db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const notes = 'Walked through the release checklist, the open risks and who owns which follow-up. '.repeat(3);
    // 10-13 (closed): Wispr alone, whose transcript names Hana (exclusive → acme/p5) — the first build pins that.
    mt.run('wispr:me:w2', 'wispr', 'me', 'w2', 'Quick check', '2026-10-13T09:00:00.000Z', '2026-10-13T09:30:00.000Z', '[]', notes, 'Hana Hill: the release is ready\nOlga Owner: great\n'.repeat(20));
    recomputeCalls(db);
    const pinsPath = join(mkdtempSync(join(tmpdir(), 'pins-')), 'pins.jsonl');
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { subject: 'owner', since: '2026-10-13' } });
    const read = () => readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow', pinsPath })!.inputs;
    recomputeAttribution(db, read(), people, [], NOW);
    const wispr = `frag-2026-10-13-call-wispr-${hash('w2')}`;
    assert.deepEqual([...readPins(pinsPath).keys()], [wispr]);
    const pinned = readFileSync(pinsPath, 'utf8');
    // Then the tenant moves Hana's calls elsewhere, and Granola's copy of the same call syncs (it started 30 s earlier):
    // Granola names the call now — the closed day must keep its pinned decision, not take the new rule.
    writeFileSync(join(t.ann, 'rules.json'), JSON.stringify([{ id: 'r-hana', when: { person: 'hana' }, then: { initiative: 'initech/a' } }]));
    mt.run('granola:me:n5', 'granola', 'me', 'n5', 'Quick check', '2026-10-13T08:59:30.000Z', '2026-10-13T09:30:00.000Z', JSON.stringify([{ email: 'olga@example.com', name: 'Olga Owner' }]), notes, 'Me: so\nThem: yes\n'.repeat(50));
    recomputeCalls(db);
    recomputeAttribution(db, read(), people, [], NOW);
    const granola = `frag-2026-10-13-call-granola-${hash('n5')}`;
    const calls = () => (db.prepare("SELECT f.id, f.state, f.attributions, p.pinned_at FROM att_fragments f LEFT JOIN att_pins p ON p.id = f.id WHERE f.kind = 'call' AND f.start LIKE '2026-10-13%'").all() as Record<string, string | null>[]).map((c) => [c.id, c.state, (JSON.parse(c.attributions!) as { initiative: string }[])[0]!.initiative, !!c.pinned_at]);
    assert.deepEqual(calls(), [[granola, 'decided', 'acme/p5', true]], 'renamed, and still the pinned decision');
    assert.equal(readFileSync(pinsPath, 'utf8'), pinned, 'nothing new is pinned');
    // `orch sources attribution redo` for 10-13 (Moscow): the pin under the Wispr copy's id is released with the call
    const ids = pinnedIdsBetween(db, '2026-10-12T21:00:00.000Z', '2026-10-13T20:59:59.999Z');
    assert.deepEqual(ids, [granola, wispr]);
    appendPinLines(pinsPath, unpinLines(readPins(pinsPath), ids, 'redo'));
    recomputeAttribution(db, read(), people, [], NOW);
    assert.deepEqual(calls(), [[granola, 'decided', 'initech/a', true]], 'the current rule decides it, pinned again');
    assert.deepEqual([...readPins(pinsPath).keys()], [granola]);
  } finally {
    db.close();
  }
});

test('team mode: the loop gets the plan\'s drafts — none — so it builds no fragment units next to the items', () => {
  const db = store();
  try {
    const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': { items: { days: 2 }, learn: { mode: 'shadow' } } });
    const sum = recomputeAttribution(db, readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow' })!.inputs, people, [], NOW);
    assert.equal(sum.fragments, 0);
    const learn = sum.learn as LearnSummary;
    assert.ok(learn && !('error' in learn), JSON.stringify(sum.learn));
    assert.equal(learn.units.fragment, 0, 'the store has a call and a work block: a tenant without a subject fragments neither');
    assert.ok(learn.units.item > 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM att_learn WHERE unit = 'fragment'").get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
});

test('item mode and the loop leave the pins alone: the rules version ignores `items` and `learn`', () => {
  assert.equal(versionConfig({ subject: 'owner', since: '2026-10-12' }), versionConfig({ subject: 'owner', items: { days: 30 }, since: '2026-10-12', learn: { mode: 'shadow' } }));
  assert.notEqual(versionConfig({ subject: 'owner' }), versionConfig({ subject: 'owner', admin: { acme: 'acme/admin' } }), 'what decides still moves it');
  const pinsOf = (cfg: object): string => {
    const db = store();
    try {
      // a message on 10-12 in #shop: a closed day's registry decision, pinned by the build
      db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'slack:T/C1/0', 'slack', 'T', '#shop', 't0', '2026-10-12T07:00:00.000Z', 'owner', 'Olga Owner', '', 'Checked the SH-11 export, all rows are there now',
      );
      const pinsPath = join(mkdtempSync(join(tmpdir(), 'pins-')), 'pins.jsonl');
      const t = tenant({ 'initiatives.json': registry, 'annotations/attribution.json': cfg });
      recomputeAttribution(db, readAttributionInputs({ tenantRoot: t.root, annotationsDir: t.ann, timezone: 'Europe/Moscow', pinsPath })!.inputs, people, [], NOW);
      return readFileSync(pinsPath, 'utf8');
    } finally {
      db.close();
    }
  };
  const off = pinsOf({ subject: 'owner', since: '2026-10-12' });
  assert.match(off, /"rules_version":"[0-9a-f]{12}"/);
  assert.equal(pinsOf({ subject: 'owner', since: '2026-10-12', items: { days: 30 }, learn: { mode: 'shadow' } }), off, 'byte-identical pins with item mode and the loop on');
});

test('attributionLine: the plan\'s counts as before; the item pass and the loop only while on, and their errors spelled out', () => {
  const base: AttributionSummary = { since: '2026-10-01', until: '2026-10-15', fragments: 3, states: { decided: 1, escalated: 0, rule: 1, open: 1 }, proposals: 2, identities: { merges: 0, questions: 0 }, commitments: 0, items: null };
  const plan = 'attribution 2026-10-01..2026-10-15: 3 fragments (decided 1, escalated 0, rule 1, open 1), 2 proposals';
  assert.equal(attributionLine(base), plan, 'off: the line as it always was');
  assert.equal(
    attributionLine({ ...base, items: { since: '2026-09-16', until: '2026-10-15', items: 120, senders: { human: 80, bot: 30, bulk: 6, system: 4 }, decided: 90, clusters: 12 }, learn: { mode: 'shadow', units: { fragment: 3, item: 120 }, would_decide: 70, floor_decided: 64, questions: 3, audits: 1 } as unknown as LearnSummary }),
    `${plan}; items 2026-09-16..2026-10-15: 120 (90 decided, 12 clusters); learn shadow: 3 fragments + 120 items, would decide 70 (floor 64), 3 questions, 1 audits`,
  );
  assert.equal(attributionLine({ ...base, items: { error: 'no such table: tasks' }, learn: { error: 'boom' } }), `${plan}; items FAILED: no such table: tasks (previous rows kept); learn FAILED: boom (previous rows kept)`);
});
