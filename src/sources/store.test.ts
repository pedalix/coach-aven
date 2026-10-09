import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identitiesOf, validatePeople } from './people.js';
import { buildStore, classifyRawFile, openReadOnly, openStore, readNewLines, SCHEMA_VERSION, threadIdOf, type BuildContext } from './store.js';

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'store-'));
  const raw = join(root, 'raw');
  mkdirSync(join(raw, 'google', 'acc@x.com'), { recursive: true });
  mkdirSync(join(raw, 'slack'), { recursive: true });
  mkdirSync(join(raw, 'msgraph', 'upn'), { recursive: true });
  const people = join(root, 'people.json');
  writeFileSync(
    people,
    JSON.stringify([
      { person_id: 'tobin', name: 'Tess North', company: 'contoso', default_initiative: 'hcg/p1', identities: ['Tess North@example.com', 'slack:Tess North'] },
      { person_id: 'owen', name: 'Owen', identities: ['owen@example.com', 'slack:Owen Hale'] },
    ]),
  );
  const ctx: BuildContext = { slug: 't', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), peoplePath: people, log: () => undefined };
  return { root, raw, ctx };
}
const line = (o: object) => JSON.stringify(o) + '\n';
// node:sqlite rows have a null prototype; strict deepEqual wants plain objects.
const plain = <T>(rows: T[]): T[] => rows.map((r) => ({ ...r }));
const gmail = (id: string, text: string, extra: object = {}) =>
  line({ source: 'gmail', account: 'acc@x.com', container: 'inbox', id, ts: `2026-10-0${id.length % 9 || 1}T10:00:00.000Z`, author: 'Tess North@example.com', participants: ['Tess North@example.com', 'owen@example.com'], subject: `Re: ${id}`, text, permalink: `https://mail/${id}`, raw_ref: `gmail:acc@x.com/thr1/${id}`, scrub: { withheld: false, kinds: [], redactions: 0 }, ...extra });

test('classifyRawFile + threadIdOf follow the pullers\' contracts', () => {
  assert.equal(classifyRawFile('/x/google/a/messages.jsonl'), 'messages');
  assert.equal(classifyRawFile('/x/slack/slack.files.jsonl'), 'files');
  assert.equal(classifyRawFile('/x/msgraph/u/calendar.jsonl'), 'events');
  assert.equal(classifyRawFile('/x/msgraph/u/tombstones.jsonl'), 'tombstones');
  assert.equal(classifyRawFile('/x/slack/slack.cursor.json'), undefined);
  assert.equal(threadIdOf({ source: 'slack', raw_ref: 'slack:T/C/1.5#1.0' }, 'slack:T:C:1.5'), 'slack:T/C/1.0');
  assert.equal(threadIdOf({ source: 'slack', raw_ref: 'slack:T/C/1.0' }, 'slack:T:C:1.0'), 'slack:T/C/1.0');
  assert.equal(threadIdOf({ source: 'gmail', raw_ref: 'gmail:a/thr/m' }, 'gmail:a:m'), 'gmail:a/thr');
  assert.equal(threadIdOf({ source: 'gmail', raw_ref: 'gmail:a/?/m' }, 'gmail:a:m'), 'gmail:a:m');
  assert.equal(threadIdOf({ source: 'msgraph', raw_ref: 'msgraph:t/x' }, 'msgraph:u:x'), 'msgraph:u:x');
});

test('readNewLines consumes only complete lines and resumes after the partial one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rnl-'));
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
  const r1 = readNewLines(f, 0);
  assert.deepEqual(r1.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r1.nextOffset, Buffer.byteLength('{"a":1}\n{"b":2}\n'));
  appendFileSync(f, '3}\n{"d":"ü"}\n');
  const r2 = readNewLines(f, r1.nextOffset);
  assert.deepEqual(r2.lines, ['{"c":3}', '{"d":"ü"}']);
  assert.equal(r2.nextOffset, Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}\n{"d":"ü"}\n'));
  writeFileSync(f, '{"z":0}\n'); // rotated/truncated
  const r3 = readNewLines(f, r2.nextOffset);
  assert.equal(r3.truncated, true);
  assert.deepEqual(r3.lines, ['{"z":0}']);
});

