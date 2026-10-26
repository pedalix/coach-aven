// Messages that may concern the agent, platform-neutral: an @mention starts (or continues)
// a thread conversation, a direct message is a private conversation per project, and a
// reply in a thread the agent already owns continues it without a new mention. The chat
// driver filters platform noise (bots, edits, its own mentions) and normalizes the rest
// into ChatMessage; dedupe across duplicate deliveries is its `claim`. Moved verbatim from
// the Slack event handlers (OpenSpec chat-driver-interface, PR 3).

import type { Store } from '../../state.js';
import { teamProjects, type RegistryRef } from '../../projects.js';
import { keyFor } from '../surfaces.js';
import type { ChatDriverName } from '../drivers.js';
import type { TurnEngine } from '../../turn.js';
import type { Channels } from '../../channels.js';
import { info } from '../slack/blocks.js';
import type { ChatDriver, ChatMessage } from '../driver.js';
import type { ActorGate } from './gates.js';

export interface MessageDeps {
  store: Store;
  reg: RegistryRef;
  engine: TurnEngine;
  channels: Channels;
  homeTeamId?: string;
  // The surface these handlers serve (multi-driver-installation); undefined = the installation's default
  // surface, whose keys keep today's shapes. An additional surface's keys carry its name.
  surface?: ChatDriverName;
  actor: ActorGate;
  // Park a DM's question until a project is picked (the interaction core owns the picks).
  parkDmPick: (pending: { channel: string; user: string; question: string }) => string;
}

const FILES_ONLY = 'Please take a look at the attached file(s).';

export function createMessages(deps: MessageDeps) {
  const { store, reg, engine, channels, homeTeamId, actor, surface } = deps;

  // @mention → a public thread, one session per thread. The thread is the mention's own
  // thread, or the mention itself when it starts one.
  async function onMention(m: ChatMessage, d: ChatDriver): Promise<void> {
    const tenant = m.actor.tenant;
    const threadTs = m.thread || m.id;
    const where = { conv: m.conv, thread: threadTs };
    const { project, question, error } = await channels.pickProject(d, m.conv, m.text, tenant);
    if (error) {
      // Error replies claim their OWN namespace: with duplicate deliveries, the tenant that
      // can't resolve the project must not steal the claim from the one that can.
      if (!m.claim('mention-err')) return;
      await d.post(where, { kind: 'text', text: info(error) });
      return;
    }
    // A bare mention with a file (no text) is a valid ask — only nag when there's neither.
    if (!question && !m.hasFiles) {
      if (!m.claim('mention')) return;
      await d.post(where, { kind: 'text', text: info('Ask me something — `@CoachAven <task>`. I work in a thread and open a PR for review.') });
      return;
    }
    // A mention is a deliberate act — a non-cleared user gets ONE explicit denial (its own
    // claim namespace, for the same reason as errors).
    const gate = actor(tenant, m.actor.user);
    if (!gate.ok) {
      if (!m.claim('mention-denied')) return;
      await d.post(where, { kind: 'text', text: gate.denial });
      return;
    }
    if (!m.claim('mention')) return;
    const attachments = m.hasFiles ? await m.files() : undefined;
    const key = keyFor(surface, tenant, homeTeamId, `thread:${threadTs}`);
    await engine.liveTurn(d, m.conv, m.id, threadTs, key, project!, question || FILES_ONLY, attachments);
  }

  // A plain message: a DM is a private conversation; in a channel, only a reply in a thread
  // the agent already owns concerns it (it never barges in elsewhere).
  async function onMessage(m: ChatMessage, d: ChatDriver): Promise<void> {
    const tenant = m.actor.tenant;
    if (m.direct) {
      const { project, question, error } = await channels.pickProject(d, m.conv, m.text, tenant);
      if (error) {
        // No project hint → offer a picker (of the TENANT's projects only) instead of
        // demanding a slug prefix. The question is parked until a project is chosen.
        // (Attachments don't survive the picker — rare enough to accept.)
        const mine = teamProjects(reg.current, tenant, homeTeamId);
        if (m.actor.user && question && mine.length > 1) {
          const pid = deps.parkDmPick({ channel: m.conv, user: m.actor.user, question });
          await d.post({ conv: m.conv }, { kind: 'projectPicker', pid, projects: mine });
        } else {
          await d.post({ conv: m.conv }, { kind: 'text', text: info(error) });
        }
        return;
      }
      if (!m.actor.user) return;
      // DMs are deliberate acts — explicit denial for non-cleared users.
      const dmGate = actor(tenant, m.actor.user);
      if (!dmGate.ok) {
        await d.post({ conv: m.conv }, { kind: 'text', text: dmGate.denial });
        return;
      }
      // A file with no text IS the message — only nag when there's neither.
      if (!question && !m.hasFiles) {
        await d.post({ conv: m.conv }, { kind: 'text', text: info("I didn't catch a question — just type what you'd like me to do.") });
        return;
      }
      const dmKey = keyFor(surface, tenant, homeTeamId, `dm:${m.conv}:${project!.slug}`);
      await engine.liveTurn(d, m.conv, m.id, undefined, dmKey, project!, question || FILES_ONLY, await m.files());
      return;
    }

    // A channel: only continue a thread we already own (no re-mention needed). The key is
    // this delivery's tenant's — in a shared channel the other side finds no conversation
    // under its key and exits here without claiming.
    if (!m.thread) return;
    const key = keyFor(surface, tenant, homeTeamId, `thread:${m.thread}`);
    if (!engine.hasLive(key) && !store.getChat(key)) return;
    const { project, question, error } = await channels.pickProject(d, m.conv, m.text, tenant);
    if (error || !project) return;
    // Replies from non-cleared users are IGNORED silently: viewers discussing in the thread
    // must not drive the agent, but per-message denials would spam them.
    if (!actor(tenant, m.actor.user).ok) return;
    if (!m.claim('message')) return;
    if (!question && !m.hasFiles) {
      await d.post({ conv: m.conv, thread: m.thread }, { kind: 'text', text: info("I didn't catch a question — what would you like me to do?") });
      return;
    }
    await engine.liveTurn(d, m.conv, m.id, m.thread, key, project, question || FILES_ONLY, await m.files());
  }

  return { onMention, onMessage };
}
