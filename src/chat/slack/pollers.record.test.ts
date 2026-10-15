// Recorded-call pins for what the bot posts on its own (OpenSpec chat-driver-interface,
// task 4.1): scheduled routines (guard off and on, answered / failed / canceled / stacked /
// orphaned), reviews, and the dispatch primitive (Send for a message and a task, Dismiss,
// outbox ingest gated and auto-approved, rejected and duplicate files). Real createPollers /
// createDispatcher against the twin's RecordingApi with a recording fake engine that plays
// the turn's outcome. Taken before the deliveries moved behind the chat driver; the move must
// leave them byte-identical. Re-snapshot on purpose with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bolt from '@slack/bolt';
import type { Config } from '../../config.js';
import { Store, type RoutineRecord } from '../../state.js';
import { createChannels } from '../../channels.js';
import { createPollers } from '../../pollers.js';
import { createDispatcher, type Dispatcher } from '../../dispatchrun.js';
import { dispatch, outboxDir, type StoredProposal } from '../../dispatch.js';
import { routineGuard } from '../../routineguard.js';
import type { TurnEngine, TurnOpts } from '../../turn.js';
import { RecordingApi } from './twin.js';
import { slackDriver, type SlackChatDriver } from './driver.js';

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAP = (name: string) => new URL(`../../fixtures/chat/pollers/${name}.json`, import.meta.url).pathname;
const HOME = 'THOME1111';

let api: RecordingApi;
let url: string;
before(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 7, 0) });
  api = new RecordingApi({}, {}, true);
  url = await api.start();
});
after(async () => {
  mock.timers.reset();
  await api.stop();
});

type Outcome = 'answer' | 'error' | 'canceled' | 'hang';
function recordingEngine(outcome: Outcome) {
  const log: unknown[] = [];
  const busy = new Set<string>();
  const turns: Promise<void>[] = []; // every non-hanging turn, so a recording can wait them out
  const engine = {
    liveTurn: (...args: Parameters<typeof play>) => {
      const p = play(...args);
      if (outcome !== 'hang') turns.push(p);
      return p;
    },
    restartSession: async (key: string, project: { slug: string }) => log.push({ restartSession: { key, slug: project.slug } }),
    hasKey: (key: string) => busy.has(key),
  } as unknown as TurnEngine;
  async function play(
    d: SlackChatDriver,
    channel: string,
    msgTs: string | undefined,
    threadTs: string | undefined,
    key: string,
    project: { slug: string },
    question: string,
    attachments?: unknown,
    opts?: TurnOpts,
  ): Promise<void> {
    log.push({ liveTurn: { token: (d.client as { token?: string }).token, channel, msgTs, threadTs, key, slug: project.slug, question, attachments: !!attachments, routine: opts?.routine, origin: opts?.origin } });
    if (outcome === 'hang') return new Promise<void>(() => {});
    if (outcome === 'answer') {
      await opts?.onAnswer?.('Shipped 3 PRs yesterday.\nDetails follow.');
      await opts?.onSettle?.('ok');
    } else {
      await opts?.onSettle?.(outcome, outcome === 'error' ? 'sandbox exploded\nstack…' : undefined);
    }
  }
  return { engine, log, busy, turns };
}

function harness(outcome: Outcome = 'answer') {
  const dir = mkdtempSync(join(tmpdir(), 'aven-pollrec-'));
  process.env.AVEN_DATA_DIR = join(dir, 'data');
  const store = new Store(join(dir, 'state.json'));
  const reg = {
    current: {
      projects: [
        { slug: 'alpha', repos: ['Org/alpha'], dispatch: { auto: ['beta'] } },
        { slug: 'beta', repos: ['Org/beta'] },
      ],
      workspaces: { [HOME]: ['alpha', 'beta'] },
    },
  };
  const rec = recordingEngine(outcome);
  const channels = createChannels(reg as never, () => HOME);
  const client = slackDriver(new bolt.webApi.WebClient('xoxb-home', { slackApiUrl: url, retryConfig: { retries: 0 } }));
  const driverFor = (t?: string) => {
    if (t && t !== HOME) throw new Error(`no installation for tenant ${t}`);
    return client;
  };
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
  const dispatcher = createDispatcher({ store, reg: reg as never, engine: rec.engine, channels, driverFor, home: () => HOME, tz: 'Europe/Zurich' });
  const pollers = createPollers(cfg, store, reg as never, driverFor, rec.engine, channels, () => HOME, dispatcher);
  return { store, reg, client, driverFor, pollers, dispatcher, ...rec };
}
type H = ReturnType<typeof harness>;