test('build: last line per id wins, tombstone flips deleted and leaves the FTS index, resurrection returns', () => {
  const { raw, ctx } = scaffold();
  const f = join(raw, 'google', 'acc@x.com', 'messages.jsonl');
  writeFileSync(f, gmail('m1', 'erste Fassung über Ретейнеры') + gmail('m2', 'zweite Nachricht') + gmail('m1', 'zweite Fassung') + line({ source: 'gmail', account: 'acc@x.com', id: 'm2', deleted: true, ts: '2026-10-05T00:00:00Z' }));
  const s = buildStore(ctx);
  assert.equal(s.messages, 3);
  assert.equal(s.tombstones, 1);
  const db = openReadOnly(ctx.storePath);
  const rows = plain(db.prepare('SELECT ref, text, deleted FROM messages ORDER BY ref').all()) as { ref: string; text: string; deleted: number }[];
  assert.deepEqual(rows, [
    { ref: 'gmail:acc@x.com:m1', text: 'zweite Fassung', deleted: 0 },
    { ref: 'gmail:acc@x.com:m2', text: 'zweite Nachricht', deleted: 1 },
  ]);
  const fts = (q: string) => (db.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get(q) as { c: number }).c;
  assert.equal(fts('zweite'), 1, 'the deleted message must be gone from FTS, the live one found');
  assert.equal(fts('erste'), 0, 'superseded text is not searchable');
  db.close();
  // Resurrection: a later non-deleted line for m2 brings it back into the index.
  appendFileSync(f, gmail('m2', 'wieder da'));
  buildStore(ctx);
  const db2 = openReadOnly(ctx.storePath);
  assert.equal((db2.prepare('SELECT deleted FROM messages WHERE ref = ?').get('gmail:acc@x.com:m2') as { deleted: number }).deleted, 0);
  assert.equal((db2.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get('wieder') as { c: number }).c, 1);
  db2.close();
});

test('build: incremental offsets, replay is a no-op, truncated last line waits for the next build', () => {
  const { raw, ctx } = scaffold();
  const f = join(raw, 'slack', 'slack.messages.jsonl');
  const slack = (ts: string, text: string) => line({ source: 'slack', account: 'T1', container: '#c', id: `C1:${ts}`, ts: `2026-10-06T00:00:0${ts[0]}.000Z`, author: 'Owen Hale', participants: ['Owen Hale'], text, permalink: 'p', raw_ref: `slack:T1/C1/${ts}` });
  writeFileSync(f, slack('1.0', 'one') + slack('2.0', 'two').slice(0, 20));
  const s1 = buildStore(ctx);
  assert.equal(s1.messages, 1);
  appendFileSync(f, slack('2.0', 'two').slice(20) + slack('3.0', 'three'));
  const s2 = buildStore(ctx);
  assert.equal(s2.messages, 2);
  assert.equal(s2.lines, 2);
  const s3 = buildStore(ctx);
  assert.equal(s3.lines, 0, 'nothing new → nothing read');
  // Copy of an already-consumed line (e.g. a restored backup) must not re-apply.
  appendFileSync(f, slack('1.0', 'one'));
  const s4 = buildStore(ctx);
  assert.equal(s4.replayed, 1);
  assert.equal(s4.messages, 0);
});

test('build: FTS finds diacritics-insensitive and stemmed terms', () => {
  const { raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'messages.jsonl'), gmail('d1', 'Tobin läuft über die Brücke; running retainers') );
  buildStore(ctx);
  const db = openReadOnly(ctx.storePath);
  const hit = (q: string) => (db.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get(q) as { c: number }).c;
  assert.equal(hit('uber'), 1);
  assert.equal(hit('brucke'), 1);
  assert.equal(hit('run'), 1);
  assert.equal(hit('retainer'), 1);
  assert.equal(hit('nothere'), 0);
  db.close();
});

