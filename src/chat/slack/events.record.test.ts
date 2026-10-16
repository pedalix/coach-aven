// Recorded-call pins for the Slack interaction surface (OpenSpec chat-driver-interface,
// task 2.1): every button, modal submission, the App Home tab and the install lifecycle,
// driven through the REAL Bolt app + registerEvents over the twin (src/twin.ts). Each
// scenario snapshots the Slack Web API / response_url calls AND what reached the turn
// engine (a recording fake). Taken before the handlers moved behind the chat driver; the
// move must leave them byte-identical. Re-snapshot on purpose with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import type { FeedbackRecord } from '../../feedback.js';
import { createChannels } from '../../channels.js';
import { registerEvents } from './events.js';
import { slugOfBase, isThreadKey } from '../../teamkeys.js';
import { memoryRepoDir } from '../../memjournal.js';
import { dispatch, type StoredProposal } from '../../dispatch.js';
import type { PendingQuestion, TurnEngine, TurnOpts, TurnTrail } from '../../turn.js';
import type { Dispatcher } from '../../dispatchrun.js';
import type { SlackChatDriver } from './driver.js';
import { FB_CALLBACK, FB_NOTE, FB_REASON, YT_PROMPT_CALLBACK, YT_PROMPT_INPUT, YT_PROMPT_NOW, YT_SEND_CALLBACK, YT_SEND_INPUT } from './blocks.js';
import { createTwinApp, messageEnvelope, homeOpenedEnvelope, blockActionEnvelope } from './twin.js';

