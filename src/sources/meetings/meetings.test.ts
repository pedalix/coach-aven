import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullContext } from '../types.js';
import { geminiQuery } from './gmeet.js';
import { pullGranola } from './granola.js';
import { extractNextSteps, granolaTranscript, normaliseGeminiDoc, normaliseGranolaNote, normaliseWisprMeeting, parseGeminiDoc, parseGeminiDocName, scrubMeeting } from './normalise.js';
import { deviceLogin, parseRpcBody, toolPayload, transcriptPage } from './wispr.js';

// Shapes copied from the real Granola export of 2026-10-08 (values shortened, nothing secret).
const granolaNote = {
  id: 'not_UJ29EeA8tqpykU',
  object: 'note',
  title: 'Front Office Cloud security incident and encryption vulnerabilities',
  owner: { name: 'Owen', email: 'Owen@example.com' },
  created_at: '2026-10-08T17:07:34.602Z',
  updated_at: '2026-10-08T17:52:00.000Z',
  calendar_event: null,
  attendees: [{ name: 'Owen', email: 'owen@example.com' }],
  summary_markdown: '# Security Incident Overview\n\n- Attacker extracted a backup\n\n# Next Steps\n\n- **Run security AI agent on Front Office Cloud repo**\n- Review password reset endpoint encryption\n\n---\n',
  private_notes_markdown: '',
  transcript: [
    { text: 'So the attacker', start_time: '2026-10-08T17:07:40.000Z', end_time: '2026-10-08T17:07:42.000Z', speaker: { source: 'speaker', attribution: 'them' } },
    { text: 'got the backup.', start_time: '2026-10-08T17:07:42.000Z', end_time: '2026-10-08T17:07:44.000Z', speaker: { source: 'speaker', attribution: 'them' } },
    { text: 'I will run the agent tomorrow.', start_time: '2026-10-08T17:40:00.000Z', end_time: '2026-10-08T17:47:10.000Z', speaker: { source: 'microphone', attribution: 'me' } },
  ],
  web_url: 'https://notes.granola.ai/d/e1145581',
};

test('granola: note → meeting (times from transcript when no calendar event, me/them merged, next steps)', () => {
  const m = normaliseGranolaNote(granolaNote);
  assert.equal(m.source, 'granola');
  assert.equal(m.account, 'owen@example.com');
  assert.equal(m.start, '2026-10-08T17:07:40.000Z');
  assert.equal(m.end, '2026-10-08T17:47:10.000Z');
  assert.equal(m.transcript, 'Them: So the attacker got the backup.\nMe: I will run the agent tomorrow.');
  assert.deepEqual(m.next_steps, ['Run security AI agent on Front Office Cloud repo', 'Review password reset endpoint encryption']);
  assert.match(m.text, /Next steps:\nRun security AI agent/);
  assert.equal(granolaTranscript(undefined), '');
});

test('extractNextSteps: Wispr / Gemini (German) / Russian headings; stops at the next heading', () => {
  assert.deepEqual(extractNextSteps('### Next Steps\n- (Owen) Contact Dimitri\n- (Vincent) Pitch\n\n### Decisions Made\n- GCP stays'), ['(Owen) Contact Dimitri', '(Vincent) Pitch']);
  assert.deepEqual(extractNextSteps('Suggested next steps\n\n[Owen Hale] Dimitri kontaktieren: Gespräch\n\nMeeting records'), ['[Owen Hale] Dimitri kontaktieren: Gespräch', 'Meeting records']);
  assert.deepEqual(extractNextSteps('### Дальнейшие шаги\n- (Owen) Переработать документ\n### Принятые решения\n- x'), ['(Owen) Переработать документ']);
  assert.deepEqual(extractNextSteps('no such section'), []);
});

