// Dispatch primitive, the IO half (pure half: dispatch.ts). Owns the three verbs — take a
// proposal (the `host` tool `propose`, which the bot serves over the session's control channel:
// hostrouter.ts), approve/dismiss it, execute it — and talks to the chat driver, the turn engine
// and state.json. Constructed once in the composition root (chat/slack/app.ts) and handed to the
// host router (propose) and events (the buttons). Nothing here runs unless DISPATCH=1.
import type { Store } from './state.js';
import type { TurnEngine } from './turn.js';
import type { ChatDriver, DriverForTenant } from './chat/driver.js';
import type { Channels } from './channels.js';
import { resolveBySlug, teamProjects, type ProjectConfig, type RegistryRef } from './projects.js';
import { withTeam } from './teamkeys.js';
import { headline } from './routinerun.js';
import { localDate } from './routineguard.js';
import { log } from './log.js';
import {
  gateDecision,
  parseProposal,
  sessionThread,
  wrapDispatch,
  type ProposeOutcome,
  type StoredProposal,
} from './dispatch.js';

export interface DispatcherDeps {
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  driverFor: DriverForTenant;
  home: () => string | undefined;
  tz: string;
  now?: () => Date;
}

export interface Dispatcher {
  /** The `propose` tool: a record the host composed from the call (dispatch.ts composeProposal) → stored, gated, rendered; what the agent is told. */
  propose(slug: string, raw: unknown): Promise<ProposeOutcome>;
  /** Send clicked: executes once (idempotent on id); returns the fresh record for the message rewrite. */
  approve(chat: ChatDriver, id: string, userId: string): Promise<StoredProposal | undefined>;
  dismiss(id: string, userId: string): StoredProposal | undefined;
}

const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{6,}$/;

