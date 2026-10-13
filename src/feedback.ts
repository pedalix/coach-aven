import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { costOf, type UsageRecord } from './metering.js';

// Answer feedback — the "was that any good?" counter, the value half of the metering story
// (metering.ts is the cost half). Cost has always been recorded; usefulness never was,
// which left every optimisation argument unfalsifiable. One JSONL line per click under
// ./feedback/<YYYY-MM>.jsonl, joined to usage by turnId.
//
// Why a separate file and not a second record kind in usage/<month>.jsonl: aggregateUsage
// counts every line there as a turn, so a rating landing in that file would silently double
// the turn count. Separate store, joined on read.
//
// Why turnId and not the message ts: exactly ONE message per turn carries the rating
// buttons — its answer (see answerBlocks) — so a person has exactly one verdict to give per
// turn. Later clicks supersede earlier ones; the message ts rides along only as a "show me
// that message" backlink, nothing keys on it.

// Why a rating was bad. Deliberately causes we can act on, not moods — each maps to a
// different fix (wrong retrieval vs. missing evidence vs. wrong register). A good verdict
// carries no reason: the positive path stays one click, since the information lives in the
// misses.
export const BAD_REASONS = [
  { value: 'wrong', label: 'Wrong — the facts are off' },
  { value: 'unverifiable', label: "Can't verify — probably right, but I couldn't check it" },
  { value: 'missed', label: 'Missed the question — answered something else' },
  { value: 'tone', label: 'Too technical / wrong tone' },
  { value: 'slow', label: 'Too slow' },
  { value: 'backforth', label: 'Took too much back-and-forth' },
] as const;

export type BadReason = (typeof BAD_REASONS)[number]['value'];

export const isBadReason = (v: string): v is BadReason => BAD_REASONS.some((r) => r.value === v);

export interface FeedbackRecord {
  at: string; // ISO timestamp of the click
  turnId: string; // join key into UsageRecord.turnId
  key: string; // conversation key — carries the tenant, same convention as usage
  slug: string; // project
  user: string; // Slack user id — for last-write-wins and "who accepted it"
  verdict: 'good' | 'bad';
  reason?: BadReason; // bad only, from the modal
  note?: string; // optional free text from the modal
  ts?: string; // backlink to the rated message; never a key
  channel?: string; // backlink companion
}

// Bot-minted turnIds (`t<boot36>-<seq>`) round-trip through Slack button values, so
// validate before one is trusted as a join key. Same guard shape as drafts.isDraftId.
export function isTurnId(id: string): boolean {
  return /^t[a-z0-9]+-\d+$/.test(id);
}

// Pure: collapse the append-only log to one verdict per (turnId, user) — the latest click
// wins. A person may change their mind (👍 then 👎); the final click is the verdict. There is
// deliberately no toggle: re-clicking the same verdict is a no-op, never a retraction.
export function latestPerUser(records: FeedbackRecord[]): FeedbackRecord[] {
  const best = new Map<string, FeedbackRecord>();
  for (const r of records) {
    const k = `${r.turnId} ${r.user}`;
    const prev = best.get(k);
    if (!prev || Date.parse(r.at) >= Date.parse(prev.at)) best.set(k, r);
  }
  return [...best.values()];
}

export interface FeedbackRow {
  group: string; // slug, matching UsageRow.group
  rated: number; // turns with at least one verdict
  good: number;
  bad: number;
  ratedCostUsd: number; // cost of the rated turns — per-turn metered records only
  goodCostUsd: number; // cost of the turns that helped — same
  // Rated turns whose usage record predates per-turn cost metering (metering.ts costOf):
  // how many, how many of those helped, and their overstated dollars — kept apart so the
  // cost-per-helped figure is built from honest numbers only.
  legacyRated: number;
  legacyGood: number;
  legacyCostUsd: number;
  reasons: Partial<Record<BadReason, number>>;
}

// A turn counts as good when nobody rated it bad: one dissent disqualifies it. With a
// handful of raters a strict rule beats a majority vote, and the failure direction we want
// is pessimistic — never let the number flatter the agent. Reasons are a SET per turn, so
// the tally answers "how many missed turns were blamed on X" — two people both saying
// "wrong" about one answer is one wrong answer, not two.
function verdictByTurn(records: FeedbackRecord[]): Map<string, { good: boolean; slug: string; reasons: Set<BadReason> }> {
  const out = new Map<string, { good: boolean; slug: string; reasons: Set<BadReason> }>();
  for (const r of latestPerUser(records)) {
    const cur = out.get(r.turnId) ?? { good: true, slug: r.slug, reasons: new Set<BadReason>() };
    if (r.verdict === 'bad') {
      cur.good = false;
      if (r.reason) cur.reasons.add(r.reason);
    }
    out.set(r.turnId, cur);
  }
  return out;
}

