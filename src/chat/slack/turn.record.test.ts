// Recorded-call pins for the turn path (OpenSpec chat-driver-interface, task 1.1). Drives the
// REAL turn engine against a REAL Slack WebClient whose Web API is the twin's RecordingApi,
// with a scripted fake session instead of a sandbox, and snapshots every Slack call in order.
// The snapshots were taken on the code BEFORE the turn path moved behind the chat driver and
// must stay byte-identical after it: that is the proof that Slack users see no change.
//
// Clock: Date is frozen (mock.timers), so elapsed times render as 0s and the 1.5 s status
// throttle only lets FORCED flushes through — deterministic without sleeping.
// Re-snapshot on purpose with UPDATE_SNAPSHOTS=1 (then review the diff like any golden file).

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bolt from '@slack/bolt';
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
import { RecordingApi } from '../../twin.js';
import type { ChatDriver } from '../driver.js';
import { slackDriver } from './driver.js';

const SNAP_DIR = new URL('../../fixtures/chat/turn/', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const PROJECT: ProjectConfig = { slug: 'alpha', repos: ['Org/alpha'] } as ProjectConfig;
const reg: RegistryRef = { current: { projects: [PROJECT] } } as unknown as RegistryRef;
const cfg = {
  sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 },
} as unknown as Config;

// What a scenario's fake session does when asked. Everything the engine hands to ask().
type AskScript = (ctx: {
  prompt: string;
  onStep: (s: string) => void;
  signal: AbortSignal;
  onQuestion: OnQuestion;
  onLong: () => void;
}) => Promise<string>;

interface FakeOpts {
  ask?: AskScript;
  adopt?: (onLong: () => void) => Promise<{ ok: boolean; status: string; text: string }>;
  contextLost?: boolean;
  skipped?: { name: string; reason: string }[];
  idleText?: string; // fire the idle-notify callback with this text right after ask resolves
}

function fakeOpenChat(o: FakeOpts): typeof openChat {
  return (async () => {
    let idle: ((t: string) => void) | undefined;
    let lost = o.contextLost ?? false;
    const session: ChatSession = {
      ask: async (prompt, onStep, signal, onQuestion, onLong) => {
        const text = await (o.ask ?? (async () => 'Done.'))({
          prompt,
          onStep: onStep ?? (() => {}),
          signal: signal ?? new AbortController().signal,
          onQuestion: onQuestion ?? (async () => ({})),
          onLong: onLong ?? (() => {}),
        });
        if (o.idleText && idle) idle(o.idleText);
        return text;
      },
      sessionId: () => 'sess-1',
      attachInfo: () => ({ sessionKey: 'sk-1', cmdId: 'cmd-1' }),
      adoptInflight: async (_s, onLong) => (o.adopt ? o.adopt(onLong ?? (() => {})) : { ok: true, status: 'ok', text: 'Recovered.' }),
      contextLost: () => {
        const v = lost;
        lost = false;
        return v;
      },
      lastUsage: () => undefined,
      ingest: async () => ({ preamble: '[files: /inbox/a.png]', skipped: o.skipped ?? [] }),
      close: async () => {},
      setIdleNotify: (fn) => {
        idle = fn;
      },
    };
    return session;
  }) as unknown as typeof openChat;
}

// An abortable wait — what a real session does on ✖ Cancel.
const untilAborted = (signal: AbortSignal) =>
  new Promise<string>((_, reject) => {
    if (signal.aborted) reject(new Error('canceled'));
    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
  });

let api: RecordingApi;
let url: string;
before(async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  api = new RecordingApi({}, {}, true);
  url = await api.start();
});
after(async () => {
  mock.timers.reset();
  await api.stop();
});

function harness(fake: FakeOpts, seed?: (store: Store, journal: QueueJournal) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-turnrec-'));
  const store = new Store(join(dir, 'state.json'));
  const journal = new QueueJournal(join(dir, 'queue.jsonl'));
  seed?.(store, journal);
  const engine = createTurnEngine(cfg, store, reg, {
    openChat: fakeOpenChat(fake),
    journal,
    usageLog: new UsageLog(join(dir, 'usage')),
    feedbackLog: new FeedbackLog(join(dir, 'feedback')),
    drafts: new DraftStore(join(dir, 'drafts')),
  });
  const client = slackDriver(new bolt.webApi.WebClient('xoxb-home', { slackApiUrl: url, retryConfig: { retries: 0 } }));
  return { engine, store, client };
}

