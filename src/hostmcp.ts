// The `host` MCP server inside the sandbox (snapshot/plain/host-mcp.mjs): shipped and launched
// exactly like the sources server (sources/mcp.ts) — a dependency-free .mjs uploaded by sha —
// and present only while DISPATCH=1, so every other sandbox's MCP list is byte-identical.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { McpServerSpec } from './projects.js';
import { OUTBOX_MOUNT_TARGET } from './dispatch.js';

export const HOST_MCP_PATH = '/opt/aven/host-mcp.mjs';
export const HOST_SERVER_NAME = 'host';
export const HOST_MCP_SOURCE = new URL('../snapshot/plain/host-mcp.mjs', import.meta.url).pathname;

export function hostMcpScript(): Buffer {
  return readFileSync(HOST_MCP_SOURCE);
}
export function hostMcpSha256(script: Buffer = hostMcpScript()): string {
  return createHash('sha256').update(script).digest('hex');
}

export function hostMcpSpec(): McpServerSpec {
  return { name: HOST_SERVER_NAME, command: 'node', args: ['--no-warnings', HOST_MCP_PATH], env: { HOST_OUTBOX: OUTBOX_MOUNT_TARGET } };
}

/** Merge the `host` server into a project's MCP specs; a project-declared `host` server wins; off → untouched. */
export function withHostMcp(mcp: McpServerSpec[] | undefined, enabled: boolean): McpServerSpec[] | undefined {
  if (!enabled) return mcp;
  const base = mcp ?? [];
  if (base.some((s) => s.name === HOST_SERVER_NAME)) return base;
  return [...base, hostMcpSpec()];
}

/** Layer-1 system-prompt paragraph while dispatch is on (prompt.ts). Absent otherwise — the prod golden fixtures pin that. */
export const DISPATCH_PROMPT_PARAGRAPH =
  `Proposals: the \`host\` MCP tool \`propose\` is the ONLY way to reach beyond this thread — a \`message\` to a project ` +
  `channel, or a \`dispatch\` (a task for another project's agent, answered in a new thread of its channel with a pointer back ` +
  `here). A proposal is a record; a human approves it in this thread (Send / Dismiss) unless the target is auto-approved. Propose ` +
  `once, with refs and a one-line rationale, then finish your turn — never wait for the outcome, never repeat a proposal, and never ` +
  `expect a mention of a project in your text to reach it.`;
