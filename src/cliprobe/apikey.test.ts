// The probe on an API key (OpenSpec api-key-credit D6): the credit kind reaches the command line, a scenario
// that needs a key is skipped on a token run and keeps its earlier row, the report splits cost per credit,
// and `api-key-turn` judged over a hand-built recording (no live run: task 4.6 records the real one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeLaunch } from '../claudeSession.js';
import { main } from './cli.js';
import type { ProcessHandlers, Transport } from './ctx.js';
import { costTotals, mergeScenarios, renderReport, type ReportJson, type ReportScenario } from './report.js';
import { runScenario, type RunDirs } from './runner.js';
import { SCENARIOS } from './scenarios/index.js';
import { KEY_PROBE_COMMAND } from './scenarios/candidates.js';
import { runsOn, type Frame } from './types.js';

const SESSION = '3f2b9c1e-8d4a-4b6f-9e21-7c5d0a1b2c3d';

// A fake CLI that answers the first user message with `frames` (a hand-built recording of a key turn).
function replay(frames: (d: RunDirs) => Frame[]) {
  const launches: ClaudeLaunch[] = [];
  const factory = async (d: RunDirs): Promise<Transport> => ({
    kind: 'sandbox',
    workDir: d.workDir,
    async seed() {},
    async start(l: ClaudeLaunch, h: ProcessHandlers) {
      launches.push(l);
      let alive = true;
      return {
        write: async (line: string) => {
          if ((JSON.parse(line) as Frame).type !== 'user') return;
          for (const f of frames(d)) setImmediate(() => alive && h.onLine(JSON.stringify(f)));
        },
        end: () => void ((alive = false), setImmediate(() => h.onExit(0, null))),
        kill: (sig?: string) => void ((alive = false), setImmediate(() => h.onExit(null, sig ?? 'SIGKILL'))),
      };
    },
    async dispose() {},
  });
  return { factory, launches };
}

const keyTurn = (apiKeySource: unknown, toolOut: string) => (d: RunDirs): Frame[] => [
  { type: 'system', subtype: 'init', session_id: SESSION, claude_code_version: '2.1.292', cwd: d.workDir, ...(apiKeySource === undefined ? {} : { apiKeySource }) },
  { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: KEY_PROBE_COMMAND } }] } },
  { type: 'user', session_id: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: toolOut }] } },
  { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: toolOut }] } },
  { type: 'result', subtype: 'success', result: toolOut, is_error: false, session_id: SESSION, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 900 },
];
const apiKeyTurn = SCENARIOS.find((s) => s.meta.id === 'api-key-turn')!;
const opts = (factory: (d: RunDirs) => Promise<Transport>, credit?: 'api-key' | 'subscription') => ({ version: '2.1.292', transport: factory, home: '/home/owen', cache: '/home/owen/.cache/cli-probe', ...(credit ? { credit } : {}) });

