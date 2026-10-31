// Recorded-call pins for Slack messages (mentions, thread replies, DMs) and every `/aven`
// verb (OpenSpec chat-driver-interface, task 3.1), through the REAL Bolt app +
// registerEvents/registerCommands over the twin. Each scenario snapshots the Slack calls
// (Web API + response_url) and what reached the turn engine and the pollers. Taken before
// the message/command logic moved behind the chat driver; the move must leave them
// byte-identical. Re-snapshot on purpose with UPDATE_SNAPSHOTS=1.

import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import { createChannels } from '../../channels.js';
import { registerEvents } from './events.js';
import { registerCommands } from './commands.js';
import { slugOfBase, isThreadKey } from '../../teamkeys.js';
import { memoryRepoDir } from '../../memjournal.js';
import type { TurnEngine } from '../../turn.js';
import type { Pollers } from '../../pollers.js';
import type { SlackChatDriver } from './driver.js';
import { createTwinApp, mentionEnvelope, messageEnvelope } from './twin.js';
import { CMD } from './blocks.js';
import type { CommandDeps } from '../core/commands.js';

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const SNAP = (dir: string, name: string) => new URL(`../../fixtures/chat/${dir}/${name}.json`, import.meta.url).pathname;
const HOME = 'THOME1111';
const CLIENT = 'TCLIENT222';
const MEM = 'cmdrec-mem'; // a project whose memory journal dir is test scratch

before(() => mock.timers.enable({ apis: ['Date'], now: 0 }));
after(() => mock.timers.reset());

function recordingEngine(store: Store) {
  const log: unknown[] = [];
  const busy = new Set<string>();
  const engine = {
    liveTurn: async (d: SlackChatDriver, channel: string, msgTs: string | undefined, threadTs: string | undefined, key: string, project: { slug: string }, question: string, attachments?: { refs: unknown[]; bearer: string }) => {
      log.push({
        liveTurn: { token: (d.client as { token?: string }).token, channel, msgTs, threadTs, key, slug: project.slug, question, attachments: attachments ? { refs: attachments.refs, bearer: attachments.bearer } : undefined },
      });
    },
    runAsk: async (key: string, project: { slug: string }, question: string) => (log.push({ runAsk: { key, slug: project.slug, question } }), 'The answer is **42**.'),
    persist: () => {},
    cancel: () => {},
    hasKey: (key: string) => busy.has(key),
    hasLive: () => false,
    activeKeys: () => ['thread:9.1'],
    runningCount: () => 1,
    claudeQuota: () => undefined,
    projectBusy: () => false,
    slugForKey: (key: string) => (isThreadKey(key) ? store.getChat(key)?.slug : slugOfBase(key)),
    restartSession: async () => {},
    resumeInflightTurns: () => new Map(),
    resumeQueuedTurns: () => {},
    questions: { get: () => undefined, isCompleted: () => false, answeredAll: () => false, finalize: () => {} },
    trail: () => undefined,
    ytDraft: () => undefined,
    usageReport: (days: number) => `usage report for ${days}d`,
    recordFeedback: () => ({ good: 0, bad: 0 }),
  } as unknown as TurnEngine;
  return { engine, log, busy };
}

async function twin(o: { asks?: CommandDeps['asks'] } = {}) {
  const reg = {
    current: {
      projects: [
        { slug: 'alpha', repos: ['Org/alpha'], mcp: [{ name: 'youtrack' }], systemPrompt: 'Be **brief**.' },
        { slug: 'beta', repos: ['Org/beta'] },
        { slug: MEM, repos: ['Org/mem'] },
      ],
      workspaces: { [HOME]: ['alpha', 'beta', MEM], [CLIENT]: ['beta'] },
    },
  };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-cmdrec-')), 'state.json'));
  const rec = recordingEngine(store);
  const pollerLog: unknown[] = [];
  const pollers = {
    fireRoutine: (d: SlackChatDriver, r: { id: string }) => (pollerLog.push({ fireRoutine: { token: (d.client as { token?: string }).token, id: r.id } }), true),
    fireReview: (d: SlackChatDriver, project: { slug: string }, repo: string, number: number, channel: string, effort: string, tid?: string) =>
      (pollerLog.push({ fireReview: { token: (d.client as { token?: string }).token, slug: project.slug, repo, number, channel, effort, tid } }), true),
  } as unknown as Pollers;
  const channels = createChannels(reg as never, () => HOME);
  const servedTenant = (t: string | undefined) =>
    !!t && (t === HOME || (reg.current.workspaces[t as keyof typeof reg.current.workspaces]?.length ?? 0) > 0);
  const { app, receiver, api, stop } = await createTwinApp(
    { C_HOME: 'aven-alpha', C_BETA: 'aven-beta', C_CLIENT: 'aven-beta', C_MEM: `aven-${MEM}` },
    { F_HIDDEN: { id: 'F_HIDDEN', name: 'secret.pdf', mimetype: 'application/pdf', url_private_download: 'https://files/secret.pdf', size: 9 } },
  );
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 }, projectsConfigPath: '/nonexistent/projects.config.json' } as unknown as Config;
  registerEvents(app, { cfg, store, reg: reg as never, engine: rec.engine, channels, botUserId: `UBOT_${HOME}`, homeTeamId: HOME, servedTenant });
  registerCommands(app, { cfg, store, reg: reg as never, engine: rec.engine, channels, pollers, homeTeamId: HOME, ...(o.asks ? { asks: o.asks } : {}) });
  return { receiver, api, store, ...rec, pollerLog, stop };
}
type Twin = Awaited<ReturnType<typeof twin>>;