// Fire-and-forget Slack calls (cancel-while-queued, question cleanup) land after the turn's
// promise settles; wait until the recording has been quiet for a moment.
async function quiesce(): Promise<void> {
  let n = -1;
  while (n !== api.calls.length) {
    n = api.calls.length;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function record(name: string, run: () => Promise<void>): Promise<void> {
  api.reset();
  await run();
  await quiesce();
  const got = api.calls.map((c) => ({ method: c.method, payload: c.payload }));
  const file = join(SNAP_DIR, `${name}.json`);
  if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
  assert.ok(existsSync(file), `missing snapshot ${file} — run with UPDATE_SNAPSHOTS=1`);
  assert.deepEqual(got, JSON.parse(readFileSync(file, 'utf8')));
}

const mention = (engine: TurnEngine, client: ChatDriver, q: string, opts?: TurnOpts) =>
  engine.liveTurn(client, 'C1', '100.1', '100.1', 'thread:100.1', PROJECT, q, undefined, opts);

test('turn record: mention → steps → answer with a PR link', async () => {
  await record('answer', async () => {
    const { engine, client } = harness({
      ask: async ({ onStep }) => {
        onStep('📖 Read src/a.ts');
        onStep('✏️ Edit src/a.ts');
        return 'Fixed it in https://github.com/Org/alpha/pull/7 — **done**.';
      },
    });
    await mention(engine, client, 'fix the bug');
  });
});

test('turn record: DM turn (no thread, no permalink)', async () => {
  await record('dm', async () => {
    const { engine, client } = harness({});
    await engine.liveTurn(client, 'D1', '200.1', undefined, 'dm:D1:alpha', PROJECT, 'hi');
  });
});

test('turn record: a second message queues behind the running turn', async () => {
  await record('queued', async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const { engine, client } = harness({
      ask: () => (++calls === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve('Second.')),
    });
    const first = mention(engine, client, 'one');
    await quiesce();
    const second = engine.liveTurn(client, 'C1', '100.2', '100.1', 'thread:100.1', PROJECT, 'two');
    await quiesce();
    release('First.');
    await Promise.all([first, second]);
  });
});

test('turn record: cancel while running', async () => {
  await record('cancel-running', async () => {
    const { engine, client } = harness({ ask: async ({ signal }) => untilAborted(signal) });
    const t = mention(engine, client, 'long job');
    await quiesce();
    engine.cancel('t0-1');
    await t;
  });
});

test('turn record: cancel while queued', async () => {
  await record('cancel-queued', async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const { engine, client } = harness({
      ask: () => (++calls === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve('never')),
    });
    const first = mention(engine, client, 'one');
    await quiesce();
    const second = engine.liveTurn(client, 'C1', '100.2', '100.1', 'thread:100.1', PROJECT, 'two');
    await quiesce();
    engine.cancel('t0-2');
    await quiesce();
    release('First.');
    await Promise.all([first, second]);
  });
});

test('turn record: the agent fails', async () => {
  await record('error', async () => {
    const { engine, client } = harness({
      ask: async () => {
        throw new Error('sandbox exploded');
      },
    });
    await mention(engine, client, 'do it');
  });
});

test('turn record: soft deadline → background card → answer as a new message', async () => {
  await record('background', async () => {
    const { engine, client } = harness({
      ask: async ({ onStep, onLong }) => {
        onStep('🔧 Bash npm test');
        onLong();
        return 'Finally done.';
      },
    });
    await mention(engine, client, 'slow');
  });
});

test('turn record: background turn that fails', async () => {
  await record('background-error', async () => {
    const { engine, client } = harness({
      ask: async ({ onLong }) => {
        onLong();
        throw new Error('timed out');
      },
    });
    await mention(engine, client, 'slow');
  });
});

