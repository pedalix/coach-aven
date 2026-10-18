// Agent messaging inside one installation, end to end (OpenSpec `agent-messaging` 4.4, 5.1–5.6): the real
// service, store, local transport, shadow driver, marks and framings; a scripted engine stands in for the
// turns (each shadow turn answers what its script says, through the real tools when it asks back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../state.js';
import { shadowDriver } from '../chat/shadow/driver.js';
import type { ChatDriver, ConvTarget, MsgRef } from '../chat/driver.js';
import type { MessageView } from '../chat/views.js';
import type { ProjectConfig, RegistryRef } from '../projects.js';
import type { TurnOpts } from '../turn.js';
import type { ChatSession } from '../tasks.js';
import type { InjectOutcome, TurnUsage } from '../claudeSession.js';
import { UsageLog } from '../metering.js';
import { LocalTransport } from './local.js';
import { memoryStore } from './transport.js';
import { createMessaging, NUDGE_TEXT, type Messaging, type MessagingEngine } from './service.js';
import type { EventSink } from './events.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const OWEN = 'thread:1700000000.000100'; // owen-ops's thread

interface Turn {
  key: string;
  slug: string;
  question: string;
  driver: ChatDriver;
  opts?: TurnOpts;
}
type Script = (t: Turn, h: Harness) => Promise<string | undefined> | string | undefined; // undefined: the turn ends without an answer callback

interface Harness {
  svc: Messaging;
  store: Store;
  reg: RegistryRef;
  turns: Turn[];
  posts: { to: ConvTarget; view: MessageView }[];
  events: string[];
  captured: { line: string; level: string; tags: Record<string, string> }[];
  running: Map<string, { automatic: boolean; injected: number; session: Partial<ChatSession> }>;
  scripts: Record<string, Script>;
  canceled: string[];
  closed: string[];
  tool: (key: string, slug: string) => { slug: string; conversationKey: string };
  usage: UsageLog;
}

function harness(
  projects: ProjectConfig[],
  o: { scripts?: Record<string, Script>; peers?: Record<string, unknown>; hub?: Any; turnUsage?: (t: Turn) => TurnUsage | undefined } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'aven-msg-'));
  const store = new Store(join(dir, 'state.json'));
  const reg: RegistryRef = { current: { projects } } as unknown as RegistryRef;
  const events: string[] = [];
  const captured: Harness['captured'] = [];
  const sink: EventSink = { log: (_l, line) => events.push(line), capture: (line, level, tags) => void captured.push({ line, level, tags }), now: () => Date.now() };
  const turns: Turn[] = [];
  const posts: Harness['posts'] = [];
  const running: Harness['running'] = new Map();
  const canceled: string[] = [];
  const closed: string[] = [];
  const chat: ChatDriver = {
    capabilities: { reactions: true, privateReplies: 'native', threadRepliesNeedMention: false },
    post: async (to, view) => (posts.push({ to, view }), { conv: to.conv, id: `p${posts.length}` }),
    update: async () => {},
    mark: async () => {},
    permalink: async () => undefined,
    reply: async () => {},
    conversationName: async () => undefined,
    openDirect: async () => undefined,
    findConversation: async () => undefined,
    postPrivate: async () => {},
    openDialog: async () => undefined,
    updateDialog: async () => {},
    refreshRating: async () => {},
    publishHome: async () => {},
  };
  const h = {} as Harness;
  const engine: MessagingEngine = {
    async liveTurn(driver, _channel, _msgTs, _thread, key, project, question, _att, opts) {
      const t: Turn = { key, slug: project.slug, question, driver, ...(opts ? { opts } : {}) };
      turns.push(t);
      opts?.onAccepted?.();
      await flush(2);
      opts?.onStart?.();
      const script = h.scripts[project.slug];
      const answer = script ? await script(t, h) : undefined;
      if (answer !== undefined) await opts?.onAnswer?.(answer, o.turnUsage?.(t));
      await opts?.onSettle?.('ok');
    },
    turnOn: (key) => {
      const r = running.get(key);
      return r ? { turnId: 't', startedAt: Date.now(), automatic: r.automatic, injected: r.injected } : undefined;
    },
    noteInjection: (key) => void (running.get(key) && running.get(key)!.injected++),
    liveSession: (key) => running.get(key)?.session as ChatSession | undefined,
    sessionFor: async (key) => (running.get(key)?.session ?? {}) as ChatSession,
    isAsk: (key) => key.startsWith('cmd:'),
    cancelKey: (key) => void canceled.push(key),
    closeSession: async (key) => void closed.push(key),
    retireSession: async () => {},
    hasKey: (key) => running.has(key),
  };
  const local = new LocalTransport(memoryStore(), { installation: 'home' });
  const usage = new UsageLog(join(dir, 'usage'));
  const svc = createMessaging({
    installation: 'home',
    store,
    reg,
    home: () => undefined,
    peers: () => o.peers ?? {},
    engine,
    local,
    ...(o.hub ? { hub: o.hub } : {}),
    shadow: shadowDriver({ dir: join(dir, 'shadow') }),
    platform: 'slack',
    driverFor: () => chat,
    usageLog: usage,
    sink,
  });
  local.onDeliver((x) => svc.onDelivery(local, x));
  Object.assign(h, { svc, store, reg, turns, posts, events, captured, running, scripts: o.scripts ?? {}, canceled, closed, usage, tool: (key: string, slug: string) => ({ slug, conversationKey: key }) });
  // owen-ops's thread has a turn running (the tool is called inside it): its reply target.
  store.patchChat(OWEN, 'owen-ops', { inflight: { channel: 'C0OWEN', statusTs: '1700000000.000200', msgThreadTs: '1700000000.000100', startedAt: new Date().toISOString() } });
  return h;
}