test('build: people are seeded, authors resolved, message_people recomputed on re-edit', () => {
  const { raw, ctx } = scaffold();
  const f = join(raw, 'google', 'acc@x.com', 'messages.jsonl');
  writeFileSync(f, gmail('p1', 'hallo'));
  const s = buildStore(ctx);
  assert.equal(s.people, 2);
  let db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT author_person FROM messages WHERE ref = ?').get('gmail:acc@x.com:p1') as { author_person: string }).author_person, 'tobin');
  assert.deepEqual(
    plain(db.prepare('SELECT person_id, role FROM message_people WHERE ref = ? ORDER BY person_id').all('gmail:acc@x.com:p1')),
    [{ person_id: 'owen', role: 'to' }, { person_id: 'tobin', role: 'from' }],
  );
  assert.equal((db.prepare('SELECT count(*) c FROM identities').get() as { c: number }).c, 4);
  db.close();
  // Re-emitted with a different sender: the old 'from' row must not linger.
  appendFileSync(f, gmail('p1', 'hallo again', { author: 'owen@example.com', participants: ['owen@example.com'] }));
  buildStore(ctx);
  db = openReadOnly(ctx.storePath);
  assert.deepEqual(plain(db.prepare('SELECT person_id, role FROM message_people WHERE ref = ?').all('gmail:acc@x.com:p1')), [{ person_id: 'owen', role: 'from' }]);
  // Slack display names resolve through the slack: identities; an unknown label stays unresolved.
  db.close();
  writeFileSync(join(raw, 'slack', 'slack.messages.jsonl'), line({ source: 'slack', account: 'T1', container: '#c', id: 'C1:1.0', ts: '2026-10-06T00:00:01.000Z', author: 'Tess North', participants: ['Tess North', 'Somebody Else'], text: 'x', permalink: 'p', raw_ref: 'slack:T1/C1/1.0' }));
  buildStore(ctx);
  db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT author_person FROM messages WHERE ref = ?').get('slack:T1:C1:1.0') as { author_person: string }).author_person, 'tobin');
  db.close();
});

test('build: events/files upsert, msgraph tombstones.jsonl routes by kind, threads roll up', () => {
  const { raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'events.jsonl'), line({ source: 'gcal', account: 'acc@x.com', id: 'e1', calendar: 'acc@x.com', start: '2026-10-08', end: '2026-10-09', title: 'Steering', attendees: ['a@b'], organizer: 'acc@x.com', link: 'l' }));
  writeFileSync(join(raw, 'google', 'acc@x.com', 'files.jsonl'), line({ source: 'gdrive', account: 'acc@x.com', id: 'f1', name: 'Hours', path: 'My Drive/Hours', mime: 'sheet', modified: '2026-10-07T00:00:00Z', size: 5, link: 'l' }));
  writeFileSync(join(raw, 'msgraph', 'upn', 'messages.jsonl'), line({ source: 'msgraph', account: 'upn', container: 'chat:@x', id: 'g1', ts: '2026-10-07T00:00:00Z', author: 'X <x@y.z>', participants: [], text: 'teams', permalink: 'p', raw_ref: 'msgraph:t/chats/1' }));
  writeFileSync(join(raw, 'msgraph', 'upn', 'tombstones.jsonl'), line({ source: 'msgraph', account: 'upn', id: 'g1', deleted: true, kind: 'message' }) + line({ source: 'gcal', account: 'acc@x.com', id: 'e1', deleted: true, kind: 'calendar' }) + line({ source: 'gdrive', account: 'acc@x.com', id: 'f1', deleted: true, kind: 'file' }));
  writeFileSync(join(raw, 'slack', 'slack.messages.jsonl'), line({ source: 'slack', account: 'T1', container: '#c', id: 'C1:1.0', ts: '2026-10-06T00:00:01.000Z', author: 'A', participants: [], text: 'parent', permalink: 'p', raw_ref: 'slack:T1/C1/1.0' }) + line({ source: 'slack', account: 'T1', container: '#c', id: 'C1:1.5', ts: '2026-10-06T00:00:02.000Z', author: 'B', participants: [], text: 'reply', permalink: 'p', raw_ref: 'slack:T1/C1/1.5#1.0' }));
  const s = buildStore(ctx);
  assert.equal(s.events, 1);
  assert.equal(s.fileRecords, 1);
  assert.equal(s.tombstones, 3);
  const db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT deleted FROM events WHERE ref = ?').get('gcal:acc@x.com:e1') as { deleted: number }).deleted, 1);
  assert.equal((db.prepare('SELECT deleted FROM files WHERE ref = ?').get('gdrive:acc@x.com:f1') as { deleted: number }).deleted, 1);
  assert.equal((db.prepare('SELECT deleted FROM messages WHERE ref = ?').get('msgraph:upn:g1') as { deleted: number }).deleted, 1);
  assert.deepEqual(plain(db.prepare('SELECT thread_id, n, first_ts, last_ts FROM threads').all()), [{ thread_id: 'slack:T1/C1/1.0', n: 2, first_ts: '2026-10-06T00:00:01.000Z', last_ts: '2026-10-06T00:00:02.000Z' }]);
  db.close();
});