async function record(dir: string, name: string, run: (t: Twin) => Promise<void>, o: { asks?: CommandDeps['asks'] } = {}): Promise<void> {
  const t = await twin(o);
  try {
    await run(t);
    await new Promise((r) => setTimeout(r, 30));
    const got = {
      calls: t.api.calls.map((c) => ({ method: c.method, token: c.token, payload: c.payload })),
      engine: t.log,
      pollers: t.pollerLog,
    };
    const file = SNAP(dir, name);
    if (UPDATE) writeFileSync(file, JSON.stringify(got, null, 2) + '\n');
    assert.ok(existsSync(file), `missing snapshot ${file} — run with UPDATE_SNAPSHOTS=1`);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    await t.stop();
  }
}

const restrict = (t: Twin, team = CLIENT) => t.store.setTeamAccess(team, { mode: 'allowlist', users: [], admins: ['U_ADMIN'] });
const cmd = (text: string, o: { team?: string; channel?: string; user?: string } = {}) => ({
  command: CMD,
  text,
  team_id: o.team ?? HOME,
  channel_id: o.channel ?? 'C_HOME',
  user_id: o.user ?? 'U_HUMAN',
  api_app_id: 'A0TWIN',
  trigger_id: 'trig.c',
  response_url: 'http://127.0.0.1:1/noop',
});

