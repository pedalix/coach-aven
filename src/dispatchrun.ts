// Dispatch primitive, the IO half (pure half: dispatch.ts). Owns the three verbs — ingest a
// proposal from a project's outbox, approve/dismiss it, execute it — and talks to Slack, the
// turn engine and state.json. Constructed once in slack.ts and handed to pollers.ts (outbox
// poll, auto mode) and events.ts (the buttons). Nothing here runs unless DISPATCH=1.
import type bolt from '@slack/bolt';
import type { Store } from './state.js';
import type { TurnEngine } from './turn.js';
import { slackDriver, type ClientForTeam } from './chat/slack/driver.js';
import type { Channels } from './channels.js';
import { resolveBySlug, teamProjects, type ProjectConfig, type RegistryRef } from './projects.js';
import { withTeam } from './teamkeys.js';
import { headline } from './routinerun.js';
import { localDate } from './routineguard.js';
import { log } from './log.js';
import {
  consumeProposals,
  dispatch,
  gateDecision,
  outboxDir,
  parseProposal,
  proposalBlocks,
  proposalText,
  sessionThread,
  wrapDispatch,
  type StoredProposal,
} from './dispatch.js';

export interface DispatcherDeps {
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  clientFor: ClientForTeam;
  home: () => string | undefined;
  tz: string;
  now?: () => Date;
}

export interface Dispatcher {
  /** One pass over every project's outbox (pollers.ts, every few seconds). */
  pollOutboxes(): void;
  /** Send clicked: executes once (idempotent on id); returns the fresh record for the message rewrite. */
  approve(client: bolt.webApi.WebClient, id: string, userId: string): Promise<StoredProposal | undefined>;
  dismiss(id: string, userId: string): StoredProposal | undefined;
}

const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;

