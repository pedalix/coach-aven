// The turn engine's side of the idle stop (OpenSpec sandbox-idle-stop, design D4/D7): what holds a
// project's sandbox, what lingers, and what a stop does to the live sessions — over the real engine
// with a scripted session factory and a no-op chat driver (no Slack, no sandbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { Store } from './state.js';
import { QueueJournal } from './queuejournal.js';
import { UsageLog } from './metering.js';
import { FeedbackLog } from './feedback.js';
import { DraftStore } from './drafts.js';
import type { ProjectConfig, RegistryRef } from './projects.js';
import type { ChatSession, openChat } from './tasks.js';
import type { SessionIdleState } from './claudeSession.js';
import type { ChatDriver } from './chat/driver.js';
import { createTurnEngine } from './turn.js';
import { STALE_HOLD_MARGIN_MS } from './idlestop.js';

const ALPHA = { slug: 'alpha', repos: ['Org/alpha'] } as ProjectConfig;
const BETA = { slug: 'beta', repos: ['Org/beta'] } as ProjectConfig;
const reg = { current: { projects: [ALPHA, BETA] } } as unknown as RegistryRef;
const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 30 } } as unknown as Config;
const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// A gate a scripted step waits on.
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

interface FakeSession {
  slug: string;
  state: SessionIdleState;
  ended: (string | undefined)[];
  asks: number;
}

function harness(o: { ask?: (s: FakeSession, ctx: { onQuestion?: (q: never[]) => Promise<unknown> }) => Promise<string>; adopt?: () => Promise<{ ok: boolean; status: string; text: string }>; seed?: (store: Store) => void; clock?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-idle-'));
  const store = new Store(join(dir, 'state.json'));
  o.seed?.(store);
  const sessions: FakeSession[] = [];
  const open = (async (_cfg: unknown, _store: unknown, opts: { slug: string }) => {
    const s: FakeSession = { slug: opts.slug, state: { background: 0, injected: 0, selfTurn: false }, ended: [], asks: 0 };
    sessions.push(s);
    const chat: ChatSession = {
      ask: async (_p, _step, _signal, onQuestion) => {
        s.asks++;
        return o.ask ? o.ask(s, { onQuestion: onQuestion as never }) : 'Done.';
      },
      sessionId: () => 'sess-1',
      attachInfo: () => ({ sessionKey: 'claude-sess-1-1', cmdId: '41' }),
      adoptInflight: async () => (o.adopt ? o.adopt() : { ok: true, status: 'ok', text: 'Recovered.' }),
      contextLost: () => false,
      lastUsage: () => undefined,
      ingest: async () => ({ preamble: '', skipped: [] }),
      close: async () => {},
      setIdleNotify: () => {},
      hasLedger: () => false,
      injectRefusal: () => 'spawned without the message ledger',
      backgroundTasks: () => [],
      pendingTurnTakenUp: () => false,
      inject: async () => ({ kind: 'refused', reason: 'spawned without the message ledger' }),
      recoverInjected: async () => ({ kind: 'refused', reason: 'spawned without the message ledger' }),
      idleState: () => s.state,
      processEnded: (notice) => void s.ended.push(notice),
    };
    return chat;
  }) as unknown as typeof openChat;
  const engine = createTurnEngine(cfg, store, reg, {
    openChat: open,
    journal: new QueueJournal(join(dir, 'queue.jsonl')),
    usageLog: new UsageLog(join(dir, 'usage')),
    feedbackLog: new FeedbackLog(join(dir, 'feedback')),
    drafts: new DraftStore(join(dir, 'drafts')),
    ...(o.clock ? { clock: o.clock } : {}),
  });
  return { engine, store, sessions };
}

function chatDriver(o: { markGate?: Promise<void> } = {}): ChatDriver {
  let n = 0;
  return {
    post: async (to: { conv: string }) => ({ conv: to.conv, id: `1700000000.${String(++n).padStart(6, '0')}` }),
    update: async () => {},
    mark: async () => {
      if (o.markGate) await o.markGate;
    },
    permalink: async () => undefined,
  } as unknown as ChatDriver;
}

test('holds — from the first instant a message is accepted, while it runs, until it settles; per project', async () => {
  const run = gate();
  const { engine } = harness({ ask: async () => (await run.wait, 'Done.') });
  const ack = gate();
  const turn = engine.liveTurn(chatDriver({ markGate: ack.wait }), 'C1', '1700000000.000001', '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'hello');
  assert.deepEqual(engine.sandboxUse('alpha'), { held: true }, 'held while the message is still being acknowledged');
  assert.deepEqual(engine.sandboxUse('beta'), { held: false });
  ack.open();
  await flush();
  assert.deepEqual(engine.sandboxUse('alpha'), { held: true }, 'running');
  run.open();
  await turn;
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false }, 'released when it settled');
});

