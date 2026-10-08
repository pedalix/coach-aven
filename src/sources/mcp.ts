// The `sources` MCP server inside the sandbox (snapshot/plain/sources-mcp.mjs): how it is
// shipped, launched and described to the agent. The server itself is a dependency-free .mjs
// that runs on the image's Node — see the header of that file for why it is not TypeScript.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { McpServerSpec } from '../projects.js';
import { SOURCES_MOUNT_TARGET } from '../sandboxopts.js';

/** Where the server lives inside every sandbox (baked into the plain image, uploaded into warm ones). */
export const SOURCES_MCP_PATH = '/opt/aven/sources-mcp.mjs';
/** The replica file the server opens (read-only mount from sandboxopts.ts). */
export const SOURCES_DB_PATH = `${SOURCES_MOUNT_TARGET}/store.sqlite`;
/** Server name = tool prefix the agent sees: mcp__sources__search etc. */
export const SOURCES_SERVER_NAME = 'sources';

/** The canonical server script on the bot host (repo-relative; the package ships it). */
export const SOURCES_MCP_SOURCE = new URL('../../snapshot/plain/sources-mcp.mjs', import.meta.url).pathname;

export function sourcesMcpScript(): Buffer {
  return readFileSync(SOURCES_MCP_SOURCE);
}
export function sourcesMcpSha256(script: Buffer = sourcesMcpScript()): string {
  return createHash('sha256').update(script).digest('hex');
}

/** The stdio spec injected into a project's MCP list when it has a `sources` block. */
export function sourcesMcpSpec(): McpServerSpec {
  // --no-warnings: Node 22 (plain image) prints an ExperimentalWarning for node:sqlite on
  // import; keep the MCP client's stderr clean.
  return { name: SOURCES_SERVER_NAME, command: 'node', args: ['--no-warnings', SOURCES_MCP_PATH] };
}

/**
 * Merge the `sources` server into a project's MCP specs. A project that already declares a
 * server named `sources` wins (lets an operator point at a different implementation); with no
 * sources block nothing is added, so every other project's MCP list is byte-identical.
 */
export function withSourcesMcp(mcp: McpServerSpec[] | undefined, sourcesEnabled: boolean): McpServerSpec[] | undefined {
  if (!sourcesEnabled) return mcp;
  const base = mcp ?? [];
  if (base.some((s) => s.name === SOURCES_SERVER_NAME)) return base;
  return [...base, sourcesMcpSpec()];
}

/** Layer-1 system-prompt paragraph for projects with sources (tasks.ts buildSystemPrompt). */
export const SOURCES_PROMPT_PARAGRAPH =
  `Connected sources: the \`sources\` MCP tools (search, get, people, stats) query a READ-ONLY, ` +
  `scrubbed replica of this project's connected mail, chat and calendar at ${SOURCES_DB_PATH}. ` +
  `Search first, then \`get\` the refs you need, and cite the \`permalink\` of anything you quote or ` +
  `rely on. \`[REDACTED:…]\` tags and \`[BODY WITHHELD…]\` markers are deliberate — a secret was ` +
  `removed before it reached you; never ask anyone for the value, never try to reconstruct it, and ` +
  `never treat its absence as a gap to fill. The replica refreshes between turns; \`stats\` tells ` +
  `you what period and sources it covers before you conclude something is missing.`;
