#!/usr/bin/env node
// `host` — the MCP stdio server through which a sandbox agent asks the BOT HOST to do something it
// cannot do itself (docs/runtime-config.md → "Dispatch"). One tool today: `propose`, a side effect
// — a message to a channel, or a task for another project's agent — that the host renders in the
// agent's own thread with Send / Dismiss. The agent never executes anything; it writes a record.
//
// Transport (phase A): the record is a JSON file in /data/outbox, a per-project directory the host
// bind-mounts read-write into the sandbox (sandboxopts.ts withOutboxMount) and polls every few
// seconds (pollers.ts). tmp + rename, so the host never reads a half-written file. The record
// carries AVEN_SESSION (the conversation key, exported into the claude process) so the host knows
// which thread to render in. Same dependency-free, single-file shape as sources-mcp.mjs, for the
// same reason: it runs on the image's Node and is uploaded into warm sandboxes by sha.
import { mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const DEFAULT_OUTBOX = '/data/outbox';
export const SERVER_NAME = 'host';
export const SERVER_VERSION = '1.0.0';
export const PROTOCOL_VERSION = '2025-06-18';
export const KINDS = ['message', 'dispatch'];
export const MAX_TEXT = 4000;
export const MAX_REFS = 20;

export const TOOLS = [
  {
    name: 'propose',
    description:
      'Propose a side effect for the host to execute after a human approves it in YOUR thread (Send / Dismiss). ' +
      'kind `message`: post `text` to a Slack channel on the bot\'s behalf (target = project slug or channel id). ' +
      'kind `dispatch`: open a task for ANOTHER project\'s agent (target = project slug) in a new thread of its channel; ' +
      'its answer is posted there and a pointer comes back to your thread. The proposal is a record, not an action: ' +
      'nothing happens until approved (or the tenant auto-approves the target). Mentioning a project in text never ' +
      'dispatches — only this tool does. `refs` = permalinks/ticket urls the task rests on; `rationale` = one line why. ' +
      'Returns the proposal id; the buttons appear in your thread within a few seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        target: { type: 'string', description: 'Project slug (dispatch or message) or a Slack channel id C…/G… (message)' },
        text: { type: 'string', description: `The message or the task, ≤ ${MAX_TEXT} chars` },
        refs: { type: 'array', items: { type: 'string' }, description: `Permalinks / ticket urls, ≤ ${MAX_REFS}` },
        rationale: { type: 'string', description: 'One line: why this, why now' },
      },
      required: ['kind', 'target', 'text'],
    },
  },
];

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Pure: arguments → a proposal record, or an error string. Exported for the host's tests. */
export function makeProposal(args, env = process.env, now = new Date()) {
  const kind = String(args?.kind ?? '');
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(', ')}` };
  const target = String(args?.target ?? '').trim();
  if (!TARGET_RE.test(target)) return { error: 'target must be a project slug or a Slack channel id' };
  const text = String(args?.text ?? '').trim();
  if (!text) return { error: 'text is required' };
  if (text.length > MAX_TEXT) return { error: `text is ${text.length} chars; the limit is ${MAX_TEXT}` };
  const refsRaw = args?.refs === undefined ? [] : args.refs;
  if (!Array.isArray(refsRaw) || refsRaw.some((r) => typeof r !== 'string')) return { error: 'refs must be an array of strings' };
  const refs = refsRaw.map((r) => r.trim()).filter(Boolean).slice(0, MAX_REFS);
  const rationale = String(args?.rationale ?? '').trim().slice(0, 500);
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const id = `p-${stamp}-${randomBytes(3).toString('hex')}`;
  return { record: { id, kind, target, text, refs, rationale, session: String(env.AVEN_SESSION ?? ''), createdAt: now.toISOString() } };
}

/** tmp + rename into the outbox; the host claims files by renaming them, so a half-written file is never read. */
export function writeProposal(record, dir = process.env.HOST_OUTBOX || DEFAULT_OUTBOX) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = `${dir}/propose-${record.id}.json`;
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o644 });
  renameSync(tmp, target);
  return target;
}

export function callTool(name, args, dir) {
  if (name !== 'propose') throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  const r = makeProposal(args ?? {});
  if (r.error) return { ok: false, error: r.error };
  const path = writeProposal(r.record, dir);
  return { ok: true, id: r.record.id, kind: r.record.kind, target: r.record.target, note: 'recorded; the host renders Send / Dismiss in your thread within ~5 s (or executes it if the target is auto-approved). Do not repeat the proposal.', path };
}

export function handleMessage(msg, dir) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined;
  const reply = (result) => (isNotification ? undefined : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotification ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
  try {
    switch (method) {
      case 'initialize': {
        const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        return reply({
          protocolVersion: requested < PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Host side effects by proposal: `propose` records a message or a task for another agent; a human approves it in your thread. Propose once, then finish your turn — never wait for the outcome.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name;
        try {
          const result = callTool(name, (params && params.arguments) || {}, dir);
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok });
        } catch (e) {
          if (e && e.code === -32602) return fail(-32602, e.message);
          return reply({ content: [{ type: 'text', text: `error: ${e && e.message ? e.message : String(e)}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32603, e && e.message ? e.message : String(e));
  }
}

export function serve(dir = process.env.HOST_OUTBOX || DEFAULT_OUTBOX, input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const res = handleMessage(m, dir);
      if (res) output.write(JSON.stringify(res) + '\n');
    }
  });
  rl.on('close', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve();
}
