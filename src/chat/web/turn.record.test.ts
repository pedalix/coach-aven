// The core turn scenarios of chat-driver-interface against the web driver (web-chat-driver 2.6): the REAL
// turn engine with a scripted fake session, the web driver over a history store in a temp dir, and the
// conversation's stored events pinned per scenario (src/fixtures/chat/web/turn/*.json). The clock is
// frozen (mock.timers) and ids are sequential, so the files are deterministic. Re-snapshot on purpose
// with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import { QueueJournal } from '../../queuejournal.js';
import { UsageLog } from '../../metering.js';
import { FeedbackLog } from '../../feedback.js';
import { DraftStore } from '../../drafts.js';
import type { ProjectConfig, RegistryRef } from '../../projects.js';
import type { ChatSession, openChat } from '../../tasks.js';
import type { OnQuestion } from '../../claudeSession.js';
import { createTurnEngine, type TurnEngine, type TurnOpts } from '../../turn.js';
import { History, type Stored } from './history.js';
import { webDriver, type WebChatDriver } from './driver.js';

const SNAP_DIR = new URL('../../fixtures/chat/web/turn/', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const PROJECT: ProjectConfig = { slug: 'alpha', repos: ['Org/alpha'] } as ProjectConfig;
const reg: RegistryRef = { current: { projects: [PROJECT] } } as unknown as RegistryRef;
const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
const ROOM = 'room:alpha';
const PC = 'pc:u1:alpha';

type AskScript = (ctx: { prompt: string; onStep: (s: string) => void; signal: AbortSignal; onQuestion: OnQuestion; onLong: () => void }) => Promise<string>;
interface FakeOpts {
  ask?: AskScript;
  adopt?: (onLong: () => void) => Promise<{ ok: boolean; status: string; text: string }>;
}
function fakeOpenChat(o: FakeOpts): typeof openChat {
  return (async () => {
    const session = {
      ask: async (prompt: string, onStep?: (s: string) => void, signal?: AbortSignal, onQuestion?: OnQuestion, onLong?: () => void) =>
        (o.ask ?? (async () => 'Done.'))({ prompt, onStep: onStep ?? (() => {}), signal: signal ?? new AbortController().signal, onQuestion: onQuestion ?? (async () => ({})), onLong: onLong ?? (() => {}) }),
      sessionId: () => 'sess-1',
      attachInfo: () => ({ sessionKey: 'sk-1', cmdId: 'cmd-1' }),
      adoptInflight: async (_s: unknown, onLong?: () => void) => (o.adopt ? o.adopt(onLong ?? (() => {})) : { ok: true, status: 'ok', text: 'Recovered.' }),
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
      idleState: () => ({ background: 0, injected: 0, selfTurn: false }),
      processEnded: () => {},
    } as unknown as ChatSession;
    return session;
  }) as unknown as typeof openChat;
}
const untilAborted = (signal: AbortSignal) =>
  new Promise<string>((_, reject) => {
    if (signal.aborted) reject(new Error('canceled'));
    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
  });

const NOW = Date.UTC(2026, 9, 26, 10, 0);
const BOOT = NOW.toString(36); // the engine's turn ids are `t<boot>-<n>` with boot = Date.now() at creation (frozen here)
before(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
after(() => mock.timers.reset());

function harness(fake: FakeOpts, seed?: (store: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-turnrec-'));
  const store = new Store(join(dir, 'state.json'));
  seed?.(store);
  const engine = createTurnEngine(cfg, store, reg, {
    openChat: fakeOpenChat(fake),
    journal: new QueueJournal(join(dir, 'queue.jsonl')),
    usageLog: new UsageLog(join(dir, 'usage')),
    feedbackLog: new FeedbackLog(join(dir, 'feedback')),
    drafts: new DraftStore(join(dir, 'drafts')),
  });
  const history = new History(join(dir, 'web'));
  let seq = 0;
  const driver = webDriver({ history, baseUrl: 'https://chat.example', nameOf: (id) => (id === 'u1' ? 'Ann' : undefined), ids: () => `m${++seq}` });
  const seed1 = (conv: string, id: string, text: string, thread?: string) => history.conversation(conv).append({ t: 'post', id, ...(thread ? { thread } : {}), by: { id: 'u1', name: 'Ann' }, text });
  return { engine, store, driver, history, seed1 };
}

// Fire-and-forget appends (a cancel while queued, a question cleanup) land after the turn's promise settles.
async function quiesce(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function record(name: string, run: () => Promise<{ history: History; convs: string[] }>): Promise<void> {
  const { history, convs } = await run();
  await quiesce();
  const got = Object.fromEntries(convs.map((c) => [c, history.conversation(c).since(0).map((e: Stored) => e)]));
  const file = join(SNAP_DIR, `${name}.json`);
  if (UPDATE || !existsSync(file)) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
  assert.deepEqual(got, JSON.parse(readFileSync(file, 'utf8')));
}

const mention = (engine: TurnEngine, d: WebChatDriver, rootId: string, q: string, opts?: TurnOpts) => engine.liveTurn(d, ROOM, rootId, rootId, 'web:thread:' + rootId, PROJECT, q, undefined, opts);

test('web turn: a top-level post → steps → answer with a PR link, marks on the post, a permalink to the thread', async () => {
  await record('answer', async () => {
    const { engine, driver, history, seed1 } = harness({
      ask: async ({ onStep }) => {
        onStep('📖 Read src/a.ts');
        onStep('✏️ Edit src/a.ts');
        return 'Fixed it in https://github.com/Org/alpha/pull/7 — **done**.';
      },
    });
    seed1(ROOM, 'r1', 'fix the bug');
    await mention(engine, driver, 'r1', 'fix the bug');
    assert.equal(await driver.permalink({ conv: ROOM, id: 'r1' }), 'https://chat.example/r/alpha/t/r1');
    return { history, convs: [ROOM] };
  });
});

test('web turn: a private conversation (no thread, no permalink)', async () => {
  await record('private', async () => {
    const { engine, driver, history, seed1 } = harness({});
    seed1(PC, 'p1', 'hi');
    await engine.liveTurn(driver, PC, 'p1', undefined, 'web:dm:pc:u1:alpha:alpha', PROJECT, 'hi');
    assert.equal(await driver.permalink({ conv: PC, id: 'p1' }), undefined);
    return { history, convs: [PC] };
  });
});

test('web turn: a second post queues behind the running turn, then runs', async () => {
  await record('queued', async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const { engine, driver, history, seed1 } = harness({ ask: () => (++calls === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve('Second.')) });
    seed1(ROOM, 'r1', 'one');
    const first = mention(engine, driver, 'r1', 'one');
    await quiesce();
    seed1(ROOM, 'r2', 'two', 'r1');
    const second = engine.liveTurn(driver, ROOM, 'r2', 'r1', 'web:thread:r1', PROJECT, 'two');
    await quiesce();
    release('First.');
    await Promise.all([first, second]);
    return { history, convs: [ROOM] };
  });
});

test('web turn: cancel while running, cancel while queued', async () => {
  await record('cancel', async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const { engine, driver, history, seed1 } = harness({ ask: ({ signal }) => (++calls === 1 ? untilAborted(signal) : new Promise<string>((r) => (release = r))) });
    seed1(ROOM, 'r1', 'long job');
    const t = mention(engine, driver, 'r1', 'long job');
    await quiesce();
    engine.cancel(`t${BOOT}-1`);
    await t;
    seed1(ROOM, 'r2', 'one');
    const a = mention(engine, driver, 'r2', 'one');
    await quiesce();
    seed1(ROOM, 'r3', 'two', 'r2');
    const b = engine.liveTurn(driver, ROOM, 'r3', 'r2', 'web:thread:r2', PROJECT, 'two');
    await quiesce();
    engine.cancel(`t${BOOT}-3`);
    await quiesce();
    release('A.');
    await Promise.all([a, b]);
    return { history, convs: [ROOM] };
  });
});

test('web turn: the agent fails; a "!" note starts no turn and gets the note mark', async () => {
  await record('error-and-note', async () => {
    const { engine, driver, history, seed1 } = harness({
      ask: async () => {
        throw new Error('sandbox exploded');
      },
    });
    seed1(ROOM, 'r1', 'do it');
    await mention(engine, driver, 'r1', 'do it');
    seed1(ROOM, 'r2', '! just a note');
    await mention(engine, driver, 'r2', '! just a note');
    return { history, convs: [ROOM] };
  });
});

test('web turn: soft deadline → background card → the answer as a new message', async () => {
  await record('background', async () => {
    const { engine, driver, history, seed1 } = harness({
      ask: async ({ onStep, onLong }) => {
        onStep('🔧 Bash npm test');
        onLong();
        return 'Finally done.';
      },
    });
    seed1(ROOM, 'r1', 'slow');
    await mention(engine, driver, 'r1', 'slow');
    return { history, convs: [ROOM] };
  });
});

test('web turn: an agent question is posted, answered through the core’s action, then the answer', async () => {
  await record('question', async () => {
    const { engine, driver, history, seed1 } = harness({
      ask: async ({ onQuestion }) => {
        const a = await onQuestion([{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]);
        return `Using ${Object.values(a)[0]}.`;
      },
    });
    seed1(ROOM, 'r1', 'set up storage');
    const t = mention(engine, driver, 'r1', 'set up storage');
    await quiesce();
    // The person picks the second option: what the core's answer_q handler does with the engine's registry.
    const entry = engine.questions.get('q1')!;
    entry.picks.set(0, new Set([1]));
    await driver.update({ conv: ROOM, id: entry.ts }, { kind: 'question', questions: entry.questions, picks: entry.picks, multi: entry.multi, qid: 'q1', done: true });
    engine.questions.finalize(entry, 'q1');
    await t;
    return { history, convs: [ROOM] };
  });
});

test('web turn: an in-flight turn is recovered after a restart into its original thread (ok, and gone)', async () => {
  const seed = (store: Store) =>
    store.patchChat('web:thread:r1', 'alpha', { sessionKey: 'sk-1', cmdId: 'cmd-1', inflight: { channel: ROOM, statusTs: 'm1', msgThreadTs: 'r1', startedAt: '2026-10-26T09:00:00.000Z' } });
  await record('recover', async () => {
    const { engine, driver, history, seed1 } = harness({}, seed);
    seed1(ROOM, 'r1', 'fix the bug');
    history.conversation(ROOM).append({ t: 'post', id: 'm1', thread: 'r1', view: { kind: 'status', line: '🔎 Working…', turnId: 't-old', notify: 'Working…' } });
    const recovering = engine.resumeInflightTurns(() => driver);
    await Promise.all(recovering.values());
    return { history, convs: [ROOM] };
  });
  await record('recover-lost', async () => {
    const { engine, driver, history, seed1 } = harness({ adopt: async () => ({ ok: false, status: 'timeout', text: '' }) }, seed);
    seed1(ROOM, 'r1', 'fix the bug');
    history.conversation(ROOM).append({ t: 'post', id: 'm1', thread: 'r1', view: { kind: 'status', line: '🔎 Working…', turnId: 't-old', notify: 'Working…' } });
    const recovering = engine.resumeInflightTurns(() => driver);
    await Promise.all(recovering.values());
    return { history, convs: [ROOM] };
  });
});
