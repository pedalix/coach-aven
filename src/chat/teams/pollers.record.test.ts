// What the bot posts on its own, through the Teams driver (OpenSpec teams-chat-driver, task
// 3.4): the pollers scenarios of src/chat/slack/pollers.record.test.ts replayed against
// teamsDriver + the recording TeamsApi — real createPollers / createDispatcher, the same
// recording fake engine. Pins the Connector calls per scenario; re-snapshot on purpose with
// UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store, type RoutineRecord } from '../../state.js';
import { createChannels } from '../../channels.js';
import { createPollers } from '../../pollers.js';
import { createDispatcher } from '../../dispatchrun.js';
import { dispatch, type StoredProposal } from '../../dispatch.js';
import { routineGuard } from '../../routineguard.js';
import type { TurnEngine, TurnOpts } from '../../turn.js';
import type { ChatDriver } from '../driver.js';
import { teamsDriver } from './driver.js';
import { Recorder } from './twin.js';

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAP = (name: string) => new URL(`../../fixtures/chat/teams/pollers/${name}.json`, import.meta.url).pathname;
const TENANT = '00000000-0000-4000-8000-00000000000a';
const CH_ALPHA = '19:ALPHA@thread.tacv2';
const CH_BETA = '19:BETA@thread.tacv2';
const CH_TARGET = '19:TARGET@thread.tacv2';

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
  async function play(
    _d: ChatDriver,
    channel: string,
    msgTs: string | undefined,
    threadTs: string | undefined,
    key: string,
    project: { slug: string },
    question: string,
    attachments?: unknown,
    opts?: TurnOpts,
  ): Promise<void> {
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
  const dir = mkdtempSync(join(tmpdir(), 'aven-teams-pollrec-'));
  process.env.AVEN_DATA_DIR = join(dir, 'data');
  const store = new Store(join(dir, 'state.json'));
  const reg = {
    current: {
      projects: [
        { slug: 'alpha', repos: ['Org/alpha'], teamsChannel: CH_ALPHA, dispatch: { auto: ['beta'] } },
        { slug: 'beta', repos: ['Org/beta'], teamsChannel: CH_BETA },
      ],
      workspaces: { [TENANT]: ['alpha', 'beta'] },
    },
  };
  const rec = recordingEngine(outcome);
  const channels = createChannels(reg as never, () => TENANT);
  const api = new Recorder();
  api.names.set('29:OWNER1', 'Example Owner');
  const client = teamsDriver(api, { tenantId: TENANT });
  const driverFor = (t?: string) => {
    if (t && t !== TENANT) throw new Error(`no installation for tenant ${t}`);
    return client;
  };
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
  const dispatcher = createDispatcher({ store, reg: reg as never, engine: rec.engine, channels, driverFor, home: () => TENANT, tz: 'Europe/Zurich' });
  const pollers = createPollers(cfg, store, reg as never, driverFor, rec.engine, channels, () => TENANT);
  return { store, reg, api, client, driverFor, pollers, dispatcher, ...rec };
}
type H = ReturnType<typeof harness>;

