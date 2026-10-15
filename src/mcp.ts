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

// Gateway auth (spec.auth === 'gateway-m2m'): Claude Code asks this helper for headers at
// connect time and again after a 401/403. It reads the token the orchestrator wrote for this
// server (seedGatewayAuth) and the conversation id from AVEN_SESSION (set on the claude
// command line, inherited by the helper — --mcp-config servers keep the process env). The
// token file is re-written every turn, so a 401 after the 24 h expiry picks up the fresh one.
// The server name a project gives its gateway entry in projects.config.json (steps.ts relies
// on it to render `mcp__gw__<target>_<tool>` by target).
export const GATEWAY_SERVER_NAME = 'gw';
export const GATEWAY_DIR = '/root/.aven';
export const GATEWAY_HELPER_PATH = `${GATEWAY_DIR}/gw-headers.sh`;
export const gatewayTokenPath = (serverName: string) => `${GATEWAY_DIR}/gw-token-${serverName}`;
export const GATEWAY_HELPER_SCRIPT = [
  '#!/bin/sh',
  `t=$(cat "${GATEWAY_DIR}/gw-token-\${CLAUDE_CODE_MCP_SERVER_NAME}" 2>/dev/null)`,
  `printf '{"Authorization":"Bearer %s","x-aven-session":"%s"}' "$t" "\${AVEN_SESSION:-}"`,
  '',
].join('\n');

// Build the `mcpServers` object of a Claude Code --mcp-config file from project specs.
// Two spec shapes: a `url` entry is a REMOTE server ({type:'http', url, headers} — e.g.
// the shared mcp-grafana at observe.example.com/mcp), anything else a local stdio
// command ({command, args, env}). Env refs are resolved in `env` and `headers` alike.
export function buildMcpServers(
  mcp: McpServerSpec[],
  source: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const s of mcp) {
    mcpServers[s.name] = s.url
      ? {
          type: 'http',
          url: s.url,
          headers: resolveEnvRefs(s.headers, source),
          ...(s.auth === 'gateway-m2m' ? { headersHelper: GATEWAY_HELPER_PATH } : {}),
        }
      : { command: s.command, args: s.args ?? [], env: resolveEnvRefs(s.env, source) };
  }
  return mcpServers;
}
