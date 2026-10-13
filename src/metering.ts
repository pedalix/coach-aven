import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitTeam } from './teamkeys.js';
import { log } from './log.js';

// Usage metering — the "whose Claude tokens are we burning?" counter (multi-tenancy
// slice 4, docs/multitenancy.md §7). Every settled agent turn appends one JSONL line to
// ./usage/<YYYY-MM>.jsonl (beside state.json; month files keep reads bounded and make
// manual invoicing "attach the month file"). This is attribution, not billing: today all
// turns run on our one Claude Max subscription, but the moment a client asks "what did
// we use?" — or we mint per-tenant API keys — the history already exists.
//
// teamId is best-effort until the slice-2/3 re-keying lands: conversation keys carry no
// team today, so records without one aggregate as the home team. When keys become
// `<team_id>:thread:<ts>`, teamOf() picks the team up with no migration — old records
// simply stay attributed to home, which is factually where they ran.

// Token/cost figures from the claude CLI's `result` event — extracted in
// claudeSession.ts (usageOf) and carried on TurnResult. All fields optional; a record
// without usage still counts turns.
export type { TurnUsage } from './claudeSession.js';
import type { TurnUsage } from './claudeSession.js';

export interface UsageRecord {
  at: string; // ISO timestamp of turn settle
  key: string; // conversation key (carries the team once slice-2 re-keying lands)
  // The turn's own id (`t<boot36>-<seq>`), the join key answer feedback uses to attach a
  // verdict to what that answer cost (feedback.ts). Optional: records written before this
  // field existed simply carry no id and join to nothing.
  turnId?: string;
  slug: string; // project
  // live turn vs no-UI ask (dreams, /aven Q&A) vs a turn the CLI ran on its own when a
  // background Task/Agent finished after its owning turn settled (no message in).
  kind: 'turn' | 'ask' | 'background';
  status: 'ok' | 'error' | 'canceled';
  elapsedMs: number; // wall clock — doubles as the sandbox-hours proxy for now
  usage?: TurnUsage;
  routineId?: string; // the scheduled routine this turn ran for (pollers.ts) — cuts usage/feedback per routine
  routineLabel?: string; // its human label at the time ("📋 Morning brief")
}

// Tenant id from a tenant-scoped conversation key, e.g. "T0ABCDEF:thread:123.45" →
// "T0ABCDEF" (enterprise E… ids too). Bare keys → 'home' — the same convention as
// teamkeys.ts, which owns the encoding.
export function teamOf(key: string): string {
  return splitTeam(key).tenantId ?? 'home';
}

export interface UsageRow {
  group: string; // slug or team, per the aggregation dimension
  turns: number; // prompts in (live turns + asks)
  background: number; // self-started CLI turns — their cost is in the totals, not in `turns`
  errors: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// Pure: records → per-group totals, biggest cost first. Canceled turns still count as
// turns (they may have burned tokens before the interrupt).
export function aggregateUsage(records: UsageRecord[], by: 'slug' | 'team'): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const r of records) {
    const group = by === 'team' ? teamOf(r.key) : r.slug;
    const row =
      rows.get(group) ??
      { group, turns: 0, background: 0, errors: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    if (r.kind === 'background') row.background++;
    else row.turns++;
    if (r.status === 'error') row.errors++;
    row.wallMs += r.elapsedMs;
    row.inputTokens += r.usage?.inputTokens ?? 0;
    row.outputTokens += r.usage?.outputTokens ?? 0;
    row.cacheReadTokens += r.usage?.cacheReadTokens ?? 0;
    row.cacheCreationTokens += r.usage?.cacheCreationTokens ?? 0;
    row.costUsd += r.usage?.costUsd ?? 0;
    rows.set(group, row);
  }
  return [...rows.values()].sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns);
}

// Pure: JSONL text → records, tolerant of torn lines (crash mid-append) and foreign junk.
export function parseUsageLines(text: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as UsageRecord;
      if (typeof r?.at === 'string' && typeof r?.slug === 'string' && typeof r?.key === 'string') out.push(r);
    } catch {
      /* torn line — skip */
    }
  }
  return out;
}

