// What the bot posts on its own, through the web driver (web-chat-driver 3.4): the pollers scenarios of
// src/chat/slack/pollers.record.test.ts replayed against webDriver + a history store — real createPollers over a
// channel directory with the web's own hooks (a room is a project's conversation), the same recording fake
// engine. Pins the stored events per scenario; re-snapshot on purpose with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store, type RoutineRecord } from '../../state.js';
import { createChannels } from '../../channels.js';
import { createPollers } from '../../pollers.js';
import { routineGuard } from '../../routineguard.js';
import type { TurnEngine, TurnOpts } from '../../turn.js';
import type { ChatDriver } from '../driver.js';
import { History } from './history.js';
import { webDriver } from './driver.js';
import { projectOfConv, roomConv } from './keys.js';

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAP = (name: string) => new URL(`../../fixtures/chat/web/pollers/${name}.json`, import.meta.url).pathname;
const ORG = 'corp.example';
const ROOM_ALPHA = roomConv('alpha');
const ROOM_BETA = roomConv('beta');

before(() => mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 15, 7, 0) }));
after(() => mock.timers.reset());

type Outcome = 'answer' | 'error' | 'canceled' | 'hang';
function recordingEngine(outcome: Outcome) {
  const log: unknown[] = [];
  const busy = new Set<string>();
  const turns: Promise<void>[] = [];
  const engine = {
    liveTurn: (...args: Parameters<typeof play>) => {
      const p = play(...args);
      if (outcome !== 'hang') turns.push(p);
      return p;
    },
    restartSession: async (key: string, project: { slug: string }) => log.push({ restartSession: { key, slug: project.slug } }),
    hasKey: (key: string) => busy.has(key),
  } as unknown as TurnEngine;
  async function play(_d: ChatDriver, channel: string, msgTs: string | undefined, threadTs: string | undefined, key: string, project: { slug: string }, question: string, attachments?: unknown, opts?: TurnOpts): Promise<void> {
    log.push({ liveTurn: { channel, msgTs, threadTs, key, slug: project.slug, question, attachments: !!attachments, routine: opts?.routine, origin: opts?.origin } });
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
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-pollrec-'));
  process.env.AVEN_DATA_DIR = join(dir, 'data');
  const store = new Store(join(dir, 'state.json'));
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }, { slug: 'beta', repos: ['Org/beta'] }, { slug: 'hidden', repos: ['Org/h'], webRoom: false }] } };
  const rec = recordingEngine(outcome);
  const channels = createChannels(reg as never, () => ORG, {
    binding: 'web',
    boundOnly: () => true,
    projectOf: (conv) => {
      const slug = projectOfConv(conv);
      const p = reg.current.projects.find((x) => x.slug === slug);
      return p && p.webRoom !== false ? p.slug : undefined;
    },
    conversationFor: (p) => (p.webRoom === false ? undefined : roomConv(p.slug)),
  });
  const history = new History(join(dir, 'web'));
  let seq = 0;
  const client = webDriver({ history, baseUrl: 'https://chat.example', nameOf: () => undefined, ids: () => `m${++seq}` });
  const driverFor = () => client;
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
  const pollers = createPollers(cfg, store, reg as never, driverFor, rec.engine, channels, () => ORG, { defaultSurface: 'web' });
  return { store, reg, history, client, driverFor, pollers, ...rec };
}
type H = ReturnType<typeof harness>;

async function quiesce(h: { history: History; log: unknown[]; turns: Promise<void>[] }): Promise<void> {
  let quiet = 0;
  let last = '';
  while (quiet < 5) {
    await Promise.all(h.turns);
    const now = `${h.history.conversation(ROOM_ALPHA).seq}/${h.history.conversation(ROOM_BETA).seq}/${h.log.length}/${h.turns.length}`;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function record(name: string, outcome: Outcome, run: (h: H) => Promise<unknown>): Promise<void> {
  const h = harness(outcome);
  const result = await run(h);
  await quiesce(h);
  const got = {
    events: { [ROOM_ALPHA]: h.history.conversation(ROOM_ALPHA).since(0), [ROOM_BETA]: h.history.conversation(ROOM_BETA).since(0) },
    engine: h.log,
    result: result ?? null,
    routines: h.store.listRoutines().map((r) => ({ id: r.id, lastRunAt: r.lastRunAt, lastOutcome: (r as { lastOutcome?: string }).lastOutcome })),
  };
  const file = SNAP(name);
  if (UPDATE || !existsSync(file)) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(readFileSync(file, 'utf8')));
}

const routine = (h: H, over: Partial<RoutineRecord> = {}): RoutineRecord =>
  h.store.addRoutine({ slug: 'alpha', channel: ROOM_ALPHA, cron: '0 9 * * *', tz: 'Europe/Zurich', spec: 'daily 9:00', prompt: 'what shipped', enabled: true, createdBy: 'u1', ...over });

const withGuard = async (on: boolean, run: () => Promise<void>) => {
  const was = routineGuard.enabled;
  (routineGuard as { enabled: boolean }).enabled = on;
  try {
    await run();
  } finally {
    (routineGuard as { enabled: boolean }).enabled = was;
  }
};

// ── routines: a new thread in the project's room — the headline is its root, the status and the answer in it ──
test('web pollers record: routine answered (guard off)', () =>
  withGuard(false, () => record('routine-answer', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h)))));
test('web pollers record: task routine answered (guard off)', () =>
  withGuard(false, () => record('routine-task', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h, { kind: 'task', prompt: 'tidy up' })))));
for (const o of ['answer', 'error', 'canceled'] as const) {
  test(`web pollers record: routine ${o} (guard on)`, () =>
    withGuard(true, () => record(`routine-guard-${o}`, o, async (h) => h.pollers.fireRoutine(h.client, routine(h), { mode: 'scheduled', slot: new Date(Date.UTC(2026, 9, 15, 7, 0)) }))));
}
test('web pollers record: a routine still in flight is not stacked', () =>
  withGuard(false, () =>
    record('routine-stacked', 'hang', async (h) => {
      const r = routine(h);
      const first = h.pollers.fireRoutine(h.client, r);
      await quiesce(h);
      return [first, h.pollers.fireRoutine(h.client, r)];
    }),
  ));
test('web pollers record: a routine of a project without a room is skipped', () =>
  withGuard(false, () => record('routine-hidden', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h, { slug: 'hidden', channel: roomConv('hidden') })))));

// ── reviews: into the project's room, the answer as the thread's root ──
test('web pollers record: review fired', () =>
  record('review', 'answer', async (h) => h.pollers.fireReview(h.client, h.reg.current.projects[1] as never, 'Org/beta', 12, ROOM_BETA, 'high')));
