import type { McpServerSpec } from './projects.js';

// Resolve ${ENV_NAME} refs from the orchestrator's env (so secrets — a Grafana token,
// an MCP endpoint's auth header — live in the orchestrator's .env, not the project
// config / the sandbox config). Unknown refs resolve to '' rather than leaking the
// literal `${...}` into the sandbox.
function resolveEnvRefs(
  values: Record<string, string> | undefined,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    out[k] = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => source[name] ?? '');
  }
  return out;
}

// Build the `mcpServers` object of a Claude Code --mcp-config file from project specs.
// Two spec shapes: a `url` entry is a REMOTE server ({type:'http', url, headers} — e.g.
// the shared mcp-grafana at <grafana-host>/mcp), anything else a local stdio
// command ({command, args, env}). Env refs are resolved in `env` and `headers` alike.
export function buildMcpServers(
  mcp: McpServerSpec[],
  source: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const s of mcp) {
    mcpServers[s.name] = s.url
      ? { type: 'http', url: s.url, headers: resolveEnvRefs(s.headers, source) }
      : { command: s.command, args: s.args ?? [], env: resolveEnvRefs(s.env, source) };
  }
  return mcpServers;
}
