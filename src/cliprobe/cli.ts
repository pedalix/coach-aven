#!/usr/bin/env -S npx tsx
// The CLI probe — `npm run cli-probe -- <cmd>` (OpenSpec `cli-probe`, docs/cli-probe.md).
//
//   run [scenario | scenario[variant] …] --cli <x.y.z> [--bin <path>] [--transport local|sandbox]
//       [--runs N] [--model <id>] [--out <dir>]
//         → runs the scenarios (all by default) live, writes the normalized recordings, report.json and
//           REPORT.md into src/fixtures/cli/<version>/ (or --out), merging into an existing report
//   check [version …]   → re-checks committed recordings against the declarations their reports name;
//                         exits 1 on a protocol violation in a frame the CLI wrote (CI runs this)
//   report <version>    → recomputes the catalogue and findings from the committed recordings and
//                         renders REPORT.md again
//   list                → the scenarios, contract first
//
// Environment: CLI_PROBE_TOKEN (a subscription token) or CLI_PROBE_API_KEY (an API key) — a live run's credit,
// exactly one, and nothing else is read for one; a scenario that needs a key is skipped on a token run;
// CLI_PROBE_CACHE (default ~/.cache/coach-aven/cli-probe) for CLI installs and fetched declarations;
// --transport sandbox reads the driver's settings from the probe's own environment (sandbox.ts).
// A live run costs model usage (reported per scenario); CI never runs one.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, isValidCliVersion, PROBED_CLI_VERSIONS } from '../cliversion.js';
import { ensureCli, probeCacheRoot, probeCredit } from './install.js';
import { localTransport } from './local.js';
import { catalogue, costTotals, failing, groupFindings, mergeScenarios, recordingText, renderReport, sha256, type FindingGroup, type ReportJson, type ReportScenario } from './report.js';
import { runScenario } from './runner.js';
import { driverFromEnv, PROBE_MANAGED_BY, sandboxTransport } from './sandbox.js';
import { SCENARIOS } from './scenarios/index.js';
import { API_SDK_PACKAGE, SDK_PACKAGE, chooseSdkRelease, ensureDeclarations, fetchPackument, publishedAt, releaseAt } from './sdk.js';
import { checkRecordings, loadChecker } from './typecheck.js';
import { recordingFile, rowId, runsOn, type RecordLine } from './types.js';

class UsageError extends Error {}

const REPO = resolve(new URL('../..', import.meta.url).pathname);
export const fixturesDir = (version: string): string => join(REPO, 'src', 'fixtures', 'cli', version);

function readReport(dir: string): ReportJson | undefined {
  const p = join(dir, 'report.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ReportJson) : undefined;
}

export function readRecordings(dir: string): { file: string; lines: RecordLine[] }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((file) => ({
      file,
      lines: readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RecordLine),
    }));
}

/** The newest probed version (other than `version`) whose report is committed. */
function previousReport(version: string): ReportJson | undefined {
  const others = PROBED_CLI_VERSIONS.filter((v) => v !== version).sort(compareVersions).reverse();
  for (const v of others) {
    const r = readReport(fixturesDir(v));
    if (r) return r;
  }
  return undefined;
}

async function resolveSdk(cli: string, existing?: ReportJson['sdk']): Promise<NonNullable<ReportJson['sdk']>> {
  if (existing) return existing;
  const agent = await fetchPackument(SDK_PACKAGE);
  const choice = chooseSdkRelease(cli, agent);
  const api = releaseAt(await fetchPackument(API_SDK_PACKAGE), publishedAt(agent, choice.release));
  return { release: choice.release, claudeCodeVersion: choice.claudeCodeVersion, exact: choice.exact, anthropicSdk: api };
}

async function findingsFor(sdk: NonNullable<ReportJson['sdk']>, recordings: { file: string; lines: RecordLine[] }[]): Promise<FindingGroup[]> {
  const { sdkDts } = await ensureDeclarations({ release: sdk.release, apiSdk: sdk.anthropicSdk, cacheRoot: probeCacheRoot() });
  const checker = loadChecker({ sdkDts, typeRoots: [join(REPO, 'node_modules', '@types')] });
  return groupFindings(checkRecordings(checker, recordings));
}