const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const fmtH = (ms: number): string => `${(ms / 3_600_000).toFixed(1)}h`;

// Pure: the /aven usage reply (Slack mrkdwn). Wall-clock is labeled as the sandbox-time
// proxy it is — real per-sandbox hours need provider-side accounting we don't do yet.
//
// Cache traffic is printed on its own, and first: an agentic turn re-reads its whole session
// context on every tool call, so cache reads are routinely ~95% of a turn's tokens and most
// of its cost (a real caldora turn: 7k in / 18k out / 1.85M cache read → $1.40). Showing
// only in/out made "690k tokens for $171" look like a bug when it was the hidden 98%.
export function usageSummaryText(bySlug: UsageRow[], byTeam: UsageRow[], days: number): string {
  if (bySlug.length === 0) return `No agent turns recorded in the last ${days}d.`;
  const line = (r: UsageRow) =>
    `• *${r.group}* — ${r.turns} turns${r.background ? ` + ${r.background} background` : ''}${r.errors ? ` (${r.errors} errors)` : ''} · ` +
    `${fmtK(r.cacheReadTokens)} cache read / ${fmtK(r.cacheCreationTokens)} cache write / ` +
    `${fmtK(r.inputTokens)} in / ${fmtK(r.outputTokens)} out tok · ~$${r.costUsd.toFixed(2)} · ${fmtH(r.wallMs)} active`;
  const sum = bySlug.reduce(
    (a, r) => ({
      turns: a.turns + r.turns,
      background: a.background + r.background,
      cost: a.cost + r.costUsd,
      wall: a.wall + r.wallMs,
      cache: a.cache + r.cacheReadTokens,
      tok: a.tok + r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens + r.outputTokens,
    }),
    { turns: 0, background: 0, cost: 0, wall: 0, cache: 0, tok: 0 },
  );
  const cachePct = sum.tok ? Math.round((sum.cache / sum.tok) * 100) : 0;
  const parts = [
    `*Usage — last ${days}d*  (~$ = API-list-price equivalent computed by the CLI, not a bill — we run on a Max subscription)`,
    `Total: ${sum.turns} turns${sum.background ? ` + ${sum.background} background` : ''} · ~$${sum.cost.toFixed(2)} · ${fmtK(sum.tok)} tok, ${cachePct}% of them cache reads · ${fmtH(sum.wall)} agent-active time`,
    '',
    '*By project*',
    ...bySlug.map(line),
  ];
  // Only show the team cut once there IS more than the home team (post slice-2/3).
  if (byTeam.length > 1) parts.push('', '*By workspace*', ...byTeam.map(line));
  return parts.join('\n');
}

const USAGE_DIR = new URL('../usage', import.meta.url).pathname;
const monthFile = (d: Date): string => `${d.toISOString().slice(0, 7)}.jsonl`;

export class UsageLog {
  // `dir` is injectable for tests (same pattern as Store/QueueJournal/DraftStore).
  constructor(private readonly dir: string = USAGE_DIR) {}

  // Best-effort: metering must never sink a turn.
  record(rec: UsageRecord): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, monthFile(new Date(rec.at))), JSON.stringify(rec) + '\n');
    } catch (e) {
      log.error(`usage record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Records newer than `sinceMs` ago. Reads every month file the window can touch —
  // month files keep this O(window), not O(history).
  read(sinceMs: number, now = Date.now()): UsageRecord[] {
    const cutoff = now - sinceMs;
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f));
    } catch {
      return []; // no usage dir yet
    }
    const firstMonth = monthFile(new Date(cutoff)).slice(0, 7);
    const out: UsageRecord[] = [];
    for (const name of names.sort()) {
      if (name.slice(0, 7) < firstMonth) continue;
      try {
        for (const r of parseUsageLines(readFileSync(join(this.dir, name), 'utf8'))) {
          if (Date.parse(r.at) >= cutoff) out.push(r);
        }
      } catch {
        /* unreadable file — skip */
      }
    }
    return out;
  }
}