test('holds — the first turn of a new thread waiting for a free slot holds its own project (no chat record yet)', async () => {
  const prev = process.env.TURN_MAX_CONCURRENT;
  process.env.TURN_MAX_CONCURRENT = '1';
  try {
    const run = gate();
    const { engine, store } = harness({ ask: async (s) => (s.slug === 'alpha' ? (await run.wait, 'A') : 'B') });
    const a = engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'busy');
    await flush();
    const b = engine.liveTurn(chatDriver(), 'C2', undefined, '1700000000.000009', 'thread:1700000000.000009', BETA, 'waits');
    try {
      await flush();
      // The turn waits for the slot before doTurn writes its chat record: nothing else can place it.
      assert.equal(store.getChat('thread:1700000000.000009'), undefined);
      assert.equal(engine.slugForKey('thread:1700000000.000009'), undefined);
      assert.equal(engine.projectBusy('beta'), false);
      assert.deepEqual(engine.sandboxUse('beta'), { held: true }, 'its hold carries the project');
    } finally {
      run.open();
    }
    await Promise.all([a, b]);
    assert.deepEqual(engine.sandboxUse('alpha'), { held: false });
    assert.deepEqual(engine.sandboxUse('beta'), { held: false });
  } finally {
    if (prev === undefined) delete process.env.TURN_MAX_CONCURRENT;
    else process.env.TURN_MAX_CONCURRENT = prev;
  }
});

test('holds — an agent question nobody answers holds; a one-off ask holds; a restart recovery holds until it settled', async () => {
  const answered = gate();
  const { engine } = harness({
    ask: async (_s, ctx) => {
      void ctx.onQuestion?.([]).catch(() => {});
      await answered.wait;
      return 'ok';
    },
  });
  const t = engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'ask me');
  await flush();
  assert.deepEqual(engine.sandboxUse('alpha'), { held: true });
  answered.open();
  await t;

  const askRun = gate();
  const h2 = harness({ ask: async () => (await askRun.wait, 'answer') });
  const ask = h2.engine.runAsk('cmd:U1:beta', BETA, 'q');
  assert.deepEqual(h2.engine.sandboxUse('beta'), { held: true }, 'a one-off ask (or a dream)');
  askRun.open();
  await ask;
  assert.deepEqual(h2.engine.sandboxUse('beta'), { held: false });

  const adopted = gate();
  const h3 = harness({
    adopt: async () => (await adopted.wait, { ok: true, status: 'ok', text: 'Recovered.' }),
    seed: (store) =>
      store.patchChat('thread:1700000000.000005', 'alpha', {
        sessionId: 's',
        sessionKey: 'claude-sess-1-1',
        cmdId: '41',
        inflight: { channel: 'C1', statusTs: '1700000000.000006', startedAt: '2026-10-19T00:00:00Z' },
      }),
  });
  const recovering = h3.engine.resumeInflightTurns(() => chatDriver());
  assert.deepEqual(h3.engine.sandboxUse('alpha'), { held: true }, 'held before the recovery even opened its session');
  adopted.open();
  await recovering.get('thread:1700000000.000005');
  assert.deepEqual(h3.engine.sandboxUse('alpha'), { held: false });
});

test('holds — a hold older than the turn hard cap plus the margin stops holding: it lingers as a stale hold', async () => {
  let now = 1_000_000; // the idle stop's monotonic clock
  const hang = gate();
  const { engine } = harness({ ask: async () => (await hang.wait, 'late'), clock: () => now });
  const turn = engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'hang');
  await flush();
  now += 60 * 60_000 + STALE_HOLD_MARGIN_MS - 1000;
  assert.deepEqual(engine.sandboxUse('alpha'), { held: true });
  now += 2000;
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false, lingering: 'stale-hold' });
  hang.open();
  await turn;
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false });
});

