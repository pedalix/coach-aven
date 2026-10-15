// The bench report: markdown over scored runs. One section per dataset × task — a table of variants, a
// paired bootstrap of each variant against the FIRST one (the reference, usually the baseline), the
// per-rung breakdown and the most frequent confusions.
//
// It prints numbers, label ids and rung names only — never unit texts, titles or ids: a report on a
// real dataset gets pasted into chats and notes, and must not quote anyone's messages. (TaskScore does
// not even carry text; keep it that way.)

import { pairedBootstrap, splitOf, type AutoShare, type Scored } from './metrics.js';
import type { RunResult } from './run.js';
import type { TaskScore } from './score.js';
import { TASKS } from './types.js';

export interface ReportEntry {
  result: RunResult;
  score: TaskScore;
}

export interface ReportOpts {
  title?: string;
  iters?: number; // bootstrap resamples (1000)
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pts = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;
const usd = (x: number | null): string => (x === null ? '—' : `$${x < 0.01 && x > 0 ? x.toFixed(5) : x.toFixed(4)}`);
const num = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : '—');
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const row = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
const table = (head: string[], rows: string[][]): string => [row(head), `|${head.map(() => '---').join('|')}|`, ...rows.map(row)].join('\n');

function runLabel(r: RunResult): string {
  const o = r.opts;
  if (o.mode === 'static') return `static${o.threshold ? ` ≥${o.threshold}` : ''}`;
  return `replay·${o.memory} q${o.questionsPerDay}${o.threshold ? ` ≥${o.threshold}` : ''}`;
}

// "share of test decided, at what precision (Wilson 95% CI), threshold picked on dev"
function autoCell(a: AutoShare): string {
  const t = a.test;
  if (!Number.isFinite(a.dev.threshold)) return '0% (no dev threshold holds the floor)';
  return `${pct(t.coverage)} (P ${t.decided ? pct(t.precision) : '—'} [${pct(t.ci.lo)}–${pct(t.ci.hi)}], n ${t.decided}, thr ${num(a.dev.threshold, 2)})`;
}

function groupsOf(entries: ReportEntry[]): ReportEntry[][] {
  const out = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    const k = `${e.result.dataset}\u0000${e.result.task}`;
    const g = out.get(k);
    if (g) g.push(e);
    else out.set(k, [e]);
  }
  return [...out.values()].sort((a, b) => a[0].result.dataset.localeCompare(b[0].result.dataset) || TASKS.indexOf(a[0].result.task) - TASKS.indexOf(b[0].result.task));
}

function mainTable(group: ReportEntry[]): string {
  const task = group[0].result.task;
  if (task === 't2-dedup') {
    return table(
      ['variant', 'run', 'units (gold)', 'pairwise P / R / F1', 'B³ P / R / F1', 'compression', 'human safety', 'pairs P / R (n)', 'exact family', 'cost/unit'],
      group.map(({ result: r, score: s }) => {
        const c = s.cluster;
        if (!c) return [r.variant, runLabel(r), String(s.population), '—', '—', '—', '—', '—', '—', usd(s.costPerUnit)];
        return [
          r.variant,
          runLabel(r),
          `${s.population} (${c.units})`,
          `${pct(c.pairwise.precision)} / ${pct(c.pairwise.recall)} / ${pct(c.pairwise.f1)}`,
          `${pct(c.bcubed.precision)} / ${pct(c.bcubed.recall)} / ${pct(c.bcubed.f1)}`,
          `${num(c.compression, 3)} (${c.families} fam.)`,
          c.humanUnits ? `${pct(c.humanSafety)} of ${c.humanUnits}` : '—',
          c.pairs ? `${pct(c.pairs.precision)} / ${pct(c.pairs.recall)} (${c.pairs.n})` : '—',
          pct(c.exact),
          usd(s.costPerUnit),
        ];
      }),
    );
  }
  const head = ['variant', 'run', 'n (dev/test)', 'auto@95 test', 'auto@95 conservative', 'oracle', 'acc (test)'];
  if (task === 't1-fragment') head.push('auto@95 by minutes');
  if (task === 't4-kind') head.push('macroF1');
  if (task === 't4-addressee') head.push('Jaccard');
  head.push('cost/unit · /auto', 'q/day (answered)');
  return table(
    head.map((h) => h.replace('95', String(Math.round((group[0].score.floor ?? 0.95) * 100)))),
    group.map(({ result: r, score: s }) => {
      const cells = [r.variant, runLabel(r), `${s.n} (${s.split.dev}/${s.split.test})${s.answered ? ` +${s.answered} answered` : ''}`, autoCell(s.auto), autoCell(s.autoConservative), pct(s.auto.oracle.coverage), pct(s.auto.accuracyAll)];
      if (task === 't1-fragment') cells.push(s.autoMinutes ? pct(s.autoMinutes.test.coverage) : '—');
      if (task === 't4-kind') cells.push(s.macroF1 !== undefined ? num(s.macroF1, 3) : '—');
      if (task === 't4-addressee') cells.push(s.jaccard !== undefined ? num(s.jaccard, 3) : '—');
      cells.push(`${usd(s.costPerUnit)} · ${usd(s.costPerAuto)}`, `${num(s.questionsPerDay)}${r.opts.mode === 'replay' ? ` (${num(s.answeredPerDay)})` : ''}`);
      return cells;
    }),
  );
}