// ── messages ─────────────────────────────────────────────────────────────────
const M = (name: string, run: (t: Twin) => Promise<void>) => test(`messages record: ${name}`, () => record('messages', name, run));
M('mention', (t) => t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_HOME', ts: '1.1', text: `<@UBOT_${HOME}> fix the build` })));
M('mention-in-thread', (t) => t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_HOME', ts: '1.2', threadTs: '1.0', text: `<@UBOT_${HOME}> and this` })));
M('mention-unbound', (t) => t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_RANDOM', ts: '1.3', text: `<@UBOT_${HOME}> hi` })));
M('mention-empty', (t) => t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_HOME', ts: '1.4', text: `<@UBOT_${HOME}>` })));
M('mention-denied', async (t) => {
  restrict(t);
  await t.receiver.send(mentionEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '1.5', text: `<@UBOT_${CLIENT}> go` }));
});
M('mention-file-only', (t) =>
  t.receiver.send(
    mentionEnvelope({
      team: HOME,
      channel: 'C_HOME',
      ts: '1.6',
      text: `<@UBOT_${HOME}>`,
      files: [{ id: 'F1', name: 'shot.png', mimetype: 'image/png', url_private_download: 'https://files/shot.png', size: 5 }],
    }),
  ),
);
M('mention-client', (t) => t.receiver.send(mentionEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '1.7', text: `<@UBOT_${CLIENT}> go` })));
M('dm-with-slug', (t) => t.receiver.send(messageEnvelope({ team: HOME, channel: 'D1', ts: '2.1', channelType: 'im', text: 'beta what changed?' })));
M('dm-picker', (t) => t.receiver.send(messageEnvelope({ team: HOME, channel: 'D1', ts: '2.2', channelType: 'im', text: 'what changed?' })));
M('dm-single-project', (t) => t.receiver.send(messageEnvelope({ team: CLIENT, channel: 'D2', ts: '2.3', channelType: 'im', text: 'hello' })));
M('dm-denied', async (t) => {
  restrict(t);
  await t.receiver.send(messageEnvelope({ team: CLIENT, channel: 'D2', ts: '2.4', channelType: 'im', text: 'hello' }));
});
M('dm-empty', (t) => t.receiver.send(messageEnvelope({ team: CLIENT, channel: 'D2', ts: '2.5', channelType: 'im', text: '' })));
M('dm-file', (t) =>
  t.receiver.send(
    messageEnvelope({
      team: CLIENT,
      channel: 'D2',
      ts: '2.6',
      channelType: 'im',
      text: '',
      files: [{ id: 'F_HIDDEN', file_access: 'check_file_info' }],
    }),
  ),
);
M('thread-reply-owned', async (t) => {
  t.store.patchChat('thread:3.0', 'alpha', { sessionId: 's' });
  await t.receiver.send(messageEnvelope({ team: HOME, channel: 'C_HOME', ts: '3.1', threadTs: '3.0', text: 'and also this' }));
});
M('thread-reply-unowned', (t) => t.receiver.send(messageEnvelope({ team: HOME, channel: 'C_HOME', ts: '3.2', threadTs: '3.9', text: 'chat' })));
M('thread-reply-denied', async (t) => {
  restrict(t);
  t.store.patchChat(`${CLIENT}:thread:3.0`, 'beta', { sessionId: 's' });
  await t.receiver.send(messageEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '3.3', threadTs: '3.0', text: 'me too' }));
});
M('thread-reply-empty', async (t) => {
  t.store.patchChat('thread:3.0', 'alpha', { sessionId: 's' });
  await t.receiver.send(messageEnvelope({ team: HOME, channel: 'C_HOME', ts: '3.4', threadTs: '3.0', text: '' }));
});
M('top-level-chatter', (t) => t.receiver.send(messageEnvelope({ team: HOME, channel: 'C_HOME', ts: '3.5', text: 'morning all' })));
M('bot-message', (t) =>
  t.receiver.send({ team_id: HOME, api_app_id: 'A0TWIN', type: 'event_callback', event: { type: 'message', channel: 'D1', channel_type: 'im', ts: '4.1', text: 'hi', bot_id: 'B1' } }),
);
M('edit-subtype', (t) =>
  t.receiver.send({ team_id: HOME, api_app_id: 'A0TWIN', type: 'event_callback', event: { type: 'message', subtype: 'message_changed', channel: 'D1', channel_type: 'im', ts: '4.2' } }),
);
M('self-mention-message', (t) => t.receiver.send(messageEnvelope({ team: HOME, channel: 'C_HOME', ts: '4.3', threadTs: '3.0', text: `<@UBOT_${HOME}> hi` })));
M('connect-double-envelope', async (t) => {
  t.store.patchChat('thread:5.0', 'beta', { sessionId: 's' });
  const env = { channel: 'C_BETA', ts: '5.1', threadTs: '5.0', text: 'follow-up', extShared: true };
  await t.receiver.send(messageEnvelope({ team: HOME, ...env }));
  await t.receiver.send(messageEnvelope({ team: HOME, ...env }));
});

// ── /aven ────────────────────────────────────────────────────────────────────
const C = (name: string, run: (t: Twin) => Promise<void>) => test(`commands record: ${name}`, () => record('commands', name, run));
C('unserved-workspace', (t) => t.receiver.send(cmd('status', { team: 'TNOBODY9', channel: 'C_X' })));
C('users-list', (t) => t.receiver.send(cmd('users')));
C('users-error', (t) => t.receiver.send(cmd('users frobnicate')));
C('users-not-admin', async (t) => {
  restrict(t);
  await t.receiver.send(cmd('users allow <@U2>', { team: CLIENT, channel: 'C_CLIENT' }));
});
C('users-restrict', (t) => t.receiver.send(cmd('users restrict')));
C('denied-write-verb', async (t) => {
  restrict(t);
  await t.receiver.send(cmd('schedule daily 9:00 | x', { team: CLIENT, channel: 'C_CLIENT' }));
});
// The twin's configuration has no driver settings, so the sandbox listing fails: Sandboxes ⚠️, and each
// project's sandbox reads "unknown", never "not created" (OpenSpec retire-daytona-driver D4).
C('status', async (t) => {
  t.store.patchChat('thread:9.1', 'alpha', { sessionId: 's' });
  await t.receiver.send(cmd('status'));
});
C('usage', (t) => t.receiver.send(cmd('usage 7')));
C('usage-client', (t) => t.receiver.send(cmd('usage', { team: CLIENT, channel: 'C_CLIENT' })));
C('reload-fails', (t) => t.receiver.send(cmd('reload')));
C('reload-client', (t) => t.receiver.send(cmd('reload', { team: CLIENT, channel: 'C_CLIENT' })));
C('access', (t) => t.receiver.send(cmd('access')));
C('access-unbound', (t) => t.receiver.send(cmd('access', { channel: 'C_RANDOM' })));
C('schedule', (t) => t.receiver.send(cmd('schedule weekdays 9:00 | what shipped yesterday')));
C('schedule-task', (t) => t.receiver.send(cmd('schedule task daily 19:30 | tidy the backlog')));
C('schedule-usage', (t) => t.receiver.send(cmd('schedule')));
C('schedule-bad-when', (t) => t.receiver.send(cmd('schedule someday | x')));
C('schedule-unbound', (t) => t.receiver.send(cmd('schedule daily 9:00 | x', { channel: 'C_RANDOM' })));
const seedRoutine = (t: Twin) =>
  t.store.addRoutine({ slug: 'alpha', channel: 'C_HOME', cron: '0 9 * * *', tz: 'Europe/Zurich', spec: 'daily 9:00', prompt: 'digest', enabled: true, createdBy: 'U_HUMAN' });