const SNAP_DIR = new URL('../../fixtures/chat/interactions/', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const HOME = 'THOME1111';
const CLIENT = 'TCLIENT222';

before(() => mock.timers.enable({ apis: ['Date'], now: 0 }));
after(() => mock.timers.reset());

// A turn engine that records what the interaction handlers asked of it, with just enough
// state (busy keys, trails, drafts, a question registry) for every branch to be reachable.
function recordingEngine(store: Store) {
  const log: unknown[] = [];
  const busy = new Set<string>();
  const trails = new Map<string, TurnTrail>();
  const drafts = new Map<string, string>();
  const questions = new Map<string, PendingQuestion>();
  const completed = new Set<string>();
  const ratings: FeedbackRecord[] = [];
  const engine = {
    liveTurn: async (
      d: SlackChatDriver,
      channel: string,
      msgTs: string | undefined,
      threadTs: string | undefined,
      key: string,
      project: { slug: string },
      question: string,
      attachments?: unknown,
      opts?: TurnOpts,
    ) => {
      log.push({
        liveTurn: {
          token: (d.client as { token?: string }).token,
          channel,
          msgTs,
          threadTs,
          key,
          slug: project.slug,
          question,
          attachments: !!attachments,
          ytDraftFor: opts?.ytDraftFor,
          autoPost: !!opts?.autoPost,
        },
      });
    },
    runAsk: async () => 'ok',
    persist: () => {},
    cancel: (turnId: string) => log.push({ cancel: turnId }),
    hasKey: (key: string) => busy.has(key),
    hasLive: () => false,
    activeKeys: () => [],
    runningCount: () => 0,
    projectBusy: () => false,
    slugForKey: (key: string) => (isThreadKey(key) ? store.getChat(key)?.slug : slugOfBase(key)),
    restartSession: async (key: string, project: { slug: string }) => log.push({ restartSession: { key, slug: project.slug } }),
    resumeInflightTurns: () => new Map(),
    resumeQueuedTurns: () => {},
    questions: {
      get: (qid: string) => questions.get(qid),
      isCompleted: (qid: string) => completed.has(qid),
      answeredAll: (e: PendingQuestion) => e.questions.every((_, qi) => (e.picks.get(qi)?.size ?? 0) > 0),
      finalize: (e: PendingQuestion, qid: string) => {
        e.done = true;
        questions.delete(qid);
        completed.add(qid);
        log.push({ finalize: { qid, picks: [...e.picks].map(([qi, s]) => [qi, [...s]]) } });
      },
    },
    trail: (id: string) => trails.get(id),
    ytDraft: (id: string) => drafts.get(id),
    usageReport: () => '',
    recordFeedback: (rec: FeedbackRecord) => {
      ratings.push(rec);
      log.push({ recordFeedback: rec });
      const latest = new Map(ratings.filter((r) => r.turnId === rec.turnId).map((r) => [r.user, r.verdict]));
      return {
        good: [...latest.values()].filter((v) => v === 'good').length,
        bad: [...latest.values()].filter((v) => v === 'bad').length,
      };
    },
  } as unknown as TurnEngine;
  return { engine, log, busy, trails, drafts, questions, completed };
}

async function twin(opts: { dispatcher?: Dispatcher } = {}) {
  const reg = {
    current: {
      projects: [
        { slug: 'alpha', repos: ['Org/alpha'], mcp: [{ name: 'youtrack' }] },
        { slug: 'beta', repos: ['Org/beta'] },
        { slug: 'evrec-mem', repos: ['Org/mem'] }, // memory-topic scenario only (its journal dir is scratch)
      ],
      workspaces: { [HOME]: ['alpha', 'beta', 'evrec-mem'], [CLIENT]: ['beta'] },
    },
  };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-evrec-')), 'state.json'));
  const rec = recordingEngine(store);
  const channels = createChannels(reg as never, () => HOME);
  const servedTenant = (t: string | undefined) =>
    !!t && (t === HOME || (reg.current.workspaces[t as keyof typeof reg.current.workspaces]?.length ?? 0) > 0);
  const { app, receiver, api, stop } = await createTwinApp({ C_HOME: 'aven-alpha', C_CLIENT: 'aven-beta' });
  registerEvents(app, {
    cfg: { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config,
    store,
    reg: reg as never,
    engine: rec.engine,
    channels,
    botUserId: `UBOT_${HOME}`,
    homeTeamId: HOME,
    servedTenant,
    dispatcher: opts.dispatcher,
  });
  return { receiver, api, store, ...rec, stop };
}

type Twin = Awaited<ReturnType<typeof twin>>;

async function record(name: string, run: (t: Twin) => Promise<void>, opts?: { dispatcher?: Dispatcher }): Promise<void> {
  const t = await twin(opts);
  try {
    await run(t);
    await new Promise((r) => setTimeout(r, 30));
    const got = {
      calls: t.api.calls.map((c) => ({ method: c.method, token: c.token, payload: c.payload })),
      engine: t.log,
    };
    const file = join(SNAP_DIR, `${name}.json`);
    if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
    assert.ok(existsSync(file), `missing snapshot ${file} — run with UPDATE_SNAPSHOTS=1`);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    await t.stop();
  }
}

const restrict = (t: Twin, team = CLIENT) => t.store.setTeamAccess(team, { mode: 'allowlist', users: [], admins: ['U_ADMIN'] });
const action = (team: string, id: string, value: string, channel = 'C_HOME', threadTs?: string) =>
  blockActionEnvelope(team, id, value, channel, threadTs);
const submission = (team: string, callbackId: string, meta: string, values: Record<string, unknown>) => ({
  type: 'view_submission',
  team: { id: team },
  user: { id: 'U_HUMAN', team_id: team },
  api_app_id: 'A0TWIN',
  trigger_id: 'trig.2',
  view: { id: 'V9', type: 'modal', callback_id: callbackId, private_metadata: meta, state: { values } },
});

// ── cancel ───────────────────────────────────────────────────────────────────
test('events record: cancel_turn', () => record('cancel', (t) => t.receiver.send(action(HOME, 'cancel_turn', 't1-1'))));
test('events record: cancel_turn denied', () =>
  record('cancel-denied', async (t) => {
    restrict(t);
    await t.receiver.send(action(CLIENT, 'cancel_turn', 't1-1', 'C_CLIENT'));
  }));

// ── dispatch ─────────────────────────────────────────────────────────────────
const proposal: StoredProposal = {
  id: 'p-1',
  kind: 'message',
  target: 'C_CLIENT',
  text: 'Please look at X',
  refs: ['https://x/pull/1'],
  rationale: 'they asked yesterday',
  session: 'thread:9.1',
  createdAt: '1970-01-01T00:00:00.000Z',
  slug: 'alpha',
  status: 'sent',
  receivedAt: '1970-01-01T00:00:00.000Z',
  approvedBy: 'U_HUMAN',
  approvedAt: '1970-01-01T00:00:00.000Z',
  result: 'https://slack/permalink',
};
const fakeDispatcher = (log: unknown[]) =>
  ({
    approve: async (_c: unknown, id: string, user: string) => (log.push({ approve: { id, user } }), proposal),
    dismiss: (id: string, user: string) => (log.push({ dismiss: { id, user } }), { ...proposal, status: 'dismissed' }),
  }) as unknown as Dispatcher;
for (const which of ['dispatch_send', 'dispatch_dismiss']) {
  test(`events record: ${which}`, async () => {
    const was = dispatch.enabled;
    (dispatch as { enabled: boolean }).enabled = true;
    const dlog: unknown[] = [];
    try {
      await record(which, async (t) => {
        await t.receiver.send({ ...action(HOME, which, 'p-1'), message: { ts: '5.5' } });
        t.log.push(...dlog);
      }, { dispatcher: fakeDispatcher(dlog) });
    } finally {
      (dispatch as { enabled: boolean }).enabled = was;
    }
  });
}

// ── link + trail ─────────────────────────────────────────────────────────────
test('events record: pr_link only acks', () => record('pr-link', (t) => t.receiver.send(action(HOME, 'pr_link:0', 'https://x/pull/1'))));
test('events record: show_trail live', () =>
  record('show-trail', async (t) => {
    t.trails.set('t1-1', { steps: ['📖 Read a.ts', '✏️ Edit a.ts'], elapsedMs: 4200, done: false });
    await t.receiver.send(action(HOME, 'show_trail', 't1-1'));
  }));
test('events record: show_trail expired', () => record('show-trail-expired', (t) => t.receiver.send(action(HOME, 'show_trail', 'tgone'))));
test('events record: show_trail refused by Slack → ephemeral in the thread', () =>
  record('show-trail-refused', async (t) => {
    t.api.failures['views.open'] = 'internal_error';
    await t.receiver.send(action(HOME, 'show_trail', 't1-1', 'C_HOME', '9.1'));
  }));

// ── ratings ──────────────────────────────────────────────────────────────────
const rateValue = JSON.stringify({ t: 'tabc123-1', s: 'beta', k: 'thread:9.2' });
const ratedBlocks = [
  { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'the answer' }] }] },
  {
    type: 'actions',
    elements: [
      { type: 'button', action_id: 'show_trail', text: { type: 'plain_text', text: '🧭 Show steps' }, value: 'tabc123-1' },
      { type: 'button', action_id: 'fb_good', text: { type: 'plain_text', text: '👍 Helped' }, value: rateValue },
      { type: 'button', action_id: 'fb_bad', text: { type: 'plain_text', text: '👎 Missed' }, value: rateValue },
    ],
  },
];
test('events record: fb_good', () =>
  record('fb-good', (t) => t.receiver.send({ ...action(HOME, 'fb_good', rateValue), message: { ts: '1.0', blocks: ratedBlocks } })));
