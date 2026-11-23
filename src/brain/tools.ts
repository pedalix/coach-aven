// Company brain: the host tool the agent asks for a ticket's or a record's history (design D4, D5). Served on the
// session's own channel beside the messaging tools (hostrouter.ts), so the caller is the session: the project is
// the channel's, never an argument — another project's ticket simply has no entry here.

import type { HostCaller, HostToolDef } from '../hosttools.js';
import { answersFor, historyText, type AnswerEntry, type Later } from './answers.js';
import { readAnswers, readIndex } from './store.js';

export const BRAIN_HISTORY = 'brain_history';

/** How many turns a conversation had after a moment, and when the last one was (the usage log knows every turn). */
export type LaterTurns = (key: string, afterIso: string, turnId: string) => Later;

export function brainTools(caller: HostCaller, later: LaterTurns): HostToolDef[] {
  return [
    {
      name: BRAIN_HISTORY,
      description:
        'What this project already answered about a ticket or a memory record, and how far the record can be trusted. ' +
        'Give a ticket id (e.g. the id in a record\'s `ticket`) or a memory file name. Returns, for each matching ' +
        'record, how many turns started by a person used it and whether it was ever revised after a person\'s reply, ' +
        'then the logged answers oldest first: date, thread link, what was asked, what was answered, and how many ' +
        'turns followed in that conversation. Call it before you answer about a ticket that has a memory record, and ' +
        'before you state a figure or a rule from a `method` or `domain` record.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A ticket id or a memory record file name' } },
        required: ['query'],
        additionalProperties: false,
      },
      call: async (args) => {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return { text: 'brain_history: give a ticket id or a memory record file name in `query`.', isError: true };
        const [index, answers] = await Promise.all([readIndex(caller.slug), readAnswers(caller.slug)]);
        const q = query.toLowerCase().replace(/\.md$/, '');
        const records = (index?.records ?? []).filter((r) => r.name.toLowerCase().replace(/\.md$/, '') === q || r.ticket?.trim().toLowerCase() === q);
        return { text: historyText({ query, answers: answersFor(answers, query), later: (e: AnswerEntry) => later(e.key, e.at, e.turnId), records }) };
      },
    },
  ];
}
