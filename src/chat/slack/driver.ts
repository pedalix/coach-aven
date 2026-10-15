// The Slack chat driver: renders the core's view models to Block Kit (blocks.ts) and
// performs them with a workspace's Web API client. One driver per client — events carry
// their own team's client, recovery resolves one per tenant (DriverForTenant).
//
// Byte-for-byte what the core used to send directly; src/chat/slack/turn.record.test.ts
// pins it against snapshots taken before the move.

import type bolt from '@slack/bolt';
import type { ChatDriver, ConvTarget, Mark, MsgRef } from '../driver.js';
import type { TurnView } from '../views.js';
import {
  answerBlocks,
  backgroundBlocks,
  backgroundDoneBlocks,
  questionBlocks,
  reportPostedBlocks,
  statusBlocks,
} from '../../blocks.js';
import { fallbackText } from '../../format.js';

// Reaction a skipped "!" note gets (configurable — some workspaces lack the default emoji).
const NOTE_REACTION = process.env.SLACK_NOTE_REACTION || 'shushing_face';
const REACTION: Record<Mark, string> = {
  working: 'eyes',
  done: 'white_check_mark',
  failed: 'x',
  note: NOTE_REACTION,
};

// Pure: a view → the text + blocks Slack gets. `blocks` undefined = a text-only message.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function renderTurnView(v: TurnView): { text: string; blocks?: any[] } {
  switch (v.kind) {
    case 'status':
      return { text: v.notify, blocks: statusBlocks(v.line, v.turnId) };
    case 'text':
      return { text: v.text };
    case 'background':
      return { text: 'Working in the background…', blocks: backgroundBlocks(v.turnId, v.elapsedMs) };
    case 'backgroundDone':
      return { text: v.label, blocks: backgroundDoneBlocks(v.label, { steps: v.steps, elapsedMs: v.elapsedMs }) };
    case 'answer': {
      const blocks = answerBlocks(v.markdown, v.opts);
      if (v.notice) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: v.notice }] });
      return { text: fallbackText(v.markdown), blocks };
    }
    case 'reported':
      return { text: `✅ Reported to ${v.ticket}`, blocks: reportPostedBlocks(v.markdown, v.ticket, v.url, v.group) };
    case 'question':
      return { text: '❓ The agent has a question', blocks: questionBlocks(v.questions, v.picks, v.multi, v.qid, v.done) };
  }
}

// Resolves a workspace's Web API client (undefined = home). Throws for a tenant with no
// live installation — callers treat that per record, never letting one uninstalled
// workspace abort a whole loop (recovery, pollers, dispatch).
export type ClientForTeam = (tenantId?: string) => bolt.webApi.WebClient;

// The Slack driver keeps its workspace client visible: Slack-side code (and the tenant
// twin tests, which assert WHICH workspace's token drove a turn) can reach it; the core
// only ever sees ChatDriver.
export interface SlackChatDriver extends ChatDriver {
  readonly client: bolt.webApi.WebClient;
}

export function slackDriver(client: bolt.webApi.WebClient): SlackChatDriver {
  return {
    client,
    capabilities: { reactions: true, privateReplies: 'native', threadRepliesNeedMention: false },
    async post(to: ConvTarget, view: TurnView): Promise<MsgRef> {
      const { text, blocks } = renderTurnView(view);
      const posted = await client.chat.postMessage({ channel: to.conv, thread_ts: to.thread, text, blocks });
      return { conv: to.conv, id: posted.ts as string };
    },
    async update(msg: MsgRef, view: TurnView): Promise<void> {
      const { text, blocks } = renderTurnView(view);
      // An update with no blocks must clear the old ones (buttons included) — [] does that.
      await client.chat.update({ channel: msg.conv, ts: msg.id, text, blocks: blocks ?? [] });
    },
    async mark(msg: MsgRef, mark: Mark, op: 'add' | 'remove'): Promise<void> {
      const args = { channel: msg.conv, timestamp: msg.id, name: REACTION[mark] };
      try {
        if (op === 'add') await client.reactions.add(args);
        else await client.reactions.remove(args);
      } catch {
        /* non-fatal: already_reacted / no_reaction / missing scope */
      }
    },
    async permalink(msg: MsgRef): Promise<string | undefined> {
      try {
        const pl = await client.chat.getPermalink({ channel: msg.conv, message_ts: msg.id });
        return pl.permalink as string | undefined;
      } catch {
        return undefined; // DM / missing scope — the traceability line is simply omitted
      }
    },
  };
}