const share = (units: Scored[]): number => (units.length ? units.filter((u) => u.pred !== null && u.pred === u.gold).length / units.length : 0);
// The units a variant would decide at its own dev-chosen operating point; the rest abstain.
const atOwnThreshold = (units: Scored[], thr: number): Scored[] => units.map((u) => (u.pred !== null && u.conf >= thr ? u : { ...u, pred: null }));

function bootstrapLines(group: ReportEntry[], iters: number): string[] {
  const [ref, ...rest] = group;
  if (!rest.length) return [];
  const test = (s: TaskScore) => s.units.filter((u) => splitOf(u.id) === 'test');
  const a = test(ref.score);
  const ids = new Set(a.map((u) => u.id));
  const what = ref.result.task === 't2-dedup' ? 'exact-family share' : 'accuracy';
  const lines = [`Paired bootstrap vs **${ref.result.variant}** (${runLabel(ref.result)}), test split, ${iters} resamples — Δ in points [95% interval], P(better):`];
  for (const e of rest) {
    const b = test(e.score);
    const shared = b.filter((u) => ids.has(u.id)).length;
    if (!shared) {
      lines.push(`- **${e.result.variant}** (${runLabel(e.result)}): no shared test units`);
      continue;
    }
    const acc = pairedBootstrap(a, b, share, iters);
    const auto = pairedBootstrap(atOwnThreshold(a, ref.score.auto.dev.threshold), atOwnThreshold(b, e.score.auto.dev.threshold), share, iters);
    lines.push(
      `- **${e.result.variant}** (${runLabel(e.result)}, ${shared} units): ${what} ${pts(acc.delta)} [${pts(acc.lo)}, ${pts(acc.hi)}], P ${num(acc.pBetter, 2)} · auto-decided-correct ${pts(auto.delta)} [${pts(auto.lo)}, ${pts(auto.hi)}], P ${num(auto.pBetter, 2)}`,
    );
  }
  return lines;
}

function rungLines(group: ReportEntry[]): string[] {
  const out: string[] = [];
  for (const { result: r, score: s } of group) {
    if (!s.rungs.length) continue;
    const shown = s.rungs.slice(0, 20);
    out.push(
      `**${r.variant}** (${runLabel(r)})`,
      '',
      table(
        ['rung', 'n', 'decided', 'correct', 'precision'],
        shown.map((x) => [x.rung, String(x.n), String(x.decided), String(x.correct), x.decided ? pct(x.correct / x.decided) : '—']),
      ),
    );
    if (s.rungs.length > shown.length) out.push(`… ${s.rungs.length - shown.length} more rungs`);
    out.push('');
  }
  return out;
}

function confusionLines(group: ReportEntry[]): string[] {
  const out: string[] = [];
  for (const { result: r, score: s } of group) {
    if (!s.confusions.length) continue;
    out.push(`**${r.variant}** (${runLabel(r)})`, '', table(['gold', 'pred', 'n'], s.confusions.slice(0, 10).map((c) => [c.gold, c.pred, String(c.n)])), '');
  }
  return out;
}

function header(group: ReportEntry[]): string {
  const s = group[0].score;
  const tiers = s.tiers?.length ? s.tiers.join('+') : 'all tiers';
  const umbrella = s.level === 'umbrella' && s.task.startsWith('t1-'); // the level only exists for initiatives
  return `## ${group[0].result.dataset} · ${group[0].result.task}\n\nGold: ${tiers}${umbrella ? ' · umbrella level' : ''} · floor ${pct(s.floor)}`;
}

// The compact view the CLI prints after a run: the main table per dataset × task.
export function renderSummary(entries: ReportEntry[]): string {
  return groupsOf(entries)
    .map((g) => `${header(g)}\n\n${mainTable(g)}`)
    .join('\n\n');
}

export function renderReport(entries: ReportEntry[], opts: ReportOpts = {}): string {
  const iters = opts.iters ?? 1000;
  const parts = [
    `# ${opts.title ?? 'Lab report'}`,
    '',
    'Headline: **auto@floor test** — the share of TEST units decided automatically at the threshold chosen on DEV (point precision ≥ floor), with the precision and its Wilson 95% interval on test. *Conservative*: the dev threshold must hold the floor at the Wilson lower bound. *Oracle*: the best test share with the threshold picked on test (an upper bound, never the headline). *acc*: plain accuracy on test, abstention = wrong. Units a person answered during a replay are excluded from all of these. *q/day*: units sent to a person per active day of the population.',
  ];
  for (const g of groupsOf(entries)) {
    parts.push('', header(g), '', mainTable(g));
    const boot = bootstrapLines(g, iters);
    if (boot.length) parts.push('', ...boot);
    const rungs = rungLines(g);
    if (rungs.length) parts.push('', '### Per rung', '', ...rungs);
    const conf = confusionLines(g);
    if (conf.length) parts.push('### Top confusions (gold → pred)', '', ...conf);
  }
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