test('holds — measured on the monotonic clock: a wall-clock jump during a turn (a laptop that slept for hours) leaves its hold a hold', async (t) => {
  const hang = gate();
  const { engine } = harness({ ask: async () => (await hang.wait, 'late') }); // the real clock (monoNow)
  const turn = engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'long');
  await flush();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 60 * 60_000 }); // the watchdog's timers did not see these hours either
  assert.deepEqual(engine.sandboxUse('alpha'), { held: true });
  t.mock.timers.reset();
  hang.open();
  await turn;
});

test('lingering — background tasks, an unanswered injected message, a turn of the CLI\'s own; the latest wakeup of the project', async (t) => {
  const { engine, sessions } = harness();
  await engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'one');
  await engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000002', 'thread:1700000000.000002', ALPHA, 'two');
  await engine.liveTurn(chatDriver(), 'C2', undefined, '1700000000.000003', 'thread:1700000000.000003', BETA, 'three');
  const [a1, a2, b1] = sessions;
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false });
  a1!.state = { background: 0, injected: 0, selfTurn: true };
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false, lingering: 'self-turn' });
  a2!.state = { background: 0, injected: 1, selfTurn: false };
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false, lingering: 'injected' }, 'injected outranks a self-started turn');
  // A wakeup's due time is the CLI's, on the wall clock: the rule gets how far away it is.
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  a1!.state = { background: 2, injected: 0, selfTurn: false, wakeupDueAt: 5_000 };
  a2!.state = { background: 0, injected: 0, selfTurn: false, wakeupDueAt: 9_000 };
  b1!.state = { background: 0, injected: 0, selfTurn: false, wakeupDueAt: 99_000 };
  assert.deepEqual(engine.sandboxUse('alpha'), { held: false, lingering: 'background', wakeupInMs: 8_000 }, 'only alpha\'s sessions, the latest wakeup');
  t.mock.timers.tick(10_000);
  assert.equal(engine.sandboxUse('alpha').wakeupInMs, -2_000, 'past due: negative (the rule waits two more minutes)');
});

test('sandboxStopped — ends only that project\'s live sessions, the notice everywhere but a shadow conversation, coordinates forgotten; the next turn asks the same session', async () => {
  const { engine, store, sessions } = harness();
  await engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'one');
  await engine.liveTurn(chatDriver(), 'C9', undefined, undefined, 'a2a:northwind:0123456789abcdef01234567:alpha', ALPHA, 'shadow');
  await engine.liveTurn(chatDriver(), 'C2', undefined, '1700000000.000003', 'thread:1700000000.000003', BETA, 'three');
  assert.equal(store.getChat('thread:1700000000.000001')?.cmdId, '41');
  engine.sandboxStopped('alpha', 61);
  const [a, shadow, b] = sessions;
  assert.equal(a!.ended.length, 1);
  assert.match(a!.ended[0]!, /^⏹ The sandbox was stopped after 61 min without activity — the background work still running in this conversation ended with it\./);
  assert.deepEqual(shadow!.ended, [undefined], 'a shadow conversation: its idle target is the task\'s completion rule');
  assert.deepEqual(b!.ended, [], 'another project is untouched');
  assert.equal(store.getChat('thread:1700000000.000001')?.cmdId, undefined, 'no reattach by pid after a restart');
  assert.equal(store.getChat('thread:1700000000.000001')?.sessionId, 'sess-1', 'the conversation resumes');
  assert.equal(store.getChat('thread:1700000000.000003')?.cmdId, '41');
  assert.equal(engine.hasLive('thread:1700000000.000001'), true, 'kept in the live map');
  await engine.liveTurn(chatDriver(), 'C1', undefined, '1700000000.000001', 'thread:1700000000.000001', ALPHA, 'again');
  assert.equal(sessions.length, 3, 'no new chat prep');
  assert.equal(a!.asks, 2, 'the same ChatSession, which reopens with --resume');
});
