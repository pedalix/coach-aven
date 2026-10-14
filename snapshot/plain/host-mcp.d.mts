// Type surface of host-mcp.mjs for the orchestrator's tests (the .mjs is the single source of truth).
export const DEFAULT_OUTBOX: string;
export const SERVER_NAME: string;
export const SERVER_VERSION: string;
export const PROTOCOL_VERSION: string;
export const KINDS: string[];
export const MAX_TEXT: number;
export const MAX_REFS: number;
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const TOOLS: ToolDef[];
export interface ProposalFile {
  id: string;
  kind: string;
  target: string;
  text: string;
  refs: string[];
  rationale: string;
  session: string;
  createdAt: string;
}
export function makeProposal(args: Record<string, unknown>, env?: Record<string, string | undefined>, now?: Date): { record: ProposalFile } | { error: string };
export function writeProposal(record: ProposalFile, dir?: string): string;
export function callTool(name: string, args: Record<string, unknown>, dir?: string): Record<string, unknown>;
export function handleMessage(msg: unknown, dir?: string): Record<string, unknown> | undefined;
export function serve(dir?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): void;
