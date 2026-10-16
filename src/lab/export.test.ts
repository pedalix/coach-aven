// The real-store exporter over a tiny fictional store and tenant: unit and gold shapes, alias and split resolution,
// the local-day window, and that name-only and glued attendees reach the bench exactly as stored. Pure: tmp files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, seedPeople } from '../sources/store.js';
import { hash } from '../sources/attribution/fragment.js';
import { parseRegistry, Registry } from '../sources/attribution/registry.js';
import type { Person } from '../sources/people.js';
import { loadDataset } from './dataset.js';
import { attendeeRaw, exportDataset, identityAnswer, itemKeys, main, mentionKey, Roster, speakerLabels, t1Label, topicSection } from './export.js';
import type { FragmentUnit, GoldRow, ItemUnit, MentionUnit } from './types.js';

const NOW = new Date('2026-10-15T16:00:00.000Z'); // 19:00 in Europe/Moscow
const TZ = 'Europe/Moscow';

const people: Person[] = [
  { person_id: 'owner', name: 'Olga Owner', identities: ['olga@home.example', 'slack:Olga Owner'] },
  { person_id: 'hana', name: 'Hana Hill', identities: ['hana@acme.example', 'slack:Hana Hill'], marker: { type: 'exclusive', initiatives: ['acme/shop'] } },
  { person_id: 'rui', name: 'Rui Rosa', identities: ['rui@globex.example', 'slack:Rui Rosa'], marker: { type: 'narrow', initiatives: ['globex/a', 'globex/b'] } },
  // added to the roster after a "new person" answer: listed by name and mailbox only
  { person_id: 'dana-dune', name: 'Dana Dune', identities: ['dana@globex.example'] },
];

const registry = {
  initiatives: [
    { id: 'acme/shop', umbrella: 'acme', sources: { slack_channels: ['#shop'], youtrack_prefixes: ['SH'] } },
    { id: 'acme/old-shop', umbrella: 'acme', alias_of: 'acme/shop', sources: {} },
    { id: 'globex/a', umbrella: 'globex', sources: {} },
    { id: 'globex/b', umbrella: 'globex', sources: {} },
    { id: 'globex/ab', umbrella: 'globex', split_into: { 'globex/a': 0.5, 'globex/b': 0.5 }, sources: {} },
    { id: 'personal/garden', sources: { repos: ['github.com/olga-example/garden'] } },
  ],
};

const SUMMARY = ['## Release plan', 'Ship the platform release on Friday; the owners are confirmed.', '## Hiring', 'Two backend roles are open, interviews next week.', '## Next steps', '- Olga sends the notes'].join('\n');

