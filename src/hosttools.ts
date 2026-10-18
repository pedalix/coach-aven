// Host tools — MCP servers the BOT implements and serves to the agent over the session's own
// control channel (OpenSpec `host-tools`, docs/runtime-config.md → "Host tools"). Claude Code lets
// the controlling process register in-process MCP servers at `initialize` (`sdkMcpServers`) and then
// routes their handshake and every tools/call back as `control_request{mcp_message}`; the reply
// travels in `control_response.response.mcp_response` (the Agent SDK's own mechanism, verified on
// the pinned CLI with scripts/host-tools-smoke.mjs). No mount, no listener, no credential in the
// sandbox: a call rides the pipe the bot already drives turns through, so the CALLER IS THE
// SESSION — its project and conversation come from the channel, never from a field in the input.
// claudeSession.ts speaks the framing; hostrouter.ts composes the per-session routes; this module
// is the pure part — the JSON-RPC server over a tool table. The `host` tools themselves are agent
// messaging's (messaging/tools.ts); the dispatch primitive's propose/registry were retired
// (OpenSpec `retire-agent-dispatch`).

/** A JSON-RPC 2.0 message as MCP carries it (request, notification or response). */
export interface JsonRpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Who is calling: the session's project and conversation (turn.ts fixes them when the session opens). */
export interface HostCaller {
  slug: string;
  conversationKey: string;
  teamId?: string;
}

/** One in-process server as the session registers it: a name the CLI addresses, and the handler for its messages. */
export interface HostServerRoute {
  name: string;
  /** Per-server tools/call timeout the CLI enforces (sdkMcpServerConfigs); unset → the CLI default. */
  timeoutMs?: number;
  /** A request → its response; a notification → undefined (the session acknowledges it). */
  handle: (message: JsonRpc, ctx?: CallContext) => Promise<JsonRpc | undefined> | JsonRpc | undefined;
}

/**
 * The control request a message came in: its `request_id` is a fresh UUID per call and the same when
 * a restarted bot serves a pending call again — what a tool with an effect derives its ids from
 * (agent-messaging D9 step 4). The JSON-RPC id inside is a per-process counter and is not.
 */
export interface CallContext {
  requestId?: string;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}
export interface HostToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>, ctx?: CallContext) => Promise<ToolResult> | ToolResult;
}

/** The MCP revision this server speaks when the client names none; a named one is echoed (the CLI's client picks). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Pure: the MCP JSON-RPC subset an in-process server needs — initialize, ping, tools/list,
 * tools/call — over a fixed tool table. A notification (no id) returns undefined; a tool that
 * throws answers as a tool error (the agent must read it), never as a JSON-RPC error.
 */
export function mcpServer(name: string, tools: readonly HostToolDef[], version = '1.0.0'): (message: JsonRpc, ctx?: CallContext) => Promise<JsonRpc | undefined> {
  return async (m, ctx) => {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return undefined; // a response or junk: nothing to answer
    const id = m.id;
    if (id === undefined || id === null) return undefined; // notification
    const ok = (result: unknown): JsonRpc => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string): JsonRpc => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const pv = m.params?.protocolVersion;
        return ok({ protocolVersion: typeof pv === 'string' && pv ? pv : MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name, version } });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) });
      case 'tools/call': {
        const wanted = m.params?.name;
        const tool = tools.find((t) => t.name === wanted);
        if (!tool) return err(-32602, `unknown tool ${JSON.stringify(wanted ?? null)}`);
        const raw = m.params?.arguments;
        const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        try {
          const r = await tool.call(args, ctx);
          return ok({ content: [{ type: 'text', text: r.text }], isError: r.isError === true });
        } catch (e) {
          return ok({ content: [{ type: 'text', text: `${tool.name} failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
        }
      }
      default:
        return err(-32601, `method not found: ${m.method}`);
    }
  };
}
