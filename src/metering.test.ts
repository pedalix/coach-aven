import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { teamOf, aggregateUsage, costOf, parseUsageLines, usageSummaryText, UsageLog, type UsageRecord } from './metering.js';

// A record as written since the per-turn cost fix: costUsd is the turn's own cost and
// costUsdCumulative the CLI's running total it was derived from. A record without the
// latter is pre-fix ("legacy") — see the legacy tests below.
const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: '2026-07-12T10:00:00Z',
  key: 'thread:1.2',
  slug: 'caldora',
  kind: 'turn',
  status: 'ok',
  elapsedMs: 120_000,
  usage: { inputTokens: 500_000, outputTokens: 20_000, cacheReadTokens: 400_000, costUsd: 1.25, costUsdCumulative: 1.25 },
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
      rec({ status: 'error', usage: { costUsd: 0.1, costUsdCumulative: 1.35, inputTokens: 1000, outputTokens: 50 } }),
      rec({ slug: 'bluefin-infra', usage: { costUsd: 9.99, costUsdCumulative: 9.99, inputTokens: 1, outputTokens: 1 } }),
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
      rec({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 100, cacheCreationTokens: 10, costUsd: 0, costUsdCumulative: 0 } }),
      rec({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 200, cacheCreationTokens: 20, costUsd: 0, costUsdCumulative: 0 } }),
      rec({ usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, costUsdCumulative: 0 } }), // older CLI shape, no cache fields
    ],
    'slug',
  );
  assert.equal(rows[0].cacheReadTokens, 300);
  assert.equal(rows[0].cacheCreationTokens, 30);
});