const owenOps = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({ slug: 'owen-ops', repos: ['Org/ops'], messaging: { send: true }, ...over }) as ProjectConfig;
const caldora = (over: Partial<NonNullable<ProjectConfig['messaging']>> = {}): ProjectConfig =>
  ({ slug: 'caldora', repos: ['Org/caldora'], messaging: { accept: ['owen-ops'], description: 'Orders and payments of caldora', ...over } }) as ProjectConfig;
const billing = (): ProjectConfig => ({ slug: 'billing', repos: ['Org/billing'] }) as ProjectConfig;
const send = (h: Harness, target: string, text: string, rid = 'r1', key = OWEN) => h.svc.sendMessage(h.tool(key, 'owen-ops'), { target, text }, rid);
const data = (r: { ok: boolean }): Any => (r as Any).data;

test('accepted in the same installation: the task runs in a shadow conversation of caldora; its answer becomes a turn in owen-ops’ thread', async () => {
  const h = harness([owenOps(), caldora(), billing()], { scripts: { caldora: () => 'Orders dropped 40 % after the 14:10 deploy.' } });
  const r = send(h, 'caldora', 'Why did orders drop on 2026-10-16?');
  assert.equal(r.ok, true);
  assert.equal(data(r).state, 'submitted', 'send returns at once');
  await flush(20);
  const shadowTurn = h.turns.find((t) => t.slug === 'caldora')!;
  assert.match(shadowTurn.key, /^a2a:home:[0-9a-f]{24}:caldora$/);
  assert.match(shadowTurn.question, /^\[Request from another agent\]\nFrom: agent owen-ops of installation home · Task: /);
  assert.match(shadowTurn.question, /> Why did orders drop on 2026-10-16\?/);
  const answerTurn = h.turns.find((t) => t.slug === 'owen-ops')!;
  assert.equal(answerTurn.key, OWEN, 'the answer turn runs in the asking thread');
  assert.match(answerTurn.question, /From: home\/caldora · Task: [0-9a-f]{24} · State: completed/);
  assert.match(answerTurn.question, /> Orders dropped 40 % after the 14:10 deploy\./);
  const out = h.store.getOutTask(data(r).taskId)!;
  assert.equal(out.state, 'completed');
  assert.equal(out.cost, undefined, 'nothing metered, no figure: no cost reported');
  assert.equal(h.store.getInTask('home', out.id)!.state, 'completed');
  assert.deepEqual(h.closed, [shadowTurn.key], 'the shadow session is closed when its task ends');
  assert.equal(h.posts.length, 0, 'nothing posted in any channel');
});

test('cost (D17): the final status reports the task’s metered turns plus the answering one; over the asker’s costWarnUsd, ask.cost.high', async () => {
  const h = harness([owenOps({ messaging: { send: true, costWarnUsd: 0.5 } }), caldora()], {
    scripts: {
      caldora: (t, hh) => {
        // An earlier turn of the same task (a clarification round), metered with the task id; and a
        // record written before per-turn cost, which has no figure of its own and counts nothing.
        const taskId = (t.opts!.origin as { taskId: string }).taskId;
        const at = new Date().toISOString();
        hh.usage.record({ at, key: t.key, slug: 'caldora', kind: 'turn', status: 'ok', elapsedMs: 5, usage: { costUsd: 0.25, costUsdCumulative: 0.25 }, taskId } as never);
        hh.usage.record({ at, key: t.key, slug: 'caldora', kind: 'turn', status: 'ok', elapsedMs: 5, usage: { costUsd: 9 }, taskId } as never);
        hh.usage.record({ at, key: 'thread:other', slug: 'caldora', kind: 'turn', status: 'ok', elapsedMs: 5, usage: { costUsd: 7, costUsdCumulative: 7 } } as never);
        return 'Orders dropped 40 % after the 14:10 deploy.';
      },
    },
    // The answering turn is metered only after it settles: its figure comes with the answer.
    turnUsage: (t) => (t.slug === 'caldora' ? { costUsd: 0.4, costUsdCumulative: 0.65 } : undefined),
  });
  const r = send(h, 'caldora', 'Why did orders drop on 2026-10-16?');
  await flush(20);
  const out = h.store.getOutTask(data(r).taskId)!;
  assert.equal(out.state, 'completed');
  assert.equal(out.cost, 0.65);
  assert.ok(
    h.events.some((l) => l === `messaging ask.cost.high task=${out.id} slug=home/caldora cost=0.65`),
    h.events.filter((l) => l.includes('cost')).join('\n') || 'no cost event',
  );
});

