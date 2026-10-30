// The report of one probed CLI version (design D4): report.json (machine) and REPORT.md (people).
// REPORT.md is what a pin bump is reviewed by — a new version's report is a new file, so a diff alone
// shows nothing; its "Changed since" section compares it with the newest version already probed.
import { createHash } from 'node:crypto';
import type { CreditKind } from '../credit.js';
import type { RecordLine, RunOutcome, Verdict } from './types.js';
import { rowId } from './types.js';

export type FindingKind = 'violation' | 'undeclared-field' | 'undeclared-kind';
export interface Finding {
  dir: 'out' | 'in';
  /** The recording file and the 1-based line of the frame. */
  file: string;
  line: number;
  kind: FindingKind;
  /** `type[/subtype]` of the frame. */
  frameKind: string;
  /** JSON path inside the frame (`$` for the frame itself). */
  path: string;
  detail: string;
  /** `protocol`: the agent SDK's own declarations; `api`: the API message model they import (listed, never failed). */
  origin: 'protocol' | 'api';
}

/**
 * Findings as the report keeps them: one per (direction, origin, kind, frame kind, path with array
 * indices folded, detail), with how often and where first — the same gap repeats in every recording.
 */
export interface FindingGroup {
  dir: Finding['dir'];
  origin: Finding['origin'];
  kind: FindingKind;
  frameKind: string;
  path: string;
  detail: string;
  count: number;
  first: { file: string; line: number };
}

/** Pure: group findings, in a stable order. */
export function groupFindings(fs: readonly Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const f of fs) {
    const path = f.path.replace(/\[\d+\]/g, '[]');
    const k = [f.dir, f.origin, f.kind, f.frameKind, path, f.detail].join('\u0000');
    const g = groups.get(k);
    if (g) g.count++;
    else groups.set(k, { dir: f.dir, origin: f.origin, kind: f.kind, frameKind: f.frameKind, path, detail: f.detail, count: 1, first: { file: f.file, line: f.line } });
  }
  const order = (g: FindingGroup): string => [g.dir === 'out' ? 0 : 1, g.kind, g.origin, g.frameKind, g.path, g.detail].join('\u0000');
  return [...groups.values()].sort((a, b) => order(a).localeCompare(order(b)));
}

/** The findings that fail the check: violations of the protocol's own declarations in frames the CLI wrote. */
export const failing = (gs: readonly FindingGroup[]): FindingGroup[] => gs.filter((g) => g.dir === 'out' && g.kind === 'violation' && g.origin === 'protocol');

export interface ReportScenario {
  id: string;
  variant?: string;
  contract: boolean;
  hypothesis: string;
  model: string;
  verdict: Verdict;
  holds: number;
  fails: number;
  inconclusive: number;
  costUsd: number;
  runs: RunOutcome[];
  recording: { file: string; sha256: string };
  /** How the runs reached the CLI: `local`, or `sandbox (<driver>)`, i.e. `sandbox (ssh-docker)`. */
  transport?: string;
  /** The credit the runs were on (OpenSpec api-key-credit D6): absent means a subscription token — every row before it existed. */
  credit?: CreditKind;
}