test('events record: fb_bad opens the reason modal', () =>
  record('fb-bad', (t) => t.receiver.send({ ...action(HOME, 'fb_bad', rateValue), message: { ts: '1.0', blocks: ratedBlocks } })));
test('events record: fb_good denied', () =>
  record('fb-denied', async (t) => {
    restrict(t);
    await t.receiver.send({ ...action(CLIENT, 'fb_good', rateValue, 'C_CLIENT'), message: { ts: '1.0', blocks: ratedBlocks } });
  }));
test('events record: fb_good from an unserved workspace', () =>
  record('fb-unserved', (t) => t.receiver.send({ ...action('TNOBODY9', 'fb_good', rateValue), message: { ts: '1.0', blocks: ratedBlocks } })));
test('events record: fb reason modal submitted', () =>
  record('fb-reason', (t) =>
    t.receiver.send(
      submission(HOME, FB_CALLBACK, JSON.stringify({ t: 'tabc123-1', s: 'beta', k: 'thread:9.2', c: 'C_HOME', ts: '1.0' }), {
        [FB_REASON.block]: { [FB_REASON.action]: { type: 'static_select', selected_option: { value: 'wrong' } } },
        [FB_NOTE.block]: { [FB_NOTE.action]: { type: 'plain_text_input', value: 'missed the point' } },
      }),
    ),
  ));

