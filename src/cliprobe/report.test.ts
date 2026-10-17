import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { catalogue, changedSince, failing, groupFindings, mergeScenarios, recordingText, renderReport, sha256, type ReportJson, type ReportScenario } from './report.js';
import type { RecordLine, RunOutcome } from './types.js';

const GOLDEN = new URL('../fixtures/cliprobe/report.golden.md', import.meta.url).pathname;

const run = (verdict: RunOutcome['verdict'], costUsd: number, observations: Record<string, unknown> = {}, reason?: string): RunOutcome => ({ verdict, costUsd, observations, durationMs: 1000, ...(reason ? { reason } : {}) });
const row = (id: string, verdict: ReportScenario['verdict'], runs: RunOutcome[], o: Partial<ReportScenario> = {}): ReportScenario => ({
  id,
  contract: true,
  hypothesis: `${id} hypothesis`,
  model: 'claude-haiku-5-5',
  verdict,
  holds: runs.filter((r) => r.verdict === 'holds').length,
  fails: runs.filter((r) => r.verdict === 'fails').length,
  inconclusive: runs.filter((r) => r.verdict === 'inconclusive').length,
  costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
  runs,
  recording: { file: `${id}.jsonl`, sha256: 'x' },
  ...o,
});

const rec1: RecordLine[] = [
  { t: 0, proc: 'start', argv: ['claude'] },
  { t: 5, dir: 'out', frame: { type: 'system', subtype: 'init', session_id: 's', cwd: '/probe/work' } },
  { t: 9, dir: 'out', frame: { type: 'result', subtype: 'success', result: 'ok', session_id: 's' } },
];
const rec2: RecordLine[] = [
  { t: 5, dir: 'out', frame: { type: 'system', subtype: 'init', session_id: 's', cwd: '/probe/work', capabilities: [] } },
  { t: 7, dir: 'out', frame: { type: 'system', subtype: 'background_tasks_changed', tasks: [] } },
  { t: 9, dir: 'out', frame: { type: 'result', subtype: 'success', result: 'ok', session_id: 's' } },
];

const before: ReportJson = {
  cli: '2.1.260',
  sdk: { release: '0.3.260', claudeCodeVersion: '2.1.260', exact: true, anthropicSdk: '0.95.0' },
  transport: 'local',
  date: '2026-09-01',
  models: ['claude-haiku-5-5'],
  totalCostUsd: 0.05,
  scenarios: [row('turn', 'holds', [run('holds', 0.02)]), row('interrupt', 'holds', [run('holds', 0.01), run('holds', 0.01), run('holds', 0.01)])],
  catalogue: catalogue([rec1]),
  findings: [],
};
const now: ReportJson = {
  ...before,
  cli: '2.1.282',
  sdk: { release: '0.3.281', claudeCodeVersion: '2.1.281', exact: false, anthropicSdk: '0.96.0' },
  date: '2026-10-17',
  models: ['claude-haiku-5-5', 'claude-opus-5-5'],
  totalCostUsd: 0.23,
  scenarios: [
    row('turn', 'holds', [run('holds', 0.02, { results: 1 })]),
    row('interrupt', 'flaky', [run('holds', 0.01), run('fails', 0.01, {}, 'a result within 10 s — not within 10000 ms')]),
    row('chain-priority', 'holds', [run('holds', 0.18, { answeredIn: 'result#1' })], { variant: 'next', contract: false, model: 'claude-opus-5-5' }),
  ],
  catalogue: catalogue([rec2]),
  findings: groupFindings([
    { dir: 'out', file: 'turn.jsonl', line: 2, kind: 'undeclared-field', frameKind: 'system/init', path: '$.capabilities', detail: 'not declared', origin: 'protocol' },
    { dir: 'out', file: 'turn.jsonl', line: 3, kind: 'violation', frameKind: 'result/success', path: '$.usage', detail: 'required, missing', origin: 'protocol' },
    { dir: 'out', file: 'turn.jsonl', line: 3, kind: 'violation', frameKind: 'assistant', path: '$.message.usage.server_tool_use', detail: 'required, missing', origin: 'api' },
    { dir: 'out', file: 'turn.jsonl', line: 6, kind: 'violation', frameKind: 'assistant', path: '$.message.usage.server_tool_use', detail: 'required, missing', origin: 'api' },
    { dir: 'in', file: 'turn.jsonl', line: 4, kind: 'violation', frameKind: 'user', path: '$.parent_tool_use_id', detail: 'required, missing', origin: 'protocol' },
    { dir: 'out', file: 'turn.jsonl', line: 5, kind: 'undeclared-kind', frameKind: 'system/telemetry', path: '$', detail: 'no declared kind', origin: 'protocol' },
  ]),
};

test('changedSince — a pin bump shows what changed: verdicts, new kinds and fields', () => {
  const c = changedSince(now, before);
  assert.deepEqual(c.verdicts, [
    { row: 'chain-priority[next]', was: '—', now: 'holds' },
    { row: 'interrupt', was: 'holds', now: 'flaky' },
  ]);
  assert.deepEqual(c.kindsAdded, ['system/background_tasks_changed']);
  assert.deepEqual(c.fieldsAdded, [{ kind: 'system/init', fields: ['capabilities'] }]);
});

test('renderReport — REPORT.md (golden): header with cost, changed-since, scenarios with per-row cost, catalogue, findings by direction', () => {
  const md = renderReport(now, before);
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, md);
  assert.equal(md, readFileSync(GOLDEN, 'utf8'));
  assert.ok(md.includes('- **Cost:** $0.23 API-equivalent'));
  assert.ok(md.includes('## Changed since 2.1.260'));
  assert.ok(md.includes('  - `assistant` at `$.message.usage.server_tool_use`: required, missing (2×)'), 'API model mismatches are grouped and listed');
});

test('failing — only protocol violations in frames the CLI wrote fail the check', () => {
  assert.deepEqual(failing(now.findings).map((f) => `${f.dir} ${f.path} ${f.count}`), ['out $.usage 1']);
  const api = now.findings.find((g) => g.origin === 'api')!;
  assert.deepEqual([api.count, api.first], [2, { file: 'turn.jsonl', line: 3 }], 'repeated findings are one group with a count and the first place');
});

test('mergeScenarios — a partial run replaces its rows only; recordings hash as committed text', () => {
  const merged = mergeScenarios(before.scenarios, [row('turn', 'fails', [run('fails', 0.03)])]);
  assert.deepEqual(merged.map((s) => `${s.id}:${s.verdict}`), ['interrupt:holds', 'turn:fails']);
  assert.equal(recordingText(rec1).split('\n').length, 4);
  assert.equal(sha256(recordingText(rec1)), sha256(recordingText(rec1)));
});