test('agent that does not accept the caller: in the own installation, an error that lists who does — not whether it exists', async () => {
  const h = harness([owenOps(), caldora(), billing()]);
  const noSuch = send(h, 'ghost', 'x');
  const notAccepting = send(h, 'billing', 'x', 'r2');
  assert.equal(noSuch.ok, false);
  assert.equal((noSuch as Any).error.replace('ghost', 'X'), (notAccepting as Any).error.replace('billing', 'X'));
  assert.match((noSuch as Any).error, /agents that do: home\/caldora/);
});

test('unknown installation: an error naming the forms and the known installations; nothing is sent', () => {
  const h = harness([owenOps(), caldora()]);
  const r = send(h, 'northwind/ledger', 'x');
  assert.equal(r.ok, false);
  assert.match((r as Any).error, /unknown installation "northwind"; known: home/);
  assert.equal(h.store.messagingTasks().out.length, 0);
});

test('call served again after a restart: the same call (request id) returns the task it started; no second task', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const a = send(h, 'caldora', 'q', 'req-7');
  const b = send(h, 'caldora', 'q', 'req-7');
  assert.equal(data(a).taskId, data(b).taskId);
  await flush(20);
  assert.equal(h.turns.filter((t) => t.slug === 'caldora').length, 1);
});

test('status on demand, and another thread asks for the answer: get_task answers its own conversation only', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const got = h.svc.getTask(h.tool(OWEN, 'owen-ops'), data(r).taskId);
  assert.equal(got.ok, true);
  assert.equal(data(got).state, 'working', '`working` came when caldora’s turn started');
  const other = h.svc.getTask(h.tool('thread:1700000000.000999', 'owen-ops'), data(r).taskId);
  assert.equal(other.ok, false);
  assert.equal(JSON.stringify(other).includes('working'), false, 'nothing of the task leaks');
});

test('answer while the asker is working: folded into the running turn (one answer, a trail step); turn ends just as it arrives: answered as its own', async () => {
  for (const outcome of [{ kind: 'folded', into: 'turn' }, { kind: 'answered', result: { status: 'ok', resultText: 'Thanks — so the deploy broke checkout.', isError: false, started: true } }] as InjectOutcome[]) {
    const h = harness([owenOps(), caldora()], { scripts: { caldora: () => 'Because of the deploy.' } });
    const injected: { text: string; label?: string }[] = [];
    h.running.set(OWEN, {
      automatic: false,
      injected: 0,
      session: { injectRefusal: () => undefined, pendingTurnTakenUp: () => true, inject: async (text: string, o: { label?: string }) => (injected.push({ text, label: o.label }), outcome) },
    });
    send(h, 'caldora', 'Why?');
    await flush(25);
    assert.equal(injected.length, 1, 'written into the running turn');
    assert.match(injected[0]!.label!, /^↩ answer from home\/caldora \(task [0-9a-f]{24}\) folded in$/);
    assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 0, 'no extra turn');
    assert.equal(h.store.listDeliveries().length, 0, 'the delivery is done');
    if (outcome.kind === 'answered') assert.deepEqual(h.posts.map((p) => [p.to.conv, p.to.thread, (p.view as Any).markdown]), [['C0OWEN', '1700000000.000100', 'Thanks — so the deploy broke checkout.']]);
  }
});

test('automatic turn running: the answer waits for it and runs as its own turn', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => 'Because.' } });
  let injected = 0;
  h.running.set(OWEN, { automatic: true, injected: 0, session: { injectRefusal: () => undefined, pendingTurnTakenUp: () => true, inject: async () => (injected++, { kind: 'folded', into: 'turn' }) } });
  send(h, 'caldora', 'Why?');
  await flush(25);
  assert.equal(injected, 0);
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 1);
  assert.ok(h.events.some((e) => e.includes('ask.inject.skipped') && e.includes('automatic')));
});

test('a process that dies before the next tool step loses the message: it is delivered again as a turn (ask.inject.lost)', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => 'Because.' } });
  h.running.set(OWEN, { automatic: false, injected: 0, session: { injectRefusal: () => undefined, pendingTurnTakenUp: () => true, inject: async () => ({ kind: 'lost', takenUp: false }) as InjectOutcome } });
  send(h, 'caldora', 'Why?');
  await flush(25);
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.inject.lost')));
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 1);
});

