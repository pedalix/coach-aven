// Recorded-call pins for what the bot posts on its own (OpenSpec chat-driver-interface,
// task 4.1): scheduled routines (guard off and on, answered / failed / canceled / stacked /
// orphaned) and reviews. Real createPollers against the twin's RecordingApi with a recording
// fake engine that plays the turn's outcome. Taken before the deliveries moved behind the chat driver; the move must
// leave them byte-identical. Re-snapshot on purpose with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bolt from '@slack/bolt';
import type { Config } from '../../config.js';
import { Store, type RoutineRecord } from '../../state.js';
import { createChannels } from '../../channels.js';
import { createPollers } from '../../pollers.js';
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
        { slug: 'alpha', repos: ['Org/alpha'] },
        { slug: 'beta', repos: ['Org/beta'] },
      ],
      workspaces: { [HOME]: ['alpha', 'beta'] },
    },
  };
  const rec = recordingEngine(outcome);
  const channels = createChannels(reg as never, () => HOME);
  const client = slackDriver(new bolt.webApi.WebClient('xoxb-home', { slackApiUrl: url, retryConfig: { retries: 0 } }));
  const driverFor = ({ tenantId: t }: { tenantId?: string }) => {
    if (t && t !== HOME) throw new Error(`no installation for tenant ${t}`);
    return client;
  };
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
  const pollers = createPollers(cfg, store, reg as never, driverFor, rec.engine, channels, () => HOME);
  return { store, reg, client, driverFor, pollers, ...rec };
}
type H = ReturnType<typeof harness>;

// Fire-and-forget paths (fireRoutine) land after the call returns: wait until every
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
  api.responses['conversations.list'] = { channels: [{ id: 'C_BETA', name: 'aven-beta' }, { id: 'C_HOME', name: 'aven-alpha' }] };
  api.responses['chat.getPermalink'] = { permalink: 'https://slack/p/1' };
  const h = harness(outcome);
  const result = await run(h);
  await quiesce(h);
  const got = {
    calls: api.calls.map((c) => ({ method: c.method, token: c.token, payload: c.payload })),
    engine: h.log,
    result: result ?? null,
    routines: h.store.listRoutines().map((r) => ({ id: r.id, lastRunAt: r.lastRunAt, lastOutcome: (r as { lastOutcome?: string }).lastOutcome })),
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
