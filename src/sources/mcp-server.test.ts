import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStore, openReadOnly, SCHEMA_VERSION, type BuildContext } from './store.js';
import { SOURCES_MCP_SOURCE } from './mcp.js';
// The server script IS the implementation under test (see its header): import it directly.
import {
  TOOLS,
  PROTOCOL_VERSION,
  buildSearchSql,
  handleMessage,
  normalizeTime,
  runFragments,
  runGet,
  runMeetings,
  runPeople,
  runSearch,
  runStats,
  sanitizeFtsQuery,
} from '../../snapshot/plain/sources-mcp.mjs';

// ── fixture: a tiny raw tree → store → replica, exactly the way the bot builds it ─────────
function fixtureReplica(): { dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcp-'));
  const raw = join(root, 'raw');
  mkdirSync(join(raw, 'google', 'me@x.com'), { recursive: true });
  mkdirSync(join(raw, 'slack'), { recursive: true });
  const people = join(root, 'people.json');
  writeFileSync(
    people,
    JSON.stringify([
      { person_id: 'tobin', name: 'Tess North', company: 'contoso', marker: { type: 'broad', initiatives: ['hcg/p1'] }, identities: ['Tess North@example.com'] },
      // legacy field: read as a broad marker
      { person_id: 'Carla', name: 'Carla Bowman', company: 'bluefin', default_initiative: 'bluefin/lumora', identities: ['slack:Carla Bowman'] },
      { person_id: 'owen', name: 'Owen', identities: ['me@x.com', 'slack:Owen'] },
    ]),
  );
  const line = (o: object) => JSON.stringify(o) + '\n';
  const gmail = (id: string, ts: string, subject: string, text: string, extra: object = {}) =>
    line({
      source: 'gmail', account: 'me@x.com', container: 'inbox', id, ts, author: 'Tess North@example.com',
      participants: ['Tess North@example.com', 'me@x.com'], subject, text, permalink: `https://mail/${id}`,
      raw_ref: `gmail:me@x.com/thr1/${id}`, scrub: { withheld: false, kinds: [], redactions: 0 }, ...extra,
    });
  writeFileSync(
    join(raw, 'google', 'me@x.com', 'messages.jsonl'),
    gmail('m1', '2026-10-01T09:00:00.000Z', 'Team4Multimedia access', 'Tobin sends the forensic report about the breached check-in service.') +
      gmail('m2', '2026-10-02T09:00:00.000Z', 'Re: Team4Multimedia access', 'Still waiting for Konrad; the credentials arrive Monday.') +
      gmail('m3', '2026-10-03T09:00:00.000Z', 'Your Contoso Account', '[BODY WITHHELD: credential carrier — see vault abc123def456]', {
        scrub: { withheld: true, kinds: ['kv'], redactions: 1 },
      }) +
      gmail('m4', '2026-10-04T09:00:00.000Z', 'Ретейнер за октябрь', 'Половина капа ушла на платформу Haki; ретейнер HCG считаем по стене.'),
  );
  writeFileSync(
    join(raw, 'slack', 'slack.messages.jsonl'),
    line({
      source: 'slack', account: 'T1', container: '#lumora', id: 'T1:C1:1700000000.000100', ts: '2026-10-05T12:00:00.000Z',
      author: 'Carla Bowman', participants: ['Carla Bowman'], text: 'Variants release goes live after staging sign-off.',
      permalink: 'https://slack/p1', raw_ref: 'slack:T1/C1/1700000000.000100', scrub: { withheld: false, kinds: [], redactions: 0 },
    }) +
      line({
        source: 'slack', account: 'T1', container: '#lumora', id: 'T1:C1:1700000000.000200', ts: '2026-10-05T12:05:00.000Z',
        author: 'Owen', participants: ['Owen'], text: 'Deleted before anyone read it: password hunter2.', permalink: 'https://slack/p2',
        raw_ref: 'slack:T1/C1/1700000000.000200', scrub: { withheld: false, kinds: [], redactions: 0 },
      }) +
      line({ source: 'slack', account: 'T1', id: 'T1:C1:1700000000.000200', deleted: true }),
  );
  mkdirSync(join(raw, 'meetings', 'granola', 'granola'), { recursive: true });
  writeFileSync(
    join(raw, 'meetings', 'granola', 'granola', 'meetings.jsonl'),
    line({
      source: 'granola', account: 'me@x.com', id: 'g1', title: 'FO Cloud security incident', start: '2026-10-08T17:00:00.000Z', end: '2026-10-08T17:40:00.000Z',
      attendees: [{ email: 'Tess North@example.com', name: 'Tess North' }, { email: 'me@x.com', name: 'Owen' }],
      summary: '# Incident\n- base64 URL encryption reverse-engineered', next_steps: ['(Owen) run the security agent on the repo'],
      transcript: 'Me: we rotate the GWS secret tomorrow', url: 'https://notes.granola.ai/d/g1', text: '', scrub: { withheld: false, kinds: [], redactions: 0 },
    }),
  );
  // Calendar: two Google events + one Outlook event (start order ≠ file order on purpose).
  const ev = (source: string, account: string, id: string, start: string, title: string, attendees: string[], organizer: string) =>
    line({ source, account, id, kind: 'calendar', calendar: 'primary', start, end: start.replace('T09', 'T10'), title, attendees, organizer, link: `https://cal/${id}` });
  writeFileSync(
    join(raw, 'google', 'me@x.com', 'events.jsonl'),
    ev('gcal', 'me@x.com', 'e2', '2026-10-09T09:30:00.000Z', 'BLUEFIN Devs Weekly Sync', ['me@x.com', 'nicola@bluefin.example'], 'me@x.com') +
      ev('gcal', 'me@x.com', 'e1', '2026-10-09T09:00:00.000Z', 'Daily Catch-up', ['me@x.com'], 'me@x.com'),
  );
  mkdirSync(join(raw, 'msgraph', 'owen@example.com'), { recursive: true });
  writeFileSync(join(raw, 'msgraph', 'owen@example.com', 'calendar.jsonl'), ev('msgraph', 'owen@example.com', 'o1', '2026-10-09T09:15:00.000Z', 'T4M security sync', ['Tess North@example.com', 'owen@example.com'], 'Tess North@example.com'));
  // The same call captured by Wispr too (overlapping window, longer transcript) → one call.
  mkdirSync(join(raw, 'meetings', 'wispr', 'wispr'), { recursive: true });
  writeFileSync(
    join(raw, 'meetings', 'wispr', 'wispr', 'meetings.jsonl'),
    line({
      source: 'wispr', account: 'wispr', id: 'w1', title: 'Instant meeting', start: '2026-10-08T17:01:00.000Z', end: '2026-10-08T17:39:00.000Z',
      attendees: [], summary: 'Security incident: URL encryption', next_steps: ['(Owen) compare findings with the agent output'],
      transcript: 'Owen: we rotate the GWS secret tomorrow and add a WAF in front of the app before Friday', url: 'https://notes.wisprflow.ai/w1', text: '',
      scrub: { withheld: false, kinds: [], redactions: 0 },
    }),
  );
  // An integration posting into the channel: excluded from search unless includeBots.
  writeFileSync(
    join(raw, 'slack', 'slack.messages.jsonl'),
    line({
      source: 'slack', account: 'T1', container: '#lumora', id: 'T1:C1:1700000000.000300', ts: '2026-10-05T12:10:00.000Z',
      author: 'Intercom Convert', participants: ['Intercom Convert'], text: 'New conversation about the staging sign-off.',
      permalink: 'https://slack/p3', raw_ref: 'slack:T1/C1/1700000000.000300', scrub: { withheld: false, kinds: [], redactions: 0 },
    }),
    { flag: 'a' },
  );
  // The tenant's decisions: m1+m2 → hcg/p1; the meeting via the account-free shorthand → a sub-initiative;
  // a superseded fragment that must be ignored.
  const fragments = join(root, 'fragments.jsonl');
  writeFileSync(
    fragments,
    line({ id: 'f1', kind: 'thread', start: '2026-10-01T09:00:00Z', end: '2026-10-02T09:00:00Z', refs: ['gmail:me@x.com:m1', 'gmail:me@x.com:m2'], attributions: [{ initiative: 'hcg/p1', share: 1 }], decided_by: 'rule', status: 'decided' }) +
      line({ id: 'f2', kind: 'call', start: '2026-10-08T17:00:00Z', end: '2026-10-08T17:40:00Z', refs: ['meeting:granola:g1'], attributions: [{ initiative: 'hcg/p1/fo-cloud', share: 1 }], decided_by: 'owen', rationale: 'incident call', status: 'decided' }) +
      line({ id: 'f3', kind: 'thread', start: '2026-10-05T12:00:00Z', refs: ['slack:T1:T1:C1:1700000000.000100'], attributions: [{ initiative: 'bluefin/lumora', share: 1 }], decided_by: 'model', status: 'decided' }) +
      line({ id: 'f3', kind: 'thread', start: '2026-10-05T12:00:00Z', refs: ['slack:T1:T1:C1:1700000000.000100'], attributions: [{ initiative: 'bluefin/lumora', share: 1 }], decided_by: 'model', status: 'superseded' }) +
      'not json\n',
  );
  const ctx: BuildContext = {
    slug: 't', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), peoplePath: people, fragmentsPath: fragments, log: () => undefined,
  };
  buildStore(ctx);
  return { dbPath: join(root, 'replica', 'store.sqlite') };
}