test('fan-out: an answer lists the tasks of the conversation still open', async () => {
  const h = harness([owenOps(), caldora(), { ...caldora(), slug: 'stockist' } as ProjectConfig], { scripts: { caldora: () => 'Caldora’s part.', stockist: () => undefined } });
  send(h, 'caldora', 'Part one?', 'r1');
  send(h, 'stockist', 'Part two?', 'r2');
  await flush(30);
  const answer = h.turns.find((t) => t.slug === 'owen-ops')!;
  assert.match(answer.question, /Still open from this conversation: home\/stockist \((submitted|working), task [0-9a-f]{24}\)\./);
});

test('clarification answered while still working: request_input goes to the asker; the reply reaches the shadow conversation', async () => {
  const h = harness([owenOps(), caldora()], {
    scripts: {
      caldora: (t, hh) => {
        const r = hh.svc.requestInput(hh.tool(t.key, 'caldora'), 'B2C or B2B?');
        assert.equal(r.ok, true);
        return undefined; // keeps working; no final answer in this turn
      },
    },
  });
  const r = send(h, 'caldora', 'Why did orders drop?');
  await flush(25);
  const asked = h.turns.find((t) => t.slug === 'owen-ops')!;
  assert.match(asked.question, /home\/caldora asks back:\n> B2C or B2B\?/);
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, 'input-required');
  const rep = h.svc.sendMessage(h.tool(OWEN, 'owen-ops'), { target: 'caldora', text: 'B2C.', taskId: data(r).taskId }, 'r-reply');
  assert.equal(rep.ok, true);
  await flush(25);
  const reply = h.turns.filter((t) => t.slug === 'caldora').at(-1)!;
  assert.match(reply.question, /^\[Reply from the asker/);
  assert.match(reply.question, /You asked:\n> B2C or B2B\?/);
  assert.match(reply.question, /The reply:\n> B2C\./);
});

test('agents loop: the sixth question asked back on a task with the default limit ends it `failed: too many rounds`, both sides', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const key = h.turns.find((t) => t.slug === 'caldora')!.key;
  for (let i = 0; i < 5; i++) {
    const x = h.svc.requestInput(h.tool(key, 'caldora'), `question ${i + 1}?`);
    assert.equal(x.ok, true);
    const t = h.store.getInTask('home', data(r).taskId)!;
    h.store.patchInTask('home', t.id, { awaitingInput: false }); // the asker replied each time
  }
  const sixth = h.svc.requestInput(h.tool(key, 'caldora'), 'question 6?');
  assert.equal(sixth.ok, false);
  await flush(20);
  assert.equal(h.store.getInTask('home', data(r).taskId)!.reason, 'too many rounds');
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, 'failed');
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.rounds.exceeded')));
});

test('asker gives up: cancel_task ends the task on both sides and cancels the turn running for it; a late answer starts nothing', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const key = h.turns.find((t) => t.slug === 'caldora')!.key;
  const c = h.svc.cancelTask(h.tool(OWEN, 'owen-ops'), data(r).taskId);
  assert.equal(data(c).state, 'canceled');
  await flush(20);
  assert.deepEqual(h.canceled, [key]);
  assert.equal(h.store.getInTask('home', data(r).taskId)!.state, 'canceled');
  await h.svc.settleShadowTurn(key, { ok: true, text: 'Too late.' });
  await flush(10);
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.shadow.late_result')));
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 0, 'no turn starts in the asking thread');
});

test('cap reached: the sender’s daily cap refuses the tool; the receiver’s daily cap rejects with `budget` and the asker is told', async () => {
  const h = harness([owenOps({ messaging: { send: true, sendPerDay: 1 } } as Any), caldora({ acceptPerDay: 1 })], { scripts: { caldora: () => undefined } });
  assert.equal(send(h, 'caldora', 'one', 'r1').ok, true);
  const second = send(h, 'caldora', 'two', 'r2');
  assert.equal(second.ok, false);
  assert.match((second as Any).error, /limit of 1 tasks today/);
  const h2 = harness([owenOps(), caldora({ acceptPerDay: 1 })], { scripts: { caldora: () => undefined } });
  send(h2, 'caldora', 'one', 'r1');
  const b = send(h2, 'caldora', 'two', 'r2');
  await flush(25);
  assert.equal(h2.store.getOutTask(data(b).taskId)!.state, 'rejected');
  assert.equal(h2.store.getOutTask(data(b).taskId)!.reason, 'budget');
  assert.ok(h2.turns.some((t) => t.slug === 'owen-ops' && /State: rejected \(budget\)/.test(t.question)));
});