test('usageSummaryText — cache traffic is printed, first, and its share of all tokens is stated', () => {
  // A real caldora turn: cache reads were 98% of tokens and two thirds of the cost.
  const real = rec({
    usage: { inputTokens: 7_075, outputTokens: 17_534, cacheReadTokens: 1_849_796, cacheCreationTokens: 92_869, costUsd: 1.397, costUsdCumulative: 1.397 },
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

test('aggregateUsage — background turns add cost but not prompt turns', () => {
  const rows = aggregateUsage(
    [rec(), rec({ kind: 'background', usage: { costUsd: 0.75, costUsdCumulative: 2.0, outputTokens: 10 } })],
    'slug',
  );
  assert.equal(rows[0].turns, 1); // turns = prompts in; a self-started CLI turn isn't one
  assert.equal(rows[0].background, 1);
  assert.ok(Math.abs(rows[0].costUsd - 2.0) < 1e-9); // …but its money is in the total
  const text = usageSummaryText(rows, rows, 30);
  assert.ok(text.includes('Total: 1 turns + 1 background · ~$2.00'));
  assert.ok(text.includes('1 turns + 1 background ·'));
  // No background records → no suffix (the common case stays as it was).
  assert.ok(usageSummaryText(aggregateUsage([rec()], 'slug'), [], 30).includes('Total: 1 turns · '));
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

test('parseUsageLines — the routine stamp (routineId/routineLabel) round-trips; records without it still parse', () => {
  const stamped = { ...rec(), key: 'thread:1700000000.0001', routineId: 'r1', routineLabel: '📋 Morning brief' };
  const [a, b] = parseUsageLines(`${JSON.stringify(stamped)}\n${JSON.stringify(rec())}\n`);
  assert.equal(a!.routineId, 'r1');
  assert.equal(a!.routineLabel, '📋 Morning brief');
  assert.equal(b!.routineId, undefined);
});

test('costOf — a record without costUsdCumulative is pre-fix: its dollars are legacy, never per-turn', () => {
  assert.deepEqual(costOf(rec({ usage: { costUsd: 0.12, costUsdCumulative: 0.31 } })), { usd: 0.12, legacyUsd: 0 });
  assert.deepEqual(costOf(rec({ usage: { costUsd: 0.31 } })), { usd: 0, legacyUsd: 0.31 }); // the running total, recorded verbatim
  assert.deepEqual(costOf(rec({ usage: { costUsd: 0, costUsdCumulative: 0.31 } })), { usd: 0, legacyUsd: 0 }); // a canceled zero-token turn, post-fix
  assert.deepEqual(costOf(rec({ usage: { inputTokens: 5 } })), { usd: 0, legacyUsd: 0 }); // no cost on the wire at all
  assert.deepEqual(costOf(rec({ usage: undefined })), { usd: 0, legacyUsd: 0 });
});

test('aggregateUsage — pre-fix records are a separate legacy figure, never added to costUsd', () => {
  // One home-bot thread as it was recorded (running totals 0.19 → 0.31 → 0.334) followed by
  // the same thread as the fix records it (deltas, with the totals kept beside them).
  const rows = aggregateUsage(
    [
      rec({ usage: { costUsd: 0.19 } }),
      rec({ usage: { costUsd: 0.31 } }),
      rec({ usage: { costUsd: 0.334 } }),
      rec({ usage: { costUsd: 0.19, costUsdCumulative: 0.19 } }),
      rec({ usage: { costUsd: 0.12, costUsdCumulative: 0.31 } }),
      rec({ usage: { costUsd: 0.024, costUsdCumulative: 0.334 } }),
    ],
    'slug',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turns, 6); // turn counts were never wrong — every record is still a turn
  assert.ok(Math.abs(rows[0].costUsd - 0.334) < 1e-9); // the corrected thread costs what its last total says
  assert.ok(Math.abs(rows[0].legacyCostUsd - 0.834) < 1e-9); // the pre-fix sum, 2.5× that, kept apart
  assert.equal(rows[0].legacyTurns, 3);
});

test('usageSummaryText — legacy dollars get their own line and suffix; neither exists without legacy records', () => {
  const mixed = aggregateUsage(
    [rec({ usage: { costUsd: 0.5, costUsdCumulative: 0.5 } }), rec({ usage: { costUsd: 0.9 } }), rec({ slug: 'art', usage: { costUsd: 0.2, costUsdCumulative: 0.2 } })],
    'slug',
  );
  const text = usageSummaryText(mixed, aggregateUsage([rec()], 'team'), 7);
  assert.match(text, /^Total: 3 turns · ~\$0\.70 · /m); // per-turn dollars only
  assert.match(text, /^Legacy: ~\$0\.90 across 1 turns recorded before the per-turn cost fix — session running totals, overstated roughly 2×; not in the figures above$/m);
  assert.match(text, /• \*caldora\* — 2 turns · .* ~\$0\.50 \(\+ ~\$0\.90 legacy\) · /); // the row that has some
  assert.match(text, /• \*art\* — 1 turns · .* ~\$0\.20 · /); // the row that has none: unchanged
  assert.deepEqual(mixed.map((r) => r.group), ['caldora', 'art']); // legacy still ranks (1.40 > 0.20)
  // The layout operators know, byte for byte, once the window holds only per-turn records.
  const clean = usageSummaryText(aggregateUsage([rec()], 'slug'), aggregateUsage([rec()], 'team'), 7);
  assert.ok(!/legacy/i.test(clean));
  assert.ok(clean.includes('Total: 1 turns · ~$1.25 · '));
});

// The scheduler's stamp is optional on UsageRecord (another change declares it); the cut
// reads it structurally, so build stamped records through a cast here.
const routine = (routineId: string, routineLabel: string | undefined, over: Partial<UsageRecord> = {}): UsageRecord =>
  ({ ...rec(over), routineId, routineLabel }) as UsageRecord;

test('aggregateUsage — by routine keys on the stamp (label + id) and skips unstamped records', () => {
  const records = [
    routine('r1', 'Morning brief', { usage: { costUsd: 0.5, costUsdCumulative: 0.5 } }),
    routine('r1', 'Morning brief', { usage: { costUsd: 0.25, costUsdCumulative: 0.75 } }),
    routine('r2', 'Evening close', { usage: { costUsd: 0.1, costUsdCumulative: 0.1 } }),
    routine('r3', undefined, { usage: { costUsd: 0.1, costUsdCumulative: 0.1 } }), // no label → the id alone
    routine('r1', 'Morning brief (renamed)', { usage: { costUsd: 0.05, costUsdCumulative: 0.05 } }), // a rename is a new line, by design
    rec(), // a live turn: no stamp → not a routine row
  ];
  const rows = aggregateUsage(records, 'routine');
  assert.deepEqual(
    rows.map((r) => [r.group, r.turns]),
    [
      ['Morning brief (r1)', 2],
      ['Evening close (r2)', 1],
      ['r3', 1],
      ['Morning brief (renamed) (r1)', 1],
    ],
  );
  assert.ok(Math.abs(rows[0].costUsd - 0.75) < 1e-9);
  // The slug cut still counts every record — the routine cut is a view, not a partition.
  assert.equal(aggregateUsage(records, 'slug')[0].turns, 6);
});

test('usageSummaryText — the routine section appears only when there are routine rows', () => {
  const records = [routine('r1', 'Morning brief'), rec({ slug: 'art' })];
  const withRoutines = usageSummaryText(aggregateUsage(records, 'slug'), aggregateUsage(records, 'team'), 7, aggregateUsage(records, 'routine'));
  assert.match(withRoutines, /\n\*By routine\*\n• \*Morning brief \(r1\)\* — 1 turns · /);
  assert.ok(withRoutines.indexOf('*By project*') < withRoutines.indexOf('*By routine*')); // after the cuts operators know
  const live = [rec()];
  assert.ok(!usageSummaryText(aggregateUsage(live, 'slug'), aggregateUsage(live, 'team'), 7, aggregateUsage(live, 'routine')).includes('By routine'));
  assert.ok(!usageSummaryText(aggregateUsage(live, 'slug'), aggregateUsage(live, 'team'), 7).includes('By routine')); // the pre-existing call shape
});

// ── the credit that paid (OpenSpec api-key-credit D4) ──────────────────────────────────────────────

// A subscription installation's report, byte for byte as it read before records named their credit: old
// records (no `credit`), a new one stamped `subscription`, a legacy one, a usage-less canceled turn.
test('usageSummaryText — subscription records only: today\'s text, byte for byte, with or without `credit` on them', () => {
  const base = { at: '2026-07-12T10:00:00Z', key: 'thread:1.2', kind: 'turn' as const, status: 'ok' as const, elapsedMs: 120_000 };
  const records: UsageRecord[] = [
    { ...base, slug: 'caldora', usage: { inputTokens: 500_000, outputTokens: 20_000, cacheReadTokens: 400_000, costUsd: 1.25, costUsdCumulative: 1.25 } },
    { ...base, slug: 'caldora', kind: 'background', usage: { inputTokens: 1000, cacheReadTokens: 90_000, costUsd: 0.4, costUsdCumulative: 1.65, credit: 'subscription' } },
    { ...base, slug: 'art', status: 'error', usage: { costUsd: 0.9 } },
    { ...base, slug: 'art', key: 'T0AAAAAA:thread:1', status: 'canceled' },
  ];
  assert.equal(
    usageSummaryText(aggregateUsage(records, 'slug'), aggregateUsage(records, 'team'), 7),
    [
      '*Usage — last 7d*  (~$ = API-list-price equivalent computed by the CLI, not a bill — we run on a Max subscription)',
      'Total: 3 turns + 1 background · ~$1.65 · 1.0M tok, 48% of them cache reads · 0.1h agent-active time',
      'Legacy: ~$0.90 across 1 turns recorded before the per-turn cost fix — session running totals, overstated roughly 2×; not in the figures above',
      '',
      '*By project*',
      '• *caldora* — 1 turns + 1 background · 490k cache read / 0 cache write / 501k in / 20k out tok · ~$1.65 · 0.1h active',
      '• *art* — 2 turns (1 errors) · 0 cache read / 0 cache write / 0 in / 0 out tok · ~$0.00 (+ ~$0.90 legacy) · 0.1h active',
      '',
      '*By workspace*',
      '• *home* — 2 turns + 1 background (1 errors) · 490k cache read / 0 cache write / 501k in / 20k out tok · ~$1.65 (+ ~$0.90 legacy) · 0.1h active',
      '• *T0AAAAAA* — 1 turns · 0 cache read / 0 cache write / 0 in / 0 out tok · ~$0.00 · 0.0h active',
    ].join('\n'),
  );
});

test('usageSummaryText — API-key records only: the header says billed to the key at list prices, never "not a bill"', () => {
  const key = (over: Partial<UsageRecord> = {}) => rec({ usage: { inputTokens: 1000, costUsd: 0.8, costUsdCumulative: 0.8, credit: 'api-key' }, ...over });
  const records = [key(), key({ slug: 'art' })];
  const text = usageSummaryText(aggregateUsage(records, 'slug'), aggregateUsage(records, 'team'), 30);
  assert.equal(text.split('\n')[0], '*Usage — last 30d*  (~$ = billed to the API key at list prices, before discounts and tax — computed by the CLI)');
  assert.ok(!/not a bill|Max subscription/.test(text));
  assert.match(text, /^Total: 2 turns · ~\$1\.60 · /m);
  assert.ok(!/^API key:/m.test(text), 'no separate key line when the key is all there is');
  assert.match(text, /• \*caldora\* — 1 turns · .* ~\$0\.80 · /);
});

test('usageSummaryText — a mixed period (the month of a switch): subscription figures, the key\'s total on its own line, never one sum', () => {
  const records = [
    rec({ usage: { costUsd: 1.25, costUsdCumulative: 1.25 } }), // an old record: subscription
    rec({ usage: { costUsd: 0.5, costUsdCumulative: 0.5, credit: 'subscription' } }),
    rec({ usage: { costUsd: 2, costUsdCumulative: 2, credit: 'api-key' } }),
    rec({ slug: 'art', usage: { costUsd: 0.3, costUsdCumulative: 0.3, credit: 'api-key' } }),
  ];
  const rows = aggregateUsage(records, 'slug');
  assert.ok(Math.abs(rows[0].keyCostUsd - 2) < 1e-9);
  assert.equal(rows[0].keyTurns, 1);
  assert.equal(rows[0].subscriptionTurns, 2);
  const text = usageSummaryText(rows, aggregateUsage(records, 'team'), 30);
  assert.match(text.split('\n')[0], /subscription turns: API-list-price equivalent .* not a bill; API-key turns are on their own line/);
  assert.match(text, /^Total: 4 turns · ~\$1\.75 · /m); // turns are summed as before; dollars are the subscription's
  assert.match(text, /^API key: ~\$2\.30 billed at list prices \(before discounts and tax\) across 2 turns — not in the \$ figures above$/m);
  // Each line: the subscription's dollars, the key's beside them when it has any — a key-only project is not ~$0.00 alone.
  assert.match(text, /• \*caldora\* — 3 turns · .* ~\$1\.75 \(\+ ~\$2\.00 API key\) · /);
  assert.match(text, /• \*art\* — 1 turns · .* ~\$0\.00 \(\+ ~\$0\.30 API key\) · /);
  // The workspace and routine cuts carry the same suffix.
  const cut = [...records, routine('r1', 'Brief', { key: 'T0AAAAAA:thread:1', usage: { costUsd: 0.4, costUsdCumulative: 0.4, credit: 'api-key' } })];
  const cutText = usageSummaryText(aggregateUsage(cut, 'slug'), aggregateUsage(cut, 'team'), 30, aggregateUsage(cut, 'routine'));
  assert.match(cutText, /• \*home\* — 4 turns · .* ~\$1\.75 \(\+ ~\$2\.30 API key\) · /);
  assert.match(cutText, /• \*T0AAAAAA\* — 1 turns · .* ~\$0\.00 \(\+ ~\$0\.40 API key\) · /);
  assert.match(cutText, /• \*Brief \(r1\)\* — 1 turns · .* ~\$0\.00 \(\+ ~\$0\.40 API key\) · /);
  assert.ok(!text.includes('4.05'), 'never the sum of both');
});