// The per-turn vote count shown in the button labels ("👍 Helped · 2"). Recomputed from the
// log on every click so what the message shows IS the data — never a counter that can drift.
export interface Tally {
  good: number;
  bad: number;
}

export function tallyFor(records: FeedbackRecord[]): Tally {
  const t = { good: 0, bad: 0 };
  for (const r of latestPerUser(records)) t[r.verdict]++;
  return t;
}

// Pure: feedback + usage → per-project rows. Cost comes from the usage side, so a rating
// whose turn predates turnId-stamped usage records contributes 0 cost rather than a wrong
// one, and one whose record predates per-turn cost metering is tallied as legacy (its
// figure is a running total, not the turn's). Ordered by rated count, then name, so the
// table is stable across calls.
export function joinUsage(records: FeedbackRecord[], usage: UsageRecord[]): FeedbackRow[] {
  const costByTurn = new Map<string, number>();
  const legacyByTurn = new Map<string, number>();
  const slugByTurn = new Map<string, string>();
  for (const u of usage) {
    if (!u.turnId) continue;
    const { usd, legacyUsd } = costOf(u);
    costByTurn.set(u.turnId, (costByTurn.get(u.turnId) ?? 0) + usd);
    if (legacyUsd) legacyByTurn.set(u.turnId, (legacyByTurn.get(u.turnId) ?? 0) + legacyUsd);
    slugByTurn.set(u.turnId, u.slug);
  }
  const rows = new Map<string, FeedbackRow>();
  for (const [turnId, v] of verdictByTurn(records)) {
    const group = slugByTurn.get(turnId) ?? v.slug;
    const row =
      rows.get(group) ??
      { group, rated: 0, good: 0, bad: 0, ratedCostUsd: 0, goodCostUsd: 0, legacyRated: 0, legacyGood: 0, legacyCostUsd: 0, reasons: {} };
    const cost = costByTurn.get(turnId) ?? 0;
    const legacy = legacyByTurn.get(turnId);
    row.rated++;
    row.ratedCostUsd += cost;
    if (legacy !== undefined) {
      row.legacyRated++;
      row.legacyCostUsd += legacy;
      if (v.good) row.legacyGood++;
    }
    if (v.good) {
      row.good++;
      row.goodCostUsd += cost;
    } else {
      row.bad++;
      for (const reason of v.reasons) row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
    }
    rows.set(group, row);
  }
  return [...rows.values()].sort((a, b) => b.rated - a.rated || a.group.localeCompare(b.group));
}

const reasonLabel = (v: BadReason): string => BAD_REASONS.find((r) => r.value === v)?.label ?? v;

