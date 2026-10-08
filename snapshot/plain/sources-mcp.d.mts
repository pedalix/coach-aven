// Type surface of sources-mcp.mjs for the orchestrator's tests (the .mjs is the single source
// of truth; keep this in step by hand — the test suite fails loudly if an export disappears).
import type { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DB_PATH: string;
export const SERVER_NAME: string;
export const SERVER_VERSION: string;
export const PROTOCOL_VERSION: string;
export const TRACKER_SOURCES: string[];

export function sanitizeFtsQuery(input: unknown): string;
export function normalizeTime(v: unknown, edge: 'since' | 'until'): string | undefined;
export function buildSearchSql(f: {
  match?: string;
  since?: string;
  until?: string;
  source?: string;
  personIds?: string[];
  limit?: number | string;
}): { mode: 'fts' | 'recent'; sql: string; params: unknown[] };

export function buildTaskSearchSql(f: {
  match?: string;
  since?: string;
  until?: string;
  source?: string;
  personIds?: string[];
  limit?: number | string;
}): { mode: 'fts' | 'recent'; sql: string; params: unknown[] };
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

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const TOOLS: ToolDef[];

export function runSearch(db: DatabaseSync, args: Record<string, unknown>): { mode: string; note?: string; hits: Record<string, unknown>[] };
export function runGet(db: DatabaseSync, args: Record<string, unknown>): Record<string, unknown>;
export function runPeople(db: DatabaseSync, args: Record<string, unknown>): { people: Record<string, unknown>[] };
export function runStats(db: DatabaseSync): Record<string, unknown>;
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