export function createDispatcher(d: DispatcherDeps): Dispatcher {
  const now = d.now ?? (() => new Date());
  const projectOf = (slug: string): ProjectConfig | undefined => resolveBySlug(d.reg.current, slug);

  // Rewrite the proposal message in its thread to the record's current state (best-effort).
  async function render(chat: ChatDriver, p: StoredProposal): Promise<void> {
    if (!p.channel || !p.messageTs) return;
    await chat.update({ conv: p.channel, id: p.messageTs }, { kind: 'proposal', proposal: p }).catch((e: unknown) => log.warn(`dispatch ${p.id}: render failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // The target channel of a message/dispatch: a raw channel id, or the target project's bound channel.
  async function targetChannel(chat: ChatDriver, p: StoredProposal): Promise<{ channel: string; project?: ProjectConfig } | { error: string }> {
    if (p.kind === 'message' && CHANNEL_ID_RE.test(p.target)) return { channel: p.target };
    const project = projectOf(p.target);
    if (!project) return { error: `unknown target project "${p.target}"` };
    // The target must be a project this tenant is served for — a proposal must not reach across workspaces.
    if (!teamProjects(d.reg.current, p.teamId ?? d.home(), d.home()).some((x) => x.slug === project.slug)) return { error: `project "${p.target}" is not available to this workspace` };
    const channel = await d.channels.channelIdForSlug(chat, project, p.teamId);
    if (!channel) return { error: `project "${p.target}" has no bound channel` };
    return { channel, project };
  }

  async function execute(chat: ChatDriver, p: StoredProposal): Promise<StoredProposal> {
    const t = await targetChannel(chat, p);
    if ('error' in t) return d.store.patchProposal(p.id, { status: 'failed', result: t.error }) ?? p;
    const source = projectOf(p.slug);
    const by = p.approvedBy === 'auto' ? `auto-approved (${p.slug} config)` : `approved by <@${p.approvedBy}>`;
    if (p.kind === 'message') {
      const res = await chat.post({ conv: t.channel }, { kind: 'relayed', text: p.text, from: p.slug, by });
      const link = await chat.permalink(res);
      d.store.bumpDispatch(p.slug, localDate(d.tz, now()));
      return d.store.patchProposal(p.id, { status: 'sent', result: link ? `<${link}|posted in <#${t.channel}>>` : `posted in <#${t.channel}>` }) ?? p;
    }
    // dispatch: a fresh thread in the target's channel, the task as data, the answer back as a pointer.
    const target = t.project!;
    const label = `📨 Task from ${p.slug}`;
    const parent = await chat.post({ conv: t.channel }, { kind: 'text', text: `${label} · running… (proposal ${p.id}, ${by})` });
    const parentTs = parent.id;
    const key = withTeam(p.teamId, d.home(), `thread:${parentTs}`);
    const link = await chat.permalink(parent);
    const pointer = async (text: string): Promise<void> => {
      if (!p.channel || !p.threadTs) return;
      await chat.post({ conv: p.channel, thread: p.threadTs }, { kind: 'text', text }).catch(() => {});
    };
    d.store.bumpDispatch(p.slug, localDate(d.tz, now()));
    const stored = d.store.patchProposal(p.id, { status: 'sent', result: link ? `<${link}|thread in <#${t.channel}>>` : `thread in <#${t.channel}>` }) ?? p;
    void d.engine
      .liveTurn(chat, t.channel, undefined, parentTs, key, target, wrapDispatch(stored), undefined, {
        origin: { slug: p.slug, proposalId: p.id },
        onAnswer: async (text) => {
          const head = headline(text);
          await chat.update(parent, { kind: 'line', text: `${label} — ${head || 'done'}` }).catch(() => {});
          await pointer(`↩️ ${p.kind} ${p.id} → ${link ? `<${link}|${target.slug}>` : target.slug}: ${head || 'done'}`);
        },
        onSettle: async (outcome, reason) => {
          if (outcome === 'ok') return;
          await chat.update(parent, { kind: 'line', text: `⚠️ ${label} — ${outcome}${reason ? `: ${reason.split('\n')[0]!.slice(0, 160)}` : ''}` }).catch(() => {});
          await pointer(`↩️ ${p.kind} ${p.id} → ${target.slug}: ${outcome}${reason ? ` — ${reason.split('\n')[0]!.slice(0, 160)}` : ''}`);
        },
      })
      .catch((e: unknown) => log.error(`dispatch ${p.id}: child turn failed to start: ${e instanceof Error ? e.message : String(e)}`));
    return stored;
  }

  async function ingest(slug: string, raw: unknown): Promise<ProposeOutcome> {
    const parsed = parseProposal(raw);
    if (!parsed.ok) {
      log.warn(`dispatch (${slug}): proposal rejected — ${parsed.error}`);
      return { ok: false, error: parsed.error };
    }
    const rec = parsed.record;
    const known = d.store.getProposal(rec.id);
    if (known) {
      // Same content from the same conversation (a retried call, a reattached session): the agent
      // learns the existing record's state; nothing is rendered twice.
      log.info(`dispatch (${slug}): ${rec.id} already known — ignored`);
      return { ok: true, id: known.id, status: known.status, gate: known.approvedBy === 'auto' ? 'auto' : 'buttons', duplicate: true };
    }
    const project = projectOf(slug);
    if (!project) return { ok: false, error: `unknown project ${slug}` };
    const { teamId, threadTs } = sessionThread(rec.session);
    const driver = d.driverFor(teamId);
    // Where the proposing turn runs: its chat record lives under the FULL conversation key —
    // `thread:<ts>` (team-prefixed for a client workspace) or `dm:…` — which is exactly what the
    // session carries; the bare ts finds nothing, so every proposal used to fall back to the
    // project's bound channel. While the turn runs, `inflight` names its channel and thread; only
    // without it (the turn already settled) is the bound channel the guess.
    const live = rec.session ? d.store.getChat(rec.session)?.inflight : undefined;
    const channel = live?.channel ?? (await d.channels.channelIdForSlug(driver, project, teamId));
    const thread = live ? (live.msgThreadTs ?? threadTs) : threadTs;
    const p: StoredProposal = { ...rec, slug, ...(teamId ? { teamId } : {}), status: 'pending', receivedAt: now().toISOString(), ...(channel ? { channel } : {}), ...(thread ? { threadTs: thread } : {}) };
    d.store.setProposal(p);
    const gate = gateDecision(rec, project.dispatch, d.store.dispatchCount(slug, localDate(d.tz, now())));
    if (gate.auto) {
      const approved = d.store.patchProposal(p.id, { approvedBy: 'auto', approvedAt: now().toISOString() }) ?? p;
      log.info(`dispatch (${slug}): ${p.id} ${p.kind} → ${p.target} auto-approved`);
      const done = await execute(driver, approved);
      if (channel) {
        const res = await driver.post({ conv: channel, thread }, { kind: 'proposal', proposal: done }).catch(() => undefined);
        if (res?.id) d.store.patchProposal(p.id, { messageTs: res.id });
      }
      return { ok: true, id: p.id, status: done.status, gate: 'auto', ...(done.result ? { note: done.result } : {}) };
    }
    log.info(`dispatch (${slug}): ${p.id} ${p.kind} → ${p.target} gated — ${gate.reason}`);
    if (!channel) {
      log.warn(`dispatch (${slug}): ${p.id} has no channel to render in (session ${rec.session || 'none'})`);
      return { ok: true, id: p.id, status: 'pending', gate: 'buttons', note: 'recorded, but this conversation has no thread to show the Send / Dismiss buttons in' };
    }
    const res = await driver.post({ conv: channel, thread }, { kind: 'proposal', proposal: p }).catch((e: unknown) => {
      log.warn(`dispatch (${slug}): ${p.id} render failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    if (res?.id) d.store.patchProposal(p.id, { messageTs: res.id });
    return { ok: true, id: p.id, status: 'pending', gate: 'buttons', note: `waiting for Send / Dismiss in this thread (${gate.reason})` };
  }

  return {
    propose: (slug, raw) =>
      ingest(slug, raw).catch((e: unknown) => {
        log.error(`dispatch (${slug}): propose: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false as const, error: 'the orchestrator could not record the proposal' };
      }),
    async approve(chat, id, userId) {
      const p = d.store.getProposal(id);
      if (!p) return undefined;
      if (p.status !== 'pending') return p; // second click, or already auto-executed: nothing changes
      const approved = d.store.patchProposal(id, { status: 'sent', approvedBy: userId, approvedAt: now().toISOString() }) ?? p;
      log.info(`dispatch (${p.slug}): ${id} approved by ${userId}`);
      const done = await execute(chat, approved).catch((e: unknown) => d.store.patchProposal(id, { status: 'failed', result: e instanceof Error ? e.message.slice(0, 200) : String(e) }) ?? approved);
      await render(chat, done);
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