// ── pure builders ────────────────────────────────────────────────────────────────────────
test('sanitizeFtsQuery quotes every token so user text cannot reach the MATCH grammar', () => {
  assert.equal(sanitizeFtsQuery('Tess North'), '"Tobin" "Alder"');
  assert.equal(sanitizeFtsQuery('  team4multimedia  '), '"team4multimedia"');
  // column filters and parentheses are neutralised; a leading NOT is dangling and dropped;
  // OR between two terms survives as an operator; prefix star survives
  assert.equal(sanitizeFtsQuery('NOT (secret) subject:x OR y*'), '"secret" "subjectx" OR "y"*');
  assert.equal(sanitizeFtsQuery('say "hi"'), '"say" "hi"');
  // quoted phrases stay phrases; lower-case "or" is a word; doubled / trailing operators drop
  assert.equal(sanitizeFtsQuery('"backup encryption" OR OR waf AND'), '"backup encryption" OR "waf"');
  assert.equal(sanitizeFtsQuery('monto or cartgenie'), '"monto" "or" "cartgenie"');
  assert.equal(sanitizeFtsQuery('aws NOT billing'), '"aws" NOT "billing"');
  assert.equal(sanitizeFtsQuery('"unterminated phrase'), '"unterminated phrase"');
  assert.equal(sanitizeFtsQuery('""'), '');
  assert.equal(sanitizeFtsQuery(undefined), '');
  assert.equal(sanitizeFtsQuery('owen@example.com'), '"owen@example.com"');
});

