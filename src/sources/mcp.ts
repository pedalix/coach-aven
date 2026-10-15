// The `sources` MCP server as the agent sees it, and how the system prompt describes it. Since
// host-tools the server runs in the BOT: hostrouter.ts answers its JSON-RPC over the session's
// control channel from the replica on this disk (the same `handleMessage` of
// snapshot/plain/sources-mcp.mjs that `orch sources serve` exposes over HTTP). The sandbox holds
// no copy of the script, mounts nothing and has no `sources` entry in its --mcp-config; the
// agent still sees `mcp__sources__search` etc., exactly as before.
import type { McpServerSpec } from '../projects.js';

/** Server name = tool prefix the agent sees: mcp__sources__search etc. */
export const SOURCES_SERVER_NAME = 'sources';

/**
 * The zone the server reads bare dates and zone-less datetimes in ("since 2026-10-07" = that
 * whole day where the person lives). The agent runs in UTC without tzdata, so this is the one
 * place "today" is decided: the bot's AVEN_TZ (= ROUTINE_TZ in pollers.ts, read here directly
 * to keep this module import-light), applied to the tool table once at boot (hostrouter.ts).
 */
export function sourcesTimezone(): string {
  return process.env.AVEN_TZ || 'UTC';
}

/**
 * Pure: does the bot serve `sources` over the session channel for this project? Yes for a project
 * with a `sources` block — unless it declares its own `sources` server with a `url` (a daemon the
 * sandbox reaches directly, docs/sources.md → "Remote access"); then that URL is the server and the
 * bot registers nothing, so the two never compete for the name.
 */
export function channelSourcesEnabled(sources: boolean, mcp: McpServerSpec[] | undefined): boolean {
  return sources && !(mcp ?? []).some((s) => s.name === SOURCES_SERVER_NAME && !!s.url);
}

/** Layer-1 system-prompt paragraph for projects with sources (prompt.ts buildSystemPrompt). */
export const SOURCES_PROMPT_PARAGRAPH =
  `Connected sources: the \`sources\` MCP tools (search, get, transcript, tasks, meetings, calendar, activity, fragments, attribution, unanswered, stuck, people, stats) ` +
  `query a READ-ONLY, scrubbed replica of this project's connected mail, chat, calendar, trackers and recorded calls, served by the orchestrator. ` +
  `\`initiative\` filters and \`fragments\` reflect only what the project's own review has attributed — absence there is not evidence. ` +
  `\`unanswered\` (what waits for a reply) and \`stuck\` (open tickets that stopped moving) are THE source for those two lists — ` +
  `quote their rows and permalinks instead of rebuilding them from \`search\`/\`tasks\`. ` +
  `Search first, then \`get\` the refs you need, and cite the \`permalink\` of anything you quote or ` +
  `rely on. \`[REDACTED:…]\` tags and \`[BODY WITHHELD…]\` markers are deliberate — a secret was ` +
  `removed before it reached you; never ask anyone for the value, never try to reconstruct it, and ` +
  `never treat its absence as a gap to fill. Call transcripts are long and never inlined: for a question that needs ` +
  `reading one, spawn one Agent with the question + ref; it pages/filters \`transcript\` and returns ≤30 quoted lines. ` +
  `The replica refreshes between turns; \`stats\` tells you what period and sources it covers before you conclude ` +
  `something is missing. If a \`sources\` call fails because the replica is unavailable, say so in one line and finish ` +
  `the turn — do not sleep, poll or ScheduleWakeup for it; the orchestrator re-runs failed scheduled turns itself. If the ` +
  `store is present but a source is older than its pull interval (see \`stats.meta\`), name that source and its last pull ` +
  `and continue with what you have.`;