test('api-key-turn — a key run that reports ANTHROPIC_API_KEY holds and records apiKeySource, the cost, rate-limit events and what the tool saw', async () => {
  const { factory, launches } = replay(keyTurn('ANTHROPIC_API_KEY', 'KEY-SEEN'));
  const r = await runScenario(apiKeyTurn, undefined, opts(factory, 'api-key'));
  assert.equal(r.verdict, 'holds', JSON.stringify(r.runs));
  assert.deepEqual(r.runs[0]!.observations, { apiKeySource: 'ANTHROPIC_API_KEY', costUsd: 0.0123, rateLimitEvents: [], toolSawKey: true });
  // The sandbox command a key run starts reads the credit file into ANTHROPIC_API_KEY, and sets no token.
  const cmd = launches[0]!.command('/root/probe-work');
  assert.match(cmd, / ANTHROPIC_API_KEY=\$\(cat \/root\/\.cc-token\) /);
  assert.ok(!cmd.includes('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('api-key-turn — "none" fails the prediction; a tool that did not see the key is recorded, not failed', async () => {
  const none = await runScenario(apiKeyTurn, undefined, opts(replay(keyTurn('none', 'KEY-ABSENT')).factory, 'api-key'));
  assert.equal(none.verdict, 'fails');
  assert.match(none.runs[0]!.reason ?? '', /apiKeySource "ANTHROPIC_API_KEY" \(got "none"\)/);
  const missing = await runScenario(apiKeyTurn, undefined, opts(replay(keyTurn(undefined, 'KEY-ABSENT')).factory, 'api-key'));
  assert.match(missing.runs[0]!.reason ?? '', /\(got null\)/);
});

test('a token run: the command line is today\'s (the subscription prefix), with or without the kind', async () => {
  const s = SCENARIOS.find((x) => x.meta.id === 'turn')!;
  const a = replay(keyTurn('none', 'x'));
  await runScenario({ ...s, run: async (ctx) => void (await ctx.send('hi')) }, undefined, opts(a.factory, 'subscription'));
  const b = replay(keyTurn('none', 'x'));
  await runScenario({ ...s, run: async (ctx) => void (await ctx.send('hi')) }, undefined, opts(b.factory));
  assert.equal(a.launches[0]!.command('/w'), b.launches[0]!.command('/w'));
  assert.match(a.launches[0]!.command('/w'), / CLAUDE_CODE_OAUTH_TOKEN=\$\(cat \/root\/\.cc-token\) /);
});

test('selection — a token run drops the key scenario before any transport; a key run takes every scenario', () => {
  const onToken = SCENARIOS.filter((s) => runsOn(s.meta, 'subscription')).map((s) => s.meta.id);
  assert.ok(!onToken.includes('api-key-turn'));
  assert.equal(onToken.length, SCENARIOS.length - 1);
  assert.equal(SCENARIOS.filter((s) => runsOn(s.meta, 'api-key')).length, SCENARIOS.length);
});

const row = (id: string, costUsd: number, o: Partial<ReportScenario> = {}): ReportScenario => ({
  id,
  contract: false,
  hypothesis: `${id} hypothesis`,
  model: 'claude-haiku-5-5',
  verdict: 'holds',
  holds: 1,
  fails: 0,
  inconclusive: 0,
  costUsd,
  runs: [{ verdict: 'holds', costUsd, observations: {}, durationMs: 1000 }],
  recording: { file: `${id}.jsonl`, sha256: 'x' },
  ...o,
});

test('merge — a later token run keeps the key scenario\'s row (and so its recording) as it was', () => {
  const keyRow = row('api-key-turn', 0.01, { credit: 'api-key', recording: { file: 'api-key-turn.jsonl', sha256: 'k' } });
  const merged = mergeScenarios([keyRow, row('turn', 0.02)], [row('turn', 0.03)]);
  assert.deepEqual(merged.find((s) => s.id === 'api-key-turn'), keyRow);
  assert.equal(merged.find((s) => s.id === 'turn')!.costUsd, 0.03);
});

test('report — rows carry their credit; the header lists the credits and the cost is split, never one sum', () => {
  const scenarios = [row('api-key-turn', 0.05, { credit: 'api-key' }), row('turn', 0.02), row('interrupt', 0.03)];
  assert.deepEqual(costTotals(scenarios), { totalCostUsd: 0.05, apiKeyCostUsd: 0.05 });
  assert.deepEqual(costTotals([row('turn', 0.02)]), { totalCostUsd: 0.02 }, 'no key row: no key total, the field as it always was');
  const r: ReportJson = { cli: '2.1.292', transport: 'sandbox (ssh-docker)', date: '2026-10-30', models: ['claude-haiku-5-5'], ...costTotals(scenarios), scenarios, catalogue: {}, findings: [] };
  const md = renderReport(r);
  assert.match(md, /^- \*\*Credit:\*\* subscription token, API key$/m);
  assert.match(md, /^- \*\*Cost:\*\* \$0\.05 API-equivalent \(subscription token\) · \$0\.05 billed at list prices \(API key\)$/m);
  assert.ok(!md.includes('$0.10'), 'never the sum');
  assert.match(md, /^\| api-key-turn \| .* \| \$0\.05 \(API key\) \|$/m);
  assert.match(md, /^\| turn \| .* \| \$0\.02 \|$/m);
  const keyOnly = renderReport({ ...r, ...costTotals([scenarios[0]!]), scenarios: [scenarios[0]!] });
  assert.match(keyOnly, /^- \*\*Credit:\*\* API key$/m);
  assert.match(keyOnly, /^- \*\*Cost:\*\* \$0\.05 billed at list prices \(API key\)$/m);
});

test('cli run — a token run that selected only key scenarios stops before installing a CLI, fetching declarations or rewriting a report', async (t) => {
  const cache = mkdtempSync(join(tmpdir(), 'cliprobe-nothing-'));
  const out = mkdtempSync(join(tmpdir(), 'cliprobe-nothing-out-'));
  const saved = { token: process.env.CLI_PROBE_TOKEN, key: process.env.CLI_PROBE_API_KEY, cache: process.env.CLI_PROBE_CACHE };
  process.env.CLI_PROBE_TOKEN = 'sk-ant-oat01-test';
  delete process.env.CLI_PROBE_API_KEY;
  process.env.CLI_PROBE_CACHE = cache;
  const lines: string[] = [];
  t.mock.method(console, 'log', (m: unknown) => void lines.push(String(m)));
  const fetched = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no network in this test');
  });
  try {
    assert.equal(await main(['run', 'api-key-turn', '--cli', '2.1.292', '--out', out]), 0);
    assert.ok(lines.some((l) => l.startsWith('-- api-key-turn: skipped')));
    assert.ok(lines.includes('nothing to run: every selected scenario needs another credit'));
    assert.deepEqual(readdirSync(cache), [], 'no CLI installed');
    assert.deepEqual(readdirSync(out), [], 'no report written');
    assert.equal(fetched.mock.callCount(), 0, 'no declarations fetched');
  } finally {
    for (const [k, v] of [['CLI_PROBE_TOKEN', saved.token], ['CLI_PROBE_API_KEY', saved.key], ['CLI_PROBE_CACHE', saved.cache]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