test('normalizeTime accepts ISO dates/datetimes, widens a bare `until` date to the whole day, rejects junk', () => {
  assert.equal(normalizeTime('2026-10-07', 'since'), '2026-10-07T00:00:00Z');
  assert.equal(normalizeTime('2026-10-07', 'until'), '2026-10-07T23:59:59.999Z');
  assert.equal(normalizeTime('2026-10-07T10:00:00Z', 'since'), '2026-10-07T10:00:00Z');
  assert.equal(normalizeTime('', 'since'), undefined);
  assert.throws(() => normalizeTime('yesterday', 'since'), /ISO/);
});

test('buildSearchSql: fts mode with filters, recent mode without a query, limit clamped', () => {
  const q = buildSearchSql({ match: '"x"', since: 'a', until: 'b', source: 'gmail', personIds: ['p1', 'p2'], limit: 500 });
  assert.equal(q.mode, 'fts');
  assert.match(q.sql, /messages_fts MATCH \?/);
  assert.match(q.sql, /ORDER BY rank LIMIT \?/);
  assert.deepEqual(q.params, ['"x"', 'a', 'b', 'gmail', 'p1', 'p2', 'p1', 'p2', 100]);
  const r = buildSearchSql({ match: '', limit: 0 });
  assert.equal(r.mode, 'recent');
  assert.match(r.sql, /ORDER BY m.ts DESC LIMIT \?/);
  assert.deepEqual(r.params, [20]);
});