test('sending withdrawn: a project that no longer may send is refused at call time, from a session opened before', () => {
  const h = harness([owenOps(), caldora()]);
  h.reg.current = { projects: [owenOps({ messaging: { accept: ['*'] } } as Any), caldora()] } as Any;
  const r = send(h, 'caldora', 'q');
  assert.equal(r.ok, false);
  assert.match((r as Any).error, /may not send/);
});

test('acceptance withdrawn: on reload, an open task whose sender is no longer accepted ends `canceled: not accepted`, its turn canceled, the sender told', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  h.reg.current = { projects: [owenOps(), caldora({ accept: [] })] } as Any;
  const notes = h.svc.reload();
  await flush(20);
  assert.equal(notes.length, 1);
  assert.equal(h.store.getInTask('home', data(r).taskId)!.reason, 'not accepted');
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, 'canceled');
  assert.equal(h.canceled.length, 1);
});

test('depth exceeded: a shadow conversation answering a task of depth 3 may not send further', async () => {
  const h = harness([owenOps(), caldora({ send: true } as Any)], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const key = h.turns.find((t) => t.slug === 'caldora')!.key;
  h.store.patchInTask('home', data(r).taskId, { depth: 3 });
  const sub = h.svc.sendMessage(h.tool(key, 'caldora'), { target: 'owen-ops', text: 'deeper' }, 'rs');
  assert.equal(sub.ok, false);
  assert.match((sub as Any).error, /too deep/);
});

test('background subagent: an answer while the agent’s background tasks run does not complete the task; the report after them does', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const key = h.turns.find((t) => t.slug === 'caldora')!.key;
  const bg: unknown[] = [{ id: 'b1' }];
  h.running.set(key, { automatic: false, injected: 0, session: { backgroundTasks: () => bg } });
  await h.svc.settleShadowTurn(key, { ok: true, text: 'Started a subagent; will report.' });
  assert.equal(h.store.getInTask('home', data(r).taskId)!.state, 'working', 'outstanding: background tasks');
  bg.length = 0;
  h.running.delete(key);
  await h.svc.settleShadowTurn(key, { ok: true, text: 'The subagent found it: the deploy.', unsolicited: true });
  await flush(20);
  assert.equal(h.store.getInTask('home', data(r).taskId)!.state, 'completed');
});

test('nothing outstanding and no turn comes: one nudge turn; the nudge gives no answer → `failed: no answer`', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  h.svc.tick();
  await flush(20);
  const nudge = h.turns.filter((t) => t.slug === 'caldora').at(-1)!;
  assert.equal(nudge.question, NUDGE_TEXT);
  h.svc.tick();
  await flush(20);
  assert.equal(h.store.getInTask('home', data(r).taskId)!.reason, 'no answer');
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.shadow.no_answer')));
});

test('nowhere to deliver: the asking project was removed — the task ends `failed: nowhere to deliver`, logged at error', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => 'An answer.' } });
  const r = send(h, 'caldora', 'q');
  h.reg.current = { projects: [caldora()] } as Any; // owen-ops removed before the answer arrives
  await flush(25);
  assert.equal(h.store.getOutTask(data(r).taskId)!.reason, 'nowhere to deliver');
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.deliver.no_conversation')));
});

test('a one-off /aven answer cannot start a task: answers would have nowhere to go', () => {
  const h = harness([owenOps(), caldora()]);
  const r = h.svc.sendMessage(h.tool('cmd:U0OWEN:owen-ops', 'owen-ops'), { target: 'caldora', text: 'q' }, 'r1');
  assert.equal(r.ok, false);
  assert.match((r as Any).error, /ask from a thread/);
});

test('answer from someone else: an `answer` for owen-ops’ task from another agent is dropped, the task unchanged, a warning names both', async () => {
  const h = harness([owenOps(), caldora(), { ...caldora(), slug: 'stockist' } as ProjectConfig], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const before = h.store.getOutTask(data(r).taskId)!.state;
  const local = (h.svc as Any);
  void local;
  // stockist (another agent of the installation) answers a task that is caldora's
  await h.svc.onDelivery({ kind: 'local', send: async () => ({ routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: [], removed: [] }) }, {
    seq: 99,
    env: { v: 1, id: 'e'.repeat(24), from: 'home/stockist', to: 'home/owen-ops', method: 'answer', task: data(r).taskId },
    payload: { message: { state: 'completed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ kind: 'text', text: 'hijack' }], messageId: 'f'.repeat(24) } }, domain: 'home', marks: {}, depth: 0 },
  });
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, before);
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.unexpected') && e.includes('from=home/stockist') && e.includes('expected=home/caldora')));
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 0);
});

test('late answer: an answer after the asker canceled is acked and logged with the task’s state; no turn starts in the thread', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  h.svc.cancelTask(h.tool(OWEN, 'owen-ops'), data(r).taskId);
  let acked = 0;
  await h.svc.onDelivery({ kind: 'local', send: async () => ({ routed: true }), onDeliver: () => {}, ack: async () => void acked++, presence: () => ({ online: [], removed: [] }) }, {
    seq: 5,
    env: { v: 1, id: 'd'.repeat(24), from: 'home/caldora', to: 'home/owen-ops', method: 'answer', task: data(r).taskId },
    payload: { message: { state: 'completed', timestamp: new Date().toISOString(), message: { role: 'agent', parts: [{ kind: 'text', text: 'late' }], messageId: 'c'.repeat(24) } }, domain: 'home', marks: {}, depth: 0 },
  });
  assert.equal(acked, 1);
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.after_end') && e.includes('state=canceled')));
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 0);
});