test('gemini: doc name parsed with its timezone; doc split into summary / transcript / invitees', () => {
  assert.deepEqual(parseGeminiDocName('Instant meeting – 2026/10/07 09:11 CEST – Notes by Gemini'), { title: 'Instant meeting', start: '2026-10-07T07:11:00.000Z' });
  assert.deepEqual(parseGeminiDocName('HCG sync - 2026/09/23 08:43 MSK - Notes by Gemini'), { title: 'HCG sync', start: '2026-09-23T05:43:00.000Z' });
  assert.equal(parseGeminiDocName('Quarterly plan.docx'), undefined);
  const doc = 'Instant meeting\nInvited Vera Lindqvist, Owen Hale\n\nSummary\nProduktstrategie besprochen.\n\nVorgeschlagene nächste Schritte\n[Owen Hale] Dimitri kontaktieren\n\nTranscript\nVincent: Hallo\nOwen: Hi\n';
  const p = parseGeminiDoc(doc);
  assert.deepEqual(p.attendees, ['Vera Lindqvist', 'Owen Hale']);
  assert.match(p.summary, /Produktstrategie/);
  assert.equal(p.transcript, 'Vincent: Hallo\nOwen: Hi');
  const m = normaliseGeminiDoc({ id: 'doc1', name: 'Instant meeting – 2026/10/07 09:11 CEST – Notes by Gemini', link: 'https://docs.google.com/document/d/doc1' }, doc, 'Owen@example.com')!;
  assert.equal(m.source, 'gmeet');
  assert.equal(m.account, 'owen@example.com');
  assert.deepEqual(m.next_steps, ['[Owen Hale] Dimitri kontaktieren']);
  assert.deepEqual(m.attendees, [{ email: '', name: 'Vera Lindqvist' }, { email: '', name: 'Owen Hale' }]);
  assert.match(geminiQuery('2026-10-01T00:00:00.000Z'), /Notes by Gemini.*modifiedTime > '2026-10-01T00:00:00.000Z'/);
});

test('wispr: get_meeting result → meeting; attendees as names', () => {
  const m = normaliseWisprMeeting(
    { id: '8cd8', title: 'Instant meeting', summary: 'Strategy.\n\n### Next Steps\n- (Owen Hale) Contact Dimitri\n', attendees: [{ name: 'Vera Lindqvist', response: 'accepted' }], start: '2026-10-07T07:11:40Z', end: '2026-10-07T07:26:40Z', share_link: 'https://notes.wisprflow.ai/shared/x' },
    'Vincent: ...',
    'owen@example.com',
  );
  assert.equal(m.end, '2026-10-07T07:26:40.000Z');
  assert.deepEqual(m.attendees, [{ email: '', name: 'Vera Lindqvist' }]);
  assert.deepEqual(m.next_steps, ['(Owen Hale) Contact Dimitri']);
});