const ids = {
  shop: `frag-2026-10-15-thread-${hash('#shop|slack:T/C1/1')}`,
  dm: `frag-2026-10-15-thread-${hash('dm:@Rui Rosa|slack:T/D1/2')}`,
  general: `frag-2026-10-15-thread-${hash('#general|slack:T/C2/4')}`,
  call1: `frag-2026-10-15-call-granola-${hash('n1')}#1`,
  call2: `frag-2026-10-15-call-granola-${hash('n1')}#2`,
  weekly: `frag-2026-10-14-call-gmeet-${hash('g1')}`,
  work: `frag-2026-10-15-work-${hash('activity:git:a1@2026-10-15T12:00:00.000Z')}`,
};
const TASK = 'youtrack:tracker.acme.example:t1';

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** A store laid out like the bench corpus: <root>/store.sqlite, <root>/attribution/pins.jsonl, <root>/tenant/. */
function fixture(): { root: string; storePath: string; tenantDir: string; pinsPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'lab-export-'));
  const storePath = join(root, 'store.sqlite');
  const db = openStore(storePath);
  seedPeople(db, people);
  const msg = db.prepare('INSERT INTO messages(ref, source, account, container, thread_id, ts, author_person, author_raw, subject, text, participants, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const m = (ref: string, container: string, thread: string, ts: string, person: string | null, author: string, text: string, participants = [author], bot = 0) =>
    msg.run(ref, 'slack', 'T', container, thread, ts, person, author, '', text, JSON.stringify(participants), bot);
  m('slack:T/C1/0', '#shop', 't0', '2026-09-01T07:00:00.000Z', 'owner', 'Olga Owner', 'An old note about the SH-3 import, long before the window');
  m('slack:T/C1/1', '#shop', 't1', '2026-10-15T07:00:00.000Z', 'owner', 'Olga Owner', 'The SH-12 import failed on staging again, see https://ci.example/run/42.');
  m('slack:T/C1/7', '#shop', 't1', '2026-10-15T07:30:00.000Z', 'rui', 'Rui Rosa', 'Looks like the mapping table changed');
  m('slack:T/D1/2', 'dm:@Rui Rosa', 'd1', '2026-10-15T08:00:00.000Z', 'owner', 'Olga Owner', 'Can you send me the reconciliation numbers for last week?', ['Olga Owner', 'Rui Rosa']);
  m('slack:T/D1/3', 'dm:@Rui Rosa', 'd1', '2026-10-15T08:05:00.000Z', 'rui', 'Rui Rosa', 'sure, tomorrow', ['Rui Rosa', 'Olga Owner']);
  m('slack:T/C2/4', '#general', 't2', '2026-10-15T09:00:00.000Z', 'owner', 'Olga Owner', 'Hana, the platform release notes need another pass before Friday');
  m('slack:T/C2/5', '#general', 't2', '2026-10-15T09:01:00.000Z', 'hana', 'Hana Hill', 'on it');
  m('slack:T/C9/8', '#alerts', 't9', '2026-10-15T10:00:00.000Z', null, 'CI Robot', 'Deploy 42 finished for SH-12 <https://ci.example/run/42|run 42>', ['CI Robot'], 1);
  m('slack:T/C1/9', '#shop', 't3', '2026-10-14T06:00:00.000Z', null, 'R. Rosa', 'R. here, I can take SH-12 tomorrow');
  m('slack:T/C1/10', '#shop', 't4', '2026-10-14T07:00:00.000Z', null, 'Zed Zorn', 'Zed from the vendor side, any news on the import?');
  m('slack:T/C1/11', '#shop', 't5', '2026-10-14T07:30:00.000Z', null, 'Dana D.', 'Dana here, the export file is attached');
  m('slack:T/C3/12', '#ops', 't6', '2026-10-14T08:00:00.000Z', null, 'Deploy Desk', 'Maintenance window confirmed for Thursday night');
  m('slack:T/C3/13', '#ops', 't7', '2026-10-13T20:30:00.000Z', 'rui', 'Rui Rosa', 'Late on the 13th in Moscow: outside the window');
  m('slack:T/C3/14', '#ops', 't8', '2026-10-13T21:30:00.000Z', 'rui', 'Rui Rosa', 'Just after midnight in Moscow: inside the window');
  const mp = db.prepare('INSERT INTO message_people(ref, person_id, role) VALUES (?, ?, ?)');
  mp.run('slack:T/D1/2', 'owner', 'from');
  mp.run('slack:T/D1/2', 'rui', 'to');
  mp.run('slack:T/D1/3', 'owner', 'to');
  const meet = db.prepare('INSERT INTO meetings(ref, source, account, id, title, start, "end", attendees, summary, transcript, call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  meet.run('granola:me:n1', 'granola', 'me', 'n1', 'Platform sync', '2026-10-15T10:00:00.000Z', '2026-10-15T10:30:00.000Z', JSON.stringify([{ email: 'hana@acme.example', name: 'Hana Hill' }, { email: 'olga@home.example', name: 'Olga Owner' }]), SUMMARY,
    ['Hana Hill: we ship on Friday', 'Olga Owner: good, and the hiring plan?', '00:01:14', 'see https://notes.example/x', 'Hana Hill: two roles', 'filler '.repeat(100)].join('\n'), 'call-1');
  // Gemini: a zero-length window, name-only attendees, one glued line, one address stored as the e-mail
  meet.run('gmeet:me:g1', 'gmeet', 'me', 'g1', 'Weekly sync', '2026-10-14T12:00:00.000Z', '2026-10-14T12:00:00.000Z', JSON.stringify([{ email: '', name: 'Rui Rosa' }, { email: '', name: 'Ana Berg Rui Rosa' }, { email: 'h.hill@acme.example', name: '' }]),
    'Invited Rui Rosa Ana Berg\nWe went through the reconciliation numbers for the quarter and the next release.', `Rui Rosa: the numbers are in\n${'more talk '.repeat(80)}`, 'call-2');
  const mtp = db.prepare('INSERT INTO meeting_people(ref, person_id) VALUES (?, ?)');
  mtp.run('granola:me:n1', 'hana');
  mtp.run('granola:me:n1', 'owner');
  mtp.run('gmeet:me:g1', 'rui');
  const ev = db.prepare('INSERT INTO events(ref, source, account, calendar, start, "end", title, attendees, organizer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ev.run('gcal:olga@home.example:e1', 'gcal', 'olga@home.example', 'olga@home.example', '2026-10-14T12:05:00.000Z', '2026-10-14T12:35:00.000Z', 'Weekly Sync!', JSON.stringify(['olga@home.example', 'rui@globex.example']), 'olga@home.example');
  ev.run('gcal:olga@home.example:e2', 'gcal', 'olga@home.example', 'olga@home.example', '2026-10-14T13:00:00.000Z', '2026-10-14T13:30:00.000Z', 'Weekly sync', JSON.stringify(['olga@home.example']), 'olga@home.example');
  db.prepare('INSERT INTO tasks(ref, source, account, key, title, status, assignee_raw, assignee_person, reporter_raw, reporter_person, created, updated, project, url, text, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    TASK, 'youtrack', 'tracker.acme.example', 'SH-12', 'Import fails on staging', 'Open', 'rui@globex.example', 'rui', 'youtrack:dana@ACME', null, '2026-10-01T08:00:00.000Z', '2026-10-15T09:00:00.000Z', 'SH',
    'https://tracker.acme.example/issue/SH-12', 'The nightly import stops at row 300.',
    JSON.stringify([{ id: '101', author: 'Hana Hill', ts: '2026-09-01T08:00:00.000Z', text: 'Old note' }, { id: '102', author: 'Rui Rosa', ts: '2026-10-15T08:00:00.000Z', text: 'Looking at SH-12 now, see SH-7 too' }]),
  );
  db.prepare('INSERT INTO activity(ref, source, account, id, container, start, "end", minutes, title, items, items_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'git:me:a1', 'git', 'me', 'a1', 'github.com/olga-example/garden', '2026-10-15T12:00:00.000Z', '2026-10-15T13:00:00.000Z', 60, 'garden: 2 commits', '[]', 'fix the watering schedule\nadd the soil sensor',
  );
  db.close(); // the exporter opens the file immutable: everything must be in the main file, not the WAL

  const tenantDir = join(root, 'tenant');
  const ann = join(tenantDir, 'annotations');
  mkdirSync(ann, { recursive: true });
  writeFileSync(join(tenantDir, 'initiatives.json'), JSON.stringify(registry));
  writeFileSync(join(ann, 'attribution.json'), JSON.stringify({ subject: 'owner', since: '2026-10-14' }));
  writeFileSync(join(ann, 'people.json'), JSON.stringify(people));
  const L = (o: Record<string, unknown>) => ({ kind: 'thread', start: '', end: '', refs: [], rule_id: null, rationale: '', decided_at: '2026-10-15T15:00:00.000Z', status: 'decided', ...o });
  writeFileSync(join(ann, 'fragments.jsonl'), jsonl([
    L({ id: ids.general, refs: ['slack:T/C2/4'], attributions: [{ initiative: 'acme/old-shop', share: 1 }], decided_by: 'owen' }),
    L({ id: ids.dm, refs: ['slack:T/D1/2'], attributions: [{ initiative: 'globex/ab', share: 1 }], decided_by: 'model' }),
    // an earlier cut of the #shop run: covers today's fragment by its ref (plan.ts), not by id
    L({ id: 'frag-2026-10-15-thread-oldcut', refs: ['slack:T/C1/1'], attributions: [{ initiative: 'acme/shop', share: 1 }], decided_by: 'rule', rule_id: 'registry:channel' }),
    L({ id: ids.call2, kind: 'call', attributions: [{ initiative: 'globex/a', share: 0.4 }], decided_by: 'model' }),
    L({ id: ids.call2, kind: 'call', attributions: [], decided_by: 'model', status: 'superseded' }),
    L({ id: ids.call1, kind: 'call', attributions: [], decided_by: 'model', status: 'escalated' }),
    L({ id: 'frag-2026-10-02-thread-orphan', refs: ['slack:T/C1/0'], attributions: [{ initiative: 'acme/shop', share: 1 }], decided_by: 'rule' }),
  ]));
  const pin = (id: string, initiative: string, share = 1) => ({ id, attributions: [{ initiative, share }], rule_id: 'marker:hana', rationale: 'pinned', rules_version: 'abc123def456', pinned_at: '2026-10-15T00:00:00.000Z' });
  mkdirSync(join(root, 'attribution'));
  const pinsPath = join(root, 'attribution', 'pins.jsonl');
  writeFileSync(pinsPath, jsonl([pin(ids.call2, 'acme/shop', 0.42), pin(ids.shop, 'globex/a'), pin('frag-2026-09-30-work-gone', 'acme/shop')]));
  const who = (label: string, answer: string | null, options: string[], status = 'answered') => ({
    id: `esc-identity-name-${label.replace(/[^a-z]+/g, '-')}`, kind: 'identity_merge', status, question: `Who is "${label}"? Seen 5× in slack talking with you — new person, or someone known under another name?`, options, refs: ['#shop'], answer, asked_at: '2026-10-14T19:00:00.000Z',
  });
  const NEW = (label: string) => [`new person "${label}"`, 'merge into <person_id>', 'ignore (system/irrelevant)'];
  writeFileSync(join(ann, 'escalations.jsonl'), jsonl([
    { id: `esc-attr-${ids.work}`, kind: 'attribution', status: 'answered', question: 'Which initiative is this work?', options: ['personal/non-billable, drop from timelog', 'other'], refs: ['activity:git:a1'], answer: 'side project — personal/garden', asked_at: '2026-10-15T14:00:00.000Z' },
    { id: 'esc-attr-s-gone', kind: 'attribution', status: 'answered', question: '?', options: [], refs: ['frag-2026-09-01-thread-gone'], answer: 'acme/shop', asked_at: '2026-10-15T14:00:00.000Z' },
    { id: 'esc-attr-s-refs', kind: 'attribution', status: 'answered', question: '?', options: [], refs: ['slack:T/C1/1'], answer: 'acme/shop', asked_at: '2026-10-15T14:00:00.000Z' },
    { id: 'esc-identity-name-r-rosa-yn', kind: 'identity_merge', status: 'open', question: 'Is “r. rosa” (slack) = Rui Rosa?', options: ['yes: rui', 'no — new person', 'ignore'], refs: ['#shop'], answer: null },
    { id: 'esc-identity-name-r-rosa-yn', kind: 'identity_merge', status: 'answered', question: 'Is “r. rosa” (slack) = Rui Rosa?', options: ['yes: rui', 'no — new person', 'ignore'], refs: ['#shop'], answer: 'yes' },
    who('zed zorn', 'new person', NEW('zed zorn')),
    who('dana d.', 'new person Dana Dune, globex', NEW('dana d.')),
    who('deploy desk', 'ignore (system/irrelevant)', NEW('deploy desk')),
    who('nobody here', 'new person', NEW('nobody here')),
    who('ana berg', null, NEW('ana berg'), 'open'),
  ]));
  writeFileSync(join(ann, 'identity-merges.jsonl'), jsonl([{ at: '2026-10-09T21:00:00.000Z', id: 'merge-h.hill@acme.example', identity: 'h.hill@acme.example', merged_by: 'rule', person_id: 'hana', reason: 'same first name, seen together' }]));
  return { root, storePath, tenantDir, pinsPath };
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
const gold = (rows: GoldRow[] | undefined, id: string, tier: string) => (rows ?? []).find((g) => g.id === id && g.tier === tier);

test('pure helpers: keys and links, attendee raws as stored, transcript speakers, topic sections', () => {
  assert.deepEqual(itemKeys('See SH-12 and P1-7 at <https://ci.example/run/42|run 42>, also https://x.example/a.'), ['SH-12', 'P1-7', 'https://ci.example/run/42', 'https://x.example/a']);
  assert.equal(attendeeRaw({ email: '', name: 'Ana Berg Rui Rosa' }), 'Ana Berg Rui Rosa', 'an empty e-mail keeps the (glued) name');
  assert.equal(attendeeRaw({ email: 'ana@acme.example', name: 'Ana Berg' }), 'ana@acme.example');
  assert.equal(attendeeRaw('Rui Rosa'), 'Rui Rosa');
  assert.equal(attendeeRaw(null), '');
  assert.deepEqual(speakerLabels('Ana Berg: hi\n00:01:14\nsee https://x.example/y\nRui Rosa: yo\nAna Berg: again\nThis is a long sentence ending with a colon: and more'), ['Ana Berg', 'Rui Rosa']);
  assert.match(topicSection(SUMMARY, 1), /^## Release plan\nShip the platform release/);
  assert.match(topicSection(SUMMARY, 2), /^## Hiring\nTwo backend roles/);
  // a structural or empty section before a topic does not shift the numbering
  assert.match(topicSection(`## Summary\nall good\n## Empty\n\n${SUMMARY}`, 2), /^## Hiring/);
  assert.equal(topicSection('no headings at all', 1), 'no headings at all');
  assert.equal(mentionKey('Ana Berg <ana@acme.example>'), 'ana@acme.example');
  assert.equal(mentionKey('slack:Ana Berg'), 'name:ana berg');
});

test('t1Label: weight-scaled shares made relative, aliases followed, splits spread, alts from 25 %', () => {
  const reg = new Registry(parseRegistry(registry));
  assert.deepEqual(t1Label([{ initiative: 'acme/old-shop', share: 0.2 }], reg), { label: 'acme/shop', alts: [], shares: [{ label: 'acme/shop', share: 1 }] });
  assert.deepEqual(t1Label([{ initiative: 'globex/ab', share: 0.116 }], reg)?.alts, ['globex/b'], 'a split of a small topic still reads 50/50');
  assert.deepEqual(t1Label([{ initiative: 'globex/a', share: 0.058 }, { initiative: 'globex/b', share: 0.058 }], reg), { label: 'globex/a', alts: ['globex/b'], shares: [{ label: 'globex/a', share: 0.5 }, { label: 'globex/b', share: 0.5 }] });
  assert.deepEqual(t1Label([{ initiative: 'globex/a', share: 0.8 }, { initiative: 'globex/b', share: 0.2 }], reg)?.alts, [], 'under a quarter is not an alternative');
  assert.equal(t1Label([], reg), null);
});

test('identityAnswer: yes, merge, ignore, and a "new person" who is in the roster by now', () => {
  const roster = new Roster(people);
  assert.deepEqual(identityAnswer('yes', ['yes: rui', 'no — new person', 'ignore'], 'name:r. rosa', roster), { label: 'rui', how: 'yes' });
  assert.equal(identityAnswer('yes, Rui Rosa', ['yes: hana', 'yes: rui', 'no — new person'], null, roster)?.label, 'rui');
  assert.equal(identityAnswer('yes', ['yes: hana', 'yes: rui'], null, roster), null, 'two guesses and no name: unresolved');
  assert.equal(identityAnswer('merge into Hana Hill, acme', [], null, roster)?.label, 'hana');
  assert.equal(identityAnswer('same as hana@acme.example — Hana', [], null, roster)?.label, 'hana');
  assert.equal(identityAnswer('no — a webinar invite list, ignore', ['yes: rui', 'no — new person', 'ignore'], null, roster)?.label, 'system');
  assert.equal(identityAnswer('new person Dana Dune, globex', [], 'name:dana d.', roster)?.label, 'dana-dune');
  assert.equal(identityAnswer('new person', ['new person "zed zorn"'], 'name:zed zorn', roster)?.label, 'unknown');
  assert.equal(identityAnswer('different person from rui — new person Zed Zorn', [], 'name:z.', roster)?.label, 'unknown');
  assert.equal(identityAnswer('maybe later', [], null, roster), null);
});

test('exportDataset: units, gold and meta from a frozen store and the tenant as given — read-only, links back', async () => {
  const fx = fixture();
  const out = join(fx.root, 'datasets', 'fixture-real');
  const before = [sha(fx.storePath), sha(fx.pinsPath), sha(join(fx.tenantDir, 'annotations', 'fragments.jsonl'))];
  try {
    const meta = await exportDataset({ name: 'fixture-real', kind: 'real', source: { store: fx.storePath, tenantDir: fx.tenantDir, pinsPath: fx.pinsPath }, outDir: out, until: '2026-10-15', itemsWindowDays: 2, tz: TZ, now: NOW });
    assert.deepEqual([sha(fx.storePath), sha(fx.pinsPath), sha(join(fx.tenantDir, 'annotations', 'fragments.jsonl'))], before, 'nothing in the source changes');
    assert.equal(lstatSync(join(out, 'store.sqlite')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(out, 'store.sqlite')), fx.storePath);
    assert.equal(readlinkSync(join(out, 'tenant')), fx.tenantDir);

    assert.deepEqual([meta.tenant, meta.tz, meta.since, meta.until, meta.subject, meta.createdAt], ['fixture', TZ, '2026-10-14', '2026-10-15', 'owner', NOW.toISOString()]);
    assert.deepEqual(meta.labelSpace.initiatives, ['acme/shop', 'globex/a', 'globex/b', 'personal/garden'], 'aliases and splits are never labels');
    assert.deepEqual([meta.labelSpace.umbrellas['acme/old-shop'], meta.labelSpace.umbrellas['personal/garden'], meta.labelSpace.umbrellas['globex/b']], ['acme', 'personal/garden', 'globex']);
    assert.deepEqual(meta.labelSpace.people, ['owner', 'hana', 'rui', 'dana-dune']);

    const ds = loadDataset(out);
    assert.deepEqual(meta.counts, { fragment: ds.units.fragment!.length, item: ds.units.item!.length, mention: ds.units.mention!.length });

    // --- fragments: the production fragmenter's ids, today's ladder alone, evidence text
    const frags = byId(ds.units.fragment as FragmentUnit[]);
    assert.deepEqual([...frags.keys()].sort(), Object.values(ids).sort());
    assert.deepEqual(frags.get(ids.shop)!.ladder, { state: 'rule', initiative: 'acme/shop', candidates: ['acme/shop'], rule: 'registry:channel', hint: 'registry' });
    assert.deepEqual(frags.get(ids.dm)!.ladder?.candidates, ['globex/a', 'globex/b']);
    assert.equal(frags.get(ids.dm)!.ladder?.state, 'open');
    assert.equal(frags.get(ids.general)!.ladder?.rule, 'marker:hana', 'the ladder ignores the ledger that overrides it');
    assert.equal(frags.get(ids.work)!.ladder?.initiative, 'personal/garden');
    assert.equal(frags.get(ids.shop)!.text, 'Olga Owner: The SH-12 import failed on staging again, see https://ci.example/run/42.');
    assert.match(frags.get(ids.call1)!.text, /^## Release plan\nShip the platform release/);
    assert.doesNotMatch(frags.get(ids.call1)!.text, /Hiring/);
    assert.match(frags.get(ids.call2)!.text, /^## Hiring/);
    assert.equal(frags.get(ids.work)!.text, 'fix the watering schedule\nadd the soil sensor');
    assert.equal(frags.get(ids.work)!.minutes, 60);
    assert.equal(frags.get(ids.call1)!.minutes, Math.round(30 * frags.get(ids.call1)!.weight * 10) / 10, 'a topic counts its weight of the call');
    assert.deepEqual([frags.get(ids.weekly)!.minutes, frags.get(ids.shop)!.minutes], [0, 0], 'a zero-length recording and a one-message run');
    assert.equal(frags.get(ids.weekly)!.day, '2026-10-14');

    // --- items: local days, bots and the subject's own included, context and addressees
    const items = byId(ds.units.item as ItemUnit[]);
    assert.equal(items.has('slack:T/C3/13'), false, '23:30 on the 13th in Moscow is outside');
    assert.equal(items.get('slack:T/C3/14')?.day, '2026-10-14', '00:30 on the 14th in Moscow is inside');
    assert.equal(items.has('slack:T/C1/0'), false);
    assert.deepEqual([items.get('slack:T/C9/8')!.isBot, items.get('slack:T/C9/8')!.keys], [true, ['SH-12', 'https://ci.example/run/42']]);
    assert.deepEqual(items.get('slack:T/C1/1')!.keys, ['SH-12', 'https://ci.example/run/42']);
    assert.deepEqual(items.get('slack:T/C1/7')!.context?.map((c) => [c.ref, c.author]), [['slack:T/C1/1', 'Olga Owner']], 'the previous message of the thread');
    assert.deepEqual([items.get('slack:T/D1/2')!.toPersons, items.get('slack:T/D1/2')!.fromSubject, items.get('slack:T/D1/3')!.fromSubject], [['rui'], true, false]);
    const task = items.get(TASK)!;
    assert.deepEqual([task.type, task.text, task.toPersons, task.author, task.authorPerson, task.thread], ['task', 'Import fails on staging\nThe nightly import stops at row 300.', ['rui'], 'youtrack:dana@ACME', null, TASK]);
    assert.ok(task.keys.includes('SH-12') && task.keys.includes('https://tracker.acme.example/issue/SH-12'));
    const comment = items.get(`${TASK}#c102`)!;
    assert.deepEqual([comment.type, comment.author, comment.authorPerson, comment.thread], ['comment', 'Rui Rosa', 'rui', TASK]);
    assert.deepEqual(comment.keys, ['SH-12', 'SH-7', 'https://tracker.acme.example/issue/SH-12']);
    assert.deepEqual(comment.context?.map((c) => c.ref), [TASK, `${TASK}#c101`], 'the ticket itself, then the earlier comment');
    assert.equal(items.has(`${TASK}#c101`), false, 'a comment outside the window is context only');
    const gm = items.get('gmeet:me:g1')!;
    assert.deepEqual([gm.type, gm.participants, gm.toPersons, gm.thread], ['meeting', ['Rui Rosa', 'Ana Berg Rui Rosa', 'h.hill@acme.example'], ['rui'], 'call-2']);

    // --- mentions: as stored, first occurrence in replay order, what production resolves today
    const mentions = ds.units.mention as MentionUnit[];
    const mention = (field: string, raw: string) => mentions.find((m) => m.field === field && m.raw === raw);
    const glued = mention('attendee', 'Ana Berg Rui Rosa')!;
    assert.equal(glued.id, `mention:attendee:${hash('Ana Berg Rui Rosa')}`);
    assert.equal(glued.production, null);
    assert.deepEqual(glued.context.linkedEvent, { title: 'Weekly Sync!', start: '2026-10-14T12:05:00.000Z', attendees: ['olga@home.example', 'rui@globex.example'] });
    assert.deepEqual(glued.context.speakers, ['Rui Rosa']);
    assert.deepEqual(glued.context.coMentions, ['Rui Rosa', 'h.hill@acme.example']);
    assert.equal(mention('attendee', 'Rui Rosa')?.production, 'rui', 'a name-only entry is kept, and resolves by name');
    assert.equal(mention('attendee', 'h.hill@acme.example')?.production, null);
    const hanaAtt = mention('attendee', 'hana@acme.example')!;
    assert.deepEqual([hanaAtt.production, hanaAtt.context.linkedEvent, hanaAtt.context.speakers], ['hana', null, ['Hana Hill', 'Olga Owner']]);
    assert.equal(mention('author', 'CI Robot'), undefined, 'bots are not people');
    const rui = mention('author', 'Rui Rosa')!;
    assert.deepEqual([rui.seen, rui.day, rui.ref, rui.production], [3, '2026-10-14', 'slack:T/C3/14', 'rui']);
    assert.deepEqual(mention('comment_author', 'Rui Rosa')?.context.coMentions, ['rui@globex.example', 'youtrack:dana@ACME']);
    assert.deepEqual([mention('organizer', 'olga@home.example')?.seen, mention('reporter', 'youtrack:dana@ACME')?.production], [2, null]);
    assert.equal(mention('participant', 'Rui Rosa')?.production, 'rui');
    assert.equal(new Set(mentions.map((m) => m.id)).size, mentions.length);

    // --- t1 gold: ledger (by id, or by refs as the plan matches) > pin, answered escalations; alias and split resolved
    const t1 = ds.gold['t1-fragment'];
    assert.deepEqual([gold(t1, ids.general, 'human')?.label, gold(t1, ids.general, 'human')?.note], ['acme/shop', `ledger ${ids.general}`]);
    assert.deepEqual([gold(t1, ids.dm, 'model')?.label, gold(t1, ids.dm, 'model')?.alts], ['globex/a', ['globex/b']]);
    assert.deepEqual([gold(t1, ids.shop, 'rule')?.label, gold(t1, ids.shop, 'rule')?.note], ['acme/shop', 'ledger frag-2026-10-15-thread-oldcut (by refs)'], 'the ledger beats the pin');
    assert.deepEqual([gold(t1, ids.call2, 'rule')?.label, gold(t1, ids.call2, 'rule')?.note], ['acme/shop', 'pin marker:hana'], 'superseded: the pin decides');
    assert.equal(gold(t1, ids.call2, 'model'), undefined);
    assert.equal(t1?.some((g) => g.id === ids.call1), false, 'an escalated fragment has no gold');
    assert.deepEqual([gold(t1, ids.work, 'human')?.label, gold(t1, ids.work, 'human')?.note], ['personal/garden', `escalation esc-attr-${ids.work}`]);
    const report = JSON.parse(readFileSync(join(out, 'export.json'), 'utf8')) as { t1: Record<string, number>; t3: Record<string, number>; gold: Record<string, Record<string, number>> };
    assert.deepEqual(report.t1, { ledger_malformed: 0, ledger_rows_by_id: 2, ledger_rows_by_refs: 1, units_ledger_escalated: 1, ledger_decided: 4, ledger_skipped: 1, pins: 3, pin_rows: 1, pins_skipped: 1, esc_answered: 3, esc_rows: 1, esc_targets_skipped: 1, esc_not_fragments: 1 });

    // --- t3 gold: answered escalations (human), the merge log and the roster (rule)
    const t3 = ds.gold['t3-identity'];
    const label = (field: string, raw: string, tier: string) => gold(t3, mention(field, raw)!.id, tier)?.label;
    assert.equal(label('author', 'R. Rosa', 'human'), 'rui');
    assert.equal(label('author', 'Zed Zorn', 'human'), 'unknown');
    assert.equal(label('author', 'Dana D.', 'human'), 'dana-dune', 'a "new person" since added to the roster');
    assert.equal(label('author', 'Deploy Desk', 'human'), 'system');
    assert.equal(label('attendee', 'h.hill@acme.example', 'rule'), 'hana', 'the merge log');
    assert.equal(label('attendee', 'Rui Rosa', 'rule'), 'rui', 'the roster, by production key');
    assert.equal(label('author', 'Olga Owner', 'rule'), 'owner');
    assert.equal(gold(t3, glued.id, 'rule') ?? gold(t3, glued.id, 'human'), undefined, 'nobody has judged the glued line yet');
    assert.equal(gold(t3, mention('reporter', 'youtrack:dana@ACME')!.id, 'rule'), undefined);
    assert.deepEqual([report.t3.esc_answered, report.t3.esc_rows, report.t3.esc_no_mention, report.t3.merge_rows], [5, 4, 1, 1]);

    // a re-export is byte-identical (fixed now), and keeps gold files it does not own
    writeFileSync(join(out, 'gold', 't4-kind.jsonl'), '{"id":"x","task":"t4-kind","label":"info","tier":"opus"}\n');
    const first = readFileSync(join(out, 'units', 'item.jsonl'), 'utf8') + readFileSync(join(out, 'gold', 't1-fragment.jsonl'), 'utf8') + readFileSync(join(out, 'meta.json'), 'utf8');
    await exportDataset({ name: 'fixture-real', kind: 'real', source: { store: fx.storePath, tenantDir: fx.tenantDir, pinsPath: fx.pinsPath }, outDir: out, until: '2026-10-15', itemsWindowDays: 2, tz: TZ, now: NOW });
    assert.equal(readFileSync(join(out, 'units', 'item.jsonl'), 'utf8') + readFileSync(join(out, 'gold', 't1-fragment.jsonl'), 'utf8') + readFileSync(join(out, 'meta.json'), 'utf8'), first);
    assert.equal(loadDataset(out).gold['t4-kind']?.length, 1);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('exportDataset: a tenant without attribution.json has no fragments and no subject; items and mentions still flow', async () => {
  const fx = fixture();
  try {
    rmSync(join(fx.tenantDir, 'annotations', 'attribution.json'));
    const out = join(fx.root, 'datasets', 'team');
    const meta = await exportDataset({ name: 'team', kind: 'real', source: { store: fx.storePath, tenantDir: fx.tenantDir }, outDir: out, until: '2026-10-15', itemsWindowDays: 2, tz: TZ, now: NOW });
    assert.deepEqual([meta.counts.fragment, meta.subject, meta.since], [0, undefined, '2026-10-14']);
    const ds = loadDataset(out);
    assert.equal(ds.gold['t1-fragment'], undefined);
    assert.ok((ds.units.item?.length ?? 0) > 0 && (ds.gold['t3-identity']?.length ?? 0) > 0);
    assert.equal((ds.units.item as ItemUnit[]).some((i) => 'fromSubject' in i), false, 'no subject, no fromSubject flag');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('main: argv → a dataset under --out, pins found beside the store; missing arguments print the usage', async (t) => {
  const fx = fixture();
  t.mock.method(console, 'log', () => {});
  try {
    const out = join(fx.root, 'cli');
    await main(['export', '--name', 'cli-real', '--store', fx.storePath, '--tenant', fx.tenantDir, '--until', '2026-10-15', '--days', '2', '--tz', TZ, '--now', NOW.toISOString(), '--out', out]);
    const ds = loadDataset(out);
    assert.equal(ds.meta.name, 'cli-real');
    assert.equal(gold(ds.gold['t1-fragment'], ids.call2, 'rule')?.note, 'pin marker:hana', '<store dir>/attribution/pins.jsonl by default');
    await assert.rejects(main(['export', '--name', 'x', '--store', fx.storePath, '--tenant', fx.tenantDir]), /usage: lab export/);
    await assert.rejects(main(['--name', 'x', '--store', fx.storePath, '--tenant', fx.tenantDir, '--until', '15.10.2026']), /usage: lab export/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('exportDataset: the ladder field is main\'s ladder (frozen), and tenant entries dated inside the window are flagged', async () => {
  const fx = fixture();
  try {
    // An object channel entry: this branch's registry routes '#shop' by it, main's dropped it (the key SH decides there).
    const reg = JSON.parse(JSON.stringify(registry)) as typeof registry;
    (reg.initiatives[0]!.sources as Record<string, unknown>).slack_channels = [{ id: 'C1', name: '#shop' }];
    writeFileSync(join(fx.tenantDir, 'initiatives.json'), JSON.stringify(reg));
    // Answers given inside the window (since 2026-10-14): a rule written from one, a merge, the answered identity questions.
    writeFileSync(join(fx.tenantDir, 'annotations', 'rules.json'), JSON.stringify([
      { id: 'r-late', when: { container: '#nowhere' }, then: { initiative: 'acme/shop' }, created: '2026-10-15T09:00:00.000Z' },
      { id: 'r-early', when: { container: '#nowhere' }, then: { initiative: 'acme/shop' }, created: '2026-10-01T09:00:00.000Z' },
    ]));
    writeFileSync(join(fx.tenantDir, 'annotations', 'identity-merges.jsonl'), jsonl([
      { at: '2026-10-09T21:00:00.000Z', id: 'merge-h.hill@acme.example', identity: 'h.hill@acme.example', merged_by: 'rule', person_id: 'hana', reason: 'same first name' },
      { at: '2026-10-15T08:00:00.000Z', id: 'merge-rr', identity: 'slack:R. Rosa', merged_by: 'owen', person_id: 'rui', reason: 'answered' },
    ]));
    const out = join(fx.root, 'datasets', 'frozen');
    await exportDataset({ name: 'frozen-real', kind: 'real', source: { store: fx.storePath, tenantDir: fx.tenantDir, pinsPath: fx.pinsPath }, outDir: out, until: '2026-10-15', itemsWindowDays: 2, tz: TZ, now: NOW });
    const frags = byId(loadDataset(out).units.fragment as FragmentUnit[]);
    assert.deepEqual(frags.get(ids.shop)!.ladder, { state: 'rule', initiative: 'acme/shop', candidates: ['acme/shop'], rule: 'registry:key', hint: 'registry' });
    const report = JSON.parse(readFileSync(join(out, 'export.json'), 'utf8')) as { warnings: string[] };
    assert.deepEqual(report.warnings, [
      '1 of 2 tenant rules were created on or after 2026-10-14: a replay reads them from its first day',
      "1 identity merges were made on or after 2026-10-14: people.json and the store's resolution (mention 'production') already hold them",
      '4 identity questions asked on or after 2026-10-14 were answered: the roster may already hold their answers',
    ]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
