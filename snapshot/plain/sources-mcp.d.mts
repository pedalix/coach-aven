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

export const LOCAL_TZ: string;
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
  limit?: number | string;
}): { sql: string; params: unknown[] };
export function runUnanswered(
  db: DatabaseSync,
  args: Record<string, unknown>,
  now?: Date,
): { subject: { mode: string; people: string[] }; hours: number; since?: string; until?: string; now: string; note?: string; conversations: number; unanswered: Record<string, unknown>[] };
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
export function handleMessage(msg: unknown, dbPath: string): Record<string, unknown> | undefined;
export function serve(dbPath?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): void;