// Pure: the feedback section of the /aven usage reply (Slack mrkdwn). Reports coverage
// first on purpose — at a handful of turns a day the rated/total ratio is the honest
// headline, and cost-per-helped is a direction indicator, never a decision procedure.
export function feedbackSummaryText(rows: FeedbackRow[], totalTurns: number, days: number): string {
  const rated = rows.reduce((a, r) => a + r.rated, 0);
  if (rated === 0) {
    return `*Feedback — last ${days}d*\nNo answers rated yet — the rating buttons sit under every answer.`;
  }
  const good = rows.reduce((a, r) => a + r.good, 0);
  const ratedCost = rows.reduce((a, r) => a + r.ratedCostUsd, 0);
  const legacyRated = rows.reduce((a, r) => a + r.legacyRated, 0);
  const legacyGood = rows.reduce((a, r) => a + r.legacyGood, 0);
  const legacyCost = rows.reduce((a, r) => a + r.legacyCostUsd, 0);
  // Per helped answer, over the turns whose cost is per-turn metered: a legacy turn's
  // dollars are not in ratedCost, so it must not be in the divisor either.
  const pricedGood = good - legacyGood;
  const perGood = pricedGood > 0 ? `~$${(ratedCost / pricedGood).toFixed(2)}` : 'n/a';
  // The denominator can lag the ratings (a turn whose usage line predates turnId, or a
  // window boundary that caught the click but not the turn). Clamp it rather than print a
  // nonsense "1 of 0" — coverage is never over 100%, and never over the turns we counted.
  const total = Math.max(totalTurns, rated);
  const pct = Math.round((rated / total) * 100);
  const parts = [
    `*Feedback — last ${days}d*`,
    `${rated} of ${total} turns rated (${pct}%) · ${good} helped, ${rated - good} missed · ${perGood} per answer that helped`,
  ];
  // Same transition rule as usageSummaryText: pre-fix dollars are named, never mixed in.
  if (legacyRated) {
    parts.push(
      `${legacyRated} of the rated turns predate the per-turn cost fix (~$${legacyCost.toFixed(2)} recorded, overstated) — left out of the $ figures`,
    );
  }
  if (rows.length > 1) {
    parts.push(
      '',
      '*By project*',
      ...rows.map(
        (r) =>
          `• *${r.group}* — ${r.good}/${r.rated} helped · ~$${r.ratedCostUsd.toFixed(2)} rated` +
          `${r.legacyCostUsd ? ` (+ ~$${r.legacyCostUsd.toFixed(2)} legacy)` : ''}`,
      ),
    );
  }
  const tally = new Map<BadReason, number>();
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.reasons)) {
      tally.set(k as BadReason, (tally.get(k as BadReason) ?? 0) + (n ?? 0));
    }
  }
  if (tally.size) {
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    parts.push('', '*Why answers missed*', ...top.map(([k, n]) => `• ${reasonLabel(k)} — ${n}`));
  }
  return parts.join('\n');
}

const FEEDBACK_DIR = new URL('../feedback', import.meta.url).pathname;
const monthFile = (d: Date): string => `${d.toISOString().slice(0, 7)}.jsonl`;

// Pure: JSONL text → records, tolerant of torn lines (crash mid-append) and foreign junk —
// same contract as parseUsageLines.
export function parseFeedbackLines(text: string): FeedbackRecord[] {
  const out: FeedbackRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as FeedbackRecord;
      if (typeof r?.turnId === 'string' && typeof r?.user === 'string' && (r.verdict === 'good' || r.verdict === 'bad')) {
        out.push(r);
      }
    } catch {
      /* torn or foreign line — skip */
    }
  }
  return out;
}

export class FeedbackLog {
  // `dir` is injectable for tests (same pattern as UsageLog/Store/DraftStore).
  constructor(private readonly dir: string = FEEDBACK_DIR) {}

  // Best-effort: a failed write must degrade the button quietly, never surface as an error
  // to the person who just did us the favour of rating an answer.
  record(rec: FeedbackRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, monthFile(new Date(rec.at))), JSON.stringify(rec) + '\n');
    } catch (e) {
      log.error(`feedback record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Every record for one turn. A turn is rated within days of being answered, so the
  // current and previous month files bound the search; anything older is not worth a
  // full-history scan on a button click.
  forTurn(turnId: string, now = Date.now()): FeedbackRecord[] {
    const prev = new Date(now);
    prev.setUTCDate(1);
    prev.setUTCMonth(prev.getUTCMonth() - 1);
    const out: FeedbackRecord[] = [];
    for (const name of new Set([monthFile(prev), monthFile(new Date(now))])) {
      try {
        for (const r of parseFeedbackLines(readFileSync(join(this.dir, name), 'utf8'))) {
          if (r.turnId === turnId) out.push(r);
        }
      } catch {
        /* no such month file yet */
      }
    }
    return out;
  }

  // Records newer than `sinceMs` ago — month files keep this O(window), not O(history).
  read(sinceMs: number, now = Date.now()): FeedbackRecord[] {
    const cutoff = now - sinceMs;
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
    } catch {
      return []; // no feedback dir yet
    }
    const firstMonth = monthFile(new Date(cutoff)).slice(0, 7);
    const out: FeedbackRecord[] = [];
    for (const name of names.sort()) {
      if (name.slice(0, 7) < firstMonth) continue;
      try {
        for (const r of parseFeedbackLines(readFileSync(join(this.dir, name), 'utf8'))) {
          if (Date.parse(r.at) >= cutoff) out.push(r);
        }
      } catch {
        /* unreadable file — skip */
      }
    }
    return out;
  }
}
