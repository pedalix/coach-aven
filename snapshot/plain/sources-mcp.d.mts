// Type surface of sources-mcp.mjs for the orchestrator's tests (the .mjs is the single source
// of truth; keep this in step by hand — the test suite fails loudly if an export disappears).
import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH: string;
export const SERVER_NAME: string;
export const SERVER_VERSION: string;
export const PROTOCOL_VERSION: string;
export const TRACKER_SOURCES: string[];
export const MEETING_SOURCES: string[];
export function initiativeClause(refExpr: string, initiative: string, meetingShorthand?: string): { sql: string; params: unknown[] };

export let LOCAL_TZ: string;
export function setLocalTz(name: string | undefined): string;
export const SUMMARY_PREVIEW_CHARS: number;
export const DEFAULT_MEETINGS_WINDOW_DAYS: number;
export const SPEAKER_SAMPLE_CHARS: number;
export const TRANSCRIPT_PAGE_CHARS: number;
export const TRANSCRIPT_MAX_CHARS: number;

export function sanitizeFtsQuery(input: unknown): string;
export function zonedToUtcMs(fields: number[], tz: string): number;
export function normalizeTime(v: unknown, edge: 'since' | 'until', tz?: string): string | undefined;
export type SpeakerQuality = 'me-them' | 'names-diarized' | 'anonymous' | null;
export function speakerQuality(transcript: unknown): SpeakerQuality;
export function previewSummary(head: unknown, max?: number): { summary: string; summary_truncated: boolean };
export function commentActivity(commentsJson: unknown, since?: string): { lastComment: { by: string; at: string } | null; commentsSince?: { n: number; authors: string[] } };
export function pulledMeta(meta: Record<string, string> | undefined, now?: Date): { pulled?: Record<string, { at?: string; age_minutes?: number; raw?: string }> };
export function buildSearchSql(f: {
  match?: string;
  since?: string;
  until?: string;
  source?: string;
  personIds?: string[];
  initiative?: string;
  limit?: number | string;
  excludeBots?: boolean;
}): { mode: 'fts' | 'recent'; sql: string; params: unknown[] };

export function buildTaskSearchSql(f: {
  match?: string;
  since?: string;
  until?: string;
  source?: string;
  personIds?: string[];
  initiative?: string;
  limit?: number | string;
}): { mode: 'fts' | 'recent'; sql: string; params: unknown[] };
export function buildMeetingSearchSql(f: {
  match?: string;
  since?: string;
  until?: string;
  source?: string;
  personIds?: string[];
  initiative?: string;
  limit?: number | string;
  hasCalls?: boolean;
}): { mode: 'fts' | 'recent'; sql: string; params: unknown[] };
export function buildMeetingsListSql(f: { since?: string; until?: string; personIds?: string[]; source?: string; limit?: number | string; hasCalls?: boolean }): { sql: string; params: unknown[] };
export function collapseCalls<T extends { kind?: string; call_id?: string | null; source: string; ref: string }>(rows: T[]): (T & { also?: { source: string; ref: string }[] })[];
export function buildCalendarSql(f: { since?: string; until?: string; source?: string; needles?: string[]; q?: string; limit?: number | string }): { sql: string; params: unknown[] };
export function runCalendar(db: DatabaseSync, args: Record<string, unknown>): { note?: string; events: Record<string, unknown>[] };
export function buildActivitySql(f: { since?: string; until?: string; container?: unknown; source?: unknown; q?: unknown; limit?: number | string }): { sql: string; params: unknown[] };
export function runActivity(db: DatabaseSync, args: Record<string, unknown>): { note?: string; activity: Record<string, unknown>[] };
export function buildFragmentsSql(f: { since?: string; until?: string; initiative?: string; status?: string; limit?: number | string }): { sql: string; params: unknown[] };
export function buildTasksListSql(f: {
  status?: string;
  personIds?: string[];
  assigneeRaw?: string;
  dueBefore?: string;
  project?: string;
  source?: string;
  updatedSince?: string;
  limit?: number | string;
}): { sql: string; params: unknown[] };

