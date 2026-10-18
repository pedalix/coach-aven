// The agent-facing messaging tools (OpenSpec `agent-messaging`, design D9), served on the `host` server
// over the session's control channel: the caller IS the session — its project and conversation come
// from the channel, never from the input. A2A-shaped and non-blocking: every tool returns at once;
// answers arrive later in the conversation (D11).
//
//   send_message, get_task, cancel_task, agents  — sessions of a project with `messaging.send`
//   request_input                                — a shadow conversation answering a task
import type { HostCaller, HostToolDef, ToolResult } from '../hosttools.js';
import type { Messaging, ToolReply } from './service.js';

const out = (r: ToolReply): ToolResult => (r.ok ? { text: JSON.stringify(r.data) } : { text: JSON.stringify({ ok: false, error: r.error }), isError: true });

export function messagingTools(caller: HostCaller, m: Messaging, o: { send: boolean; shadow: boolean }): HostToolDef[] {
  const c = { slug: caller.slug, conversationKey: caller.conversationKey };
  const tools: HostToolDef[] = [];
  if (o.send) {
    tools.push(
      {
        name: 'send_message',
        description:
          'Send another agent a question or a request — A2A SendMessage — in this installation or another one. `target` is ' +
          '"<installation>/<agent>" as `agents` lists it, or "<agent>" for an agent of this installation. Returns {taskId, state} at ' +
          'once; the answer arrives later in this conversation, as data. With `skill`, the task asks for one of the skills the ' +
          'target\'s card offers: the other agent runs that skill on your text. With `taskId` it is your reply to a question the ' +
          'agent asked back (input-required).',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '"<installation>/<agent>" or "<agent>"' },
            text: { type: 'string', description: 'The question or request, self-contained: the other agent sees nothing of this conversation' },
            skill: { type: 'string', description: 'Optional: a skill id from the target\'s card (`agents` lists them); a new task only' },
            taskId: { type: 'string', description: 'Reply on this task (it asked you back)' },
          },
          required: ['target', 'text'],
        },
        call: (args, ctx) => out(m.sendMessage(c, args, ctx?.requestId ?? `${Date.now()}-${Math.random()}`)),
      },
      {
        name: 'get_task',
        description: 'A task this conversation started — A2A GetTask: its state, times and last message, from local state.',
        inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        call: (args) => out(m.getTask(c, args.taskId)),
      },
      {
        name: 'cancel_task',
        description: 'Cancel a task this conversation started — A2A CancelTask. The other agent stops working on it.',
        inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
        call: (args) => out(m.cancelTask(c, args.taskId)),
      },
      {
        name: 'agents',
        description:
          'Who you may ask — agent cards: id, one-line description, the skills it offers you (id, description, tags, examples), ' +
          'whether it takes a new task from you now. Without `installation`: ' +
          'every installation you can reach (this one and each peer installation), with the agents in each that accept you — call it ' +
          'first whenever you are asked to put a question or a request to another team\'s or project\'s agent. With `installation`: ' +
          'that one only; `offline` when it is not reachable.',
        inputSchema: { type: 'object', properties: { installation: { type: 'string' } } },
        call: async (args) => out(await m.agents(c, args.installation)),
      },
    );
  }
  if (o.shadow) {
    tools.push({
      name: 'request_input',
      description:
        'Ask the agent whose task you are answering a question back — A2A input-required. Returns at once; keep working if there is ' +
        'something useful to do. Its reply arrives here, in this turn or as a new one. A task allows a few such questions only.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
        required: ['question'],
      },
      call: (args) => out(m.requestInput(c, args.question, args.options)),
    });
  }
  return tools;
}