function writeReport(dir: string, report: ReportJson): void {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
  writeFileSync(join(dir, 'REPORT.md'), renderReport(report, previousReport(report.cli)));
}

type Pick = { s: (typeof SCENARIOS)[number]; variant?: string };
function select(names: string[]): Pick[] {
  const all: Pick[] = SCENARIOS.flatMap((s): Pick[] => (s.meta.variants?.length ? s.meta.variants.map((variant) => ({ s, variant })) : [{ s }]));
  if (!names.length) return all;
  return names.flatMap((n) => {
    const m = /^([\w-]+)(?:\[([\w-]+)\])?$/.exec(n);
    const hit = m ? all.filter((x) => x.s.meta.id === m[1] && (!m[2] || x.variant === m[2])) : [];
    if (!hit.length) throw new UsageError(`no scenario "${n}" (npm run cli-probe -- list)`);
    return hit;
  });
}

async function run(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cli: { type: 'string' }, bin: { type: 'string' }, transport: { type: 'string', default: 'local' }, runs: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' } },
  });
  const cli = values.cli ?? '';
  if (!isValidCliVersion(cli)) throw new UsageError('--cli <x.y.z> is required');
  if (values.transport !== 'local' && values.transport !== 'sandbox') throw new UsageError('--transport must be local or sandbox');
  const credit = probeCredit();
  const token = credit.value;
  // A scenario that needs another credit (an API key, on a token run) is dropped here, before any transport is
  // built: no sandbox for it, and the merge below keeps its earlier row and recording as they are.
  const picked = select(positionals).filter(({ s, variant }) => {
    if (runsOn(s.meta, credit.kind)) return true;
    console.log(`-- ${rowId(s.meta.id, variant)}: skipped (needs ${s.meta.needs === 'api-key' ? 'an API key: CLI_PROBE_API_KEY' : 'a subscription token: CLI_PROBE_TOKEN'})`);
    return false;
  });
  // Only key scenarios picked on a token run: stop here — no CLI install, no declarations fetched, no report rewritten.
  if (!picked.length) {
    console.log('nothing to run: every selected scenario needs another credit');
    return;
  }
  const cacheRoot = probeCacheRoot();
  const bin = values.bin ?? (await ensureCli(cli, { cacheRoot }));
  let label = 'local';
  let factory: Parameters<typeof runScenario>[2]['transport'];
  if (values.transport === 'sandbox') {
    process.env.SANDBOX_MANAGED_BY = PROBE_MANAGED_BY; // the label the ssh-docker driver gives (and lists) — never the bot's
    const d = driverFromEnv(process.env);
    label = d.label;
    factory = (dirs) => sandboxTransport({ driver: d.driver, runId: dirs.runId, version: cli, token, log: (l) => console.log(`        ${l}`) });
  } else {
    factory = async (dirs) => localTransport({ bin, workDir: dirs.workDir, configDir: dirs.configDir, token, credit: credit.kind, log: (l) => console.log(`        ${l}`) });
  }
  const outDir = values.out ? resolve(values.out) : fixturesDir(cli);
  mkdirSync(outDir, { recursive: true });
  const rows: ReportScenario[] = [];
  for (const { s, variant } of picked) {
    const r = await runScenario(s, variant, {
      version: cli,
      transport: factory,
      home: homedir(),
      cache: cacheRoot,
      modelOverride: values.model,
      runsOverride: values.runs ? Number(values.runs) : undefined,
      credit: credit.kind,
      log: (l) => console.log(l),
    });
    const text = recordingText(r.recording);
    const file = recordingFile(r.id, r.variant);
    writeFileSync(join(outDir, file), text);
    const { recording: _rec, ...rest } = r;
    rows.push({ ...rest, recording: { file, sha256: sha256(text) }, transport: label, ...(credit.kind === 'api-key' ? { credit: 'api-key' as const } : {}) });
    console.log(`== ${rowId(r.id, r.variant)}: ${r.verdict} (${r.holds}/${r.fails}/${r.inconclusive}) $${r.costUsd.toFixed(3)}`);
  }
  const existing = readReport(outDir);
  const scenarios = mergeScenarios(existing?.cli === cli ? existing.scenarios : [], rows);
  const recordings = readRecordings(outDir);
  const sdk = await resolveSdk(cli, existing?.cli === cli ? existing.sdk : undefined);
  const findings = await findingsFor(sdk, recordings);
  const report: ReportJson = {
    cli,
    sdk,
    transport: [...new Set(scenarios.map((s) => s.transport ?? 'local'))].join(', '),
    date: new Date().toISOString().slice(0, 10),
    models: [...new Set(scenarios.map((s) => s.model))].sort(),
    ...costTotals(scenarios),
    scenarios,
    catalogue: catalogue(recordings.map((r) => r.lines)),
    findings,
  };
  writeReport(outDir, report);
  const fails = failing(findings);
  console.log(`\nreport: ${join(outDir, 'REPORT.md')}`);
  const spent = `$${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(3)} ${credit.kind === 'api-key' ? 'billed to the API key at list prices' : 'API-equivalent'}`;
  console.log(`this run: ${spent}; protocol violations: ${fails.length}`);
}