// ── tools over a real replica ────────────────────────────────────────────────────────────
test('search ranks FTS hits, honours diacritics/porter, filters by person and initiative, lists recent without a query', () => {
  const { dbPath } = fixtureReplica();
  const db = openReadOnly(dbPath);
  try {
    const hits = runSearch(db, { query: 'forensic report' }).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ref, 'gmail:me@x.com:m1');
    assert.equal(hits[0].permalink, 'https://mail/m1');
    assert.match(String(hits[0].snippet), /«forensic» «report»/);
    // porter stemming: "credentials" ↔ "credential"
    assert.equal(runSearch(db, { query: 'credential' }).hits.length, 2);
    // Cyrillic + remove_diacritics
    assert.equal(runSearch(db, { query: 'ретейнер' }).hits.length, 1);
    // person filter by identity and by name fragment
    assert.equal(runSearch(db, { query: 'access', person: 'Tess North@example.com' }).hits.length, 2);
    assert.equal(runSearch(db, { query: 'release', person: 'Carla' }).hits.length, 1);
    assert.equal(runSearch(db, { query: 'release', person: 'nobody-here' }).hits.length, 0);
    // initiative filter via the tenant's attributions (never via people): m1+m2 are hcg/p1;
    // the superseded fragment f3 must not make the Slack message bluefin/lumora.
    assert.equal(runSearch(db, { query: 'access', initiative: 'hcg/p1' }).hits.length, 2);
    assert.equal(runSearch(db, { query: 'release', initiative: 'bluefin/lumora' }).hits.length, 0);
    // prefix: hcg/p1 covers hcg/p1/fo-cloud, and the meeting shorthand ref resolves
    const incident = runSearch(db, { query: 'encryption', initiative: 'hcg/p1' }).hits;
    assert.deepEqual(incident.map((h) => [h.kind, h.ref]), [['meeting', 'granola:me@x.com:g1']]);
    assert.equal(runSearch(db, { query: 'encryption', initiative: 'hcg/p2' }).hits.length, 0);
    // deleted Slack message is gone from search even by its exact words
    assert.equal(runSearch(db, { query: 'hunter2' }).hits.length, 0);
    // no query → recent, newest first, source filter applies
    const recent = runSearch(db, { source: 'gmail', limit: 2 });
    assert.equal(recent.mode, 'recent');
    assert.deepEqual(recent.hits.map((h) => h.ref), ['gmail:me@x.com:m4', 'gmail:me@x.com:m3']);
    assert.equal(recent.hits[1].withheld, true);
    // time window
    assert.equal(runSearch(db, { query: 'access', since: '2026-10-02', until: '2026-10-02' }).hits.length, 1);
    assert.throws(() => runSearch(db, { query: 'x', since: 'last week' }), /ISO/);
  } finally {
    db.close();
  }
});