async function quiesce(h: { api: Recorder; log: unknown[]; turns: Promise<void>[] }): Promise<void> {
  let quiet = 0;
  let last = '';
  while (quiet < 5) {
    await Promise.all(h.turns);
    const now = `${h.api.calls.length}/${h.log.length}/${h.turns.length}`;
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
    calls: h.api.calls,
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
  h.store.addRoutine({ slug: 'alpha', channel: CH_ALPHA, cron: '0 9 * * *', tz: 'Europe/Zurich', spec: 'daily 9:00', prompt: 'what shipped', enabled: true, createdBy: '29:USER1', ...over });

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

// ── routines: a new chain in the project's channel, the status card in it, the answer after ──
test('teams pollers record: routine answered (guard off)', () =>
  withGuard(false, () => record('routine-answer', 'answer', async (h) => h.pollers.fireRoutine(h.client, routine(h)))));
for (const o of ['answer', 'error', 'canceled'] as const) {
  test(`teams pollers record: routine ${o} (guard on)`, () =>
    withGuard(true, () => record(`routine-guard-${o}`, o, async (h) => h.pollers.fireRoutine(h.client, routine(h), { mode: 'scheduled', slot: new Date(Date.UTC(2026, 9, 15, 7, 0)) }))));
}
test('teams pollers record: a routine still in flight is not stacked', () =>
  withGuard(false, () =>
    record('routine-stacked', 'hang', async (h) => {
      const r = routine(h);
      const first = h.pollers.fireRoutine(h.client, r);
      await quiesce(h);
      return [first, h.pollers.fireRoutine(h.client, r)];
    }),
  ));

// ── reviews ──
test('teams pollers record: review fired', () =>
  record('review', 'answer', async (h) => h.pollers.fireReview(h.client, h.reg.current.projects[1] as never, 'Org/beta', 12, CH_BETA, 'high')));

// ── dispatch: Send lands in the target project's Teams channel (bound by teamsChannel) ──
const pending = (over: Partial<StoredProposal>): StoredProposal => ({
  id: 'p-1',
  kind: 'message',
  target: CH_TARGET,
  text: 'Heads-up: the deploy moved to Friday.',
  refs: ['https://x/pull/1'],
  rationale: 'they asked',
  session: 'thread:9.1',
  createdAt: '2026-10-15T07:00:00.000Z',
  slug: 'alpha',
  status: 'pending',
  receivedAt: '2026-10-15T07:00:00.000Z',
  channel: CH_ALPHA,
  threadTs: '9.1',
  messageTs: '9.5',
  ...over,
});
test('teams pollers record: dispatch Send — a message to a channel', () =>
  withDispatch(() => record('dispatch-send-message', 'answer', async (h) => (h.store.setProposal(pending({})), h.dispatcher.approve(h.client, 'p-1', '29:USER1')))));
for (const o of ['answer', 'error'] as const) {
  test(`teams pollers record: dispatch Send — a task for another project (${o})`, () =>
    withDispatch(() =>
      record(`dispatch-send-task-${o}`, o, async (h) => (h.store.setProposal(pending({ kind: 'dispatch', target: 'beta', text: 'Bump the SDK.' })), h.dispatcher.approve(h.client, 'p-1', '29:USER1'))),
    ));
}
test('teams pollers record: dispatch Dismiss', () =>
  withDispatch(() => record('dispatch-dismiss', 'answer', async (h) => (h.store.setProposal(pending({})), h.dispatcher.dismiss('p-1', '29:USER1')))));

const proposalFile = (over: Record<string, unknown>) => ({
  id: 'p-2',
  kind: 'message',
  target: CH_TARGET,
  text: 'FYI the release is out.',
  refs: [],
  rationale: '',
  session: 'thread:9.1',
  createdAt: '2026-10-15T07:00:00.000Z',
  ...over,
});
async function propose(h: H, record: unknown, expect: Record<string, unknown>): Promise<void> {
  const out = await h.dispatcher.propose('alpha', record);
  for (const [k, v] of Object.entries(expect)) assert.deepEqual((out as Record<string, unknown>)[k], v, `propose → ${k}`);
  await quiesce(h);
}
test('teams pollers record: propose — gated proposal rendered in its chain', () =>
  withDispatch(() =>
    record('propose-gated', 'answer', async (h) => {
      h.store.patchChat('thread:9.1', 'alpha', { inflight: { channel: CH_ALPHA, statusTs: '9.2', msgThreadTs: '9.1', startedAt: '2026-10-15T07:00:00.000Z' } });
      await propose(h, proposalFile({}), { ok: true, id: 'p-2', status: 'pending', gate: 'buttons' });
    }),
  ));
test('teams pollers record: propose — auto-approved task executes in the target channel', () =>
  withDispatch(() =>
    record('propose-auto', 'answer', async (h) => {
      h.store.patchChat('thread:9.1', 'alpha', { inflight: { channel: CH_ALPHA, statusTs: '9.2', msgThreadTs: '9.1', startedAt: '2026-10-15T07:00:00.000Z' } });
      await propose(h, proposalFile({ id: 'p-3', kind: 'dispatch', target: 'beta', text: 'Bump the SDK.' }), { ok: true, id: 'p-3', status: 'sent', gate: 'auto' });
    }),
  ));

// ── an owner mention in a delivery becomes a Teams mention through the roster ──
test('teams pollers record: a configured owner is mentioned by name after one roster lookup', async () => {
  const h = harness();
  await h.client.post({ conv: CH_ALPHA }, { kind: 'text', text: 'Owners: <@29:OWNER1> <@29:NOBODY>' });
  await h.client.post({ conv: CH_ALPHA }, { kind: 'text', text: 'Again: <@29:OWNER1> <@29:NOBODY>' });
  assert.deepEqual(
    h.api.calls.map((c) => [c.op, c.id ?? c.activity?.text]),
    [
      ['memberName', '29:OWNER1'],
      ['memberName', '29:NOBODY'],
      ['send', 'Owners: <at>Example Owner</at> @29:NOBODY'],
      ['send', 'Again: <at>Example Owner</at> @29:NOBODY'],
    ],
  );
});