test('scrubMeeting: a password read out in the transcript withholds the TRANSCRIPT only', () => {
  const m = normaliseGranolaNote({ ...granolaNote, transcript: [{ text: 'the prod db is mysql://root:S3cr3tPass@db.prod.example:3306/app', speaker: { attribution: 'them' } }] });
  const s = scrubMeeting(m);
  assert.equal(s.scrub.withheld, true);
  assert.match(s.transcript, /^\[BODY WITHHELD/);
  assert.match(s.summary, /Security Incident Overview/);
  assert.ok(!JSON.stringify(s).includes('S3cr3tPass'));
});

// ── granola puller against a fake API ────────────────────────────────────────────────────
function ctxIn(dir: string): PullContext {
  return { slug: 't', outDir: dir, tokenPath: '', log: () => undefined };
}
function fakeFetch(routes: Record<string, () => { status: number; body: unknown }>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]!() : { status: 404, body: { error: 'nope' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('granola puller: paginates, skips not-yet-summarised (404), re-fetches only changed versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gran-'));
  const tok = join(dir, 'granola.json');
  writeFileSync(tok, JSON.stringify({ token: 'grn_test' }));
  let version = 'v1';
  const calls: string[] = [];
  const routes = {
    'notes?created_after=2026-10-01T00%3A00%3A00Z&cursor=p2': () => ({ status: 200, body: { notes: [{ id: 'n2', updated_at: 'v1' }], hasMore: false } }),
    'notes?created_after=2026-10-01T00%3A00%3A00Z': () => ({ status: 200, body: { notes: [{ id: 'n1', updated_at: version }, { id: 'n3', updated_at: 'v1' }], hasMore: true, cursor: 'p2' } }),
    'notes/n1?include=transcript': () => ({ status: 200, body: { ...granolaNote, id: 'n1' } }),
    'notes/n2?include=transcript': () => ({ status: 200, body: { ...granolaNote, id: 'n2' } }),
    'notes/n3?include=transcript': () => ({ status: 404, body: { error: 'processing' } }),
  };
  const r1 = await pullGranola(ctxIn(dir), tok, { since: '2026-10-01', fetchImpl: fakeFetch(routes, calls) });
  assert.equal(r1.error, undefined);
  assert.equal(r1.count, 2);
  assert.equal(r1.account, 'owen@example.com');
  const file = join(dir, 'meetings', 'granola', 'granola', 'meetings.jsonl');
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  // second run: n1 changed, n2 unchanged, n3 still processing
  version = 'v2';
  calls.length = 0;
  const r2 = await pullGranola(ctxIn(dir), tok, { since: '2026-10-01', fetchImpl: fakeFetch(routes, calls) });
  assert.equal(r2.count, 1);
  assert.ok(!calls.some((c) => c.includes('notes/n2')), 'unchanged note not re-fetched');
  assert.ok(calls.some((c) => c.includes('notes/n3')), 'processing note retried');
  const r3 = await pullGranola(ctxIn(dir), join(dir, 'missing.json'), {});
  assert.equal(r3.reauth, true);
});

// ── wispr helpers ────────────────────────────────────────────────────────────────────────
test('wispr MCP: response body parsed from JSON or SSE; tool payload decoded; transcript pages', () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', 3), { jsonrpc: '2.0', id: 3, result: { ok: 1 } });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{\\"meetings\\":[]}"}]}}\n\n';
  const msg = parseRpcBody(sse, 7)!;
  assert.deepEqual(toolPayload(msg.result as Record<string, unknown>), { meetings: [] });
  assert.equal(parseRpcBody(sse, 9), undefined);
  assert.deepEqual(transcriptPage({ transcript: { text: 'abc', next_start_char: 3 } }), { text: 'abc', next: 3 });
  assert.deepEqual(transcriptPage({ transcript: 'Me: hi\n[truncated — continue with start_char 40000]' }), { text: 'Me: hi', next: 40000 });
  assert.deepEqual(transcriptPage({ transcript: 'Me: done' }), { text: 'Me: done' });
});

test('wispr device login: registers a public client, polls through authorization_pending, stores the refresh token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wispr-'));
  const tok = join(dir, 'wispr.json');
  let polls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/oauth2/register')) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.redirect_uris.length, 1);
      assert.equal(body.token_endpoint_auth_method, 'none');
      return json(201, { client_id: 'client_X' });
    }
    if (url.endsWith('/oauth2/device_authorization')) return json(200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://mcp-auth.wisprflow.com/device', expires_in: 300, interval: 0 });
    if (url.endsWith('/oauth2/token')) {
      polls++;
      return polls < 2 ? json(400, { error: 'authorization_pending' }) : json(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
    }
    return json(404, {});
  }) as typeof fetch;
  const lines: string[] = [];
  const t = await deviceLogin(tok, (l) => lines.push(l), fetchImpl, async () => undefined);
  assert.equal(t.client_id, 'client_X');
  assert.equal(JSON.parse(readFileSync(tok, 'utf8')).refresh_token, 'rt');
  assert.ok(lines.some((l) => l.includes('ABCD-EFGH')));
});