test('build: replica is a renamed VACUUM INTO copy that opens immutable and matches the store', () => {
  const { raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'messages.jsonl'), gmail('r1', 'replica me'));
  const s = buildStore(ctx);
  assert.equal(s.replica, join(ctx.replicaDir!, 'store.sqlite'));
  assert.ok(existsSync(s.replica!));
  assert.ok(!existsSync(`${s.replica!}.tmp`));
  const r = openReadOnly(s.replica!);
  assert.equal((r.prepare('SELECT count(*) c FROM messages').get() as { c: number }).c, 1);
  assert.equal((r.prepare("SELECT value FROM sync_state WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
  r.close();
  // Live store stays WAL; the replica must not need it.
  const live = openStore(ctx.storePath);
  assert.equal((live.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  live.close();
});

test('people: the same key written twice for one person collapses; for two people it is an error', () => {
  const ok = validatePeople([{ person_id: 'a', name: 'A', identities: ['slack:Owen', 'Owen', 'a@x.y'] }]);
  assert.deepEqual(identitiesOf(ok).map((i) => [i.identity, i.kind]), [['owen', 'slack'], ['a@x.y', 'email']]);
  assert.throws(() => validatePeople([{ person_id: 'a', name: 'A', identities: ['x@y.z'] }, { person_id: 'b', name: 'B', identities: ['X@Y.Z'] }]), /already belongs/);
});

// ── tenant-derived recompute (the 2026-10-08 relink bug) ─────────────────────────────────
test('build: a people.json change relinks ALREADY stored rows; unchanged files skip the recompute', () => {
  const { raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'messages.jsonl'), gmail('r1', 'from an unknown sender', { author: 'rowan@mf.com', participants: ['rowan@mf.com', 'owen@example.com'] }));
  const s1 = buildStore(ctx);
  assert.equal(s1.recomputed, true); // first build: nothing recorded yet
  let db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT author_person FROM messages').get() as { author_person: string | null }).author_person, null);
  db.close();
  assert.equal(buildStore(ctx).recomputed, false, 'nothing changed → no recompute');
  // Rowan gets an identity — no new raw lines at all, yet the old message must now resolve.
  writeFileSync(
    ctx.peoplePath!,
    JSON.stringify([
      { person_id: 'rowan', name: 'Rowan', marker: { type: 'narrow', initiatives: ['rowan/monto', 'rowan/cartgenie'] }, identities: ['rowan@mf.com'] },
      { person_id: 'owen', name: 'Owen', identities: ['owen@example.com'] },
    ]),
  );
  const s3 = buildStore(ctx);
  assert.equal(s3.lines, 0);
  assert.equal(s3.recomputed, true);
  db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT author_person FROM messages').get() as { author_person: string }).author_person, 'rowan');
  assert.deepEqual(plain(db.prepare('SELECT person_id, role FROM message_people ORDER BY person_id').all()), [{ person_id: 'owen', role: 'to' }, { person_id: 'rowan', role: 'from' }]);
  assert.deepEqual(plain(db.prepare('SELECT marker_type, marker_initiatives FROM people WHERE person_id = ?').all('rowan')), [{ marker_type: 'narrow', marker_initiatives: '["rowan/monto","rowan/cartgenie"]' }]);
  // FTS untouched by the person-only update (the index must still find the message).
  assert.equal((db.prepare("SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH 'unknown'").get() as { c: number }).c, 1);
  db.close();
});

test('build: fragments.jsonl → fragments + attributions, last line per id, superseded dropped; edits recompute', () => {
  const { root, raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'messages.jsonl'), gmail('a1', 'one') + gmail('a2', 'two'));
  const frag = join(root, 'fragments.jsonl');
  writeFileSync(frag, line({ id: 'f1', kind: 'thread', refs: ['gmail:acc@x.com:a1'], attributions: [{ initiative: 'hcg/p3', share: 0.6 }, { initiative: 'hcg/p4', share: 0.4 }], decided_by: 'model', status: 'decided' }));
  const c = { ...ctx, fragmentsPath: frag };
  const s1 = buildStore(c);
  assert.equal(s1.fragments, 1);
  assert.equal(s1.attributions, 2);
  appendFileSync(frag, line({ id: 'f1', kind: 'thread', refs: ['gmail:acc@x.com:a1', 'gmail:acc@x.com:a2'], attributions: [{ initiative: 'hcg/p3', share: 1 }], decided_by: 'owen', status: 'decided' }) + line({ id: 'f9', refs: ['x'], attributions: [{ initiative: 'y' }], status: 'escalated' }));
  const s2 = buildStore(c);
  assert.equal(s2.recomputed, true);
  const db = openReadOnly(ctx.storePath);
  assert.deepEqual(plain(db.prepare('SELECT ref, initiative, share, decided_by FROM attributions ORDER BY ref').all()), [
    { ref: 'gmail:acc@x.com:a1', initiative: 'hcg/p3', share: 1, decided_by: 'owen' },
    { ref: 'gmail:acc@x.com:a2', initiative: 'hcg/p3', share: 1, decided_by: 'owen' },
  ]);
  // escalated fragments are stored (the review session lists them) but attribute nothing
  assert.deepEqual(plain(db.prepare('SELECT id, status FROM fragments ORDER BY id').all()), [{ id: 'f1', status: 'decided' }, { id: 'f9', status: 'escalated' }]);
  db.close();
});

test('build: a store from an older schema is discarded and rebuilt from raw', () => {
  const { raw, ctx } = scaffold();
  writeFileSync(join(raw, 'google', 'acc@x.com', 'messages.jsonl'), gmail('o1', 'old schema row'));
  buildStore(ctx);
  const db = openStore(ctx.storePath);
  db.prepare("UPDATE sync_state SET value = '2' WHERE key = 'schema_version'").run();
  db.close();
  const lines: string[] = [];
  const s = buildStore({ ...ctx, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => new RegExp(`schema v2 < v${SCHEMA_VERSION}`).test(l)));
  assert.equal(s.messages, 1, 'raw re-read from offset 0');
});

test('build: meetings land compacted with attendees → meeting_people, transcript searchable, tombstone removes', () => {
  const { raw, ctx } = scaffold();
  mkdirSync(join(raw, 'meetings', 'gmeet', 'acc@x.com'), { recursive: true });
  const f = join(raw, 'meetings', 'gmeet', 'acc@x.com', 'meetings.jsonl');
  const meeting = (extra: object = {}) =>
    line({ source: 'gmeet', account: 'acc@x.com', id: 'doc1', title: 'Instant meeting', start: '2026-10-07T07:11:00.000Z', end: '2026-10-07T07:11:00.000Z', attendees: [{ email: '', name: 'Tess North' }], summary: 'Produktstrategie', next_steps: [], transcript: 'Tobin: Personalabbau', url: 'u', text: '', scrub: { withheld: false, kinds: [] }, ...extra });
  writeFileSync(f, meeting());
  const s = buildStore(ctx);
  assert.equal(s.meetings, 1);
  let db = openReadOnly(ctx.storePath);
  assert.deepEqual(plain(db.prepare('SELECT person_id FROM meeting_people').all()), [{ person_id: 'tobin' }]);
  assert.equal((db.prepare("SELECT count(*) c FROM meetings_fts WHERE meetings_fts MATCH 'personalabbau'").get() as { c: number }).c, 1);
  db.close();
  appendFileSync(f, meeting({ summary: 'Produktstrategie v2' }) + line({ source: 'gmeet', account: 'acc@x.com', id: 'doc1', deleted: true }));
  buildStore(ctx);
  db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare("SELECT count(*) c FROM meetings_fts WHERE meetings_fts MATCH 'produktstrategie'").get() as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT deleted FROM meetings').get() as { deleted: number }).deleted, 1);
  db.close();
});

test('build v4: recorder copies of one call share a call_id; Slack ids resolve to names; bots flagged', () => {
  const { raw, ctx } = scaffold();
  mkdirSync(join(raw, 'meetings', 'granola', 'acc@x.com'), { recursive: true });
  mkdirSync(join(raw, 'meetings', 'wispr', 'wispr'), { recursive: true });
  const mt = (source: string, account: string, id: string, start: string, end: string, transcript: string) =>
    line({ source, account, id, title: 'FO Cloud incident', start, end, attendees: [], summary: 's', next_steps: [], transcript, url: '', text: '', scrub: { withheld: false, kinds: [] } });
  writeFileSync(join(raw, 'meetings', 'granola', 'acc@x.com', 'meetings.jsonl'), mt('granola', 'acc@x.com', 'g1', '2026-10-08T17:07:00Z', '2026-10-08T17:50:00Z', 'short'));
  writeFileSync(join(raw, 'meetings', 'wispr', 'wispr', 'meetings.jsonl'), mt('wispr', 'wispr', 'w1', '2026-10-08T17:08:00Z', '2026-10-08T17:49:00Z', 'a much longer transcript'));
  mkdirSync(join(raw, 'slack'), { recursive: true });
  writeFileSync(join(raw, 'slack', 'slack.users.json'), JSON.stringify({ T1: { fetched_at: 'x', users: [{ id: 'U0FLORIN01', name: 'florin', profile: { display_name: 'Florin' } }] } }));
  const sl = (id: string, author: string, extra: object = {}) =>
    line({ source: 'slack', account: 'T1', container: 'dm:U0FLORIN01', id, ts: '2026-10-08T10:00:00Z', author, participants: [author], text: 'hello', permalink: '', raw_ref: '', scrub: { withheld: false, kinds: [] }, ...extra });
  writeFileSync(join(raw, 'slack', 'slack.messages.jsonl'), sl('C1:1', 'U0FLORIN01') + sl('C1:2', 'Intercom Convert') + sl('C1:3', 'Somebot', { is_bot: true }));
  const s = buildStore(ctx);
  assert.equal(s.calls, 1);
  const db = openReadOnly(ctx.storePath);
  const calls = db.prepare('SELECT * FROM calls').all() as { call_id: string; primary_ref: string; sources: string }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.primary_ref, 'wispr:wispr:w1');
  assert.equal(JSON.parse(calls[0]!.sources).length, 2);
  const ids = db.prepare('SELECT DISTINCT call_id FROM meetings').all() as { call_id: string }[];
  assert.equal(ids.length, 1);
  const msgs = db.prepare('SELECT id_part, container, author_raw, is_bot FROM (SELECT substr(ref, 10) AS id_part, container, author_raw, is_bot FROM messages) ORDER BY id_part').all() as { container: string; author_raw: string; is_bot: number }[];
  assert.deepEqual(msgs.map((m) => [m.container, m.author_raw, m.is_bot]), [
    ['dm:@florin', 'Florin', 0],
    ['dm:@florin', 'Intercom Convert', 1],
    ['dm:@florin', 'Somebot', 1],
  ]);
  db.close();
});

test('build v4: a better users map relabels rows already in the store', () => {
  const { raw, ctx } = scaffold();
  mkdirSync(join(raw, 'slack'), { recursive: true });
  writeFileSync(join(raw, 'slack', 'slack.messages.jsonl'),
    line({ source: 'slack', account: 'T1', container: 'dm:U0GUEST001', id: 'D1:1', ts: '2026-10-08T10:00:00Z', author: 'U0GUEST001', participants: ['U0GUEST001'], text: 'hi', permalink: '', raw_ref: '', scrub: { withheld: false, kinds: [] } }));
  buildStore(ctx);
  let db = openReadOnly(ctx.storePath);
  assert.equal((db.prepare('SELECT container FROM messages').get() as { container: string }).container, 'dm:U0GUEST001');
  db.close();
  writeFileSync(join(raw, 'slack', 'slack.users.json'), JSON.stringify({ T1: { fetched_at: 'x', users: [{ id: 'U0GUEST001', name: 'guest', real_name: 'Guest Person' }] } }));
  const s = buildStore(ctx);
  assert.equal(s.recomputed, true);
  db = openReadOnly(ctx.storePath);
  const row = db.prepare('SELECT container, author_raw FROM messages').get() as { container: string; author_raw: string };
  assert.deepEqual([row.container, row.author_raw], ['dm:@guest', 'Guest Person']);
  db.close();
});