test('get returns the row with thread neighbours and scrub meta; withheld bodies keep the marker verbatim', () => {
  const { dbPath } = fixtureReplica();
  const db = openReadOnly(dbPath);
  try {
    const m2 = runGet(db, { ref: 'gmail:me@x.com:m2' });
    assert.equal(m2.subject, 'Re: Team4Multimedia access');
    const thread = m2.thread as { before: { ref: string }[]; after: { ref: string }[] };
    assert.deepEqual(thread.before.map((s) => s.ref), ['gmail:me@x.com:m1']);
    assert.deepEqual(thread.after.map((s) => s.ref), ['gmail:me@x.com:m3', 'gmail:me@x.com:m4']);
    const people = m2.people as { person_id: string }[];
    assert.ok(people.some((p) => p.person_id === 'tobin'));
    const m3 = runGet(db, { ref: 'gmail:me@x.com:m3' });
    assert.match(String(m3.text), /^\[BODY WITHHELD/);
    assert.deepEqual(m3.scrub, { withheld: true, kinds: ['kv'] });
    assert.match(String(runGet(db, { ref: 'nope' }).error), /no message/);
  } finally {
    db.close();
  }
});

test('stats reports per-source coverage, withheld count and sync meta', () => {
  const { dbPath } = fixtureReplica();
  const db = openReadOnly(dbPath);
  try {
    const s = runStats(db) as { messages: { source: string; n: number }[]; withheld: number; people: number; meta: Record<string, string> };
    assert.equal((s as unknown as { attributions: number }).attributions, 3);
    assert.deepEqual(
      s.messages.map((m) => [m.source, m.n]),
      [
        ['gmail', 4],
        ['slack', 2],
      ],
    );
    assert.equal(s.withheld, 1);
    assert.equal(s.people, 3);
    assert.equal(s.meta.schema_version, String(SCHEMA_VERSION));
  } finally {
    db.close();
  }
});

// ── protocol ─────────────────────────────────────────────────────────────────────────────
test('handleMessage speaks the JSON-RPC subset the MCP client needs and never throws on junk', () => {
  const { dbPath } = fixtureReplica();
  const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, dbPath)!;
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, '2024-11-05'); // echo an older client
  const init2 = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, dbPath)!;
  assert.equal((init2.result as { protocolVersion: string }).protocolVersion, PROTOCOL_VERSION);
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, dbPath), undefined);
  assert.deepEqual(handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, dbPath), { jsonrpc: '2.0', id: 2, result: {} });
  const list = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, dbPath)!;
  assert.deepEqual(
    (list.result as { tools: { name: string }[] }).tools.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
  assert.deepEqual(TOOLS.map((t) => t.name), ['search', 'get', 'tasks', 'meetings', 'calendar', 'fragments', 'people', 'stats']);
  const call = handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'forensic' } } }, dbPath)!;
  const content = (call.result as { content: { text: string }[]; isError: boolean });
  assert.equal(content.isError, false);
  assert.equal(JSON.parse(content.content[0].text).hits.length, 1);
  // a bad argument is a tool RESULT with isError, not a protocol error (the model can recover)
  const bad = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'search', arguments: { since: 'nope' } } }, dbPath)!;
  assert.equal((bad.result as { isError: boolean }).isError, true);
  const unknownTool = handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'drop' } }, dbPath)!;
  assert.equal((unknownTool.error as { code: number }).code, -32602);
  assert.equal((handleMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, dbPath)!.error as { code: number }).code, -32601);
  assert.equal((handleMessage({ foo: 1 }, dbPath)!.error as { code: number }).code, -32600);
  assert.equal((handleMessage(null, dbPath)!.error as { code: number }).code, -32600);
});