// Fire-and-forget paths (fireRoutine, dispatch) land after the call returns: wait until every
// non-hanging turn settled and neither the API nor the engine log moved for 150 ms. Without
// the settle wait, a slow full-suite run once leaked one scenario's posts into the next.
async function quiesce(h?: { log: unknown[]; turns: Promise<void>[] }): Promise<void> {
  let quiet = 0;
  let last = '';
  while (quiet < 5) {
    if (h) await Promise.all(h.turns);
    const now = `${api.calls.length}/${h?.log.length ?? 0}/${h?.turns.length ?? 0}`;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function record(name: string, outcome: Outcome, run: (h: H) => Promise<unknown>): Promise<void> {
  api.reset();
  api.responses['conversations.list'] = { channels: [{ id: 'C_BETA', name: 'bluefin-aven-beta' }, { id: 'C_HOME', name: 'bluefin-aven-alpha' }] };
  api.responses['chat.getPermalink'] = { permalink: 'https://slack/p/1' };
  const h = harness(outcome);
  const result = await run(h);
  await quiesce(h);
  const got = {
    calls: api.calls.map((c) => ({ method: c.method, token: c.token, payload: c.payload })),
    engine: h.log,
    result: result ?? null,
    routines: h.store.listRoutines().map((r) => ({ id: r.id, lastRunAt: r.lastRunAt, lastOutcome: (r as { lastOutcome?: string }).lastOutcome })),
    proposals: ['p-1', 'p-2', 'p-3'].map((id) => h.store.getProposal(id) ?? null),
  };
  const file = SNAP(name);
  if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
  assert.ok(existsSync(file), `missing snapshot ${file} — run with UPDATE_SNAPSHOTS=1`);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(readFileSync(file, 'utf8')));
}

const routine = (h: H, over: Partial<RoutineRecord> = {}): RoutineRecord =>
  h.store.addRoutine({ slug: 'alpha', channel: 'C_HOME', cron: '0 9 * * *', tz: 'Europe/Zurich', spec: 'daily 9:00', prompt: 'what shipped', enabled: true, createdBy: 'U1', ...over });

const withGuard = async (on: boolean, run: () => Promise<void>) => {
  const was = routineGuard.enabled;
  (routineGuard as { enabled: boolean }).enabled = on;
  try {
    await run();
  } finally {
    (routineGuard as { enabled: boolean }).enabled = was;
  }
};
const withDispatch = async (run: () => Promise<void>) => {
  const was = dispatch.enabled;
  (dispatch as { enabled: boolean }).enabled = true;
  try {
    await run();
  } finally {
    (dispatch as { enabled: boolean }).enabled = was;
  }
};

// ── routines ─────────────────────────────────────────────────────────────────
test('pollers record: routine answered (guard off)', () =>
  withGuard(false, () => record('routine-answer', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h)))));
test('pollers record: task routine answered (guard off)', () =>
  withGuard(false, () => record('routine-task', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h, { kind: 'task', prompt: 'tidy up' })))));
for (const o of ['answer', 'error', 'canceled'] as const) {
  test(`pollers record: routine ${o} (guard on)`, () =>
    withGuard(true, () => record(`routine-guard-${o}`, o, async (h) => h.pollers.fireRoutine(h.client, routine(h), { mode: 'scheduled', slot: new Date(Date.UTC(2026, 9, 15, 7, 0)) }))));
}
test('pollers record: a routine still in flight is not stacked', () =>
  withGuard(false, () =>
    record('routine-stacked', 'hang', async (h) => {
      const r = routine(h);
      const first = h.pollers.fireRoutine(h.client, r);
      await quiesce(h);
      return [first, h.pollers.fireRoutine(h.client, r)];
    }),
  ));
test('pollers record: a routine whose project left the registry is skipped', () =>
  withGuard(false, () => record('routine-orphan', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h, { slug: 'gone' })))));
test('pollers record: a routine whose tenant lost the project is skipped', () =>
  withGuard(false, () => record('routine-revoked', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h, { teamId: 'TOTHER99' })))));

// ── reviews ──────────────────────────────────────────────────────────────────
test('pollers record: review fired', () =>
  record('review', 'answer', async (h) => h.pollers.fireReview(h.client, h.reg.current.projects[1] as never, 'Org/beta', 12, 'C_BETA', 'high')));
test('pollers record: review already running', () =>
  record('review-busy', 'answer', async (h) => {
    h.busy.add('review:Org/beta:12:beta');
    return h.pollers.fireReview(h.client, h.reg.current.projects[1] as never, 'Org/beta', 12, 'C_BETA');
  }));

// ── dispatch ─────────────────────────────────────────────────────────────────
const pending = (over: Partial<StoredProposal>): StoredProposal => ({
  id: 'p-1',
  kind: 'message',
  target: 'C0TARGET1',
  text: 'Heads-up: the deploy moved to Friday.',
  refs: ['https://x/pull/1'],
  rationale: 'they asked',
  session: 'thread:9.1',
  createdAt: '2026-10-15T07:00:00.000Z',
  slug: 'alpha',
  status: 'pending',
  receivedAt: '2026-10-15T07:00:00.000Z',
  channel: 'C_HOME',
  threadTs: '9.1',
  messageTs: '9.5',
  ...over,
});
test('pollers record: dispatch Send — a message to a channel', () =>
  withDispatch(() => record('dispatch-send-message', 'answer', async (h) => (h.store.setProposal(pending({})), h.dispatcher.approve(h.client, 'p-1', 'U_HUMAN')))));