// ── YouTrack ticket modal (no YouTrack configured → unavailable view) ────────
test('events record: ticket_modal', () => record('ticket-modal', (t) => t.receiver.send(action(HOME, 'ticket_modal', 'SUP-12'))));

// ── DM picker ────────────────────────────────────────────────────────────────
const parkDm = (t: Twin) =>
  t.receiver.send(messageEnvelope({ team: HOME, channel: 'D_HOME', ts: '6.1', channelType: 'im', text: 'what is up?' }));
test('events record: dm picker → pick a project', () =>
  record('dm-pick', async (t) => {
    await parkDm(t);
    await t.receiver.send({
      ...action(HOME, 'dm_pick_project', '', 'D_HOME'),
      actions: [{ action_id: 'dm_pick_project', type: 'static_select', selected_option: { value: 'dp1:beta' } }],
      message: { ts: '6.2' },
    });
  }));
test('events record: dm picker expired', () =>
  record('dm-pick-expired', (t) =>
    t.receiver.send({
      ...action(HOME, 'dm_pick_project', '', 'D_HOME'),
      actions: [{ action_id: 'dm_pick_project', type: 'static_select', selected_option: { value: 'dp9:beta' } }],
      message: { ts: '6.2' },
    }),
  ));
test('events record: dm picker denied', () =>
  record('dm-pick-denied', async (t) => {
    t.store.setTeamAccess(HOME, { mode: 'allowlist', users: ['U_HUMAN'], admins: ['U_ADMIN'] });
    await parkDm(t);
    await t.receiver.send({
      ...action(HOME, 'dm_pick_project', '', 'D_HOME'),
      user: { id: 'U_OTHER', team_id: HOME },
      actions: [{ action_id: 'dm_pick_project', type: 'static_select', selected_option: { value: 'dp1:beta' } }],
      message: { ts: '6.2' },
    });
  }));

// ── session panel + restart ──────────────────────────────────────────────────
const sessValue = JSON.stringify({ key: 'thread:9.1', channel: 'C_HOME', threadTs: '9.1' });
test('events record: session_panel', () =>
  record('session-panel', async (t) => {
    t.store.patchChat('thread:9.1', 'alpha', { sessionId: 'sess-1', prCreated: true });
    await t.receiver.send(action(HOME, 'session_panel', sessValue, 'C_HOME', '9.1'));
  }));
test('events record: session_restart', () =>
  record('session-restart', async (t) => {
    t.store.patchChat('thread:9.1', 'alpha', { sessionId: 'sess-1' });
    await t.receiver.send(action(HOME, 'session_restart', sessValue));
  }));
test('events record: session_restart while busy', () =>
  record('session-restart-busy', async (t) => {
    t.store.patchChat('thread:9.1', 'alpha', { sessionId: 'sess-1' });
    t.busy.add('thread:9.1');
    await t.receiver.send(action(HOME, 'session_restart', sessValue));
  }));
test('events record: session_restart denied', () =>
  record('session-restart-denied', async (t) => {
    restrict(t);
    t.store.patchChat(`${CLIENT}:thread:9.1`, 'beta', { sessionId: 'sess-1' });
    await t.receiver.send(action(CLIENT, 'session_restart', JSON.stringify({ key: `${CLIENT}:thread:9.1`, channel: 'C_CLIENT' }), 'C_CLIENT'));
  }));