test('answer after the asker’s bot restarted: a delivery recorded before the restart runs once, in the original thread', async () => {
  const h = harness([owenOps(), caldora()]);
  h.store.putOutTask({ id: 'a'.repeat(24), slug: 'owen-ops', key: OWEN, reply: { key: OWEN, driver: 'slack', channel: 'C0OWEN', thread: '1700000000.000100' }, target: 'home/caldora', question: 'q', state: 'completed', depth: 0, rounds: 0, replies: [], seen: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  h.store.putDelivery({ uuid: '11111111-1111-4111-8111-111111111111', key: OWEN, slug: 'owen-ops', reply: { key: OWEN, driver: 'slack', channel: 'C0OWEN', thread: '1700000000.000100' }, text: 'the framed answer', label: 'l', task: { dir: 'out', id: 'a'.repeat(24) }, at: new Date().toISOString() });
  await h.svc.recoverDeliveries(new Map([[OWEN, Promise.resolve()]]));
  await flush(10);
  const turns = h.turns.filter((t) => t.slug === 'owen-ops');
  assert.deepEqual(turns.map((t) => [t.key, t.question]), [[OWEN, 'the framed answer']]);
  assert.equal(h.store.listDeliveries().length, 0, 'journaled as a turn: the record is gone');
});

test('agents — the own installation: the cards of the agents that accept the caller, with their description and whether they take a task now', async () => {
  const h = harness([owenOps(), caldora(), billing(), { slug: 'stockist', repos: ['Org/s'], messaging: { accept: ['someone-else'] } } as ProjectConfig]);
  const cards = [{ name: 'home/caldora', description: 'Orders and payments of caldora', accepting: true, domain: 'home' }];
  assert.deepEqual(data(await h.svc.agents(h.tool(OWEN, 'owen-ops'), 'home')), { installation: 'home', agents: cards });
  // Without an argument: every installation the caller can reach; with no hub that is this one alone.
  assert.deepEqual(data(await h.svc.agents(h.tool(OWEN, 'owen-ops'), undefined)), { installations: [{ installation: 'home', agents: cards }] });
});

test('agents without an argument lists every installation the caller can reach: this one first, then each pinned peer — an agent never has to guess a peer name', async () => {
  const hub = { kind: 'hub', send: async () => ({ routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: [], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { northwind: [{ sign: 'x', box: 'y' }], bluefin: [{ sign: 'x', box: 'y' }] }, hub });
  const r = await h.svc.agents(h.tool(OWEN, 'owen-ops'), undefined);
  assert.deepEqual(data(r), {
    installations: [
      { installation: 'home', agents: [{ name: 'home/caldora', description: 'Orders and payments of caldora', accepting: true, domain: 'home' }] },
      { installation: 'bluefin', offline: true, note: 'offline, or bluefin has not pinned home' },
      { installation: 'northwind', offline: true, note: 'offline, or northwind has not pinned home' },
    ],
  });
});

test('sub-question: an answer while a sub-task of the shadow conversation is open does not complete the task; the sub-task’s parent cancel cascades', async () => {
  const h = harness([owenOps(), caldora({ send: true } as Any), { slug: 'stockist', repos: ['Org/s'], messaging: { accept: ['caldora'] } } as ProjectConfig], { scripts: { caldora: () => undefined, stockist: () => undefined } });
  const r = send(h, 'caldora', 'q');
  await flush(20);
  const key = h.turns.find((t) => t.slug === 'caldora')!.key;
  const sub = h.svc.sendMessage(h.tool(key, 'caldora'), { target: 'stockist', text: 'stock levels?' }, 'sub-1');
  assert.equal(sub.ok, true);
  assert.equal(h.store.getOutTask(data(sub).taskId)!.depth, 1);
  await flush(20);
  await h.svc.settleShadowTurn(key, { ok: true, text: 'Waiting for stockist.' });
  assert.notEqual(h.store.getInTask('home', data(r).taskId)!.state, 'completed', 'outstanding: an open sub-task');
  h.svc.cancelTask(h.tool(OWEN, 'owen-ops'), data(r).taskId); // nora… owen-ops gives up: the parent is canceled
  await flush(25);
  assert.equal(h.store.getOutTask(data(sub).taskId)!.state, 'canceled');
  assert.equal(h.store.getOutTask(data(sub).taskId)!.reason, 'parent ended');
});

test('the target’s domain changed: a task that assumed another domain is rejected `domain changed`', async () => {
  const h = harness([owenOps(), caldora()]);
  let acked = 0;
  const sent: Any[] = [];
  await h.svc.onDelivery({ kind: 'local', send: async (env: Any, p: Any) => (sent.push([env, p]), { routed: true }), onDeliver: () => {}, ack: async () => void acked++, presence: () => ({ online: [], removed: [] }) }, {
    seq: 1,
    env: { v: 1, id: 'b'.repeat(24), from: 'home/owen-ops', to: 'home/caldora', method: 'ask', task: 'c'.repeat(24) },
    payload: { message: { role: 'user', parts: [{ kind: 'text', text: 'q' }], messageId: 'c'.repeat(24) }, domain: 'home', toDomain: 'home~0a1b2c3d', marks: {}, depth: 0 },
  });
  assert.equal(acked, 1);
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.rejected') && e.includes('reason="domain changed"')));
  assert.equal(h.turns.length, 0);
});

test('AskUserQuestion in a shadow conversation: sent to the asker as request_input, the agent answered at once, the event logged', async () => {
  const h = harness([owenOps(), caldora()], {
    scripts: {
      caldora: async (t) => {
        const answers = await t.opts!.onQuestion!([{ question: 'Which shop?', options: [{ label: 'B2C' }, { label: 'B2B' }] }]);
        assert.match(answers['Which shop?']!, /Sent to the asker/);
        return undefined;
      },
    },
  });
  const r = send(h, 'caldora', 'q');
  await flush(25);
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, 'input-required');
  assert.ok(h.turns.some((t) => t.slug === 'owen-ops' && /asks back:\n> Which shop\?\n> Options: B2C · B2B/.test(t.question)));
  assert.ok(h.events.some((e) => e.startsWith('messaging ask.shadow.askuserquestion')));
});

test('forwarding waits for a person: a thread holding bluefin’s data asks northwind — held, a card with Send/Dismiss in the thread, nothing sent until Send', async () => {
  const sent: Any[] = [];
  const hub = { kind: 'hub', send: async (env: Any, p: Any) => (sent.push([env, p]), { routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: ['northwind'], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { northwind: [{ sign: 'x', box: 'y' }] }, hub });
  h.store.setMarks(OWEN, { bluefin: ['bluefin'] }); // an answer from bluefin reached this thread earlier
  const r = send(h, 'northwind/ledger', 'Which orders failed today?');
  assert.equal(r.ok, true);
  assert.equal(data(r).held, true);
  assert.match(data(r).why, /held for a person's Send: this conversation holds data from bluefin, and northwind\/ledger is an agent whose domain is not known yet|held for a person's Send/);
  await flush(10);
  assert.equal(sent.length, 0, 'nothing reaches northwind');
  assert.deepEqual(h.posts.map((p) => [p.to.conv, p.to.thread, p.to.marked, p.view.kind, (p.view as Any).state]), [['C0OWEN', '1700000000.000100', true, 'heldAsk', 'pending']]);
  assert.ok(h.store.getHeld(data(r).taskId)?.card, 'the card is remembered with the held record');
  const ok = h.svc.release(data(r).taskId, 'U0OWEN');
  assert.equal(ok.ok, true);
  assert.equal(h.svc.release(data(r).taskId, 'U0OWEN').ok, false, 'Send releases once');
  await flush(10);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].to, 'northwind/ledger');
  assert.deepEqual(sent[0][1].marks, { bluefin: ['bluefin'] }, 'the message carries the marks');
});

test('dismiss: a held task ends `canceled: dismissed`; a dismissed reply leaves its task waiting and the conversation is told', async () => {
  const hub = { kind: 'hub', send: async () => ({ routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: [], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { northwind: [{ sign: 'x', box: 'y' }] }, hub });
  h.store.setMarks(OWEN, { bluefin: ['bluefin'] });
  const r = send(h, 'northwind/ledger', 'q');
  h.svc.dismiss(data(r).taskId);
  assert.equal(h.store.getOutTask(data(r).taskId)!.state, 'canceled');
  assert.equal(h.store.getOutTask(data(r).taskId)!.reason, 'dismissed');
  // a reply held, then dismissed
  const t2 = 'b'.repeat(24);
  h.store.putOutTask({ id: t2, slug: 'owen-ops', key: OWEN, reply: { key: OWEN, driver: 'slack', channel: 'C0OWEN', thread: '1700000000.000100' }, target: 'northwind/ledger', question: 'q2', state: 'input-required', depth: 0, rounds: 1, replies: [], seen: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const rep = h.svc.sendMessage(h.tool(OWEN, 'owen-ops'), { target: 'northwind/ledger', text: 'B2C.', taskId: t2 }, 'rr');
  assert.equal(data(rep).held, true);
  const heldId = h.store.listHeld().find((x) => x.task === t2)!.id;
  h.svc.dismiss(heldId);
  await flush(20);
  assert.equal(h.store.getOutTask(t2)!.state, 'input-required', 'still waiting for a reply');
  assert.ok(h.turns.some((t) => t.key === OWEN && /your reply was dismissed by a person/.test(t.question)), 'the conversation is told');
});

test('process lost a message (D16): an error with the task, the session key and the CLI state goes to error tracking without SENTRY_LOGS; the message is delivered again as a turn', async () => {
  const h = harness([owenOps(), caldora()], { scripts: { caldora: () => 'Because.' } });
  h.running.set(OWEN, { automatic: false, injected: 0, session: { injectRefusal: () => undefined, pendingTurnTakenUp: () => true, inject: async () => ({ kind: 'lost', takenUp: false }) as InjectOutcome } });
  const r = send(h, 'caldora', 'Why?');
  await flush(25);
  const lost = h.captured.find((c) => c.line.startsWith('messaging ask.inject.lost'))!;
  assert.ok(lost, 'captured');
  assert.equal(lost.level, 'error');
  assert.deepEqual(lost.tags, { area: 'messaging', event: 'ask.inject.lost' });
  assert.match(lost.line, new RegExp(`key=${OWEN.replace(/[.]/g, '\\.')} task=${data(r).taskId} cli="not taken up"`));
  assert.equal(h.turns.filter((t) => t.slug === 'owen-ops').length, 1, 'delivered again as a turn');
});


// ── hub-open-network: addresses on other hubs, peers that have not pinned this installation ──────
test('Address on another hub: refused at once, saying other hubs are not supported; nothing is sent', async () => {
  const sent: Any[] = [];
  const hub = { kind: 'hub', send: async (env: Any) => (sent.push(env), { routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: ['bluefin'], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { bluefin: [{ sign: 'x', box: 'y' }] }, hub });
  const r = send(h, 'bluefin@hub.example.org/caldora', 'x');
  assert.equal(r.ok, false);
  assert.match((r as Any).error, /addresses on other hubs .* are not supported/);
  const a = await h.svc.agents(h.tool(OWEN, 'owen-ops'), 'bluefin@hub.example.org');
  assert.match((a as Any).error, /addresses on other hubs .* are not supported/);
  await flush();
  assert.deepEqual(sent, []);
  assert.equal(h.store.messagingTasks().out.length, 0);
});

test('Peer has not pinned us: `agents` answers `offline` at once, with the note that the peer may not have pinned this installation', async () => {
  const hub = { kind: 'hub', send: async () => ({ routed: true }), onDeliver: () => {}, ack: async () => {}, presence: () => ({ online: [], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { northwind: [{ sign: 'x', box: 'y' }] }, hub });
  const r = await h.svc.agents(h.tool(OWEN, 'owen-ops'), 'northwind');
  assert.deepEqual(data(r), { installation: 'northwind', offline: true, note: 'offline, or northwind has not pinned home' });
});

test('target `constructor/x`: a name nobody pinned is unknown — never Object.prototype’s member, never a crash', () => {
  const h = harness([owenOps(), caldora()]);
  const r = send(h, 'constructor/x', 'q');
  assert.equal(r.ok, false);
  assert.match((r as Any).error, /unknown installation "constructor"/);
});

test('a delivery from the hub for an agent this installation does not have: answered `rejected: not accepted`, as for one that does not accept the caller (design N5)', async () => {
  const sent: Any[] = [];
  let acked = 0;
  const hub = { kind: 'hub', send: async (env: Any, p: Any) => (sent.push([env, p]), { routed: true }), onDeliver: () => {}, ack: async () => void acked++, presence: () => ({ online: ['northwind'], removed: [] }) };
  const h = harness([owenOps(), caldora()], { peers: { northwind: [{ sign: 'x', box: 'y' }] }, hub });
  await h.svc.onDelivery(hub as Any, {
    seq: 1,
    env: { v: 2, id: 'b'.repeat(24), from: 'northwind/ledger', to: 'home/ghost', method: 'ask', task: 'c'.repeat(24) },
    payload: { message: { role: 'user', parts: [{ kind: 'text', text: 'q' }], messageId: 'c'.repeat(24) }, domain: 'northwind', marks: {}, depth: 0 },
  });
  await flush();
  assert.equal(acked, 1);
  assert.equal(h.turns.length, 0);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][0].from, sent[0][0].to, sent[0][0].method, sent[0][0].task], ['home/ghost', 'northwind/ledger', 'answer', 'c'.repeat(24)]);
  assert.equal(sent[0][1].message.state, 'rejected');
  assert.match(JSON.stringify(sent[0][1].message), /not accepted/);
});
