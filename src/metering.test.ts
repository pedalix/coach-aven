import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamOf, aggregateUsage, parseUsageLines, usageSummaryText, UsageLog, type UsageRecord } from './metering.js';

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: '2026-07-12T10:00:00Z',
  key: 'thread:1.2',
  slug: 'caldora',
  kind: 'turn',
  status: 'ok',
  elapsedMs: 120_000,
  usage: { inputTokens: 500_000, outputTokens: 20_000, cacheReadTokens: 400_000, costUsd: 1.25 },
  ...over,
});

test('teamOf — tenant-scoped keys resolve, legacy keys fall back to home', () => {
  assert.equal(teamOf('T0ABCDEF:thread:1.2'), 'T0ABCDEF'); // the slice-2 re-keyed shape
  assert.equal(teamOf('thread:1.2'), 'home');
  assert.equal(teamOf('dm:D1:caldora'), 'home');
  assert.equal(teamOf('cron:r1:caldora'), 'home');
});

test('aggregateUsage — per-slug totals, errors counted, costliest first', () => {
  const rows = aggregateUsage(
    [
      rec(),
      rec({ status: 'error', usage: { costUsd: 0.1, inputTokens: 1000, outputTokens: 50 } }),
      rec({ slug: 'bluefin-infra', usage: { costUsd: 9.99, inputTokens: 1, outputTokens: 1 } }),
      rec({ slug: 'bluefin-infra', usage: undefined }), // usage-less record still counts the turn
    ],
    'slug',
  );
  assert.deepEqual(rows.map((r) => r.group), ['bluefin-infra', 'caldora']); // 9.99 > 1.35
  const caldora = rows[1];
  assert.equal(caldora.turns, 2);
  assert.equal(caldora.errors, 1);
  assert.equal(caldora.inputTokens, 501_000);
  assert.ok(Math.abs(caldora.costUsd - 1.35) < 1e-9);
  const infra = rows[0];
  assert.equal(infra.turns, 2);
});

test('aggregateUsage — by team groups tenant keys, legacy → home', () => {
  const rows = aggregateUsage([rec(), rec({ key: 'T0AAAAAA:thread:9.9' })], 'team');
  assert.deepEqual(rows.map((r) => r.group).sort(), ['T0AAAAAA', 'home']);
});

test('parseUsageLines — tolerant of torn lines and junk', () => {
  const text = [JSON.stringify(rec()), '{"at":"2026-07-12T10:0', 'garbage', JSON.stringify(rec({ slug: 'art' }))].join('\n');
  const parsed = parseUsageLines(text);
  assert.deepEqual(parsed.map((r) => r.slug), ['caldora', 'art']);
});

test('aggregateUsage — cache write tokens are summed too (they used to vanish)', () => {
  const rows = aggregateUsage(
    [
      rec({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 100, cacheCreationTokens: 10, costUsd: 0 } }),
      rec({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 200, cacheCreationTokens: 20, costUsd: 0 } }),
      rec({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }), // older CLI shape, no cache fields
    ],
    'slug',
  );
  assert.equal(rows[0].cacheReadTokens, 300);
  assert.equal(rows[0].cacheCreationTokens, 30);
});

test('usageSummaryText — cache traffic is printed, first, and its share of all tokens is stated', () => {
  // A real caldora turn: cache reads were 98% of tokens and two thirds of the cost.
  const real = rec({
    usage: { inputTokens: 7_075, outputTokens: 17_534, cacheReadTokens: 1_849_796, cacheCreationTokens: 92_869, costUsd: 1.397 },
  });
  const text = usageSummaryText(aggregateUsage([real], 'slug'), aggregateUsage([real], 'team'), 1);
  assert.match(text, /1\.8M cache read \/ 93k cache write \/ 7k in \/ 18k out tok/); // cache before in/out
  assert.match(text, /2\.0M tok, 94% of them cache reads/); // the headline that explains the dollars
  assert.match(text, /API-list-price equivalent/); // never read as a bill
  assert.match(text, /not a bill/);
});

test('usageSummaryText — totals + per-project lines; team cut only when multi-team', () => {
  const bySlug = aggregateUsage([rec(), rec({ slug: 'art', status: 'error' })], 'slug');
  const oneTeam = usageSummaryText(bySlug, aggregateUsage([rec()], 'team'), 7);
  assert.ok(oneTeam.includes('last 7d'));
  assert.ok(oneTeam.includes('*caldora*'));
  assert.ok(oneTeam.includes('(1 errors)') || oneTeam.includes('1 errors')); // error count surfaces
  assert.ok(!oneTeam.includes('By workspace')); // single team → no team section
  const twoTeams = usageSummaryText(bySlug, aggregateUsage([rec(), rec({ key: 'T0AAAAAA:thread:1' })], 'team'), 7);
  assert.ok(twoTeams.includes('By workspace'));
  assert.equal(usageSummaryText([], [], 30), 'No agent turns recorded in the last 30d.');
});

test('UsageLog — appends month files, read() honors the window across months', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-usage-'));
  const logStore = new UsageLog(dir);
  const now = Date.parse('2026-07-12T12:00:00Z');
  logStore.record(rec({ at: '2026-07-12T10:00:00Z' })); // today → 2026-07.jsonl
  logStore.record(rec({ at: '2026-06-20T10:00:00Z', slug: 'june' })); // prev month file
  logStore.record(rec({ at: '2026-05-01T10:00:00Z', slug: 'ancient' }));

  const week = logStore.read(7 * 24 * 3600_000, now);
  assert.deepEqual(week.map((r) => r.slug), ['caldora']);
  const month = logStore.read(30 * 24 * 3600_000, now);
  assert.deepEqual(month.map((r) => r.slug).sort(), ['caldora', 'june']);
});

test('UsageLog — read on a missing dir is empty, not an error', () => {
  assert.deepEqual(new UsageLog(join(tmpdir(), 'aven-usage-nope')).read(1000), []);
});
