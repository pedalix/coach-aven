import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTurnId,
  isBadReason,
  latestPerUser,
  tallyFor,
  joinUsage,
  feedbackSummaryText,
  parseFeedbackLines,
  FeedbackLog,
  type FeedbackRecord,
} from './feedback.js';
import type { UsageRecord } from './metering.js';

const fb = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  at: '2026-09-02T10:00:00Z',
  turnId: 'tabc123-1',
  key: 'thread:1.2',
  slug: 'caldora',
  user: 'U1',
  verdict: 'good',
  ...over,
});

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: '2026-09-02T09:59:00Z',
  key: 'thread:1.2',
  slug: 'caldora',
  kind: 'turn',
  status: 'ok',
  elapsedMs: 60_000,
  turnId: 'tabc123-1',
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, costUsd: 1 },
  ...over,
});

test('isTurnId — accepts bot-minted ids, rejects path tricks', () => {
  assert.equal(isTurnId('tabc123-1'), true);
  assert.equal(isTurnId('tm9k2p1-42'), true);
  assert.equal(isTurnId('../../etc/passwd'), false);
  assert.equal(isTurnId('t-1'), false); // no boot segment
  assert.equal(isTurnId(''), false);
});

test('isBadReason — only the published taxonomy', () => {
  assert.equal(isBadReason('tone'), true);
  assert.equal(isBadReason('backforth'), true);
  assert.equal(isBadReason('meh'), false);
});

test('latestPerUser — the last click wins per (turnId, user)', () => {
  const rows = latestPerUser([
    fb({ at: '2026-09-02T10:00:00Z', verdict: 'good' }),
    fb({ at: '2026-09-02T10:05:00Z', verdict: 'bad', reason: 'wrong' }), // same user changed their mind
    fb({ at: '2026-09-02T10:01:00Z', user: 'U2', verdict: 'good' }),
  ]);
  assert.equal(rows.length, 2);
  const u1 = rows.find((r) => r.user === 'U1');
  assert.equal(u1?.verdict, 'bad'); // the later click, not the first
  assert.equal(rows.find((r) => r.user === 'U2')?.verdict, 'good');
});

