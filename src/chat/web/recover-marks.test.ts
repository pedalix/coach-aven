// A turn interrupted by a bot restart and finished by the restart's recovery (turn.ts resumeInflightTurns) must
// leave the conversation as a live turn does: the answer in the thread, the status message settled, AND the
// person's message moved from `working` (👀) to `done` (✅). The first bot runs the turn for real until the
// "restart" (its session never answers); a second engine on the same state file and history directory is the
// restarted bot. Fictional names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
import { createTurnEngine } from '../../turn.js';
import { History } from './history.js';
import { webDriver } from './driver.js';

const PROJECT: ProjectConfig = { slug: 'alpha', repos: ['Org/alpha'] } as ProjectConfig;
const reg: RegistryRef = { current: { projects: [PROJECT] } } as unknown as RegistryRef;
const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
const ROOM = 'room:alpha';
const KEY = 'web:thread:r1';

function fakeSession(o: { ask: (signal: AbortSignal) => Promise<string>; adopt: (onLong: () => void) => Promise<{ ok: boolean; status: string; text: string }> }): typeof openChat {
  // Like the real openChat once its process is up: the command's coordinates go into the chat record (onOpen),
  // which is what makes the turn reattachable after a restart.
  return (async (_cfg: unknown, _store: unknown, opts: { onOpen?: (i: { sessionKey: string; cmdId: string; ledger: boolean }) => void }) => {
    opts.onOpen?.({ sessionKey: 'sk-1', cmdId: 'cmd-1', ledger: false });
    return {
      ask: (_p: string, _s?: unknown, signal?: AbortSignal) => o.ask(signal ?? new AbortController().signal),
      adoptInflight: (_s: unknown, onLong?: () => void) => o.adopt(onLong ?? (() => {})),
      sessionId: () => 'sess-1',
      attachInfo: () => ({ sessionKey: 'sk-1', cmdId: 'cmd-1' }),
      contextLost: () => false,
      lastUsage: () => undefined,
      ingest: async () => ({ preamble: '', skipped: [] }),
      collectOutbox: async () => ({ files: [], skipped: [] }),
      memoryReads: () => [],
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
  }) as unknown as typeof openChat;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
  }
};

const engineOn = (dir: string, open: typeof openChat) =>
  createTurnEngine(cfg, new Store(join(dir, 'state.json')), reg, {
    openChat: open,
    journal: new QueueJournal(join(dir, 'queue.jsonl')),
    usageLog: new UsageLog(join(dir, 'usage')),
    feedbackLog: new FeedbackLog(join(dir, 'feedback')),
    drafts: new DraftStore(join(dir, 'drafts')),
  });

test('web: a turn recovered after a restart settles the person’s message (working → done), as a live turn does', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-recover-marks-'));

  // ── the first bot: the turn starts, the agent works on, the bot "restarts" ──
  const history1 = new History(join(dir, 'web'));
  let n1 = 0;
  const driver1 = webDriver({ history: history1, baseUrl: 'https://chat.example', nameOf: () => 'Ann', ids: () => `a${++n1}` });
  history1.conversation(ROOM).append({ t: 'post', id: 'r1', by: { id: 'u1', name: 'Ann' }, text: 'move the test suite' });
  const before = engineOn(
    dir,
    fakeSession({
      ask: (signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true })),
      adopt: async () => ({ ok: false, status: 'error', text: '' }),
    }),
  );
  const running = before.liveTurn(driver1, ROOM, 'r1', 'r1', KEY, PROJECT, 'move the test suite');
  // The first bot's turn never ends on its own: cancel it at the end, pass or fail, so the test process can exit.
  t.after(async () => {
    before.cancelKey(KEY);
    await running.catch(() => {});
  });
  await settle();
  assert.deepEqual(history1.conversation(ROOM).message('r1')?.marks, ['working'], 'the live turn marked the person’s message');

  // ── the restarted bot: same state file, same history directory, a fresh process ──
  const history2 = new History(join(dir, 'web'));
  let n2 = 0;
  const driver2 = webDriver({ history: history2, baseUrl: 'https://chat.example', nameOf: () => 'Ann', ids: () => `b${++n2}` });
  const after = engineOn(
    dir,
    fakeSession({
      ask: async () => 'unused',
      // As on 2026-11-05: the recovered turn outlives the soft deadline, then the agent's result arrives.
      adopt: async (onLong) => {
        onLong();
        return { ok: true, status: 'ok', text: 'The suite is moved; the workflow is green.' };
      },
    }),
  );
  await Promise.all(after.resumeInflightTurns(() => driver2).values());
  await settle();

  const conv = history2.conversation(ROOM);
  const thread = conv.thread('r1');
  // Delivered: the answer is a new message in the thread, the status points at it.
  const answer = thread.find((m) => m.view?.kind === 'answer');
  assert.ok(answer, 'the recovered answer is posted in the thread');
  assert.equal((answer!.view as { markdown: string }).markdown, 'The suite is moved; the workflow is green.');
  const status = thread.find((m) => m.id === 'a1');
  assert.deepEqual(status?.view, { kind: 'text', text: '✅ Done — answer posted below' });
  // Settled like a live turn: without this the person’s message carried `working` (👀 seen) forever.
  assert.deepEqual(conv.message('r1')?.marks, ['done'], 'the recovered turn moves the person’s message from working to done');
});