export interface ReportJson {
  cli: string;
  /** The declarations the frames were checked against (design D5); absent until checked. */
  sdk?: { release: string; claudeCodeVersion: string; exact: boolean; anthropicSdk: string };
  transport: string;
  date: string;
  models: string[];
  /** The subscription rows' cost (API-list-price equivalent) — with no API-key row, every row's. */
  totalCostUsd: number;
  /** The API-key rows' cost (billed at list prices), when the report has any: never added to totalCostUsd. */
  apiKeyCostUsd?: number;
  scenarios: ReportScenario[];
  catalogue: Record<string, { count: number; fields: string[] }>;
  findings: FindingGroup[];
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Pure: the report's cost per credit — a key's billed dollars and a token's equivalent are never one sum. */
export function costTotals(scenarios: readonly ReportScenario[]): Pick<ReportJson, 'totalCostUsd' | 'apiKeyCostUsd'> {
  const sum = (k: CreditKind): number => scenarios.filter((s) => (s.credit ?? 'subscription') === k).reduce((a, s) => a + s.costUsd, 0);
  const key = scenarios.some((s) => s.credit === 'api-key');
  return { totalCostUsd: sum('subscription'), ...(key ? { apiKeyCostUsd: sum('api-key') } : {}) };
}

/** A recording as committed: one JSON line per record. */
export const recordingText = (lines: readonly RecordLine[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

/** The kind of a frame as the catalogue and the findings name it. */
export function frameKind(f: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = f as any;
  if (f.type === 'stream_event') return `stream_event:${String(a.event?.type)}`;
  if (f.type === 'control_request') return `control_request:${String(a.request?.subtype)}`;
  if (f.type === 'control_response') return `control_response:${String(a.response?.subtype)}`;
  if (f.type === 'user' && a.isReplay === true) return 'user (replay)';
  return `${String(f.type)}${typeof f.subtype === 'string' ? `/${f.subtype}` : ''}`;
}

/** Pure: the kinds of frames the CLI wrote across recordings, with their top-level fields. */
export function catalogue(recordings: Iterable<readonly RecordLine[]>): ReportJson['catalogue'] {
  const acc = new Map<string, { count: number; fields: Set<string> }>();
  for (const rec of recordings) {
    for (const l of rec) {
      if (!('frame' in l) || l.dir !== 'out') continue;
      const k = frameKind(l.frame);
      const e = acc.get(k) ?? { count: 0, fields: new Set<string>() };
      e.count++;
      for (const f of Object.keys(l.frame)) e.fields.add(f);
      acc.set(k, e);
    }
  }
  return Object.fromEntries([...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { count: v.count, fields: [...v.fields].sort() }]));
}

/** Pure: replace rows by row id (a partial run updates only its scenarios), sorted by row id. */
export function mergeScenarios(previous: readonly ReportScenario[], fresh: readonly ReportScenario[]): ReportScenario[] {
  const byId = new Map(previous.map((s) => [rowId(s.id, s.variant), s]));
  for (const s of fresh) byId.set(rowId(s.id, s.variant), s);
  return [...byId.values()].sort((a, b) => rowId(a.id, a.variant).localeCompare(rowId(b.id, b.variant)));
}

export interface Changes {
  since: string;
  verdicts: { row: string; was: string; now: string }[];
  kindsAdded: string[];
  kindsGone: string[];
  fieldsAdded: { kind: string; fields: string[] }[];
  fieldsGone: { kind: string; fields: string[] }[];
}

/** Pure: what changed between the newest version already probed and this one. */
export function changedSince(now: ReportJson, before: ReportJson): Changes {
  const was = new Map(before.scenarios.map((s) => [rowId(s.id, s.variant), s.verdict]));
  const verdicts: Changes['verdicts'] = [];
  for (const s of now.scenarios) {
    const row = rowId(s.id, s.variant);
    const w = was.get(row) ?? '—';
    if (w !== s.verdict) verdicts.push({ row, was: w, now: s.verdict });
  }
  for (const [row, w] of was) if (!now.scenarios.some((s) => rowId(s.id, s.variant) === row)) verdicts.push({ row, was: w, now: '—' });
  const kNow = Object.keys(now.catalogue);
  const kBefore = Object.keys(before.catalogue);
  const fieldsAdded: Changes['fieldsAdded'] = [];
  const fieldsGone: Changes['fieldsGone'] = [];
  for (const k of kNow.filter((k) => kBefore.includes(k))) {
    const a = now.catalogue[k]!.fields.filter((f) => !before.catalogue[k]!.fields.includes(f));
    const g = before.catalogue[k]!.fields.filter((f) => !now.catalogue[k]!.fields.includes(f));
    if (a.length) fieldsAdded.push({ kind: k, fields: a });
    if (g.length) fieldsGone.push({ kind: k, fields: g });
  }
  return {
    since: before.cli,
    verdicts: verdicts.sort((a, b) => a.row.localeCompare(b.row)),
    kindsAdded: kNow.filter((k) => !kBefore.includes(k)),
    kindsGone: kBefore.filter((k) => !kNow.includes(k)),
    fieldsAdded,
    fieldsGone,
  };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const usd = (n: number): string => `$${n.toFixed(2)}`;
const observed = (s: ReportScenario): string => {
  // A row that does not hold shows the run that says why; a holding row its first conclusive run.
  const run =
    (s.verdict === 'fails' || s.verdict === 'flaky' ? s.runs.find((r) => r.verdict === 'fails') : undefined) ??
    s.runs.find((r) => r.verdict !== 'inconclusive') ??
    s.runs.at(-1);
  if (!run) return '';
  const parts = Object.entries(run.observations).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const why = run.reason ?? run.error;
  return cell([...parts, ...(why ? [`(${why})`] : [])].join(', ').slice(0, 300));
};

/** Pure: REPORT.md. */
export function renderReport(r: ReportJson, previous?: ReportJson): string {
  const out: string[] = [];
  out.push(`# Claude Code ${r.cli} — probe report`, '');
  out.push('Generated by `npm run cli-probe` (OpenSpec `cli-probe`, `docs/cli-probe.md`). Do not edit by hand: `npm run cli-probe -- report ' + r.cli + '` recomputes and renders it again.', '');
  const sdk = r.sdk
    ? `\`@anthropic-ai/claude-agent-sdk\` ${r.sdk.release} (names CLI ${r.sdk.claudeCodeVersion}${r.sdk.exact ? '' : ', the nearest lower release'}) with \`@anthropic-ai/sdk\` ${r.sdk.anthropicSdk}`
    : 'not checked yet';
  // A report with an API-key row lists its credits and splits the cost; one without reads as it always has.
  const keyRows = r.scenarios.some((s) => s.credit === 'api-key');
  const subRows = r.scenarios.some((s) => (s.credit ?? 'subscription') === 'subscription');
  const credits = keyRows ? [`- **Credit:** ${[...(subRows ? ['subscription token'] : []), 'API key'].join(', ')}`] : [];
  const cost = keyRows
    ? [...(subRows ? [`${usd(r.totalCostUsd)} API-equivalent (subscription token)`] : []), `${usd(r.apiKeyCostUsd ?? 0)} billed at list prices (API key)`].join(' · ')
    : `${usd(r.totalCostUsd)} API-equivalent`;
  out.push(`- **CLI:** ${r.cli}`, `- **Declarations:** ${sdk}`, `- **Models:** ${r.models.join(', ')}`, `- **Transport:** ${r.transport}`, ...credits, `- **Date:** ${r.date}`, `- **Cost:** ${cost}`, '');
  if (previous) {
    const c = changedSince(r, previous);
    out.push(`## Changed since ${c.since}`, '');
    if (!c.verdicts.length && !c.kindsAdded.length && !c.kindsGone.length && !c.fieldsAdded.length && !c.fieldsGone.length) out.push('Nothing: the same verdicts, event kinds and fields.', '');
    if (c.verdicts.length) {
      out.push('| Scenario | Was | Now |', '|---|---|---|');
      for (const v of c.verdicts) out.push(`| ${v.row} | ${v.was} | ${v.now} |`);
      out.push('');
    }
    if (c.kindsAdded.length) out.push(`- **New event kinds:** ${c.kindsAdded.map((k) => `\`${k}\``).join(', ')}`);
    if (c.kindsGone.length) out.push(`- **Event kinds gone:** ${c.kindsGone.map((k) => `\`${k}\``).join(', ')}`);
    for (const f of c.fieldsAdded) out.push(`- **New fields** in \`${f.kind}\`: ${f.fields.map((x) => `\`${x}\``).join(', ')}`);
    for (const f of c.fieldsGone) out.push(`- **Fields gone** from \`${f.kind}\`: ${f.fields.map((x) => `\`${x}\``).join(', ')}`);
    if (c.kindsAdded.length || c.kindsGone.length || c.fieldsAdded.length || c.fieldsGone.length) out.push('');
  }
  out.push('## Scenarios', '', '| Scenario | Contract | Verdict | Runs ✓/✗/? | Hypothesis | Observed | Cost |', '|---|---|---|---|---|---|---|');
  const rows = [...r.scenarios].sort((a, b) => Number(b.contract) - Number(a.contract) || rowId(a.id, a.variant).localeCompare(rowId(b.id, b.variant)));
  for (const s of rows) {
    out.push(`| ${rowId(s.id, s.variant)} | ${s.contract ? 'yes' : ''} | **${s.verdict}** | ${s.holds}/${s.fails}/${s.inconclusive} | ${cell(s.hypothesis)} | ${observed(s)} | ${usd(s.costUsd)}${s.credit === 'api-key' ? ' (API key)' : ''} |`);
  }
  out.push('', '## Event catalogue', '', 'Frames the CLI wrote, across all recordings.', '', '| Kind | Count | Fields |', '|---|---|---|');
  for (const [k, v] of Object.entries(r.catalogue)) out.push(`| \`${k}\` | ${v.count} | ${v.fields.map((f) => `\`${f}\``).join(' ')} |`);
  out.push('', '## Type checks', '');
  const where = (g: FindingGroup): string => `${g.first.file}:${g.first.line}${g.count > 1 ? `, ${g.count}×` : ''}`;
  for (const dir of ['out', 'in'] as const) {
    const gs = r.findings.filter((g) => g.dir === dir);
    out.push(dir === 'out' ? '### Frames the CLI wrote' : '### Frames the probe wrote (as the bot writes them; listed, never failed)', '');
    if (!r.sdk) {
      out.push('Not checked yet.', '');
      continue;
    }
    const v = gs.filter((g) => g.kind === 'violation' && g.origin === 'protocol');
    out.push(`- **Violations:**${v.length ? '' : ' none'}`);
    for (const g of v) out.push(`  - \`${g.frameKind}\` at \`${g.path}\` (${where(g)}): ${cell(g.detail)}`);
    // The API message model (`message`, `usage`, stream `event`s) is imported from @anthropic-ai/sdk: listed, never failed.
    const api = gs.filter((g) => g.kind === 'violation' && g.origin === 'api');
    out.push(`- **API message model mismatches** (listed, not failed):${api.length ? '' : ' none'}`);
    for (const g of api) out.push(`  - \`${g.frameKind}\` at \`${g.path}\`: ${cell(g.detail)} (${g.count}×)`);
    const fields = new Map<string, Set<string>>();
    for (const g of gs.filter((x) => x.kind === 'undeclared-field')) (fields.get(g.frameKind) ?? fields.set(g.frameKind, new Set()).get(g.frameKind)!).add(g.path);
    out.push(`- **Undeclared fields:**${fields.size ? '' : ' none'}`);
    for (const [k, ps] of [...fields.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push(`  - \`${k}\`: ${[...ps].sort().map((p) => `\`${p}\``).join(', ')}`);
    const kinds = [...new Set(gs.filter((x) => x.kind === 'undeclared-kind').map((x) => x.frameKind))].sort();
    out.push(`- **Undeclared kinds:** ${kinds.length ? kinds.map((k) => `\`${k}\``).join(', ') : 'none'}`, '');
  }
  return out.join('\n');
}