// ── YouTrack report flow ─────────────────────────────────────────────────────
const ytValue = JSON.stringify({ t: 'SUP-12', key: 'thread:9.1', channel: 'C_HOME', threadTs: '9.1' });
test('events record: yt_report opens the prompt modal', () => record('yt-report', (t) => t.receiver.send(action(HOME, 'yt_report', ytValue))));
test('events record: yt_report denied', () =>
  record('yt-report-denied', async (t) => {
    restrict(t);
    await t.receiver.send(action(CLIENT, 'yt_report', ytValue, 'C_CLIENT'));
  }));
for (const now of [false, true]) {
  test(`events record: yt prompt submitted (post immediately: ${now})`, () =>
    record(now ? 'yt-prompt-now' : 'yt-prompt', async (t) => {
      t.store.patchChat('thread:9.1', 'alpha', {});
      await t.receiver.send(
        submission(HOME, YT_PROMPT_CALLBACK, JSON.stringify({ t: 'SUP-12', key: 'thread:9.1', channel: 'C_HOME', threadTs: '9.1' }), {
          [YT_PROMPT_INPUT.block]: { [YT_PROMPT_INPUT.action]: { type: 'plain_text_input', value: 'Summarise the fix for support.' } },
          [YT_PROMPT_NOW.block]: {
            [YT_PROMPT_NOW.action]: { type: 'checkboxes', selected_options: now ? [{ value: YT_PROMPT_NOW.value }] : [] },
          },
        }),
      );
    }));
}
test('events record: yt_edit_send with a stored draft', () =>
  record('yt-edit-send', async (t) => {
    t.drafts.set('t1-5', 'Root cause: X.');
    await t.receiver.send({ ...action(HOME, 'yt_edit_send', JSON.stringify({ t: 'SUP-12', d: 't1-5' })), message: { ts: '1.0', thread_ts: '9.1', blocks: [] } });
  }));
test('events record: yt_edit_send expired', () =>
  record('yt-edit-send-expired', (t) =>
    t.receiver.send({ ...action(HOME, 'yt_edit_send', JSON.stringify({ t: 'SUP-12', d: 'tgone' })), message: { ts: '1.0', blocks: [] } }),
  ));
test('events record: report modal submitted, YouTrack unreachable', () =>
  record('yt-send-fail', (t) =>
    t.receiver.send(
      submission(HOME, YT_SEND_CALLBACK, JSON.stringify({ t: 'SUP-12', channel: 'C_HOME', ts: '1.0', threadTs: '9.1' }), {
        [YT_SEND_INPUT.block]: { [YT_SEND_INPUT.action]: { type: 'plain_text_input', value: 'Root cause: X.' } },
      }),
    ),
  ));

// ── autofix ──────────────────────────────────────────────────────────────────
const fixValue = JSON.stringify({ slug: 'beta', repo: 'Org/beta', number: 7, channel: 'C_CLIENT' });
test('events record: autofix_apply', () => record('autofix', (t) => t.receiver.send(action(CLIENT, 'autofix_apply', fixValue, 'C_CLIENT'))));
test('events record: autofix_apply while a fix runs', () =>
  record('autofix-busy', async (t) => {
    t.busy.add(`${CLIENT}:autofix:Org/beta:7:beta`);
    await t.receiver.send(action(CLIENT, 'autofix_apply', fixValue, 'C_CLIENT'));
  }));
test('events record: autofix_apply denied', () =>
  record('autofix-denied', async (t) => {
    restrict(t);
    await t.receiver.send(action(CLIENT, 'autofix_apply', fixValue, 'C_CLIENT'));
  }));

