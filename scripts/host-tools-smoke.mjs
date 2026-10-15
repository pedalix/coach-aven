#!/usr/bin/env node
// Protocol smoke for host tools (OpenSpec `host-tools`): spawn a REAL `claude` the way claudeSession.ts
// does, register one in-process MCP server over the control channel (`initialize` → sdkMcpServers),
// answer its handshake and tools/call as control_request{mcp_message}, and check the model actually
// called the tool and got its result. Run it on every Claude Code pin bump, INSIDE a sandbox (the
// pinned CLI + the seeded token):
//   docker cp scripts/host-tools-smoke.mjs proj-<slug>:/tmp/ && docker exec proj-<slug> sh -lc \
//     'export CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token) IS_SANDBOX=1 DISABLE_AUTOUPDATER=1; node /tmp/host-tools-smoke.mjs'
// Exit 0 = the tools/call round trip happened; 2–4 = it did not (see the log). Costs one tiny turn.
import { spawn } from 'node:child_process';
const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio', '--strict-mcp-config', ...(process.env.SMOKE_MODEL ? ['--model', process.env.SMOKE_MODEL] : [])];
const p = spawn('claude', args, { cwd: process.env.SMOKE_CWD || '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const write = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const seen = [];
let buf = '';
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const tools = [{ name: 'ping', description: 'Echo test tool of the orchestrator', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
function mcpAnswer(msg) {
  if (msg.id === undefined) return { jsonrpc: '2.0', result: {}, id: 0 }; // notification ack, as the SDK does
  const m = msg.method;
  if (m === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'host', version: '0.0.1' } } };
  if (m === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools } };
  if (m === 'tools/call') {
    seen.push({ name: msg.params?.name, args: msg.params?.arguments });
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `pong:${msg.params?.arguments?.text ?? ''}` }] } };
  }
  if (m === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} };
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${m}` } };
}
p.stdout.on('data', (c) => {
  buf += c.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'control_response') { log(`control_response ${JSON.stringify(ev.response).slice(0, 200)}`); continue; }
    if (ev.type === 'control_request' && ev.request?.subtype === 'mcp_message') {
      const msg = ev.request.message;
      log(`mcp_message ← server=${ev.request.server_name} method=${msg.method ?? '(response)'} id=${msg.id}`);
      write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { mcp_response: mcpAnswer(msg) } } });
      continue;
    }
    if (ev.type === 'control_request') { log(`control_request ${ev.request?.subtype} ${JSON.stringify(ev.request).slice(0, 160)}`); write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { behavior: 'allow', updatedInput: ev.request?.input ?? {} } } }); continue; }
    if (ev.type === 'system' && ev.subtype === 'init') { log(`init: mcp_servers=${JSON.stringify(ev.mcp_servers)} tools=${(ev.tools || []).filter((t) => t.startsWith('mcp__')).join(',')}`); continue; }
    if (ev.type === 'assistant') { for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') log(`tool_use ${b.name} ${JSON.stringify(b.input)}`); continue; }
    if (ev.type === 'result') { log(`result is_error=${ev.is_error} cost=${ev.total_cost_usd} text=${JSON.stringify(ev.result).slice(0, 200)}`); log(`tools/call seen: ${JSON.stringify(seen)}`); p.kill('SIGTERM'); process.exit(seen.length ? 0 : 2); }
  }
});
p.stderr.on('data', (c) => { const s = c.toString().trim(); if (s) log(`stderr: ${s.slice(0, 300)}`); });
p.on('exit', (code) => { log(`claude exited ${code}`); process.exit(seen.length ? 0 : 3); });
write({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize', sdkMcpServers: ['host'], sdkMcpServerConfigs: { host: { timeout: 30000 } } } });
write({ type: 'user', message: { role: 'user', content: 'Call the `ping` tool of the `host` MCP server with text "x" and reply with exactly the text it returns, nothing else.' } });
setTimeout(() => { log('timeout'); p.kill('SIGTERM'); process.exit(4); }, 110_000);
