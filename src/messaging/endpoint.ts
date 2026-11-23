// The agents' MCP endpoint for people (OpenSpec `agent-mcp-endpoint`, docs/agent-messaging.md → "People
// in an MCP client"): a person working in an MCP client this project did not build — Claude, Claude Code,
// Langdock — puts a question or a request to an agent of this installation and reads the answer there.
//
// Who does what (design D4, D5):
//   the gateway   terminates TLS, speaks OAuth with the client, verifies the person's token at the
//                 installation's identity provider, and forwards the call here with OUR bearer and the
//                 person in two headers it sets itself (a client's own copy must not survive it)
//   this listener checks the bearer — the gateway is its only caller — and reads the person from the
//                 headers: never from a tool's input
//   the service   decides whether an agent takes that person's task (its `messaging.accept`), runs it in
//                 a shadow conversation and keeps the answer on the task (service.ts, "People")
//
// Stateless streamable HTTP, like `orch sources serve` (the shared shell is src/mcphttp.ts): no session,
// no event stream. A long answer is not pushed: `send_message` and `get_task` take `waitSeconds` and the
// call is held until the task has something to read, at most MAX_WAIT_MS — then the client asks again.
import type { Server } from 'node:http';
import { mcpServer, type HostToolDef, type JsonRpc, type ToolResult } from '../hosttools.js';
import { gate, isLoopback, listenHttp, MCP_PATH, parseListen, parseRpc, rpcReply, type Headers, type HttpReply } from '../mcphttp.js';
import type { Person } from './protocol.js';
import { MAX_WAIT_MS, type Messaging, type ToolReply } from './service.js';

/** The person, as the gateway names them. Fixed names: one more setting would only let an installation trust the wrong header. */
export const USER_HEADER = 'x-mcp-user';
export const GROUPS_HEADER = 'x-mcp-groups';
export const SERVER_NAME = 'coach-aven-agents';

/** The service as the endpoint uses it. */
export type PeopleService = Pick<Messaging, 'personAgents' | 'personSend' | 'personGetTask' | 'personCancel' | 'personWait'>;

export interface EndpointDeps {
  /** The bearer the gateway sends; empty refuses every request. */
  token: string;
  /** The service once it has started; undefined before. */
  messaging: () => PeopleService | undefined;
}

/** The caller of a request: the two identity headers, as sent. The service decides whether the address is usable. */
export const personOf = (headers: Headers): Person => ({
  email: headers[USER_HEADER]?.trim() ?? '',
  groups: (headers[GROUPS_HEADER] ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
});

const out = (r: ToolReply): ToolResult => (r.ok ? { text: JSON.stringify(r.data) } : { text: JSON.stringify({ ok: false, error: r.error }), isError: true });
const WAIT = { type: 'number', description: `Hold the call up to this many seconds (at most ${MAX_WAIT_MS / 1000}) for an answer, a question back or an end; it returns as soon as there is one` };

/** The tool table for one person: the caller is fixed here, whatever the inputs say. */
export function peopleTools(person: Person, m: PeopleService): HostToolDef[] {
  return [
    {
      name: 'agents',
      description:
        'The agents of this installation you may ask — agent cards: name, one-line description, the skills each offers (id, description, examples), ' +
        'and whether it takes a new task from you now. Call it first.',
      inputSchema: { type: 'object', properties: {} },
      call: () => out(m.personAgents(person)),
    },
    {
      name: 'send_message',
      description:
        'Put a question or a request to an agent — a new task. `target` is an agent name from `agents`; `text` must stand on its own: the agent sees nothing of ' +
        'your conversation, and every task starts a fresh session. With `skill`, the agent runs that skill of its card on your text. Returns {taskId, state}; ' +
        'with `waitSeconds` the call waits for the answer and returns it as `last.text` when the state is `completed`. Still `working` after the wait: call ' +
        '`get_task` with the taskId (and `waitSeconds`) until it ends. State `input-required`: the agent asked back in `last.text` — reply with send_message, ' +
        'the same `taskId` and your answer as `text`.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'An agent name as `agents` lists it; not needed for a reply on a task' },
          text: { type: 'string', description: 'The question or request, self-contained — or your reply to the agent\'s question' },
          skill: { type: 'string', description: 'Optional: a skill id from the agent\'s card; a new task only' },
          taskId: { type: 'string', description: 'Reply on this task of yours (it asked you back)' },
          waitSeconds: WAIT,
        },
        required: ['text'],
      },
      call: async (args) => {
        const r = m.personSend(person, args);
        return out(r.ok && args.waitSeconds !== undefined ? await m.personWait(person, r.data.taskId, args.waitSeconds) : r);
      },
    },
    {
      name: 'get_task',
      description: 'A task you started: its state, times and last message — the answer when `completed`, the agent\'s question when `input-required`, the reason when it ended otherwise.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, waitSeconds: WAIT }, required: ['taskId'] },
      call: async (args) => out(await m.personWait(person, args.taskId, args.waitSeconds)),
    },
    {
      name: 'cancel_task',
      description: 'Cancel a task you started. The agent stops working on it.',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
      call: (args) => out(m.personCancel(person, args.taskId)),
    },
  ];
}

/** One HTTP request → its reply. Exported so the tests cover the whole surface without a socket. */
export async function handleEndpoint(method: string, url: string, headers: Headers, body: string, d: EndpointDeps): Promise<HttpReply> {
  const path = url.split('?')[0] ?? url;
  if (path === '/health' && method === 'GET') return { status: 200, body: JSON.stringify({ ok: true }), headers: { 'content-type': 'application/json' } };
  if (path !== MCP_PATH) return { status: 404, body: '', headers: {} };
  const refused = gate(method, headers, d.token);
  if (refused) return refused;
  const m = d.messaging();
  if (!m) return { status: 503, body: '', headers: { 'retry-after': '5' } }; // the bot is still starting
  const rpc = parseRpc(body);
  if ('status' in rpc) return rpc;
  const server = mcpServer(SERVER_NAME, peopleTools(personOf(headers), m));
  const responses: JsonRpc[] = [];
  for (const msg of rpc.batch) {
    const r = await server(msg as JsonRpc);
    if (r) responses.push(r);
  }
  return rpcReply(responses, rpc.isBatch, headers);
}

export interface EndpointSettings {
  listen: string;
  token: string;
}

/** Start the listener; resolves with the server once bound. A non-loopback bind is the operator's choice and is said out loud. */
export async function startEndpoint(s: EndpointSettings, d: Omit<EndpointDeps, 'token'>, log: { info(line: string): void; warn(line: string): void; error(line: string): void }): Promise<Server> {
  const { host } = parseListen(s.listen);
  const server = await listenHttp(s.listen, (method, url, headers, body) => handleEndpoint(method, url, headers, body, { ...d, token: s.token }), (e) => log.error(`agents MCP endpoint: ${e instanceof Error ? e.message : String(e)}`));
  // A held call (waitSeconds) outlives Node's default keep-alive window on purpose; nothing else is slow here.
  server.requestTimeout = MAX_WAIT_MS + 30_000;
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  log.info(`agents MCP endpoint: http://${host}:${port}${MCP_PATH} — people named by the gateway (${USER_HEADER}, ${GROUPS_HEADER})`);
  if (!isLoopback(host)) log.warn(`agents MCP endpoint: bound to ${host}, not loopback — whoever reaches this port with the bearer names any person; only the gateway may`);
  return server;
}
