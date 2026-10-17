// The gate over the committed state (OpenSpec `cli-probe`, design D8), and the rules on synthetic input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PROBED_CLI_VERSIONS } from '../cliversion.js';
import { gateProblems, type GateInput } from './gate.js';
import { sha256, type ReportJson, type ReportScenario } from './report.js';
import { contractIds } from './scenarios/index.js';

const REPO = new URL('../../', import.meta.url).pathname;
const read = (rel: string): string | undefined => (existsSync(REPO + rel) ? readFileSync(REPO + rel, 'utf8') : undefined);

function committed(): GateInput {
  const reports: GateInput['reports'] = {};
  const hashes: GateInput['hashes'] = {};
  for (const v of PROBED_CLI_VERSIONS) {
    const text = read(`src/fixtures/cli/${v}/report.json`);
    const r = text ? (JSON.parse(text) as ReportJson) : undefined;
    reports[v] = r;
    hashes[v] = Object.fromEntries((r?.scenarios ?? []).map((s) => {
      const t = read(`src/fixtures/cli/${v}/${s.recording.file}`);
      return [s.recording.file, t === undefined ? undefined : sha256(t)];
    }));
  }
  const argOf = (rel: string): string | undefined => read(rel)?.match(/^ARG CLAUDE_CLI_VERSION=(\S+)$/m)?.[1];
  return {
    probed: PROBED_CLI_VERSIONS,
    reports,
    hashes,
    contractIds: contractIds(),
    pins: [
      { source: 'snapshot/Dockerfile', version: argOf('snapshot/Dockerfile') },
      { source: 'snapshot/plain/Dockerfile', version: argOf('snapshot/plain/Dockerfile') },
      { source: '.env.example', version: read('.env.example')?.match(/^CLAUDE_CLI_VERSION=(\S+)$/m)?.[1] },
    ],
  };
}

test('gate — the committed state: every probed version has a holding contract, intact recordings, and the repo pins only probed versions', () => {
  assert.deepEqual(gateProblems(committed()), []);
});

// Synthetic: one probed version with two contract scenarios.
const row = (id: string, verdict: ReportScenario['verdict'], file = `${id}.jsonl`): ReportScenario => ({
  id,
  contract: true,
  hypothesis: 'h',
  model: 'claude-haiku-5-5',
  verdict,
  holds: verdict === 'holds' ? 1 : 0,
  fails: verdict === 'fails' ? 1 : 0,
  inconclusive: 0,
  costUsd: 0,
  runs: [],
  recording: { file, sha256: sha256(`${id}\n`) },
});
const report = (cli: string, scenarios: ReportScenario[]): ReportJson => ({ cli, transport: 'local', date: '2026-10-17', models: [], totalCostUsd: 0, scenarios, catalogue: {}, findings: [] });
const base = (): GateInput => ({
  probed: ['2.1.282'],
  reports: { '2.1.282': report('2.1.282', [row('turn', 'holds'), row('resume', 'holds')]) },
  hashes: { '2.1.282': { 'turn.jsonl': sha256('turn\n'), 'resume.jsonl': sha256('resume\n') } },
  contractIds: ['turn', 'resume'],
  pins: [{ source: 'snapshot/Dockerfile', version: '2.1.282' }],
});

test('gate — a pin bump without a report fails', () => {
  assert.deepEqual(gateProblems(base()), []);
  const g = base();
  g.pins = [{ source: 'snapshot/Dockerfile', version: '2.1.302' }];
  assert.deepEqual(gateProblems(g), ['snapshot/Dockerfile pins Claude Code 2.1.302, which is not a probed version (2.1.282)']);
  const h = base();
  h.probed = ['2.1.282', '2.1.302'];
  assert.deepEqual(gateProblems(h), ['2.1.302: no committed report (src/fixtures/cli/2.1.302/report.json)']);
});

test('gate — a contract scenario that fails on a version keeps it out of the set', () => {
  const g = base();
  g.reports['2.1.282'] = report('2.1.282', [row('turn', 'holds'), row('resume', 'fails')]);
  assert.deepEqual(gateProblems(g), ['2.1.282: contract scenario resume does not hold (fails)']);
  const h = base();
  h.contractIds = ['turn', 'resume', 'interrupt'];
  assert.deepEqual(gateProblems(h), ['2.1.282: contract scenario interrupt has no verdict — probe the version again']);
});

test('gate — a recording edited after its report fails', () => {
  const g = base();
  g.hashes['2.1.282']!['turn.jsonl'] = sha256('turn, edited\n');
  delete g.hashes['2.1.282']!['resume.jsonl'];
  assert.deepEqual(gateProblems(g), ['2.1.282: turn.jsonl changed after its report (hash mismatch)', '2.1.282: resume.jsonl is missing']);
});