test('turn record: agent question answered, then the answer', async () => {
  await record('question', async () => {
    let engineRef!: TurnEngine;
    const { engine, client } = harness({
      ask: async ({ onQuestion }) => {
        const p = onQuestion([{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]);
        await quiesce();
        const entry = engineRef.questions.get('q1')!;
        entry.picks.set(0, new Set([1]));
        engineRef.questions.finalize(entry, 'q1');
        const answers = await p;
        return `Going with ${answers['Which DB?']}.`;
      },
    });
    engineRef = engine;
    await mention(engine, client, 'set up storage');
  });
});

test('turn record: question left open when the turn fails is closed', async () => {
  await record('question-closed', async () => {
    const { engine, client } = harness({
      ask: async ({ onQuestion }) => {
        void onQuestion([{ question: 'Sure?', multiSelect: true, options: [{ label: 'Yes' }, { label: 'No' }] }]).catch(() => {});
        await quiesce();
        throw new Error('gave up');
      },
    });
    await mention(engine, client, 'ask me');
  });
});

test('turn record: question canceled with the turn', async () => {
  await record('question-canceled', async () => {
    const { engine, client } = harness({
      ask: async ({ onQuestion, signal }) => {
        void onQuestion([{ question: 'Sure?', options: [{ label: 'Yes' }] }]).catch(() => {});
        return untilAborted(signal);
      },
    });
    const t = mention(engine, client, 'ask me');
    await quiesce();
    engine.cancel('t0-1');
    await t;
  });
});

test('turn record: a "!" note starts no turn', async () => {
  await record('note', async () => {
    const { engine, client } = harness({});
    await mention(engine, client, '! just a note for Ann');
  });
});

test('turn record: attachments with a skipped file, context lost, background update', async () => {
  await record('attachments-contextlost-idle', async () => {
    const { engine, client } = harness({
      skipped: [{ name: 'movie.mov', reason: 'unsupported type' }],
      contextLost: true,
      idleText: 'The background agent finished: 3 files changed.',
    });
    await engine.liveTurn(client, 'C1', '100.1', '100.1', 'thread:100.1', PROJECT, 'look at this', {
      refs: [
        { name: 'a.png', url: 'https://files/a.png', mime: 'image/png', size: 10 },
        { name: 'movie.mov', url: 'https://files/m.mov', mime: 'video/quicktime', size: 10 },
      ],
      bearer: 'xoxb-home',
    });
  });
});

test('turn record: YouTrack draft turn', async () => {
  await record('yt-draft', async () => {
    const { engine, client } = harness({ ask: async () => 'Internal note: root cause is X.' });
    await mention(engine, client, 'draft a report', { ytDraftFor: 'SUP-12' });
  });
});

test('turn record: YouTrack auto-post succeeds', async () => {
  await record('yt-autopost-ok', async () => {
    const { engine, client } = harness({ ask: async () => 'Root cause is X.' });
    await mention(engine, client, 'report', {
      ytDraftFor: 'SUP-12',
      autoPost: async () => ({ url: 'https://yt/issue/SUP-12#c1', group: 'Support' }),
    });
  });
});

test('turn record: YouTrack auto-post fails → reviewable draft with the error', async () => {
  await record('yt-autopost-fail', async () => {
    const { engine, client } = harness({ ask: async () => 'Root cause is X.' });
    await mention(engine, client, 'report', {
      ytDraftFor: 'SUP-12',
      autoPost: async () => {
        throw new Error('403 forbidden');
      },
    });
  });
});

test('turn record: no free agent slot → waiting status', async () => {
  const prev = process.env.TURN_MAX_CONCURRENT;
  process.env.TURN_MAX_CONCURRENT = '1';
  try {
    await record('slot-wait', async () => {
      let release!: (v: string) => void;
      let calls = 0;
      const { engine, client } = harness({
        ask: () => (++calls === 1 ? new Promise<string>((r) => (release = r)) : Promise.resolve('B done.')),
      });
      const a = engine.liveTurn(client, 'C1', '100.1', '100.1', 'thread:100.1', PROJECT, 'a');
      await quiesce();
      const b = engine.liveTurn(client, 'C2', '300.1', '300.1', 'thread:300.1', PROJECT, 'b');
      await quiesce();
      release('A done.');
      await Promise.all([a, b]);
    });
  } finally {
    if (prev === undefined) delete process.env.TURN_MAX_CONCURRENT;
    else process.env.TURN_MAX_CONCURRENT = prev;
  }
});

// ── restart recovery ─────────────────────────────────────────────────────────
const inflightSeed = (store: Store) => {
  store.patchChat('thread:100.1', 'alpha', {
    sessionKey: 'sk-1',
    cmdId: 'cmd-1',
    inflight: { channel: 'C1', statusTs: '100.5', msgThreadTs: '100.1', startedAt: '1970-01-01T00:00:00.000Z' },
  });
};

async function recover(fake: FakeOpts, seed: (store: Store, journal: QueueJournal) => void): Promise<void> {
  const { engine, client } = harness(fake, seed);
  const recovering = engine.resumeInflightTurns(() => client);
  await Promise.all(recovering.values());
  engine.resumeQueuedTurns(() => client, recovering);
}

test('turn record: in-flight turn recovered after a restart', async () => {
  await record('recover-ok', () => recover({}, inflightSeed));
});

test('turn record: recovered turn goes background, answer as a new message', async () => {
  await record('recover-background', () =>
    recover(
      {
        adopt: async (onLong) => {
          onLong();
          return { ok: true, status: 'ok', text: 'Recovered late.' };
        },
      },
      inflightSeed,
    ),
  );
});

test('turn record: in-flight turn not recoverable', async () => {
  await record('recover-lost', () => recover({ adopt: async () => ({ ok: false, status: 'timeout', text: '' }) }, inflightSeed));
});

test('turn record: queued turns replayed after a restart (plain reruns, non-plain asks for a resend)', async () => {
  await record('replay-queued', () =>
    recover({ ask: async () => 'Replayed.' }, (_store, journal) => {
      journal.add({
        turnId: 'tOLD-1',
        key: 'thread:100.1',
        slug: 'alpha',
        channel: 'C1',
        statusTs: '100.6',
        threadTs: '100.1',
        msgTs: '100.3',
        question: 'plain one',
        plain: true,
      });
      journal.add({
        turnId: 'tOLD-2',
        key: 'thread:100.1',
        slug: 'alpha',
        channel: 'C1',
        statusTs: '100.7',
        threadTs: '100.1',
        msgTs: '100.4',
        question: 'with files',
        plain: false,
      });
    }),
  );
});
