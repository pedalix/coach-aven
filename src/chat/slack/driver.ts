// The Slack chat driver: renders the core's view models to Block Kit (blocks.ts) and
// performs them with a workspace's Web API client. One driver per client — events carry
// their own team's client, recovery resolves one per tenant (DriverForTenant).
//
// Byte-for-byte what the core used to send directly; src/chat/slack/turn.record.test.ts
// pins it against snapshots taken before the move.

import type bolt from '@slack/bolt';
import type { ChatAction, ChatDriver, ConvTarget, DialogRef, Interaction, Mark, MsgRef } from '../driver.js';
import { MARKED_EVENT } from '../driver.js';
import type { DialogView, HomeView, MessageView, PrivateView } from '../views.js';
import type { Tally } from '../../feedback.js';
import {
  MAX_SLACK_TEXT,
  accessBlocks,
  allRoutinesBlocks,
  autofixNotifyBlocks,
  shortRepo,
  ticketCardBlocks,
  answerBlocks,
  backgroundBlocks,
  dmPickerBlocks,
  routineListBlocks,
  statusReportBlocks,
  topicButtons,
  backgroundDoneBlocks,
  feedbackModalView,
  homeBlocks,
  onboardingHomeBlocks,
  questionBlocks,
  reportExpiredView,
  reportModalView,
  reportPostedBlocks,
  reportPromptModalView,
  sessionPanelBlocks,
  statusBlocks,
  ticketLoadingView,
  ticketModalView,
  ticketUnavailableView,
  trailModalView,
  withRatingTally,
} from './blocks.js';
import { fallbackText, mdToMrkdwn } from '../../format.js';
import { proposalBlocks, proposalText } from '../../dispatch.js';
import { log } from '../../log.js';

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
export function renderMessageView(v: MessageView): { text: string; blocks?: any[] } {
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
    case 'projectPicker':
      return { text: 'Which project?', blocks: dmPickerBlocks(v.pid, v.projects) };
    case 'line':
      return { text: v.text };
    case 'proposal':
      return { text: proposalText(v.proposal), blocks: proposalBlocks(v.proposal) };
    case 'relayed':
      return {
        text: v.text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: v.text.slice(0, 2900) } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `proposed by *${v.from}* · ${v.by}` }] },
        ],
      };
    case 'autofixNotice':
      return {
        text: `${shortRepo(v.watch.repo)}#${v.watch.number}: ${v.notes.join('; ')}`,
        blocks: autofixNotifyBlocks(v.watch, v.notes),
      };
    case 'ticketHeader':
      return { text: `:ticket: <${v.url}|${v.ticket.id}> — ${v.ticket.summary}${v.extras ? `  ·  ${v.extras}` : ''}` };
    case 'ticketCard':
      return {
        text: `${v.ticket.id}: ${v.ticket.summary}`,
        blocks: ticketCardBlocks(v.ticket, v.url, v.attachmentNames, v.flaggedBy),
      };
    case 'question':
      return {
        text: v.done ? '✅ Answered' : '❓ The agent has a question',
        blocks: questionBlocks(v.questions, v.picks, v.multi, v.qid, v.done),
      };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function renderPrivateView(v: PrivateView): { text: string; blocks?: any[] } {
  switch (v.kind) {
    case 'text':
      return { text: v.text };
    case 'sessionPanel':
      return { text: `Session — ${v.info.slug}`, blocks: sessionPanelBlocks(v.info, v.value) };
    case 'markdown':
      // Sent as mrkdwn text, NOT markdown blocks: the ephemeral respond/response_url path
      // rejects Slack `markdown` blocks with a 500.
      return { text: `${v.title ? `*${v.title}*\n\n` : ''}${mdToMrkdwn(v.markdown)}${v.note ?? ''}`.slice(0, MAX_SLACK_TEXT) };
    case 'statusReport':
      return { text: 'CoachAven status', blocks: statusReportBlocks(v.report) };
    case 'access':
      return { text: `Access for ${v.project.slug}`, blocks: accessBlocks(v.project) };
    case 'routines':
      return { text: 'Scheduled jobs', blocks: routineListBlocks(v.routines) };
    case 'allRoutines':
      return { text: 'All scheduled jobs', blocks: allRoutinesBlocks(v.groups) };
    case 'memoryIndex':
      return {
        text: `Memory — ${v.slug}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${mdToMrkdwn(v.markdown)}${v.note}`.slice(0, 2900) } },
          ...topicButtons(v.slug, v.topics),
        ],
      };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack view payload