// ── memory topic ─────────────────────────────────────────────────────────────
test('events record: mem_open from the journal copy', async () => {
  const dir = memoryRepoDir('evrec-mem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\n**Deploys** go through `make ship`.\n');
  try {
    await record('mem-open', async (t) => {
      await t.receiver.send(action(HOME, 'mem_open:0', JSON.stringify({ s: 'evrec-mem', f: 'notes.md' })));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── questions ────────────────────────────────────────────────────────────────
const seedQuestion = (t: Twin, qid: string, multi: boolean) =>
  t.questions.set(qid, {
    questions: [{ question: 'Which DB?', multiSelect: multi, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    picks: new Map(),
    multi,
    resolve: () => {},
    channel: 'C_HOME',
    ts: '8.1',
    done: false,
  });
test('events record: single-select answer resolves on click', () =>
  record('answer-single', async (t) => {
    seedQuestion(t, 'q1', false);
    await t.receiver.send(action(HOME, 'answer_q:q1:0:1', JSON.stringify({ qid: 'q1', qi: 0, oi: 1 })));
  }));
test('events record: multi-select toggles, then Submit', () =>
  record('answer-multi', async (t) => {
    seedQuestion(t, 'q2', true);
    await t.receiver.send(action(HOME, 'answer_q:q2:0:0', JSON.stringify({ qid: 'q2', qi: 0, oi: 0 })));
    await t.receiver.send(action(HOME, 'answer_q:q2:0:1', JSON.stringify({ qid: 'q2', qi: 0, oi: 1 })));
    await t.receiver.send(action(HOME, 'answer_q:q2:0:0', JSON.stringify({ qid: 'q2', qi: 0, oi: 0 })));
    await t.receiver.send(action(HOME, 'submit_q:q2', JSON.stringify({ qid: 'q2' })));
  }));
test('events record: Submit before every question has a pick is ignored', () =>
  record('submit-early', async (t) => {
    seedQuestion(t, 'q3', true);
    await t.receiver.send(action(HOME, 'submit_q:q3', JSON.stringify({ qid: 'q3' })));
  }));
test('events record: a click on an unknown question marks it expired', () =>
  record('answer-expired', (t) => t.receiver.send({ ...action(HOME, 'answer_q:q9:0:0', JSON.stringify({ qid: 'q9', qi: 0, oi: 0 })), message: { ts: '8.9' } })));
test('events record: a late click on an answered question is a no-op', () =>
  record('answer-late', async (t) => {
    t.completed.add('q4');
    await t.receiver.send(action(HOME, 'submit_q:q4', JSON.stringify({ qid: 'q4' })));
  }));
test('events record: answering denied', () =>
  record('answer-denied', async (t) => {
    restrict(t);
    seedQuestion(t, 'q5', false);
    await t.receiver.send(action(CLIENT, 'answer_q:q5:0:0', JSON.stringify({ qid: 'q5', qi: 0, oi: 0 }), 'C_CLIENT'));
  }));

// ── App Home + install lifecycle ─────────────────────────────────────────────
test('events record: App Home for the home workspace', () => record('home', (t) => t.receiver.send(homeOpenedEnvelope(HOME))));
test('events record: App Home for a client workspace', () => record('home-client', (t) => t.receiver.send(homeOpenedEnvelope(CLIENT))));
test('events record: App Home for an unmapped workspace', () => record('home-onboarding', (t) => t.receiver.send(homeOpenedEnvelope('TNOBODY9'))));
test('events record: messages tab opened → nothing', () =>
  record('home-messages-tab', (t) =>
    t.receiver.send({ team_id: HOME, api_app_id: 'A0TWIN', type: 'event_callback', event: { type: 'app_home_opened', tab: 'messages', user: 'U_HUMAN' } }),
  ));
for (const ev of [
  { name: 'uninstalled', event: { type: 'app_uninstalled' } },
  { name: 'tokens-revoked', event: { type: 'tokens_revoked', tokens: { bot: ['UBOT'] } } },
  { name: 'tokens-revoked-user', event: { type: 'tokens_revoked', tokens: { oauth: ['U1'] } } },
]) {
  test(`events record: ${ev.name}`, () =>
    record(ev.name, async (t) => {
      t.store.setInstallation(CLIENT, { bot: { token: 'xoxb-dead' } });
      await t.receiver.send({ team_id: CLIENT, api_app_id: 'A0TWIN', type: 'event_callback', event: ev.event });
      t.log.push({ installationAfter: t.store.getInstallation(CLIENT) ?? null });
    }));
}
