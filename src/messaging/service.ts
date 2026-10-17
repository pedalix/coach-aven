// Agent messaging inside the bot (OpenSpec `agent-messaging`): the one place that sends, receives and
// delivers task messages — for both transports (D1), on both sides of a task.
//
//   asking side    send_message → an `ask` envelope; answers, questions asked back and ends come back as
//                  `answer` envelopes and are DELIVERED into the asking conversation (D11)
//   answering side an `ask` starts a task in a shadow conversation (D10); `request_input` and the final
//                  answer go back as `answer` envelopes; replies are delivered like answers
//
// Delivery (D11): a message reaches its conversation in the running turn (ClaudeSession.inject) when that
// turn can take it, otherwise as a turn of its own after it. Either way a DeliveryRecord is written before
// the transport is acked, so a restart recovers it (from the session, or by queueing it) — exactly once.
// The completion rule of a shadow conversation is settleShadowTurn: a final answer completes its task only
// when nothing is outstanding (an unanswered request_input, open sub-tasks, a message not taken up yet, a
// background task of the CLI); one nudge turn, then `failed: no answer`.
//
// Everything the agent sees from another agent is framed as data (wrap.ts); data from one domain reaches
// another only through a person (marks.ts, D14). Configuration is read at call time (D2).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ChatDriver } from '../chat/driver.js';
import type { ShadowDriver } from '../chat/shadow/driver.js';
import { parseShadowKey, shadowKey } from '../chat/shadow/driver.js';
import { STREAM_MAX_MS, type InjectOutcome } from '../claudeSession.js';
import type { UsageLog } from '../metering.js';
import { projectOwnerTeam, resolveBySlug, type ProjectConfig, type RegistryRef } from '../projects.js';
import { localDate } from '../routineguard.js';
import type { Store } from '../state.js';
import type { ChatSession } from '../tasks.js';
import { normalizeTenant, splitTeam } from '../teamkeys.js';
import type { TurnEngine, TurnOpts } from '../turn.js';
import { isTerminal, parseCard, parseMessage, parseStatus, textMessage, textOf, type AgentCard, type TaskState } from './a2a.js';
import { messagingLimits, type MessagingConfig } from './config.js';
import { emit, type EventName, type EventSink } from './events.js';
import { domainOf, heldWhy, markArrival, markSent, mayGo } from './marks.js';
import { accepts, parseAddress, parseTarget, PROTOCOL_VERSION, type Address, type Envelope, type EnvelopeHeader, type Method, type Payload } from './protocol.js';
import { acceptCountKey, isOpen, sendCountKey, type DeliveryRecord, type HeldMessage, type InTask, type OutTask, type ReplyTarget } from './records.js';
import type { Delivery, PeerTransport } from './transport.js';
import { wrapAnswer, wrapReply, wrapTask, type OpenTask } from './wrap.js';
import { expireIdleTasks } from './expiry.js';

/** The turn engine as the service uses it. */
export type MessagingEngine = Pick<TurnEngine, 'liveTurn' | 'turnOn' | 'noteInjection' | 'liveSession' | 'sessionFor' | 'isAsk' | 'cancelKey' | 'closeSession' | 'retireSession' | 'hasKey'>;

export interface MessagingDeps {
  installation: string;
  store: Store;
  reg: RegistryRef;
  /** The home tenant id (undefined in single-workspace mode): tenants and domains. */
  home: () => string | undefined;
  /** The pinned peers (hub.peers.json), read at use time. */
  peers: () => Record<string, unknown>;
  engine: MessagingEngine;
  local: PeerTransport;
  hub?: PeerTransport;
  shadow: ShadowDriver;
  /** The chat this installation runs (`orch slack` / `orch teams`): an asking conversation's driver. */
  platform: 'slack' | 'teams';
  /** The chat driver of a tenant (undefined = home); undefined when the tenant is gone. */
  driverFor: (teamId: string | undefined) => ChatDriver | undefined;
  usageLog?: UsageLog;
  /** Local days for the daily caps. */
  tz?: string;
  now?: () => Date;
  sink?: EventSink;
}

export const MAX_DEPTH = 3;
export const MAX_INJECTIONS = 5;
export const AGENTS_TIMEOUT_MS = 10_000;
export const NUDGE_TEXT = 'Nothing is outstanding any more on the task from another agent: give your final answer to the task now.';

export type ToolReply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