test('the script runs as a real stdio server: initialize → tools/list → tools/call round-trip', async () => {
  const { dbPath } = fixtureReplica();
  const child = spawn(process.execPath, ['--no-warnings', SOURCES_MCP_SOURCE], { env: { ...process.env, SOURCES_DB: dbPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));
  const lines: string[] = [];
  const got = new Promise<void>((resolve) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (lines.length === 6) resolve();
      }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stats', arguments: {} } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'calendar', arguments: { since: '2026-10-09', until: '2026-10-09' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'calendar', arguments: { since: '2026-10-09', person: 'tobin' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'calendar', arguments: { q: 'sync', until: '2026-10-08' } } }) + '\n');
  await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout; stderr=${stderr.join('')}`)), 10_000))]);
  child.stdin.end();
  const [init, list, stats, today, withTobin, none] = lines.map((l) => JSON.parse(l));
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'sources');
  assert.equal(list.result.tools.length, TOOLS.length);
  assert.equal(JSON.parse(stats.result.content[0].text).people, 3);
  const st = JSON.parse(stats.result.content[0].text);
  assert.equal(st.events.n, 3);
  assert.deepEqual(st.events.bySource.map((x: { source: string; n: number }) => [x.source, x.n]), [['gcal', 2], ['msgraph', 1]]);
  const evs = JSON.parse(today.result.content[0].text).events as { title: string; source: string; attendees: string[]; link: string }[];
  assert.deepEqual(evs.map((e) => e.title), ['Daily Catch-up', 'T4M security sync', 'BLUEFIN Devs Weekly Sync'], 'ordered by start across sources');
  assert.equal(evs[1]!.source, 'msgraph');
  assert.ok(evs[2]!.attendees.includes('nicola@bluefin.example'));
  assert.deepEqual((JSON.parse(withTobin.result.content[0].text).events as { title: string }[]).map((e) => e.title), ['T4M security sync']);
  assert.equal(JSON.parse(none.result.content[0].text).events.length, 0);
  assert.ok(list.result.tools.some((t: { name: string; description: string }) => t.name === 'calendar' && /meetings today/.test(t.description)));
  assert.equal(stderr.join(''), '', 'server must stay silent on stderr');
  await new Promise((r) => child.on('close', r));
});

test('meetings: listed by attendee, searchable by transcript, get returns summary + attributions; fragments + markers exposed', () => {
  const { dbPath } = fixtureReplica();
  const db = openReadOnly(dbPath);
  try {
    const list = runMeetings(db, { person: 'tobin', since: '2026-10-08' }).meetings;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.title, 'FO Cloud security incident');
    assert.deepEqual(list[0]!.next_steps, ['(Owen) compare findings with the agent output', '(Owen) run the security agent on the repo'], 'next steps from every copy, primary first');
    assert.equal(runMeetings(db, { person: 'Carla' }).meetings.length, 0);
    assert.equal(runSearch(db, { query: 'GWS secret', source: 'granola' }).hits.length, 1);
    const g = runGet(db, { ref: 'granola:me@x.com:g1' });
    assert.equal(g.kind, 'meeting');
    assert.match(String(g.transcript), /rotate/);
    assert.deepEqual((g.attributions as { initiative: string }[]).map((a) => a.initiative), ['hcg/p1/fo-cloud']);
    assert.ok((g.people as { person_id: string }[]).some((p) => p.person_id === 'tobin'));
    const frags = runFragments(db, { initiative: 'hcg' }).fragments;
    assert.deepEqual(frags.map((f) => f.id).sort(), ['f1', 'f2']);
    assert.deepEqual(runFragments(db, { status: 'superseded' }).fragments, []);
    const people = runPeople(db, { q: 'Carla' }).people;
    assert.deepEqual(people[0]!.marker, { type: 'broad', initiatives: ['bluefin/lumora'] });
  } finally {
    db.close();
  }
});

test('calls: recorder copies collapse in search and meetings; get shows every copy side by side; bots excluded by default', () => {
  const { dbPath } = fixtureReplica();
  const db = openReadOnly(dbPath);
  try {
    const hits = runSearch(db, { query: 'GWS secret' }).hits;
    const meet = hits.filter((h: { kind?: string }) => h.kind === 'meeting') as { also: unknown[] }[];
    assert.equal(meet.length, 1, 'one call, not two copies');
    assert.equal(meet[0]!.also.length, 1);
    const list = runMeetings(db, { since: '2026-10-08' }).meetings as { sources: unknown[]; source: string }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.sources.length, 2);
    assert.equal(list[0]!.source, 'wispr', 'primary = longest transcript');
    const call = runGet(db, { ref: 'granola:me@x.com:g1' }) as { copies: { source: string }[] };
    assert.equal(call.copies.length, 2);
    assert.deepEqual(call.copies.map((c) => c.source).sort(), ['granola', 'wispr']);
    assert.equal(runSearch(db, { query: 'staging' }).hits.length, 1, 'the Intercom post is excluded');
    assert.equal(runSearch(db, { query: 'staging', includeBots: true }).hits.length, 2);
    assert.equal(runSearch(db, { query: 'forensic OR Konrad' }).hits.length, 2, 'OR works');
  } finally {
    db.close();
  }
});