async function check(argv: string[]): Promise<number> {
  const root = join(REPO, 'src', 'fixtures', 'cli');
  const versions = argv.length ? argv : existsSync(root) ? readdirSync(root).filter(isValidCliVersion).sort(compareVersions) : [];
  let bad = 0;
  for (const v of versions) {
    const dir = fixturesDir(v);
    const report = readReport(dir);
    if (!report?.sdk) {
      console.log(`${v}: no report.json with declarations — FAIL`);
      bad++;
      continue;
    }
    const findings = await findingsFor(report.sdk, readRecordings(dir));
    const fails = failing(findings);
    console.log(`${v}: ${findings.length} finding groups against ${SDK_PACKAGE} ${report.sdk.release} / ${API_SDK_PACKAGE} ${report.sdk.anthropicSdk}; protocol violations: ${fails.length}`);
    for (const f of fails) console.log(`  ${f.first.file}:${f.first.line} (${f.count}×) ${f.frameKind} ${f.path}: ${f.detail}`);
    if (JSON.stringify(findings) !== JSON.stringify(report.findings)) console.log(`  note: the findings differ from report.json — npm run cli-probe -- run (or report) refreshes them`);
    if (fails.length) bad++;
  }
  return bad ? 1 : 0;
}

// The derived parts (catalogue, findings) recomputed from the committed recordings; REPORT.md rendered again.
async function report(argv: string[]): Promise<void> {
  const v = argv[0] ?? '';
  const dir = fixturesDir(v);
  const r = readReport(dir);
  if (!r) throw new UsageError(`no report for ${JSON.stringify(v)} under src/fixtures/cli/`);
  const recordings = readRecordings(dir);
  const sdk = await resolveSdk(v, r.sdk);
  writeReport(dir, { ...r, sdk, catalogue: catalogue(recordings.map((x) => x.lines)), findings: await findingsFor(sdk, recordings) });
  console.log(join(dir, 'REPORT.md'));
}

function list(): void {
  for (const s of [...SCENARIOS].sort((a, b) => Number(b.meta.contract) - Number(a.meta.contract))) {
    const v = s.meta.variants?.length ? ` [${s.meta.variants.join('|')}]` : '';
    console.log(`${s.meta.contract ? 'contract   ' : 'exploratory'} ${s.meta.id}${v}  runs=${s.meta.runs} model=${s.meta.model ?? 'haiku'}\n            ${s.meta.hypothesis}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'run') await run(rest);
    else if (cmd === 'check') return await check(rest);
    else if (cmd === 'report') await report(rest);
    else if (cmd === 'list') list();
    else throw new UsageError('usage: npm run cli-probe -- run|check|report|list (see src/cliprobe/cli.ts)');
    return 0;
  } catch (e) {
    // Our own checks (token, version, transport) read best as one line; CLI_PROBE_DEBUG=1 shows the stack.
    console.error(e instanceof Error ? (process.env.CLI_PROBE_DEBUG === '1' ? (e.stack ?? e.message) : e.message) : String(e));
    return e instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