test('latestPerUser — a second button on the same turn is the same verdict slot', () => {
  // The answer and a background update both carry buttons; one person, one verdict.
  const rows = latestPerUser([
    fb({ at: '2026-09-02T10:00:00Z', verdict: 'bad', reason: 'slow', ts: '1.1' }),
    fb({ at: '2026-09-02T10:09:00Z', verdict: 'good', ts: '2.2' }), // rated the background update
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'good');
});

test('tallyFor — one vote per user, latest wins, both sides counted', () => {
  const t = tallyFor([
    fb({ user: 'U1', verdict: 'good' }),
    fb({ user: 'U2', verdict: 'good' }),
    fb({ user: 'U3', verdict: 'bad', reason: 'wrong' }),
    fb({ at: '2026-09-02T10:05:00Z', user: 'U1', verdict: 'bad', reason: 'slow' }), // U1 flipped
  ]);
  assert.deepEqual(t, { good: 1, bad: 2 });
});

test('tallyFor — re-clicking the same verdict is a no-op, not a retraction', () => {
  const t = tallyFor([fb({ verdict: 'good' }), fb({ at: '2026-09-02T10:05:00Z', verdict: 'good' })]);
  assert.deepEqual(t, { good: 1, bad: 0 });
});

test('joinUsage — two people blaming the same cause on one turn count it once', () => {
  const rows = joinUsage(
    [fb({ user: 'U1', verdict: 'bad', reason: 'wrong' }), fb({ user: 'U2', verdict: 'bad', reason: 'wrong' })],
    [usage()],
  );
  assert.equal(rows[0].bad, 1);
  assert.deepEqual(rows[0].reasons, { wrong: 1 }); // a set per turn, not a vote count
});

test('joinUsage — different causes on one turn are each attributed once', () => {
  const rows = joinUsage(
    [fb({ user: 'U1', verdict: 'bad', reason: 'wrong' }), fb({ user: 'U2', verdict: 'bad', reason: 'tone' })],
    [usage()],
  );
  assert.deepEqual(rows[0].reasons, { wrong: 1, tone: 1 });
});

test('joinUsage — one dissent disqualifies the turn', () => {
  const rows = joinUsage(
    [fb({ user: 'U1', verdict: 'good' }), fb({ user: 'U2', verdict: 'bad', reason: 'wrong' })],
    [usage()],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rated, 1); // one turn, not one per rater
  assert.equal(rows[0].good, 0);
  assert.equal(rows[0].bad, 1);
  assert.deepEqual(rows[0].reasons, { wrong: 1 });
});

test('joinUsage — cost comes from the usage side, per project, costliest coverage first', () => {
  const rows = joinUsage(
    [
      fb({ turnId: 'tabc123-1', verdict: 'good' }),
      fb({ turnId: 'tabc123-2', verdict: 'bad', reason: 'tone' }),
      fb({ turnId: 'tabc123-3', slug: 'lumora', verdict: 'good' }),
    ],
    [
      usage({ turnId: 'tabc123-1', usage: { costUsd: 2 } }),
      usage({ turnId: 'tabc123-2', usage: { costUsd: 3 } }),
      usage({ turnId: 'tabc123-3', slug: 'lumora', usage: { costUsd: 5 } }),
    ],
  );
  assert.deepEqual(rows.map((r) => r.group), ['caldora', 'lumora']); // 2 rated beats 1
  assert.equal(rows[0].ratedCostUsd, 5); // 2 + 3
  assert.equal(rows[0].goodCostUsd, 2); // only the turn that helped
  assert.equal(rows[1].goodCostUsd, 5);
});

test('joinUsage — a rating with no matching usage record contributes 0 cost, not a wrong one', () => {
  const rows = joinUsage([fb({ turnId: 'told-9' })], []); // pre-turnId usage history
  assert.equal(rows[0].rated, 1);
  assert.equal(rows[0].ratedCostUsd, 0);
  assert.equal(rows[0].group, 'caldora'); // falls back to the slug on the feedback record
});

test('feedbackSummaryText — empty state names the buttons', () => {
  const t = feedbackSummaryText([], 12, 7);
  assert.match(t, /No answers rated yet/);
});

test('feedbackSummaryText — coverage first, then cost per helped answer', () => {
  const rows = joinUsage(
    [fb({ turnId: 'tabc123-1' }), fb({ turnId: 'tabc123-2', verdict: 'bad', reason: 'tone' })],
    [usage({ turnId: 'tabc123-1', usage: { costUsd: 1 } }), usage({ turnId: 'tabc123-2', usage: { costUsd: 3 } })],
  );
  const t = feedbackSummaryText(rows, 10, 7);
  assert.match(t, /2 of 10 turns rated \(20%\)/);
  assert.match(t, /1 helped, 1 missed/);
  assert.match(t, /\$4\.00 per answer that helped/); // total rated cost over answers that helped
  assert.match(t, /Too technical/); // the reason tally
});

test('feedbackSummaryText — never reports over 100% coverage when usage lags', () => {
  const rows = joinUsage([fb()], [usage()]);
  const t = feedbackSummaryText(rows, 0, 7); // totalTurns under-reported
  assert.match(t, /1 of 1 turns rated \(100%\)/);
});

test('parseFeedbackLines — tolerates torn lines and rejects foreign shapes', () => {
  const text = ['{"turnId":"t1-1","user":"U1","verdict":"good","at":"2026-09-02T10:00:00Z"}', '{"turnId":"t1-2"', '{"hello":"world"}', ''].join('\n');
  const out = parseFeedbackLines(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].turnId, 't1-1');
});

test('FeedbackLog — round-trips through month files and honours the window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-fb-'));
  const logStore = new FeedbackLog(dir);
  const now = Date.parse('2026-09-02T12:00:00Z');
  logStore.record(fb({ at: '2026-09-02T11:00:00Z', turnId: 'tabc123-1' }));
  logStore.record(fb({ at: '2026-08-01T11:00:00Z', turnId: 'tabc123-0' })); // previous month, outside the window
  const recent = logStore.read(6 * 60 * 60 * 1000, now);
  assert.deepEqual(recent.map((r) => r.turnId), ['tabc123-1']);
  const wide = logStore.read(45 * 24 * 60 * 60 * 1000, now);
  assert.equal(wide.length, 2); // reaches back into the previous month file
});

test('FeedbackLog.forTurn — collects one turn across the current and previous month', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-fb-'));
  const logStore = new FeedbackLog(dir);
  const now = Date.parse('2026-09-02T12:00:00Z');
  logStore.record(fb({ at: '2026-08-31T23:00:00Z', turnId: 'tabc123-7', user: 'U1' })); // last month's file
  logStore.record(fb({ at: '2026-09-01T09:00:00Z', turnId: 'tabc123-7', user: 'U2' }));
  logStore.record(fb({ at: '2026-09-01T09:00:00Z', turnId: 'tabc123-8', user: 'U1' })); // another turn
  logStore.record(fb({ at: '2026-06-01T09:00:00Z', turnId: 'tabc123-7', user: 'U3' })); // too old to scan
  const got = logStore.forTurn('tabc123-7', now);
  assert.deepEqual(got.map((r) => r.user).sort(), ['U1', 'U2']);
});

test('FeedbackLog — reading before anything was written is empty, not an error', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'aven-fb-')), 'never-created');
  assert.deepEqual(new FeedbackLog(dir).read(60_000), []);
});
