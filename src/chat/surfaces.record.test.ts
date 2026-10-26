// Two chat surfaces over one set of pollers (multi-driver-installation D4): a Slack default surface
// and a Teams additional one, one project bound on both. A routine delivers where it was created;
// a review runs once and its answer is mirrored to the project's other delivery surface; a ticket
// investigation lands on one surface. Recorded against both twins, like the per-driver recorders.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../config.js';
import { Store, type RoutineRecord } from '../state.js';
import { createChannels } from '../channels.js';
import { createPollers } from '../pollers.js';
import { routineGuard } from '../routineguard.js';
import type { TurnEngine, TurnOpts } from '../turn.js';
import type { ChatDriver } from './driver.js';
import type { DriverFor } from './surfaces.js';
import { RecordingApi, recordingClient } from './slack/twin.js';
import { slackDriver } from './slack/driver.js';
import { teamsDriver } from './teams/driver.js';
import { Recorder } from './teams/twin.js';
import { createActorGate } from './core/gates.js';

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAP = (name: string) => new URL(`../fixtures/chat/surfaces/${name}.json`, import.meta.url).pathname;
const HOME = 'THOME1111'; // the Slack home workspace: the default surface's tenant
const TENANT = '00000000-0000-4000-8000-00000000000a'; // the Teams tenant: the additional surface's
const C_ALPHA = 'C_ALPHA';
const T_ALPHA = '19:ALPHA@thread.tacv2';

let api: RecordingApi;
let url: string;
before(async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 26, 7, 0) });
  api = new RecordingApi({}, {}, true);
  url = await api.start();
});
after(async () => {
  mock.timers.reset();
  await api.stop();
});

function recordingEngine() {
  const log: unknown[] = [];
  const turns: Promise<void>[] = [];
  const engine = {
    liveTurn: (...args: Parameters<typeof play>) => {
      const p = play(...args);
      turns.push(p);
      return p;
    },
    hasKey: () => false,
    restartSession: async (key: string, project: { slug: string }) => log.push({ restartSession: { key, slug: project.slug } }),
  } as unknown as TurnEngine;
  async function play(_d: ChatDriver, channel: string, msgTs: string | undefined, threadTs: string | undefined, key: string, project: { slug: string }, question: string, _a?: unknown, opts?: TurnOpts): Promise<void> {
    log.push({ liveTurn: { channel, msgTs, threadTs, key, slug: project.slug, question: question.slice(0, 40), routine: opts?.routine, automatic: opts?.automatic } });
    await opts?.onAnswer?.('Looks good: two nits, one question.\nDetails follow.');
    await opts?.onSettle?.('ok');
  }
  return { engine, log, turns };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'aven-surfaces-'));
  process.env.AVEN_DATA_DIR = join(dir, 'data');
  const store = new Store(join(dir, 'state.json'));
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'], slackChannel: C_ALPHA, teamsChannel: T_ALPHA, deliverTo: ['teams'] }] } };
  const rec = recordingEngine();
  const slack = slackDriver(recordingClient(url));
  const teamsApi = new Recorder();
  const teams = teamsDriver(teamsApi, { tenantId: TENANT, statusMinMs: 0, targeted: false });
  const channelsOf = {
    slack: createChannels(reg as never, () => HOME, { binding: 'slack' }),
    teams: createChannels(reg as never, () => TENANT, { binding: 'teams' }),
  };
  const driverFor: DriverFor = (ref) => {
    if (ref.surface === 'teams') return teams;
    if (ref.tenantId && ref.tenantId !== HOME) throw new Error(`no installation for tenant ${ref.tenantId}`);
    return slack;
  };
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config;
  const pollers = createPollers(cfg, store, reg as never, driverFor, rec.engine, channelsOf.slack, () => HOME, { channelsFor: (s) => channelsOf[s as 'slack' | 'teams'], defaultSurface: 'slack' });
  return { store, reg, slack, teams, teamsApi, driverFor, pollers, ...rec };
}
type H = ReturnType<typeof harness>;

async function quiesce(h: H): Promise<void> {
  let last = '';
  let quiet = 0;
  while (quiet < 3) {
    await Promise.all(h.turns);
    const now = `${api.calls.length}/${h.teamsApi.calls.length}/${h.log.length}/${h.turns.length}`;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function record(name: string, run: (h: H) => Promise<unknown>): Promise<void> {
  api.calls.length = 0;
  const h = harness();
  const result = await run(h);
  await quiesce(h);
  const got = { slack: api.calls, teams: h.teamsApi.calls, engine: h.log, result: result ?? null };
  const file = SNAP(name);
  if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
  assert.ok(existsSync(file), `missing snapshot ${file} — run with UPDATE_SNAPSHOTS=1`);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(readFileSync(file, 'utf8')));
}

const routineOn = (h: H, surface: 'slack' | 'teams'): RoutineRecord =>
  h.store.addRoutine({ slug: 'alpha', ...(surface === 'teams' ? { surface: 'teams', teamId: undefined } : {}), channel: surface === 'teams' ? T_ALPHA : C_ALPHA, cron: '0 9 * * *', tz: 'Europe/Zurich', spec: 'daily 9:00', prompt: 'what shipped', enabled: true, createdBy: surface === 'teams' ? '29:someone' : 'U_HUMAN' } as never);

const withGuardOff = async (run: () => Promise<void>) => {
  const was = routineGuard.enabled;
  (routineGuard as { enabled: boolean }).enabled = false;
  try {
    await run();
  } finally {
    (routineGuard as { enabled: boolean }).enabled = was;
  }
};

test('surfaces record: a routine created on the additional surface fires there, with a surfaced key, and nowhere else', () =>
  withGuardOff(() =>
    record('routine-on-teams', async (h) => {
      const r = routineOn(h, 'teams');
      const d = h.driverFor({ surface: 'teams' });
      return h.pollers.fireRoutine(d, r);
    }),
  ));

test('surfaces record: a routine created on the default surface keeps a bare key and fires on Slack only', () =>
  withGuardOff(() => record('routine-on-slack', async (h) => h.pollers.fireRoutine(h.slack, routineOn(h, 'slack')))));

test('surfaces record: a review asked on the default surface runs once and its answer is mirrored to the Teams channel (deliverTo)', () =>
  record('review-mirrored', async (h) => h.pollers.fireReview(h.slack, h.reg.current.projects[0] as never, 'Org/alpha', 7, C_ALPHA, 'med', undefined, undefined)));

test('surfaces record: a review asked on the additional surface runs there and is mirrored to the default surface', () =>
  record('review-from-teams', async (h) => h.pollers.fireReview(h.teams, h.reg.current.projects[0] as never, 'Org/alpha', 8, T_ALPHA, 'med', undefined, 'teams')));

test('access is per surface: an allow-list on the Slack home grants nothing on the Teams tenant', () => {
  const h = harness();
  h.store.setTeamAccess(HOME, { mode: 'allowlist', users: ['U_HUMAN'], admins: [] });
  const onSlack = createActorGate(h.store, HOME);
  const onTeams = createActorGate(h.store, TENANT);
  assert.equal(onSlack(HOME, 'U_HUMAN').ok, true);
  assert.equal(onSlack(HOME, 'U_OTHER').ok, false);
  // The Teams tenant has no record: open by default there, and the Slack list is not consulted.
  assert.equal(onTeams(TENANT, '29:anyone').ok, true);
  h.store.setTeamAccess(TENANT, { mode: 'allowlist', users: [], admins: [] });
  assert.equal(onTeams(TENANT, 'U_HUMAN').ok, false);
});
