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