export function renderDialogView(v: DialogView): any {
  switch (v.kind) {
    case 'trail':
      return trailModalView(v.trail);
    case 'feedback':
      return feedbackModalView(v.meta);
    case 'ticketLoading':
      return ticketLoadingView(v.id);
    case 'ticket':
      return ticketModalView(v.issue, v.url, v.comments, v.attachmentNames);
    case 'ticketUnavailable':
      return ticketUnavailableView(v.id, v.url);
    case 'reportPrompt':
      return reportPromptModalView(v.ticket, v.prompt, v.contract, v.meta);
    case 'report':
      return reportModalView(v.ticket, v.draft, v.meta);
    case 'reportExpired':
      return reportExpiredView(v.ticket);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack block union
export function renderHomeView(v: HomeView): any[] {
  return v.kind === 'home' ? homeBlocks(v.projects, v.prefix) : onboardingHomeBlocks();
}

// What a Slack interaction carries that the core never sees: the response_url responder,
// the single-use trigger for modals, and the message's own blocks (a rating refresh writes
// them back with only the vote labels changed — Slack has rewritten the answer by then).
export interface SlackActionCtx {
  respond?: (msg: Record<string, unknown>) => Promise<unknown>;
  triggerId?: string;
  blocks?: unknown[];
}
const ctxOf = (a: Interaction): SlackActionCtx => (a.ctx ?? {}) as SlackActionCtx;

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

// A marked post (agent-messaging D14) carries message metadata the Slack source skips at ingest; an
// unmarked one carries nothing — its calls stay byte-identical (the recorded-call snapshots).
const marker = (marked: boolean | undefined) => (marked ? { metadata: { event_type: MARKED_EVENT, event_payload: {} } } : {});

export function slackDriver(client: bolt.webApi.WebClient): SlackChatDriver {
  return {
    client,
    capabilities: { reactions: true, privateReplies: 'native', threadRepliesNeedMention: false },
    async post(to: ConvTarget, view: MessageView): Promise<MsgRef> {
      const { text, blocks } = renderMessageView(view);
      const posted = await client.chat.postMessage({ channel: to.conv, thread_ts: to.thread, text, blocks, ...marker(to.marked) });
      return { conv: to.conv, id: posted.ts as string, ...(to.marked ? { marked: true as const } : {}) };
    },
    async update(msg: MsgRef, view: MessageView): Promise<void> {
      const { text, blocks } = renderMessageView(view);
      // A text-only headline ('line') never had blocks: change the text alone. Any other update
      // without blocks must clear the old ones (buttons included) — [] does that.
      if (view.kind === 'line') await client.chat.update({ channel: msg.conv, ts: msg.id, text, ...marker(msg.marked) });
      else await client.chat.update({ channel: msg.conv, ts: msg.id, text, blocks: blocks ?? [], ...marker(msg.marked) });
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
    async reply(to: Interaction, view: PrivateView, opts?: { replace?: boolean }): Promise<void> {
      const respond = ctxOf(to).respond;
      if (!respond) throw new Error('no response_url on this interaction');
      const { text, blocks } = renderPrivateView(view);
      await respond({
        response_type: 'ephemeral',
        ...(opts?.replace === undefined ? {} : { replace_original: opts.replace }),
        text,
        ...(blocks ? { blocks } : {}),
      });
    },
    async conversationName(conv: string): Promise<string | undefined> {
      try {
        const r = await client.conversations.info({ channel: conv });
        return (r.channel as { name?: string } | undefined)?.name;
      } catch {
        return undefined; // DM / no access
      }
    },
    async findConversation(name: string): Promise<string | undefined> {
      let cursor: string | undefined;
      do {
        const r = await client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });
        const hit = (r.channels as Array<{ id?: string; name?: string }> | undefined)?.find((c) => c.name === name);
        if (hit?.id) return hit.id;
        cursor = (r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
      } while (cursor);
      return undefined;
    },
    async openDirect(user: string): Promise<string | undefined> {
      try {
        const im = await client.conversations.open({ users: user });
        return im.channel?.id;
      } catch {
        return undefined; // no im:write
      }
    },
    async postPrivate(to: ConvTarget, user: string, view: PrivateView): Promise<void> {
      // chat.postEphemeral, not respond(): only it honours thread_ts (response_url always
      // posts an ephemeral at the channel's top level).
      const { text, blocks } = renderPrivateView(view);
      await client.chat.postEphemeral({ channel: to.conv, user, thread_ts: to.thread, text, blocks });
    },
    async openDialog(action: ChatAction, view: DialogView): Promise<DialogRef | undefined> {
      const trigger = ctxOf(action).triggerId;
      if (!trigger) return undefined;
      const opened = await client.views.open({ trigger_id: trigger, view: renderDialogView(view) });
      return opened.view?.id ? { id: opened.view.id } : undefined;
    },
    async updateDialog(dialog: DialogRef, view: DialogView): Promise<void> {
      await client.views.update({ view_id: dialog.id, view: renderDialogView(view) });
    },
    async refreshRating(action: ChatAction, tally: Tally): Promise<void> {
      const blocks = withRatingTally(ctxOf(action).blocks, tally);
      if (!action.where?.conv || !action.msg?.id || !blocks) return;
      await client.chat
        .update({ channel: action.where.conv, ts: action.msg.id, blocks })
        .catch((e) => log.error(`rating tally: ${e instanceof Error ? e.message : String(e)}`));
    },
    async publishHome(user: string, view: HomeView): Promise<void> {
      await client.views.publish({ user_id: user, view: { type: 'home', blocks: renderHomeView(view) } });
    },
  };
}