export function createMessaging(d: MessagingDeps) {
  const now = (): Date => d.now?.() ?? new Date();
  const iso = (): string => now().toISOString();
  const ev = (name: EventName, fields: Record<string, unknown>): void => emit(name, fields, { sink: d.sink });
  const tz = d.tz ?? 'UTC';
  const self = (slug: string): string => `${d.installation}/${slug}`;
  const newId = (): string => randomBytes(12).toString('hex');
  /** A task or message id derived from the call that made it (D9 step 4): a call served again finds its record. */
  const deriveId = (...parts: string[]): string => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);

  // ── projects, tenants, domains ──────────────────────────────────────────────────────────────
  const project = (slug: string): ProjectConfig | undefined => resolveBySlug(d.reg.current, slug);
  const tenantOfProject = (slug: string): string | undefined => normalizeTenant(projectOwnerTeam(d.reg.current, slug, d.home()), d.home());
  const domainOfProject = (slug: string): string => domainOf(d.installation, tenantOfProject(slug));
  const domainOfKey = (key: string): string => domainOf(d.installation, normalizeTenant(splitTeam(key).tenantId, d.home()));
  const messaging = (p: ProjectConfig | undefined): MessagingConfig | undefined => p?.messaging;
  /** Whether the agent `slug` here accepts `sender` (of `senderDomain`) — its configuration, read now (D2). */
  const accepted = (slug: string, sender: Address, senderDomain: string): boolean => {
    const m = messaging(project(slug));
    return !!m && accepts(m.accept, sender, { ownInstallation: d.installation, ownDomain: domainOfProject(slug), senderDomain });
  };
  const transportFor = (installation: string): PeerTransport | undefined =>
    installation === d.installation ? d.local : d.hub && installation in d.peers() ? d.hub : undefined;

  // ── envelopes ───────────────────────────────────────────────────────────────────────────────
  function post(h: Omit<EnvelopeHeader, 'v' | 'id'> & { id?: string }, payload: Payload): void {
    const env: Envelope = { v: PROTOCOL_VERSION, id: h.id ?? newId(), from: h.from, to: h.to, method: h.method, task: h.task };
    const t = transportFor(parseAddress(h.to)!.installation);
    if (!t) {
      ev('hub.rejected', { from: env.from, to: env.to, method: env.method, reason: 'unknown installation' });
      return;
    }
    // Outcomes of the hub come back through applyHubReports; the local transport routes at once.
    void t.send(env, payload).catch((e) => ev('hub.rejected', { from: env.from, to: env.to, method: env.method, reason: e instanceof Error ? e.message : String(e) }));
  }
  /** A status of a task to its asker (the answering side), under the marks of its shadow conversation. */
  function sendStatus(task: InTask, state: TaskState, o: { text?: string; reason?: string; cost?: number } = {}): boolean {
    const content = o.text !== undefined;
    const marks = d.store.getMarks(task.key);
    if (content) {
      const v = mayGo(marks, { own: domainOfProject(task.slug), to: task.fromDomain });
      if (!v.go) {
        ev('ask.marks.refused', { task: task.id, marks: v.blocking.join(','), target: task.from });
        return false;
      }
    }
    const message = { state, timestamp: iso(), ...(content ? { message: textMessage('agent', o.text!, newId(), task.id) } : o.reason ? { message: textMessage('agent', o.reason, newId(), task.id) } : {}) };
    post(
      { from: self(task.slug), to: task.from, method: 'answer', task: task.id },
      { message, domain: domainOfProject(task.slug), toDomain: task.fromDomain, marks: content ? marks : {}, depth: task.depth, ...(o.cost !== undefined ? { cost: o.cost } : {}) },
    );
    if (content) d.store.setMarks(task.key, markSent(marks, task.fromDomain));
    return true;
  }

  // ── where answers go (D9 step 3) ────────────────────────────────────────────────────────────
  function replyTargetOf(key: string, slug: string): ReplyTarget | { refused: string } {
    if (parseShadowKey(key)) return { key, driver: 'shadow' };
    if (d.engine.isAsk(key)) return { refused: 'this conversation is a one-off answer (an /aven question or a dream): answers would have nowhere to go — ask from a thread' };
    const chat = d.store.getChat(key);
    const inf = chat?.inflight;
    if (inf) return { key, driver: d.platform, channel: inf.channel, ...(inf.msgThreadTs ? { thread: inf.msgThreadTs } : {}) };
    const base = splitTeam(key).base;
    const dm = /^dm:([^:]+):/.exec(base);
    if (dm) return { key, driver: d.platform, channel: dm[1]! };
    void slug;
    return { refused: 'this conversation has no thread to answer into — ask from a thread' };
  }

  // ── the deliverer (D11) ─────────────────────────────────────────────────────────────────────
  const openOf = (key: string, except?: string): OpenTask[] =>
    d.store
      .messagingTasks()
      .out.filter((t) => t.key === key && t.id !== except && isOpen(t))
      .map((t) => ({ taskId: t.id, target: t.target, state: t.state }));
  const isShadow = (key: string): boolean => parseShadowKey(key) !== undefined;

  /** Record a message for a conversation; the caller acks its transport after this. Then run it. */
  function deliver(rec: Omit<DeliveryRecord, 'uuid' | 'at' | 'teamId'>, o: { ownTurn?: boolean } = {}): DeliveryRecord {
    const stored = d.store.putDelivery({ ...rec, uuid: randomUUID(), at: iso() });
    setImmediate(() => void run(stored, o.ownTurn === true).catch((e) => ev('ask.deliver.no_conversation', { task: stored.task.id, key: stored.key, slug: stored.slug, driver: e instanceof Error ? e.message : String(e) })));
    return stored;
  }

  function driverOf(reply: ReplyTarget): ChatDriver | undefined {
    if (reply.driver === 'shadow') return d.shadow;
    try {
      return d.driverFor(splitTeam(reply.key).tenantId);
    } catch {
      return undefined;
    }
  }

  async function run(rec: DeliveryRecord, ownTurn: boolean): Promise<void> {
    const p = project(rec.slug);
    const driver = driverOf(rec.reply);
    if (!p || !driver || (rec.reply.driver !== 'shadow' && !rec.reply.channel)) return nowhere(rec, driver ? 'slug' : 'driver');
    const why = ownTurn ? 'its own turn' : injectRefusal(rec.key);
    if (why === undefined) {
      const session = d.engine.liveSession(rec.key)!;
      d.store.patchDelivery(rec.uuid, { injected: true, at: iso() });
      d.engine.noteInjection(rec.key);
      const outcome = await session.inject(rec.text, { uuid: rec.uuid, label: rec.label, onSlow: () => ev('ask.inject.slow', { key: rec.key, task: rec.task.id, cli: session.injectRefusal() ?? 'checked', waited_ms: Date.now() - Date.parse(rec.at) }) });
      return settleInjected(rec, outcome, session);
    }
    if (why === 'spawned without the message ledger' || /not a probed version/.test(why)) ev('ask.inject.disabled', { key: rec.key, task: rec.task.id, reason: why });
    else if (d.engine.turnOn(rec.key)) ev('ask.inject.skipped', { key: rec.key, task: rec.task.id, reason: why });
    queueTurn(rec, p, driver);
  }

  /** Why a message cannot go into the running turn on `key` now (D11 step 2), or undefined when it can. */
  function injectRefusal(key: string): string | undefined {
    const turn = d.engine.turnOn(key);
    if (!turn) return 'no turn running';
    if (turn.automatic) return 'automatic turn';
    if (Date.now() - turn.startedAt > STREAM_MAX_MS) return 'soft deadline';
    if (turn.injected >= MAX_INJECTIONS) return 'cap';
    const session = d.engine.liveSession(key);
    if (!session) return 'no session';
    const r = session.injectRefusal();
    if (r) return r;
    return session.pendingTurnTakenUp() ? undefined : 'turn not started';
  }

  function queueTurn(rec: DeliveryRecord, p: ProjectConfig, driver: ChatDriver): void {
    const opts: TurnOpts = { ...(isShadow(rec.key) ? shadowOpts(rec.key) : {}), onAccepted: () => d.store.deleteDelivery(rec.uuid) };
    const channel = rec.reply.driver === 'shadow' ? rec.key : rec.reply.channel!;
    void d.engine.liveTurn(driver, channel, undefined, rec.reply.thread, rec.key, p, rec.text, undefined, opts).catch((e) =>
      ev('ask.deliver.no_conversation', { task: rec.task.id, key: rec.key, slug: rec.slug, driver: e instanceof Error ? e.message : String(e) }),
    );
  }

  async function settleInjected(rec: DeliveryRecord, outcome: InjectOutcome, session: ChatSession): Promise<void> {
    void session;
    const p = project(rec.slug);
    const driver = driverOf(rec.reply);
    switch (outcome.kind) {
      case 'folded':
        d.store.deleteDelivery(rec.uuid);
        return;
      case 'answered': {
        d.store.deleteDelivery(rec.uuid);
        const r = outcome.result;
        meter(rec, r.status === 'ok' && !r.isError ? 'ok' : 'error', r.usage);
        if (isShadow(rec.key)) return settleShadowTurn(rec.key, r.status === 'ok' && !r.isError ? { ok: true, text: r.resultText } : { ok: false, reason: r.resultText || r.status });
        if (driver && rec.reply.channel) {
          const marked = Object.keys(d.store.getMarks(rec.key)).length ? ({ marked: true } as const) : {};
          await driver.post({ conv: rec.reply.channel, ...(rec.reply.thread ? { thread: rec.reply.thread } : {}), ...marked }, { kind: 'answer', markdown: r.resultText || '(no output)' }).catch(() => {});
        }
        return;
      }
      case 'lost':
        ev('ask.inject.lost', { key: rec.key, task: rec.task.id, cli: outcome.takenUp ? 'taken up, then the process ended' : 'not taken up' });
        break;
      case 'stuck':
        ev('ask.inject.stuck', { key: rec.key, task: rec.task.id, waited_ms: Date.now() - Date.parse(rec.at) });
        await d.engine.retireSession(rec.key, rec.slug).catch(() => {});
        break;
      case 'refused':
        break;
    }
    // Delivered again as a turn of its own.
    d.store.patchDelivery(rec.uuid, { injected: false });
    if (p && driver) queueTurn({ ...rec, injected: false }, p, driver);
  }

  // Nothing to deliver into (the project was removed by a reload, the workspace is gone): the task ends
  // `failed: nowhere to deliver` — even when the message being delivered had just completed it (D11).
  function nowhere(rec: DeliveryRecord, why: string): void {
    d.store.deleteDelivery(rec.uuid);
    ev('ask.deliver.no_conversation', { task: rec.task.id, key: rec.key, slug: rec.slug, driver: why });
    if (rec.task.dir === 'out') {
      if (d.store.getOutTask(rec.task.id)) d.store.patchOutTask(rec.task.id, { state: 'failed', reason: 'nowhere to deliver', updatedAt: iso() });
    } else if (rec.task.origin) {
      const t = d.store.getInTask(rec.task.origin, rec.task.id);
      if (t && isOpen(t)) {
        endIn(t.origin, t.id, 'failed', 'nowhere to deliver');
        sendStatus(t, 'failed', { reason: 'nowhere to deliver' });
      }
    }
  }

  function meter(rec: DeliveryRecord, status: 'ok' | 'error', usage: unknown): void {
    const t = rec.task.dir === 'out' ? d.store.getOutTask(rec.task.id) : d.store.getInTask(rec.task.origin ?? '', rec.task.id);
    d.usageLog?.record({
      at: iso(),
      key: rec.key,
      slug: rec.slug,
      kind: 'turn',
      status,
      elapsedMs: Date.now() - Date.parse(rec.at),
      usage: usage as never,
      ...(t ? { originSlug: rec.task.dir === 'out' ? (t as OutTask).target : (t as InTask).from, taskId: t.id } : {}),
    } as never);
  }

  /**
   * After a restart: every message that was on its way (D11 "After a bot restart"), each after the
   * recovery of its conversation's in-flight turn (`recovering`, from the engine) — the session is
   * reattached then, and its snapshot tells what became of a message written into it.
   */
  async function recoverDeliveries(recovering?: Map<string, Promise<void>>): Promise<void> {
    for (const rec of d.store.listDeliveries()) {
      await recovering?.get(rec.key)?.catch(() => {});
      const p = project(rec.slug);
      const driver = driverOf(rec.reply);
      if (!p || !driver) {
        nowhere(rec, 'gone after a restart');
        continue;
      }
      if (!rec.injected) {
        queueTurn(rec, p, driver);
        continue;
      }
      let session: ChatSession;
      try {
        session = d.engine.liveSession(rec.key) ?? (await d.engine.sessionFor(rec.key, p)); // reattaches when the process still runs
      } catch {
        d.store.patchDelivery(rec.uuid, { injected: false });
        queueTurn({ ...rec, injected: false }, p, driver);
        continue;
      }
      const outcome = await session.recoverInjected({ uuid: rec.uuid, writtenAt: Date.parse(rec.at), label: rec.label });
      await settleInjected(rec, outcome, session);
    }
  }

  // ── task ends ───────────────────────────────────────────────────────────────────────────────
  function endOut(id: string, state: 'failed' | 'canceled' | 'rejected' | 'completed', reason?: string): OutTask | undefined {
    const t = d.store.getOutTask(id);
    if (!t || !isOpen(t)) return undefined;
    return d.store.patchOutTask(id, { state, ...(reason ? { reason } : {}), updatedAt: iso() });
  }
  function endIn(origin: string, id: string, state: 'failed' | 'canceled' | 'completed' | 'rejected', reason?: string): InTask | undefined {
    const t = d.store.getInTask(origin, id);
    if (!t || !isOpen(t)) return undefined;
    const next = d.store.patchInTask(origin, id, { state, ...(reason ? { reason } : {}), updatedAt: iso() });
    if (state !== 'completed') cascade(t, 'parent ended');
    void d.engine.closeSession(t.key).catch(() => {});
    return next;
  }
  /** A task that ends without completing cancels the open tasks its conversation started (D10, D15). */
  function cascade(parent: InTask, reason: string): void {
    for (const sub of d.store.messagingTasks().out) {
      if (!isOpen(sub) || sub.parent?.origin !== parent.origin || sub.parent.id !== parent.id) continue;
      d.store.patchOutTask(sub.id, { state: 'canceled', reason, updatedAt: iso() });
      post({ from: self(sub.slug), to: sub.target, method: 'cancel', task: sub.id }, { domain: domainOfKey(sub.key), marks: {}, depth: sub.depth });
      ev('ask.canceled', { task: sub.id, from: self(sub.slug), to: sub.target });
    }
  }
  /** Tell the asking conversation that its task ended other than completed, as a delivered message. */
  function tellAsker(t: OutTask, state: TaskState, reason: string): void {
    deliver({ key: t.key, slug: t.slug, reply: t.reply, label: `↩ task ${t.id} to ${t.target}: ${state}`, task: { dir: 'out', id: t.id }, text: wrapAnswer({ from: t.target, taskId: t.id, state, reason, question: t.question, open: openOf(t.key, t.id) }) });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // The tools (D9) — the caller is the session: its project and conversation come from the channel.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  interface Caller {
    slug: string;
    conversationKey: string;
  }

  function sendMessage(c: Caller, args: { target?: unknown; text?: unknown; taskId?: unknown }, requestId: string): ToolReply {
    const p = project(c.slug);
    if (!messaging(p)?.send) return { ok: false, error: 'this agent may not send tasks (its messaging configuration has no `send`)' };
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return { ok: false, error: '`text` is required' };
    if (text.length > 64 * 1024) return { ok: false, error: '`text` is longer than 64 KiB' };
    const target = parseTarget(args.target, d.installation);
    const peers = Object.keys(d.peers()).sort();
    if (!target) return { ok: false, error: `\`target\` must be "<installation>/<agent>", or "<agent>" for this installation (${d.installation}); known installations: ${[d.installation, ...peers].join(', ')}` };
    if (target.installation !== d.installation && !peers.includes(target.installation)) {
      return { ok: false, error: `unknown installation "${target.installation}"; known: ${[d.installation, ...peers].join(', ')} — targets are "<installation>/<agent>" or "<agent>"` };
    }
    if (typeof args.taskId === 'string' && args.taskId) return reply(c, p!, target, text, args.taskId, requestId);
    const id = deriveId(d.installation, c.conversationKey, requestId);
    const known = d.store.getOutTask(id);
    if (known) return { ok: true, data: { taskId: id, state: known.state } }; // the same call, served again
    // Depth (D15): 0 from a person's or a routine's conversation, the parent's + 1 from a shadow one.
    const sh = parseShadowKey(c.conversationKey);
    const parent = sh ? d.store.getInTask(sh.origin, sh.taskId) : undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_DEPTH) return { ok: false, error: `too deep: a task may start sub-tasks at most ${MAX_DEPTH} levels down` };
    const limits = messagingLimits(messaging(p)!);
    const today = localDate(tz, now());
    if (d.store.askCount(sendCountKey(c.slug, today)) >= limits.sendPerDay) return { ok: false, error: `this agent reached its limit of ${limits.sendPerDay} tasks today` };
    const replyTo = replyTargetOf(c.conversationKey, c.slug);
    if ('refused' in replyTo) return { ok: false, error: replyTo.refused };
    const own = domainOfKey(c.conversationKey);
    let toDomain: string | undefined;
    if (target.installation === d.installation) {
      const tp = project(target.agent);
      // A local agent that does not exist or does not accept the caller: the same error (D9).
      if (!tp || !accepted(target.agent, { installation: d.installation, agent: c.slug }, own)) {
        const ok = localCards({ installation: d.installation, agent: c.slug }, own).map((x) => x.name);
        return { ok: false, error: `no agent "${target.agent}" here accepts tasks from ${c.slug}; agents that do: ${ok.length ? ok.join(', ') : 'none'}` };
      }
      toDomain = domainOfProject(target.agent);
    } else {
      toDomain = d.store.peerDomain(`${target.installation}/${target.agent}`);
    }
    const task: OutTask = {
      id,
      slug: c.slug,
      key: c.conversationKey,
      reply: replyTo,
      target: `${target.installation}/${target.agent}`,
      ...(toDomain ? { targetDomain: toDomain } : {}),
      question: text,
      state: 'submitted',
      depth,
      rounds: 0,
      ...(parent ? { parent: { origin: parent.origin, id: parent.id } } : {}),
      replies: [],
      seen: [],
      createdAt: iso(),
      updatedAt: iso(),
    };
    const marks = d.store.getMarks(c.conversationKey);
    const v = mayGo(marks, { own, to: toDomain });
    if (!v.go) {
      if (sh) {
        ev('ask.marks.refused', { task: id, marks: v.blocking.join(','), target: task.target });
        return { ok: false, error: `refused: ${heldWhy(v.blocking, toDomain)} — a task started by another agent cannot pass that on` };
      }
      d.store.putOutTask(task);
      d.store.bumpAskCount(sendCountKey(c.slug, today), localDate(tz, new Date(now().getTime() - 86_400_000)));
      const why = heldWhy(v.blocking, toDomain);
      const held = d.store.putHeld({ id, task: id, kind: 'task', slug: c.slug, key: c.conversationKey, target: task.target, text, why, createdAt: iso() });
      ev('ask.marks.held', { task: id, marks: v.blocking.join(','), target: task.target });
      void postHeld(held, task.reply);
      return { ok: true, data: { taskId: id, state: 'submitted', held: true, why: `held for a person's Send: ${why}` } };
    }
    d.store.putOutTask(task);
    d.store.bumpAskCount(sendCountKey(c.slug, today), localDate(tz, new Date(now().getTime() - 86_400_000)));
    sendAsk(task, text, id);
    return { ok: true, data: { taskId: id, state: 'submitted' } };
  }

  /** Send a task's question or a reply (the marks allowed it, or a person released it). */
  function sendAsk(task: OutTask, text: string, messageId: string): void {
    const marks = d.store.getMarks(task.key);
    const own = domainOfKey(task.key);
    post(
      { from: self(task.slug), to: task.target, method: 'ask', task: task.id },
      { message: textMessage('user', text, messageId, task.id), domain: own, ...(task.targetDomain ? { toDomain: task.targetDomain } : {}), marks, depth: task.depth },
    );
    if (task.targetDomain) d.store.setMarks(task.key, markSent(marks, task.targetDomain));
  }

  function reply(c: Caller, p: ProjectConfig, target: Address, text: string, taskId: string, requestId: string): ToolReply {
    void p;
    const t = d.store.getOutTask(taskId);
    // Only tasks the calling conversation started (D9): no other conversation reads or speaks on them.
    if (!t || t.key !== c.conversationKey || t.target !== `${target.installation}/${target.agent}`) return { ok: false, error: `no task ${taskId} to ${target.installation}/${target.agent} from this conversation` };
    const mid = deriveId(d.installation, c.conversationKey, requestId, 'reply');
    if (t.replies.includes(mid)) return { ok: true, data: { taskId, state: t.state } };
    if (t.state !== 'input-required') return { ok: false, error: `task ${taskId} is ${t.state}: a reply answers a question asked back (input-required)` };
    const marks = d.store.getMarks(c.conversationKey);
    const v = mayGo(marks, { own: domainOfKey(c.conversationKey), to: t.targetDomain });
    if (!v.go) {
      if (isShadow(c.conversationKey)) {
        ev('ask.marks.refused', { task: taskId, marks: v.blocking.join(','), target: t.target });
        return { ok: false, error: `refused: ${heldWhy(v.blocking, t.targetDomain)}` };
      }
      const why = heldWhy(v.blocking, t.targetDomain);
      const held = d.store.putHeld({ id: mid, task: taskId, kind: 'reply', slug: c.slug, key: c.conversationKey, target: t.target, text, why, createdAt: iso() });
      d.store.patchOutTask(taskId, { replies: [...t.replies, mid] });
      ev('ask.marks.held', { task: taskId, marks: v.blocking.join(','), target: t.target });
      void postHeld(held, t.reply);
      return { ok: true, data: { taskId, state: t.state, held: true, why: `held for a person's Send: ${why}` } };
    }
    d.store.patchOutTask(taskId, { replies: [...t.replies, mid], state: 'working', updatedAt: iso(), last: { at: iso(), role: 'user', state: 'working', text } });
    sendAsk(d.store.getOutTask(taskId)!, text, mid);
    return { ok: true, data: { taskId, state: 'working' } };
  }

  function getTask(c: Caller, taskId: unknown): ToolReply {
    const t = typeof taskId === 'string' ? d.store.getOutTask(taskId) : undefined;
    if (!t || t.key !== c.conversationKey) return { ok: false, error: `no task ${String(taskId)} from this conversation` };
    return {
      ok: true,
      data: { taskId: t.id, target: t.target, state: t.state, ...(t.reason ? { reason: t.reason } : {}), createdAt: t.createdAt, updatedAt: t.updatedAt, ...(t.last ? { last: t.last } : {}) },
    };
  }

  function cancelTask(c: Caller, taskId: unknown, by = 'by the asker'): ToolReply {
    const t = typeof taskId === 'string' ? d.store.getOutTask(taskId) : undefined;
    if (!t || (c.conversationKey !== '*' && t.key !== c.conversationKey)) return { ok: false, error: `no task ${String(taskId)} from this conversation` };
    if (!isOpen(t)) return { ok: true, data: { taskId: t.id, state: t.state } };
    d.store.patchOutTask(t.id, { state: 'canceled', reason: by, updatedAt: iso() });
    d.store.deleteHeld(t.id);
    post({ from: self(t.slug), to: t.target, method: 'cancel', task: t.id }, { domain: domainOfKey(t.key), marks: {}, depth: t.depth });
    ev('ask.canceled', { task: t.id, from: self(t.slug), to: t.target });
    return { ok: true, data: { taskId: t.id, state: 'canceled' } };
  }

  /** `/aven asks cancel` (D17): an operator ends any open task here, either direction. */
  function cancelByOperator(taskId: string, by: string): string {
    const out = d.store.getOutTask(taskId);
    if (out) {
      const r = cancelTask({ slug: out.slug, conversationKey: '*' }, taskId, `by an operator (${by})`);
      return r.ok ? `Task \`${taskId}\` to ${out.target}: ${String(r.data.state)}.` : r.error;
    }
    const inc = d.store.messagingTasks().in.find((t) => t.id === taskId);
    if (!inc) return `No task \`${taskId}\` here.`;
    if (!isOpen(inc)) return `Task \`${taskId}\` from ${inc.from} already ended (${inc.state}).`;
    d.engine.cancelKey(inc.key);
    endIn(inc.origin, inc.id, 'canceled', `by an operator`);
    sendStatus(inc, 'canceled', { reason: 'by an operator' });
    return `Task \`${taskId}\` from ${inc.from}: canceled.`;
  }

  function requestInput(c: Caller, question: unknown, options?: unknown): ToolReply {
    const sh = parseShadowKey(c.conversationKey);
    const t = sh ? d.store.getInTask(sh.origin, sh.taskId) : undefined;
    if (!t) return { ok: false, error: 'request_input asks back on a task from another agent; this conversation is not answering one' };
    if (!isOpen(t)) return { ok: false, error: `the task ended (${t.state})` };
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) return { ok: false, error: '`question` is required' };
    const opts = Array.isArray(options) ? options.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
    const text = opts.length ? `${q}\nOptions: ${opts.join(' · ')}` : q;
    const max = messagingLimits(messaging(project(t.slug)) ?? {}).maxRounds;
    if (t.rounds + 1 > max) {
      ev('ask.rounds.exceeded', { task: t.id, from: t.from, to: self(t.slug), rounds: t.rounds + 1 });
      endIn(t.origin, t.id, 'failed', 'too many rounds');
      sendStatus(t, 'failed', { reason: 'too many rounds' });
      return { ok: false, error: `the task allows at most ${max} questions asked back; it ended failed: too many rounds` };
    }
    d.store.patchInTask(t.origin, t.id, { state: 'input-required', rounds: t.rounds + 1, awaitingInput: true, updatedAt: iso(), last: { at: iso(), role: 'agent', state: 'input-required', text } });
    if (!sendStatus(d.store.getInTask(t.origin, t.id)!, 'input-required', { text })) {
      endIn(t.origin, t.id, 'failed', 'refused by marks');
      sendStatus(t, 'failed', { reason: 'refused by marks' });
      return { ok: false, error: 'refused by marks: this conversation holds data the asker may not see' };
    }
    return { ok: true, data: { state: 'input-required' } };
  }

  // ── discovery (D9 `agents`, D7 cards) ───────────────────────────────────────────────────────
  function localCards(sender: Address, senderDomain: string): AgentCard[] {
    const today = localDate(tz, now());
    return d.reg.current.projects
      .filter((p) => p.messaging && accepted(p.slug, sender, senderDomain) && !(sender.installation === d.installation && sender.agent === p.slug))
      .map((p) => ({
        name: self(p.slug),
        description: p.messaging!.description ?? '',
        accepting: d.store.askCount(acceptCountKey(p.slug, `${sender.installation}/${sender.agent}`, today)) < messagingLimits(p.messaging!).acceptPerDay,
        domain: domainOfProject(p.slug),
      }));
  }
  const pendingCards = new Map<string, (cards: AgentCard[]) => void>();
  async function agents(c: Caller, installation: unknown): Promise<ToolReply> {
    if (!messaging(project(c.slug))?.send) return { ok: false, error: 'this agent may not send tasks' };
    const inst = typeof installation === 'string' && installation ? installation : d.installation;
    const me = { installation: d.installation, agent: c.slug };
    if (inst === d.installation) return { ok: true, data: { installation: inst, agents: localCards(me, domainOfKey(c.conversationKey)) } };
    if (!(inst in d.peers()) || !d.hub) return { ok: false, error: `unknown installation "${inst}"; known: ${[d.installation, ...Object.keys(d.peers()).sort()].join(', ')}` };
    if (!d.hub.presence().online.includes(inst)) return { ok: true, data: { installation: inst, offline: true } };
    const req = newId();
    const cards = await new Promise<AgentCard[] | undefined>((resolve) => {
      const timer = setTimeout(() => {
        pendingCards.delete(req);
        resolve(undefined);
      }, AGENTS_TIMEOUT_MS);
      timer.unref?.();
      pendingCards.set(req, (x) => {
        clearTimeout(timer);
        pendingCards.delete(req);
        resolve(x);
      });
      post({ from: self(c.slug), to: `${inst}/agents`, method: 'agents', task: req }, { domain: domainOfKey(c.conversationKey), marks: {}, depth: 0 });
    });
    if (!cards) return { ok: true, data: { installation: inst, offline: true } };
    for (const card of cards) if (card.domain) d.store.learnDomain(card.name, card.domain);
    return { ok: true, data: { installation: inst, agents: cards } };
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // Incoming (both transports): ack after the effect is recorded.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  async function onDelivery(t: PeerTransport, del: Delivery): Promise<void> {
    const { env } = del;
    const payload = del.payload;
    const ack = (): Promise<void> => t.ack(del.seq);
    if (!payload) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: 'a payload' });
      return ack();
    }
    switch (env.method) {
      case 'ask':
        return onAsk(env, payload, ack);
      case 'answer':
        return onAnswer(env, payload, ack);
      case 'cancel':
        return onCancel(env, ack);
      case 'agents':
        return onAgents(env, payload, ack);
      case 'cards': {
        const list = (payload.message as { cards?: unknown[] } | undefined)?.cards;
        pendingCards.get(env.task)?.((Array.isArray(list) ? list : []).map(parseCard).filter((x): x is AgentCard => !!x));
        return ack();
      }
    }
  }

  async function onAgents(env: Envelope, payload: Payload, ack: () => Promise<void>): Promise<void> {
    const sender = parseAddress(env.from)!;
    post({ from: `${d.installation}/agents`, to: env.from, method: 'cards', task: env.task }, { message: { cards: localCards(sender, payload.domain) }, domain: d.installation, marks: {}, depth: 0 });
    return ack();
  }

  /** The answering side: a new task, or a reply to a question asked back. */
  async function onAsk(env: Envelope, payload: Payload, ack: () => Promise<void>): Promise<void> {
    const origin = parseAddress(env.from)!.installation;
    const msg = parseMessage(payload.message);
    if (!msg) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: 'an A2A message' });
      return ack();
    }
    const known = d.store.getInTask(origin, env.task);
    if (known) {
      if (known.seen.includes(env.id)) return ack();
      if (known.from !== env.from) {
        ev('ask.unexpected', { task: env.task, from: env.from, expected: known.from });
        return ack();
      }
      if (!isOpen(known)) {
        ev('ask.after_end', { task: known.id, state: known.state, method: env.method });
        return ack();
      }
      return onReply(known, env, payload, textOf(msg), ack);
    }
    const target = parseAddress(env.to)!;
    const slug = target.agent;
    const sender = parseAddress(env.from)!;
    const reject = (reason: string): Promise<void> => {
      ev('ask.rejected', { from: env.from, to: env.to, task: env.task, reason, versions: `v${PROTOCOL_VERSION}` });
      post({ from: env.to, to: env.from, method: 'answer', task: env.task }, { message: { state: 'rejected', timestamp: iso(), message: textMessage('agent', reason, newId(), env.task) }, domain: project(slug) ? domainOfProject(slug) : d.installation, marks: {}, depth: payload.depth });
      return ack();
    };
    // Not accepted, or no such agent: the same answer (D9 — it does not say whether the agent exists).
    if (!project(slug) || !accepted(slug, sender, payload.domain)) return reject('not accepted');
    if (payload.toDomain !== undefined && payload.toDomain !== domainOfProject(slug)) return reject('domain changed');
    if (payload.depth > MAX_DEPTH) return reject('too deep');
    const limits = messagingLimits(messaging(project(slug))!);
    const today = localDate(tz, now());
    const countKey = acceptCountKey(slug, env.from, today);
    if (d.store.askCount(countKey) >= limits.acceptPerDay) return reject('budget');
    const key = shadowKey({ tenantId: tenantOfProject(slug), origin, taskId: env.task, slug });
    const task: InTask = { id: env.task, origin, from: env.from, fromDomain: payload.domain, slug, key, question: textOf(msg), state: 'submitted', depth: payload.depth, rounds: 0, seen: [env.id], createdAt: iso(), updatedAt: iso() };
    d.store.putInTask(task);
    d.store.bumpAskCount(countKey, localDate(tz, new Date(now().getTime() - 86_400_000)));
    d.store.setMarks(key, markArrival({}, { own: domainOfProject(slug), from: payload.domain, carried: payload.marks }));
    const maySend = !!messaging(project(slug))!.send && payload.depth < MAX_DEPTH;
    deliver({ key, slug, reply: { key, driver: 'shadow' }, label: `↩ task ${env.task} from ${env.from}`, task: { dir: 'in', id: env.task, origin }, text: wrapTask({ from: env.from, taskId: env.task, text: textOf(msg), maySend, maxRounds: limits.maxRounds }) }, { ownTurn: true });
    return ack();
  }

  async function onReply(task: InTask, env: Envelope, payload: Payload, text: string, ack: () => Promise<void>): Promise<void> {
    // Acceptance is checked for every message of a task (D2): withdrawn since → the task ends.
    if (!accepted(task.slug, parseAddress(env.from)!, payload.domain)) {
      endIn(task.origin, task.id, 'failed', 'not accepted');
      sendStatus(task, 'failed', { reason: 'not accepted' });
      return ack();
    }
    const asked = task.last?.state === 'input-required' ? task.last.text : '';
    d.store.patchInTask(task.origin, task.id, { seen: [...task.seen, env.id], awaitingInput: false, state: 'working', updatedAt: iso(), last: { at: iso(), role: 'user', state: 'working', text } });
    d.store.setMarks(task.key, markArrival(d.store.getMarks(task.key), { own: domainOfProject(task.slug), from: payload.domain, carried: payload.marks }));
    deliver({ key: task.key, slug: task.slug, reply: { key: task.key, driver: 'shadow' }, label: `↩ reply from ${env.from} (task ${task.id}) folded in`, task: { dir: 'in', id: task.id, origin: task.origin }, text: wrapReply({ from: env.from, taskId: task.id, asked, text }) });
    return ack();
  }

  async function onCancel(env: Envelope, ack: () => Promise<void>): Promise<void> {
    const origin = parseAddress(env.from)!.installation;
    const t = d.store.getInTask(origin, env.task);
    if (!t) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: 'a task of this installation' });
      return ack();
    }
    if (t.from !== env.from) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: t.from });
      return ack();
    }
    if (isOpen(t)) {
      d.engine.cancelKey(t.key);
      endIn(t.origin, t.id, 'canceled', 'by the asker');
      ev('ask.canceled', { task: t.id, from: t.from, to: self(t.slug) });
    }
    return ack();
  }

  /** The asking side: a status of one of our tasks. */
  async function onAnswer(env: Envelope, payload: Payload, ack: () => Promise<void>): Promise<void> {
    const t = d.store.getOutTask(env.task);
    if (!t) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: 'a task of this installation' });
      return ack();
    }
    if (env.from !== t.target) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: t.target });
      return ack();
    }
    if (t.seen.includes(env.id)) return ack();
    if (!isOpen(t)) {
      ev('ask.after_end', { task: t.id, state: t.state, method: env.method });
      return ack();
    }
    const status = parseStatus(payload.message);
    if (!status) {
      ev('ask.unexpected', { task: env.task, from: env.from, expected: 'a task status' });
      return ack();
    }
    d.store.learnDomain(t.target, payload.domain);
    const text = status.message ? textOf(status.message) : undefined;
    const seen = [...t.seen, env.id];
    if (status.state === 'working' || status.state === 'submitted') {
      d.store.patchOutTask(t.id, { seen, state: 'working', updatedAt: iso(), last: { at: iso(), role: 'agent', state: 'working', text: '' } });
      return ack();
    }
    const ended = isTerminal(status.state);
    const reason = ended && status.state !== 'completed' ? text ?? status.state : undefined;
    d.store.patchOutTask(t.id, {
      seen,
      state: status.state,
      ...(reason ? { reason } : {}),
      ...(status.state === 'input-required' ? { rounds: t.rounds + 1 } : {}),
      ...(payload.cost !== undefined ? { cost: payload.cost } : {}),
      updatedAt: iso(),
      last: { at: iso(), role: 'agent', state: status.state, text: text ?? '' },
    });
    // Content marks the asking conversation (D14): an answer or a question asked back, not a bare end.
    const content = status.state === 'completed' || status.state === 'input-required';
    if (content) d.store.setMarks(t.key, markArrival(d.store.getMarks(t.key), { own: domainOfKey(t.key), from: payload.domain, carried: payload.marks }));
    if (status.state === 'completed' && payload.cost !== undefined) {
      const limit = messagingLimits(messaging(project(t.slug)) ?? {}).costWarnUsd;
      if (payload.cost > limit) ev('ask.cost.high', { task: t.id, slug: t.target, cost: payload.cost });
    }
    deliver({
      key: t.key,
      slug: t.slug,
      reply: t.reply,
      label: `↩ ${status.state === 'input-required' ? 'question' : 'answer'} from ${t.target} (task ${t.id}) folded in`,
      task: { dir: 'out', id: t.id },
      text: wrapAnswer({ from: t.target, taskId: t.id, state: status.state, ...(reason ? { reason } : {}), question: t.question, ...(content ? { text } : {}), open: openOf(t.key, t.id) }),
    });
    return ack();
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // The answering side's completion rule (D10) — the one owner: shadowOpts callbacks, the recovery
  // branch of the turn engine, and the nudge all come here.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  function taskOfKey(key: string): InTask | undefined {
    const sh = parseShadowKey(key);
    return sh ? d.store.getInTask(sh.origin, sh.taskId) : undefined;
  }
  function outstanding(t: InTask): string | undefined {
    if (t.awaitingInput) return 'a question asked back';
    if (d.store.messagingTasks().out.some((s) => isOpen(s) && s.parent?.origin === t.origin && s.parent.id === t.id)) return 'open sub-tasks';
    if (d.store.listDeliveries().some((r) => r.key === t.key)) return 'a message not taken up yet';
    if ((d.engine.liveSession(t.key)?.backgroundTasks().length ?? 0) > 0) return 'background tasks of the agent';
    return undefined;
  }

  function shadowOpts(key: string): TurnOpts | undefined {
    const t = taskOfKey(key);
    if (!t || !isOpen(t)) return undefined;
    return {
      origin: { slug: t.from, taskId: t.id },
      onStart: () => {
        const cur = taskOfKey(key);
        if (cur && cur.state === 'submitted') {
          d.store.patchInTask(cur.origin, cur.id, { state: 'working', updatedAt: iso() });
          sendStatus(cur, 'working');
        }
      },
      onAnswer: async (text) => settleShadowTurn(key, { ok: true, text }),
      onSettle: async (outcome, reason) => {
        if (outcome !== 'ok') await settleShadowTurn(key, { ok: false, reason: outcome === 'canceled' ? 'canceled' : reason ?? outcome });
      },
      onIdleResult: (text) => void settleShadowTurn(key, { ok: true, text, unsolicited: true }),
      // AskUserQuestion despite the framing: the question goes to the asker as request_input, and the
      // agent is answered at once that it was sent (D10).
      onQuestion: async (questions) => {
        const cur = taskOfKey(key);
        if (cur) ev('ask.shadow.askuserquestion', { task: cur.id, slug: cur.slug });
        const answers: Record<string, string> = {};
        for (const q of questions) {
          const r = requestInput({ slug: cur?.slug ?? '', conversationKey: key }, q.question, q.options.map((x) => x.label));
          answers[q.question] = r.ok ? 'Sent to the asker as your question; continue, or end your turn — the reply comes as a new message.' : `Not sent: ${(r as { error: string }).error}`;
        }
        return answers;
      },
    };
  }

  async function settleShadowTurn(key: string, o: { ok: true; text: string; unsolicited?: boolean } | { ok: false; reason: string }): Promise<void> {
    const t = taskOfKey(key);
    if (!t) return;
    if (!isOpen(t)) {
      if (o.ok && o.text) ev('ask.shadow.late_result', { task: t.id, length: o.text.length });
      return;
    }
    if (!o.ok) {
      if (o.reason === 'canceled') return; // a cancel ends the task where it came from
      endIn(t.origin, t.id, 'failed', `error on the answering side: ${o.reason.slice(0, 200)}`);
      sendStatus(t, 'failed', { reason: `error on the answering side` });
      return;
    }
    const busy = outstanding(t);
    if (busy) {
      d.store.patchInTask(t.origin, t.id, { last: { at: iso(), role: 'agent', state: t.state, text: o.text } });
      return;
    }
    const cost = undefined;
    if (!sendStatus(t, 'completed', { text: o.text, ...(cost !== undefined ? { cost } : {}) })) {
      endIn(t.origin, t.id, 'failed', 'refused by marks');
      sendStatus(t, 'failed', { reason: 'refused by marks' });
      return;
    }
    endIn(t.origin, t.id, 'completed');
  }

  /**
   * The nudge (D10): a shadow conversation idle, with nothing outstanding and its task still open, gets
   * ONE turn asking for the final answer; idle again without one, the task ends `failed: no answer`.
   */
  function checkIdle(): void {
    for (const t of d.store.messagingTasks().in) {
      if (!isOpen(t) || t.state === 'submitted' || d.engine.hasKey(t.key) || outstanding(t)) continue;
      if (t.nudged) {
        ev('ask.shadow.no_answer', { task: t.id, slug: t.slug });
        endIn(t.origin, t.id, 'failed', 'no answer');
        sendStatus(t, 'failed', { reason: 'no answer' });
        continue;
      }
      d.store.patchInTask(t.origin, t.id, { nudged: true });
      ev('ask.shadow.nudge', { task: t.id, slug: t.slug });
      deliver({ key: t.key, slug: t.slug, reply: { key: t.key, driver: 'shadow' }, label: '↩ nudge', task: { dir: 'in', id: t.id, origin: t.origin }, text: NUDGE_TEXT }, { ownTurn: true });
    }
  }

  // ── held messages (D9, task 4.7): a card in the conversation; a person releases or dismisses ─
  async function postHeld(h: HeldMessage, reply: ReplyTarget): Promise<void> {
    const driver = driverOf(reply);
    if (!driver || !reply.channel) return;
    const marked = Object.keys(d.store.getMarks(h.key)).length ? ({ marked: true } as const) : {};
    try {
      const ref = await driver.post(
        { conv: reply.channel, ...(reply.thread ? { thread: reply.thread } : {}), ...marked },
        { kind: 'heldAsk', held: { id: h.id, kind: h.kind, target: h.target, text: h.text, why: h.why }, state: 'pending' },
      );
      d.store.patchHeld(h.id, { card: { channel: ref.conv, ts: ref.id } });
    } catch (e) {
      ev('ask.deliver.no_conversation', { task: h.task, key: h.key, slug: h.slug, driver: `held card: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  function release(heldId: string, by: string): { ok: boolean; text: string } {
    const h = d.store.getHeld(heldId);
    if (!h) return { ok: false, text: 'This message was already sent or dismissed.' };
    const t = d.store.getOutTask(h.task);
    d.store.deleteHeld(heldId);
    if (!t || !isOpen(t)) return { ok: false, text: 'Its task has ended.' };
    sendAsk(t, h.text, h.id); // the target's domain now has the data: markSent, as for any message that goes out
    if (h.kind === 'reply') d.store.patchOutTask(t.id, { state: 'working', updatedAt: iso() });
    return { ok: true, text: `Sent to ${t.target} by ${by}.` };
  }
  function dismiss(heldId: string): { ok: boolean; text: string } {
    const h = d.store.getHeld(heldId);
    if (!h) return { ok: false, text: 'This message was already sent or dismissed.' };
    d.store.deleteHeld(heldId);
    const t = d.store.getOutTask(h.task);
    if (h.kind === 'task') {
      endOut(h.task, 'canceled', 'dismissed');
      return { ok: true, text: 'Dismissed — the task was not sent.' };
    }
    // A dismissed reply leaves its task waiting for one, and the conversation is told (D9).
    if (t) d.store.patchOutTask(t.id, { replies: t.replies.filter((r) => r !== h.id) });
    if (t) tellAsker({ ...t, state: 'input-required' }, 'input-required', 'your reply was dismissed by a person; the task still waits for one');
    return { ok: true, text: 'Dismissed — the task still waits for a reply.' };
  }

  // ── housekeeping and reloads ────────────────────────────────────────────────────────────────
  /** A task the hub or a reload ended (applyHubReports, a dropped peer): its conversation is told. */
  function ended(t: OutTask | InTask): void {
    if ('target' in t) tellAsker(t, t.state, t.reason ?? t.state);
    else {
      cascade(t, 'parent ended');
      void d.engine.closeSession(t.key).catch(() => {});
    }
  }

  /** Local expiry (D8: the hub's expiry plus a day without a message, both sides) and the nudge (D10). */
  function tick(): void {
    const gone = expireIdleTasks(d.store, now());
    for (const t of gone.out) {
      ev('ask.expired', { task: t.id, from: self(t.slug), to: t.target, age: `${Math.round((now().getTime() - Date.parse(t.createdAt)) / 86_400_000)}d` });
      tellAsker(t, 'failed', 'expired');
    }
    for (const t of gone.in) {
      ev('ask.expired', { task: t.id, from: t.from, to: self(t.slug), age: `${Math.round((now().getTime() - Date.parse(t.createdAt)) / 86_400_000)}d` });
      cascade(t, 'parent ended');
      void d.engine.closeSession(t.key).catch(() => {});
      sendStatus(t, 'failed', { reason: 'expired' });
    }
    checkIdle();
  }

  /**
   * After `/aven reload` (D2 "Withdrawal"): an open incoming task whose sender its agent no longer
   * accepts ends `canceled: not accepted`, its shadow turn is canceled and the sender is told.
   */
  function reload(): string[] {
    const notes: string[] = [];
    for (const t of d.store.messagingTasks().in) {
      if (!isOpen(t) || accepted(t.slug, parseAddress(t.from)!, t.fromDomain)) continue;
      d.engine.cancelKey(t.key);
      endIn(t.origin, t.id, 'canceled', 'not accepted');
      sendStatus(t, 'canceled', { reason: 'not accepted' });
      notes.push(`task ${t.id} from ${t.from} canceled (not accepted any more)`);
    }
    return notes;
  }

  return {
    // the tools
    sendMessage,
    getTask,
    cancelTask,
    requestInput,
    agents,
    // transports
    onDelivery,
    // the answering side
    shadowOpts,
    settleShadowTurn,
    // the deliverer
    recoverDeliveries,
    tellAsker,
    // held messages
    release,
    dismiss,
    tick,
    ended,
    reload,
    cancelByOperator,
    // for tests and the audit
    domainOfProject,
    domainOfKey,
    localCards,
    endOut,
    endIn,
  };
}
export type Messaging = ReturnType<typeof createMessaging>;
