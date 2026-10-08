import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStore, openReadOnly, type BuildContext } from './store.js';
import { SOURCES_MCP_SOURCE } from './mcp.js';
// The server script IS the implementation under test (see its header): import it directly.
import {
  TOOLS,
  PROTOCOL_VERSION,
  buildSearchSql,
  handleMessage,
  normalizeTime,
  runGet,
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
      { person_id: 'tobin', name: 'Tess North', company: 'contoso', default_initiative: 'hcg/p1', identities: ['Tess North@example.com'] },
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
  const ctx: BuildContext = {
    slug: 't', rawDir: raw, storePath: join(root, 'store.sqlite'), replicaDir: join(root, 'replica'), peoplePath: people, log: () => undefined,
  };
  buildStore(ctx);
  return { dbPath: join(root, 'replica', 'store.sqlite') };
}

// ── pure builders ────────────────────────────────────────────────────────────────────────
test('sanitizeFtsQuery quotes every token so user text cannot reach the MATCH grammar', () => {
  assert.equal(sanitizeFtsQuery('Tess North'), '"Tobin" "Alder"');
  assert.equal(sanitizeFtsQuery('  team4multimedia  '), '"team4multimedia"');
  // operators and column filters are neutralised, prefix star survives
  assert.equal(sanitizeFtsQuery('NOT (secret) subject:x OR y*'), '"NOT" "secret" "subjectx" "OR" "y"*');
  assert.equal(sanitizeFtsQuery('say "hi"'), '"say" "hi"');
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
    // initiative filter via people.default_initiative
    assert.equal(runSearch(db, { query: 'access', initiative: 'hcg/p1' }).hits.length, 2);
    assert.equal(runSearch(db, { query: 'access', initiative: 'bluefin/lumora' }).hits.length, 0);
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
    assert.deepEqual(
      s.messages.map((m) => [m.source, m.n]),
      [
        ['gmail', 4],
        ['slack', 1],
      ],
    );
    assert.equal(s.withheld, 1);
    assert.equal(s.people, 3);
    assert.equal(s.meta.schema_version, '1');
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
  assert.deepEqual(TOOLS.map((t) => t.name), ['search', 'get', 'people', 'stats']);
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
        if (lines.length === 3) resolve();
      }
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stats', arguments: {} } }) + '\n');
  await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout; stderr=${stderr.join('')}`)), 10_000))]);
  child.stdin.end();
  const [init, list, stats] = lines.map((l) => JSON.parse(l));
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'sources');
  assert.equal(list.result.tools.length, 4);
  assert.equal(JSON.parse(stats.result.content[0].text).people, 3);
  assert.equal(stderr.join(''), '', 'server must stay silent on stderr');
  await new Promise((r) => child.on('close', r));
});