C('routines-list', async (t) => {
  seedRoutine(t);
  await t.receiver.send(cmd('routines'));
});
C('routines-all', async (t) => {
  seedRoutine(t);
  await t.receiver.send(cmd('routines all'));
});
for (const sub of ['off', 'on', 'rm', 'run', 'bogus']) {
  C(`routines-${sub}`, async (t) => {
    const r = seedRoutine(t);
    await t.receiver.send(cmd(`routines ${sub} ${r.id}`));
  });
}
C('routines-missing-id', (t) => t.receiver.send(cmd('routines off')));
C('routines-not-here', async (t) => {
  const r = seedRoutine(t);
  await t.receiver.send(cmd(`routines off ${r.id}`, { channel: 'C_BETA' }));
});
for (const verb of ['dream', 'housekeeping']) {
  C(`${verb}-status-none`, (t) => t.receiver.send(cmd(verb)));
  C(`${verb}-on`, (t) => t.receiver.send(cmd(`${verb} on`)));
  C(`${verb}-on-off-status`, async (t) => {
    await t.receiver.send(cmd(`${verb} on`));
    await t.receiver.send(cmd(`${verb} off`));
    await t.receiver.send(cmd(verb));
    await t.receiver.send(cmd(`${verb} on`));
  });
  C(`${verb}-off-none`, (t) => t.receiver.send(cmd(`${verb} off`)));
  C(`${verb}-now-none`, (t) => t.receiver.send(cmd(`${verb} now`)));
  C(`${verb}-now`, async (t) => {
    await t.receiver.send(cmd(`${verb} on`));
    await t.receiver.send(cmd(`${verb} now`));
  });
  C(`${verb}-unbound`, (t) => t.receiver.send(cmd(verb, { channel: 'C_RANDOM' })));
}
// `dream on <when>`: a weekly dream from the start; a nightly one moved to weekly (status shows the new schedule); a
// schedule it cannot read is refused with the forms, and nothing is created.
C('dream-on-weekly', (t) => t.receiver.send(cmd('dream on weekly sun 3:00')));
C('dream-nightly-to-weekly', async (t) => {
  await t.receiver.send(cmd('dream on'));
  await t.receiver.send(cmd('dream on weekly sun 3:00'));
  await t.receiver.send(cmd('dream'));
});
C('dream-on-bad-when', async (t) => {
  await t.receiver.send(cmd('dream on fortnightly'));
  await t.receiver.send(cmd('dream'));
});
C('memory-unbound', (t) => t.receiver.send(cmd('memory', { channel: 'C_RANDOM' })));
C('memory-bad-topic', (t) => t.receiver.send(cmd('memory ../etc', { channel: 'C_MEM' })));
C('memory-log-empty', (t) => t.receiver.send(cmd('memory log', { channel: 'C_MEM' })));
const withMemory = async (run: () => Promise<void>) => {
  const dir = memoryRepoDir(MEM);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n\n- [Deploys](deploys.md) — how we ship\n- [People](people.md) — who owns what\n');
  writeFileSync(join(dir, 'deploys.md'), '# Deploys\n\nUse **make ship**.\n');
  try {
    await run();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
C('memory-index', (t) => withMemory(() => t.receiver.send(cmd('memory', { channel: 'C_MEM' }))));
C('memory-topic', (t) => withMemory(() => t.receiver.send(cmd('memory deploys', { channel: 'C_MEM' }))));
// The twin's configuration has no driver settings, so building the driver fails like a missing host.
C('memory-live-no-sandbox', (t) => t.receiver.send(cmd('memory live', { channel: 'C_MEM' })));
C('prompt', (t) => t.receiver.send(cmd('prompt')));
C('prompt-none', (t) => t.receiver.send(cmd('prompt', { channel: 'C_BETA' })));
C('prompt-unbound', (t) => t.receiver.send(cmd('prompt', { channel: 'C_RANDOM' })));
C('review', (t) => t.receiver.send(cmd('review #7 high')));
C('review-url', (t) => t.receiver.send(cmd('review https://github.com/Org/beta/pull/12')));
C('review-usage', (t) => t.receiver.send(cmd('review')));
C('review-bad-ref', (t) => t.receiver.send(cmd('review nonsense', { channel: 'C_RANDOM' })));
C('review-auto-status', (t) => t.receiver.send(cmd('review auto')));
C('review-auto-on-off', async (t) => {
  await t.receiver.send(cmd('review auto on high'));
  await t.receiver.send(cmd('review auto'));
  await t.receiver.send(cmd('review auto off'));
});
C('review-auto-unbound', (t) => t.receiver.send(cmd('review auto on', { channel: 'C_RANDOM' })));
C('review-auto-not-owner', (t) => t.receiver.send(cmd('review auto on', { team: CLIENT, channel: 'C_CLIENT' })));
C('autofix-list', (t) => t.receiver.send(cmd('autofix list')));
C('autofix-usage', (t) => t.receiver.send(cmd('autofix')));
C('autofix-bad-ref', (t) => t.receiver.send(cmd('autofix nonsense', { channel: 'C_RANDOM' })));
C('autofix-off-none', (t) => t.receiver.send(cmd('autofix off #7')));
C('autofix-unreadable', (t) => t.receiver.send(cmd('autofix #7')));
C('autofix-off-watched', async (t) => {
  t.store.setPrWatch('Org/alpha#7', { repo: 'Org/alpha', number: 7, slug: 'alpha', channel: 'C_HOME', createdBy: 'U_HUMAN', createdAt: '1970-01-01T00:00:00.000Z' } as never);
  await t.receiver.send(cmd('autofix list'));
  await t.receiver.send(cmd('autofix off #7'));
});
C('question-dm', async (t) => {
  t.api.responses['conversations.open'] = { channel: { id: 'D_NEW' } };
  await t.receiver.send(cmd('how do we deploy?'));
});
C('question-no-dm', (t) => t.receiver.send(cmd('how do we deploy?')));
C('question-empty-bound', (t) => t.receiver.send(cmd('')));
C('question-unbound', (t) => t.receiver.send(cmd('how?', { channel: 'C_RANDOM' })));

// ── agent messaging: `/aven asks` (agent-messaging D17, task 6.1) ────────────────────────────────
const asksLog: unknown[] = [];
const fakeAsks = (enabled: boolean): CommandDeps['asks'] => ({
  enabled: () => enabled,
  list: () => (asksLog.push('list'), '*Tasks between agents* — the last 1, held first (times UTC)\n✅ alpha → home/beta · completed'),
  transcript: (id: string) => (asksLog.push({ transcript: id }), `*Task \`${id}\`*`),
  cancel: (id: string, by: string) => (asksLog.push({ cancel: id, by }), `Task \`${id}\` to home/beta: canceled.`),
});
test('commands record: asks — operator audit lists the tasks; a transcript; a cancel', async () => {
  asksLog.length = 0;
  await record('commands', 'asks-operator', async (t) => {
    await t.receiver.send(cmd('asks'));
    await t.receiver.send(cmd(`asks ${'a'.repeat(24)}`));
    await t.receiver.send(cmd(`asks cancel ${'a'.repeat(24)}`));
  }, { asks: fakeAsks(true) });
  assert.deepEqual(asksLog, ['list', { transcript: 'a'.repeat(24) }, { cancel: 'a'.repeat(24), by: 'U_HUMAN' }]);
});
test('commands record: asks — not an operator: told the verb is for operators, nothing listed', async () => {
  asksLog.length = 0;
  await record('commands', 'asks-client', (t) => t.receiver.send(cmd('asks', { team: CLIENT, channel: 'C_CLIENT' })), { asks: fakeAsks(true) });
  assert.deepEqual(asksLog, []);
});
test('commands record: asks — installation without configuration: `/aven asks why?` is a question to the agent, as before', async () => {
  asksLog.length = 0;
  await record('commands', 'asks-unconfigured', (t) => t.receiver.send(cmd('asks why?')), { asks: fakeAsks(false) });
  assert.deepEqual(asksLog, []);
});