export function createDispatcher(d: DispatcherDeps): Dispatcher {
  const now = d.now ?? (() => new Date());
  const projectOf = (slug: string): ProjectConfig | undefined => resolveBySlug(d.reg.current, slug);

  // Rewrite the proposal message in its thread to the record's current state (best-effort).
  async function render(client: bolt.webApi.WebClient, p: StoredProposal): Promise<void> {
    if (!p.channel || !p.messageTs) return;
    await client.chat.update({ channel: p.channel, ts: p.messageTs, text: proposalText(p), blocks: proposalBlocks(p) }).catch((e: unknown) => log.warn(`dispatch ${p.id}: render failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // The target channel of a message/dispatch: a raw channel id, or the target project's bound channel.
  async function targetChannel(client: bolt.webApi.WebClient, p: StoredProposal): Promise<{ channel: string; project?: ProjectConfig } | { error: string }> {
    if (p.kind === 'message' && CHANNEL_ID_RE.test(p.target)) return { channel: p.target };
    const project = projectOf(p.target);
    if (!project) return { error: `unknown target project "${p.target}"` };
    // The target must be a project this tenant is served for — a proposal must not reach across workspaces.
    if (!teamProjects(d.reg.current, p.teamId ?? d.home(), d.home()).some((x) => x.slug === project.slug)) return { error: `project "${p.target}" is not available to this workspace` };
    const channel = await d.channels.channelIdForSlug(client, project, p.teamId);
    if (!channel) return { error: `project "${p.target}" has no bound channel` };
    return { channel, project };
  }

  async function execute(client: bolt.webApi.WebClient, p: StoredProposal): Promise<StoredProposal> {
    const t = await targetChannel(client, p);
    if ('error' in t) return d.store.patchProposal(p.id, { status: 'failed', result: t.error }) ?? p;
    const source = projectOf(p.slug);
    const by = p.approvedBy === 'auto' ? `auto-approved (${p.slug} config)` : `approved by <@${p.approvedBy}>`;
    if (p.kind === 'message') {
      const res = await client.chat.postMessage({
        channel: t.channel,
        text: p.text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: p.text.slice(0, 2900) } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `proposed by *${p.slug}* · ${by}` }] },
        ],
      });
      const link = await client.chat.getPermalink({ channel: t.channel, message_ts: res.ts as string }).then((r) => r.permalink as string).catch(() => undefined);
      d.store.bumpDispatch(p.slug, localDate(d.tz, now()));
      return d.store.patchProposal(p.id, { status: 'sent', result: link ? `<${link}|posted in <#${t.channel}>>` : `posted in <#${t.channel}>` }) ?? p;
    }
    // dispatch: a fresh thread in the target's channel, the task as data, the answer back as a pointer.
    const target = t.project!;
    const label = `📨 Task from ${p.slug}`;
    const parent = await client.chat.postMessage({ channel: t.channel, text: `${label} · running… (proposal ${p.id}, ${by})` });
    const parentTs = parent.ts as string;
    const key = withTeam(p.teamId, d.home(), `thread:${parentTs}`);
    const link = await client.chat.getPermalink({ channel: t.channel, message_ts: parentTs }).then((r) => r.permalink as string).catch(() => undefined);
    const pointer = async (text: string): Promise<void> => {
      if (!p.channel || !p.threadTs) return;
      await client.chat.postMessage({ channel: p.channel, thread_ts: p.threadTs, text }).catch(() => {});
    };
    d.store.bumpDispatch(p.slug, localDate(d.tz, now()));
    const stored = d.store.patchProposal(p.id, { status: 'sent', result: link ? `<${link}|thread in <#${t.channel}>>` : `thread in <#${t.channel}>` }) ?? p;
    void d.engine
      .liveTurn(slackDriver(client), t.channel, undefined, parentTs, key, target, wrapDispatch(stored), undefined, {
        origin: { slug: p.slug, proposalId: p.id },
        onAnswer: async (text) => {
          const head = headline(text);
          await client.chat.update({ channel: t.channel, ts: parentTs, text: `${label} — ${head || 'done'}` }).catch(() => {});
          await pointer(`↩️ ${p.kind} ${p.id} → ${link ? `<${link}|${target.slug}>` : target.slug}: ${head || 'done'}`);
        },
        onSettle: async (outcome, reason) => {
          if (outcome === 'ok') return;
          await client.chat.update({ channel: t.channel, ts: parentTs, text: `⚠️ ${label} — ${outcome}${reason ? `: ${reason.split('\n')[0]!.slice(0, 160)}` : ''}` }).catch(() => {});
          await pointer(`↩️ ${p.kind} ${p.id} → ${target.slug}: ${outcome}${reason ? ` — ${reason.split('\n')[0]!.slice(0, 160)}` : ''}`);
        },
      })
      .catch((e: unknown) => log.error(`dispatch ${p.id}: child turn failed to start: ${e instanceof Error ? e.message : String(e)}`));
    return stored;
  }

  async function ingest(slug: string, raw: unknown, file: string): Promise<void> {
    const parsed = parseProposal(raw);
    if (!parsed.ok) {
      log.warn(`dispatch (${slug}): ${file} rejected — ${parsed.error}`);
      return;
    }
    const rec = parsed.record;
    if (d.store.getProposal(rec.id)) {
      log.info(`dispatch (${slug}): ${rec.id} already known — ignored`);
      return;
    }
    const project = projectOf(slug);
    if (!project) return;
    const { teamId, threadTs } = sessionThread(rec.session);
    const client = d.clientFor(teamId);
    const chat = threadTs ? d.store.getChat(threadTs) : undefined;
    const channel = chat?.inflight?.channel ?? (await d.channels.channelIdForSlug(client, project, teamId));
    const p: StoredProposal = { ...rec, slug, ...(teamId ? { teamId } : {}), status: 'pending', receivedAt: now().toISOString(), ...(channel ? { channel } : {}), ...(threadTs ? { threadTs } : {}) };
    d.store.setProposal(p);
    const gate = gateDecision(rec, project.dispatch, d.store.dispatchCount(slug, localDate(d.tz, now())));
    if (gate.auto) {
      const approved = d.store.patchProposal(p.id, { approvedBy: 'auto', approvedAt: now().toISOString() }) ?? p;
      log.info(`dispatch (${slug}): ${p.id} ${p.kind} → ${p.target} auto-approved`);
      const done = await execute(client, approved);
      if (channel) {
        const res = await client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: proposalText(done), blocks: proposalBlocks(done) }).catch(() => undefined);
        if (res?.ts) d.store.patchProposal(p.id, { messageTs: res.ts as string });
      }
      return;
    }
    log.info(`dispatch (${slug}): ${p.id} ${p.kind} → ${p.target} gated — ${gate.reason}`);
    if (!channel) {
      log.warn(`dispatch (${slug}): ${p.id} has no channel to render in (session ${rec.session || 'none'})`);
      return;
    }
    const res = await client.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text: proposalText(p), blocks: proposalBlocks(p) }).catch((e: unknown) => {
      log.warn(`dispatch (${slug}): ${p.id} render failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    if (res?.ts) d.store.patchProposal(p.id, { messageTs: res.ts as string });
  }

  return {
    pollOutboxes() {
      if (!dispatch.enabled) return;
      for (const p of d.reg.current.projects) {
        try {
          consumeProposals(outboxDir(p.slug), (raw, file) => {
            void ingest(p.slug, raw, file).catch((e: unknown) => log.error(`dispatch (${p.slug}): ingest ${file}: ${e instanceof Error ? e.message : String(e)}`));
          });
        } catch (e) {
          log.error(`dispatch (${p.slug}): outbox poll: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
    async approve(client, id, userId) {
      const p = d.store.getProposal(id);
      if (!p) return undefined;
      if (p.status !== 'pending') return p; // second click, or already auto-executed: nothing changes
      const approved = d.store.patchProposal(id, { status: 'sent', approvedBy: userId, approvedAt: now().toISOString() }) ?? p;
      log.info(`dispatch (${p.slug}): ${id} approved by ${userId}`);
      const done = await execute(client, approved).catch((e: unknown) => d.store.patchProposal(id, { status: 'failed', result: e instanceof Error ? e.message.slice(0, 200) : String(e) }) ?? approved);
      await render(client, done);
      return done;
    },
    dismiss(id, userId) {
      const p = d.store.getProposal(id);
      if (!p || p.status !== 'pending') return p;
      log.info(`dispatch (${p.slug}): ${id} dismissed by ${userId}`);
      return d.store.patchProposal(id, { status: 'dismissed', approvedBy: userId, approvedAt: now().toISOString() }) ?? p;
    },
  };
}