for (const o of ['answer', 'error'] as const) {
  test(`pollers record: dispatch Send — a task for another project (${o})`, () =>
    withDispatch(() =>
      record(`dispatch-send-task-${o}`, o, async (h) => (h.store.setProposal(pending({ kind: 'dispatch', target: 'beta', text: 'Bump the SDK.' })), h.dispatcher.approve(h.client, 'p-1', 'U_HUMAN'))),
    ));
}
test('pollers record: dispatch Send to an unknown project fails cleanly', () =>
  withDispatch(() => record('dispatch-send-unknown', 'answer', async (h) => (h.store.setProposal(pending({ kind: 'dispatch', target: 'nope' })), h.dispatcher.approve(h.client, 'p-1', 'U_HUMAN')))));
test('pollers record: dispatch Send twice changes nothing', () =>
  withDispatch(() => record('dispatch-send-twice', 'answer', async (h) => (h.store.setProposal(pending({ status: 'sent', approvedBy: 'U1' })), h.dispatcher.approve(h.client, 'p-1', 'U_HUMAN')))));
test('pollers record: dispatch Dismiss', () =>
  withDispatch(() => record('dispatch-dismiss', 'answer', async (h) => (h.store.setProposal(pending({})), h.dispatcher.dismiss('p-1', 'U_HUMAN')))));

const drop = (slug: string, file: string, body: unknown) => {
  const dir = outboxDir(slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
};
const proposalFile = (over: Record<string, unknown>) => ({
  id: 'p-2',
  kind: 'message',
  target: 'C0TARGET1',
  text: 'FYI the release is out.',
  refs: [],
  rationale: '',
  session: 'thread:9.1',
  createdAt: '2026-10-15T07:00:00.000Z',
  ...over,
});
async function poll(h: H): Promise<void> {
  h.dispatcher.pollOutboxes();
  await quiesce(h);
}
test('pollers record: outbox — gated proposal rendered in its thread', () =>
  withDispatch(() =>
    record('outbox-gated', 'answer', async (h) => {
      h.store.patchChat('thread:9.1', 'alpha', { inflight: { channel: 'C_HOME', statusTs: '9.2', startedAt: '2026-10-15T07:00:00.000Z' } });
      drop('alpha', 'propose-p-2.json', proposalFile({}));
      await poll(h);
    }),
  ));
test('pollers record: outbox — auto-approved task executes and renders', () =>
  withDispatch(() =>
    record('outbox-auto', 'answer', async (h) => {
      h.store.patchChat('thread:9.1', 'alpha', { inflight: { channel: 'C_HOME', statusTs: '9.2', startedAt: '2026-10-15T07:00:00.000Z' } });
      drop('alpha', 'propose-p-3.json', proposalFile({ id: 'p-3', kind: 'dispatch', target: 'beta', text: 'Bump the SDK.' }));
      await poll(h);
    }),
  ));
// The proposing conversation is found by its full key, so a thread outside the project's own channel
// and a DM render where the turn runs — not in the bound channel (the fallback the bare-ts lookup hit).
test('pollers record: outbox — a proposal from a thread outside the project channel renders in that thread', () =>
  withDispatch(() =>
    record('outbox-thread-elsewhere', 'answer', async (h) => {
      h.store.patchChat('thread:9.1', 'alpha', { inflight: { channel: 'C_OTHER', statusTs: '9.2', msgThreadTs: '9.1', startedAt: '2026-10-15T07:00:00.000Z' } });
      drop('alpha', 'propose-p-2.json', proposalFile({}));
      await poll(h);
    }),
  ));
test('pollers record: outbox — a proposal from a DM renders in the DM', () =>
  withDispatch(() =>
    record('outbox-dm', 'answer', async (h) => {
      h.store.patchChat('dm:D0DM:alpha', 'alpha', { inflight: { channel: 'D0DM', statusTs: '9.3', startedAt: '2026-10-15T07:00:00.000Z' } });
      drop('alpha', 'propose-p-2.json', proposalFile({ session: 'dm:D0DM:alpha' }));
      await poll(h);
    }),
  ));
test('pollers record: outbox — rejected and duplicate files', () =>
  withDispatch(() =>
    record('outbox-rejected', 'answer', async (h) => {
      h.store.setProposal(pending({ id: 'p-2' }));
      drop('alpha', 'propose-p-2.json', proposalFile({}));
      drop('alpha', 'propose-p-9.json', '{ not json');
      await poll(h);
    }),
  ));
