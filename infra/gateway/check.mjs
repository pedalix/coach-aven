#!/usr/bin/env node
// What a credential sees on a gateway route: the instructions the agent reads when its session
// starts, and the tools that are left after the route's rules. Node 18+, no dependencies.
//
//   GW_BEARER=<key or token> node check.mjs http://127.0.0.1:4600/gw/shop/mcp
//   GW_BEARER=<key or token> node check.mjs http://127.0.0.1:4600/gw/shop/mcp sentry_search_issues '{"query":"is:unresolved"}'
//
// With a tool name (and its arguments as JSON) it also calls that tool. The list proves the route
// and the key; only a call proves the upstream's own credential, because a server may list its
// tools to anyone.
//
// The credential comes from the environment, so it stays out of the process list and the shell
// history. Without GW_BEARER the script asks as nobody: a strict route answers 401. Exit status 1
// when the route does not answer the handshake with 200, or the call fails.
const [url, tool, toolArgs] = process.argv.slice(2);
if (!url) {
  console.error("usage: GW_BEARER=<key or token> node check.mjs <route url> [<tool> ['<arguments as JSON>']]");
  process.exit(2);
}
const bearer = process.env.GW_BEARER;
let session = null;
let id = 0;

async function rpc(method, params, notification = false) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method, params }),
  });
  session = res.headers.get('mcp-session-id') ?? session;
  const text = await res.text();
  // A streamable-HTTP answer is JSON, or an event stream whose last `data:` line is the JSON.
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() ?? text;
  let json = null;
  try { json = JSON.parse(data); } catch { /* not JSON: the caller prints the text */ }
  return { status: res.status, challenge: res.headers.get('www-authenticate'), json, text };
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-check', version: '1' } });
if (init.status !== 200) {
  console.log(`HTTP ${init.status} ${init.text.trim().slice(0, 200)}`);
  if (init.challenge) console.log(`www-authenticate: ${init.challenge}`);
  process.exit(1);
}
await rpc('notifications/initialized', {}, true);
const info = init.json?.result ?? {};
console.log(`server: ${info.serverInfo?.name ?? '?'} ${info.serverInfo?.version ?? ''}`);
if (info.instructions) console.log(`instructions:\n${info.instructions.trim().replace(/^/gm, '  ')}`);
const tools = (await rpc('tools/list', {})).json?.result?.tools ?? [];
console.log(`tools (${tools.length}):`);
for (const t of tools) console.log(`  ${t.name}`);
if (tool) {
  const call = await rpc('tools/call', { name: tool, arguments: toolArgs ? JSON.parse(toolArgs) : {} });
  const failure = call.json?.error ?? (call.json?.result?.isError ? call.json.result : null);
  const text = (call.json?.result?.content ?? []).map((c) => c.text ?? '').join('\n').trim();
  console.log(`call ${tool}: ${failure ? 'FAILED' : 'ok'}`);
  console.log((call.json?.error ? JSON.stringify(call.json.error) : text || call.text.trim()).slice(0, 600).replace(/^/gm, '  '));
  if (failure || call.status !== 200) process.exit(1);
}