export const DEFAULT_UNANSWERED_WINDOW_DAYS: number;
export function resolveSubject(db: DatabaseSync, args: Record<string, unknown>): { mode: 'person' | 'side'; ids: string[]; note?: string };
export function buildUnansweredSql(f: {
  mode: 'person' | 'side';
  subjectIds: string[];
  cutoff: string;
  since?: string;
  until?: string;
  source?: unknown;
  container?: unknown;
  hasBots?: boolean;
  all?: boolean;
  limit?: number | string;
}): { sql: string; params: unknown[] };
export function runUnanswered(
  db: DatabaseSync,
  args: Record<string, unknown>,
  now?: Date,
): { subject: { mode: string; people: string[] }; hours: number; all?: boolean; since?: string; until?: string; now: string; note?: string; conversations: number; unanswered: Record<string, unknown>[] };
export function buildStuckSql(f: { cutoff: string; status?: unknown; personIds?: string[]; assigneeRaw?: unknown; project?: unknown; source?: unknown }): { sql: string; params: unknown[] };
export function runStuck(db: DatabaseSync, args: Record<string, unknown>, now?: Date): { days?: number; now?: string; note?: string; truncated?: boolean; total?: number; groups: Record<string, unknown>[] };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const TOOLS: ToolDef[];

export function runSearch(db: DatabaseSync, args: Record<string, unknown>): { mode: string; note?: string; hits: Record<string, unknown>[] };
export function runGet(db: DatabaseSync, args: Record<string, unknown>): Record<string, unknown>;
export function runTranscript(db: DatabaseSync, args: Record<string, unknown>): Record<string, unknown>;
export function runPeople(db: DatabaseSync, args: Record<string, unknown>): { people: Record<string, unknown>[] };
export function runStats(db: DatabaseSync): Record<string, unknown>;
export function runMeetings(db: DatabaseSync, args: Record<string, unknown>): { note?: string; meetings: Record<string, unknown>[] };
export function runFragments(db: DatabaseSync, args: Record<string, unknown>): { note?: string; fragments: Record<string, unknown>[] };
export function runTasks(db: DatabaseSync, args: Record<string, unknown>): { note?: string; tasks: Record<string, unknown>[] };
export function callTool(dbPath: string, name: string, args: Record<string, unknown>): unknown;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}
export function runAttribution(
  db: unknown,
  args: { since?: string; until?: string; state?: string; limit?: number | string; unit?: 'fragment' | 'item' | string; sender?: string; collapse?: boolean; learn?: boolean | 'ask' | string },
  now?: Date,
): {
  configured?: false;
  note?: string;
  subject?: string;
  since?: string;
  until?: string;
  tz?: string;
  computed_at?: string;
  horizon?: { since: string; until: string };
  counts?: Record<string, number>;
  fragments?: Array<Record<string, unknown> & { id: string; state: string }>;
  truncated?: boolean;
  proposals?: Array<{ id: string; question: string; options: string[]; refs: string[] }>;
  /** unit "item": item mode's rows (att_items) for the requested days, or `items_mode: 'off'` when the tenant has not turned it on. */
  unit?: 'item';
  items_mode?: 'off';
  window?: { since: string; until: string; days: number };
  items?: Array<Record<string, unknown> & { ref: string; day: string; sender: string; family: string; initiative: string | null; rung: string; kind: string | null; addressee: string[] | null; case: string }>;
  /**
   * `learn: true`: the learning loop's shadow readout (att_learn + the `att:learn` meta), or `mode: 'off'`.
   * `learn: "ask"`: the head of that section plus `ask` (no tables, queue or unit rows) — and the answer carries no
   * fragment/item list.
   */
  learn?: {
    mode: 'shadow' | 'off';
    note: string;
    computed_at?: string;
    today?: string;
    tau?: number;
    counts?: Record<string, unknown>;
    agreement?: { answered: number; floor: { decided: number; agree: number }; loop: { decided: number; agree: number } };
    calibration?: Array<{ instance: string; a: number; b: number; mean: number; demoted: boolean }>;
    key_types?: Array<{ type: string; a: number; b: number; mean: number; deciding: boolean }>;
    questions?: LearnQuestion[];
    more_questions?: number;
    audits?: string[];
    rule_candidates?: Array<{ key: string; label: string; support: number }>;
    more_rule_candidates?: number;
    units?: LearnUnitRow[];
    units_truncated?: true;
    ask?: {
      questions: LearnQuestion[];
      audits: string[];
      /** One per unit the questions and audits name, questions' units first by rank; `row` as the fragment/item list shows it, null when the store has none. */
      units: Array<LearnUnitRow & { unit: 'fragment' | 'item'; row: Record<string, unknown> | null }>;
      missing?: string[];
    };
  };
};
export interface LearnQuestion { group: string; units: string[]; value: number; guess: string | null; form: 'choose' | 'confirm'; unit?: 'fragment' | 'item' }
export interface LearnUnitRow { id: string; day: string; label: string | null; conf?: number; rung: string; ask?: { group: string; value: number; guess: string | null; form: 'choose' | 'confirm' }; audit?: true }
export interface TlRoute { initiative: string | null; confidence: string; candidates: string[]; split?: Record<string, number> }
export interface TlEvidence { kind: 'meeting' | 'session'; start: string; end: string; minutes: number; title: string; ref: string; route: TlRoute; workKey?: string; facets?: { titles: string[]; container: string | null; keys: string[] } }
export function unionIntervals(xs: { start: number; end: number }[]): { start: number; end: number }[];
export function subtractIntervals(xs: { start: number; end: number }[], cut: { start: number; end: number }[]): { start: number; end: number }[];
export function routeOfAttributions(atts: { initiative: string; share: number }[], reg: Record<string, { umbrella?: string; billing_code?: string; alias_of?: string; split_into?: Record<string, number> }>): TlRoute;
export function fragmentsToEvidence(rows: Array<{ id: string; kind: string; start: string; end: string; state: string; attributions: { initiative: string; share: number }[]; candidates: string[]; refs: string[]; title?: string; container?: string | null; project_keys?: string[] }>, reg: Record<string, unknown>): TlEvidence[];
export function resolveByCoActivity(evs: TlEvidence[]): TlEvidence[];
export function buildTimelog(evidence: TlEvidence[], reg: Record<string, { umbrella?: string; billing_code?: string; alias_of?: string; split_into?: Record<string, number> }>, tz: string, policy?: 'sum' | 'wallclock'): Array<{ day: string; initiative: string | null; umbrella?: string; billing_code?: string; minutes: number; confidence: string; candidates?: string[]; refs: string[] }>;
export function reconcile(
  entries: Array<{ initiative: string | null; umbrella?: string; billing_code?: string; minutes: number }>,
  budgets: Array<{ umbrella: string; unit: 'hour' | 'half_day'; unitMinutes?: number; perMonth?: number; overrides?: Record<string, number>; by?: 'initiative' | 'billing_code' }>,
  month: string,
): {
  budgets: Array<{ umbrella: string; unit: string; minutes: number; used: number; cap?: number; cap_source?: 'default' | 'override'; remaining?: number; by: Record<string, { minutes: number; units: number }> }>;
  per_umbrella: Record<string, number>;
  non_billable: Array<{ initiative: string; minutes: number }>;
  unrouted: { minutes: number; entries: number };
};
export function runIdentities(db: unknown): Record<string, unknown> & {
  configured?: false;
  merges?: Array<{ person_id: string; identity: string; reason: string }>;
  questions?: Array<{ id: string; kind: string; question: string; options: string[]; refs: string[]; seen: number }>;
  counts?: Record<string, number>;
};
export function runCommitments(db: unknown, args: { since?: string; until?: string; owner?: string }, now?: Date): Record<string, unknown> & {
  configured?: false;
  commitments?: Array<{ id: string; owner: string | null; to: string | null; what: string; source: string; call: string; call_title: string; call_start: string; day: string; provenance: Array<{ kind: string; ref: string }> }>;
};
export interface TsSheet {
  id: string;
  umbrella: string;
  unit: 'hour' | 'half_day';
  unitMinutes: number;
  step: number;
  columns: string[];
  who?: string;
  dateFormat: string;
  comment: { language: string; style?: string };
  layout: { weekends: 'keep' | 'shift'; maxUnitsPerDay?: number };
  projects: Array<{ project?: string; projectFrom?: 'billing_code'; sameDay?: true; initiatives?: string[]; match?: { keys?: string[]; repos?: string[]; containers?: string[]; title?: string } }>;
}
export interface TsRow { date: string; project: string; units: number; minutes: number; source_days?: string[]; moved_in?: Array<{ from: string; units: number }>; moved_out?: number; evidence: Array<Record<string, unknown>>; more_evidence?: number }
export function repoTailMatches(pattern: string, container: string | null | undefined): boolean;
export function sheetEvidence(evidence: TlEvidence[], sheet: TsSheet, reg: Record<string, { umbrella?: string; billing_code?: string; alias_of?: string; split_into?: Record<string, number> }>, dayOf: (iso: string) => string): TlEvidence[];
export function layoutSheet(
  rows: Array<{ date: string; project: string; minutes: number; evidence?: Array<Record<string, unknown>> }>,
  sheet: Pick<TsSheet, 'step' | 'unitMinutes' | 'layout'>,
  window: { since: string; until: string; blocked?: (day: string) => boolean },
): { rows: TsRow[]; shifted: boolean; folded?: Array<{ date: string; project: string; minutes: number; moved_out?: number }>; over_cap_days?: Array<{ date: string; units: number }> };
export function withSubmitted<R extends ReturnType<typeof reconcile>>(
  rec: R,
  monthEntries: Array<{ day: string; initiative: string | null; umbrella?: string; billing_code?: string; minutes: number }>,
  budgets: Parameters<typeof reconcile>[1],
  month: string,
  sheets: Array<{ id: string; umbrella: string }>,
  periods: Array<{ id: string; sheet: string; since: string; until: string; rows: Array<{ date: string; units: number }> }>,
): R;
export function runTimesheet(db: unknown, args: { sheet?: string; since?: string; until?: string; include_submitted?: boolean }, now?: Date): Record<string, unknown> & {
  configured?: false;
  error?: string;
  layout?: 'kept' | 'shifted';
  rows?: TsRow[];
  totals?: { units: number; minutes: number; by_project: Record<string, { units: number; minutes: number }> };
  unmapped?: Array<{ date: string; initiative: string; minutes: number }>;
  undecided?: Array<{ date: string; minutes: number; confidence: string; candidates: string[] }>;
  folded?: Array<{ date: string; project: string; minutes: number; moved_out?: number }>;
  over_cap_days?: Array<{ date: string; units: number }>;
  submitted?: Array<{ id: string; since: string; until: string; units: number; submitted_at?: string }>;
  cap?: { month: string; cap: number; submitted: number; rows: number; left: number };
};
export function runTimelog(db: unknown, args: { since?: string; until?: string }, now?: Date): Record<string, unknown> & { configured?: false; total_minutes?: number; totals?: { initiative: string; minutes: number }[]; days?: Array<{ day: string; minutes: number; entries: Array<Record<string, unknown>> }> };
export function handleMessage(msg: unknown, dbPath: string): Record<string, unknown> | undefined;
export function serve(dbPath?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): void;
