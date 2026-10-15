// Tenant-isolation scenario tests over the Slack digital twin (src/twin.ts): real Bolt
// app + real registerEvents handlers, synthetic envelopes, recording Web API. These are
// the scenarios that can't be unit-tested per module because they emerge from the
// pipeline: gate → per-tenant resolution → key ownership → claim-on-act.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type bolt from '@slack/bolt';
import type { Config } from './config.js';
import { Store } from './state.js';
import type { FeedbackRecord } from './feedback.js';
import { loadFixture, rehome } from './fixtures.js';
import { createChannels } from './channels.js';
import { registerEvents } from './chat/slack/events.js';
import { slugOfBase, isThreadKey } from './teamkeys.js';
import type { TurnEngine } from './turn.js';
import type { SlackChatDriver } from './chat/slack/driver.js';
import {
  createTwinApp,
  mentionEnvelope,
  messageEnvelope,
  homeOpenedEnvelope,
  blockActionEnvelope,
} from './twin.js';

const HOME = 'THOME1111';
const CLIENT = 'TCLIENT222';
const STRANGER = 'TSTRANGER3';

// A turn engine that records liveTurn/restartSession calls instead of driving sandboxes.
// `busyKeys` lets a test simulate "a turn is running" for the session_restart refusal path.
type RecordedAttachments = { refs: { name: string; url: string; mime: string }[]; bearer: string };
function fakeEngine(store: Store) {
  const turns: Array<{
    key: string;
    channel: string;
    question: string;
    slug: string;
    token?: string;
    attachments?: RecordedAttachments;
  }> = [];
  const restarts: Array<{ key: string; slug: string }> = [];
  const ratings: FeedbackRecord[] = [];
  const busyKeys = new Set<string>();
  const engine = {
    liveTurn: async (
      driver: SlackChatDriver,
      channel: string,
      _m: unknown,
      _t: unknown,
      key: string,
      project: { slug: string },
      question: string,
      attachments?: RecordedAttachments,
    ) => {
      turns.push({ key, channel, question, slug: project.slug, token: (driver.client as { token?: string }).token, attachments });
    },
    runAsk: async () => 'ok',
    persist: () => {},
    cancel: () => {},
    hasKey: (key: string) => busyKeys.has(key),
    hasLive: () => false,
    activeKeys: () => [],
    runningCount: () => 0,
    projectBusy: () => false,
    slugForKey: (key: string) => (isThreadKey(key) ? store.getChat(key)?.slug : slugOfBase(key)),
    restartSession: async (key: string, project: { slug: string }) => {
      restarts.push({ key, slug: project.slug });
    },
    resumeInflightTurns: () => new Map(),
    resumeQueuedTurns: () => {},
    questions: { get: () => undefined, isCompleted: () => false, answeredAll: () => false, finalize: () => {} },
    trail: () => undefined,
    ytDraft: () => undefined,
    usageReport: () => '',
    recordFeedback: (rec: FeedbackRecord) => {
      ratings.push(rec);
      // Same collapse the real engine does: one verdict per user, latest wins.
      const latest = new Map(ratings.filter((r) => r.turnId === rec.turnId).map((r) => [r.user, r.verdict]));
      return { good: [...latest.values()].filter((v) => v === 'good').length, bad: [...latest.values()].filter((v) => v === 'bad').length };
    },
  } as unknown as TurnEngine;
  return { engine, turns, restarts, ratings, busyKeys };
}

// One fully-wired twin: registry with a home-only project (alpha) and a SHARED one
// (beta, home first → home owns it), channel names for the wildcard binding, and the
// same servedTenant rule slack.ts builds.
async function twin(files: Record<string, Record<string, unknown>> = {}) {
  const reg = {
    current: {
      projects: [
        { slug: 'alpha', repos: ['Org/alpha'] },
        { slug: 'beta', repos: ['Org/beta'] },
      ],
      workspaces: { [HOME]: ['alpha', 'beta'], [CLIENT]: ['beta'] },
    },
  };
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-twin-')), 'state.json'));
  const { engine, turns, restarts, ratings, busyKeys } = fakeEngine(store);
  const channels = createChannels(reg, () => HOME);
  const servedTenant = (t: string | undefined) =>
    !!t && (t === HOME || (reg.current.workspaces[t as keyof typeof reg.current.workspaces]?.length ?? 0) > 0);
  const { app, receiver, api, stop } = await createTwinApp(
    {
      C_HOME: 'bluefin-aven-alpha',
      C_CLIENT: 'bluefin-aven-beta',
      C_SHARED: 'bluefin-aven-beta',
    },
    files,
  );
  registerEvents(app, {
    cfg: { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 1 } } as unknown as Config,
    store,
    reg,
    engine,
    channels,
    botUserId: `UBOT_${HOME}`,
    homeTeamId: HOME,
    servedTenant,
  });
  return { receiver, api, store, turns, restarts, ratings, busyKeys, stop };
}

test('twin: home mention runs a turn with a BARE key and the home token', async () => {
  const t = await twin();
  try {
    await t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_HOME', ts: '1.1', text: `<@UBOT_${HOME}> build it` }));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, 'thread:1.1');
    assert.equal(t.turns[0].slug, 'alpha');
    assert.equal(t.turns[0].token, `xoxb-${HOME}`);
  } finally {
    await t.stop();
  }
});

test('twin: client-workspace mention gets a TENANT-PREFIXED key and the client token', async () => {
  const t = await twin();
  try {
    // Access defaults to OPEN everywhere (access.ts) — no clearance setup needed.
    await t.receiver.send(mentionEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '2.1', text: `<@UBOT_${CLIENT}> hi` }));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, `${CLIENT}:thread:2.1`);
    assert.equal(t.turns[0].slug, 'beta');
    assert.equal(t.turns[0].token, `xoxb-${CLIENT}`);
  } finally {
    await t.stop();
  }
});

test('twin: actor gate — an unlisted user in a RESTRICTED workspace gets a denial, not a turn', async () => {
  const t = await twin();
  try {
    // Restriction is opt-in (`/aven users restrict`) — this workspace turned it on;
    // U_HUMAN (the envelope default) is not on the list.
    t.store.setTeamAccess(CLIENT, { mode: 'allowlist', users: [], admins: ['U_INSTALLER'] });
    await t.receiver.send(mentionEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '3.1', text: `<@UBOT_${CLIENT}> do it` }));
    assert.equal(t.turns.length, 0); // no turn
    const posts = t.api.of('chat.postMessage');
    assert.equal(posts.length, 1); // exactly one explicit denial…
    assert.ok(String((posts[0].payload as { text?: string }).text).includes('allowlist'));
    assert.ok(String((posts[0].payload as { text?: string }).text).includes('U_INSTALLER')); // …naming the admin

    // The home workspace stays open by default — the same user drives home unimpeded.
    await t.receiver.send(mentionEnvelope({ team: HOME, channel: 'C_HOME', ts: '3.2', text: `<@UBOT_${HOME}> go` }));
    assert.equal(t.turns.length, 1);
  } finally {
    await t.stop();
  }
});

test('twin: Slack Connect double envelope — exactly ONE turn, owned by the thread\'s tenant', async () => {
  const t = await twin();
  try {
    // Home owns this thread (a prior conversation left its ChatRecord under the bare key).
    t.store.patchChat('thread:5.0', 'beta', {});
    const reply = { channel: 'C_SHARED', ts: '5.2', threadTs: '5.0', text: 'continue please', extShared: true };
    // The same human message, delivered once per installation — order: client first
    // (the dangerous order: the non-owner envelope must NOT claim or reply).
    await t.receiver.send(messageEnvelope({ team: CLIENT, ...reply }));
    await t.receiver.send(messageEnvelope({ team: HOME, ...reply }));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, 'thread:5.0');
    assert.equal(t.turns[0].token, `xoxb-${HOME}`);
  } finally {
    await t.stop();
  }
});

test('twin: App Home is per-tenant; an unmapped workspace gets the onboarding view', async () => {
  const t = await twin();
  try {
    await t.receiver.send(homeOpenedEnvelope(CLIENT));
    await t.receiver.send(homeOpenedEnvelope(STRANGER));
    const views = t.api.of('views.publish');
    assert.equal(views.length, 2);
    const clientView = String(views[0].payload.view);
    assert.ok(clientView.includes('beta') && !clientView.includes('alpha'), 'client sees only its own project');
    assert.equal(views[0].token, `xoxb-${CLIENT}`);
    const strangerView = String(views[1].payload.view);
    assert.ok(strangerView.includes('no projects are configured'), 'stranger gets onboarding');
  } finally {
    await t.stop();
  }
});

test('twin: a write button from an unserved workspace fires NO turn', async () => {
  const t = await twin();
  try {
    // autofix_apply is the write button that fires a turn directly ("Open a PR" no longer exists).
    const value = JSON.stringify({ slug: 'beta', repo: 'Org/beta', number: 7, channel: 'C_SHARED' });
    await t.receiver.send(blockActionEnvelope(STRANGER, 'autofix_apply', value, 'C_SHARED'));
    assert.equal(t.turns.length, 0);
    // …while the SAME click from a served tenant does fire.
    await t.receiver.send(blockActionEnvelope(HOME, 'autofix_apply', value, 'C_SHARED'));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, 'autofix:Org/beta:7:beta');
  } finally {
    await t.stop();
  }
});

// "⚙️ Session" must render INSIDE the thread, not as a top-level channel post — regression
// for the bug where it used respond()/response_url, which silently drops thread_ts for
// ephemeral messages. chat.postEphemeral is a plain Web API call, so the twin's existing
// RecordingApi captures it with no harness changes.
test('twin: "⚙️ Session" posts an ephemeral card INTO the thread (thread_ts set), not the channel', async () => {
  const t = await twin();
  try {
    t.store.patchChat('thread:9.0', 'beta', { sessionId: 'sess-1', sessionKey: 'sk-1', cmdId: 'cmd-1' });
    const value = JSON.stringify({ key: 'thread:9.0', channel: 'C_SHARED', threadTs: '9.0' });
    await t.receiver.send(blockActionEnvelope(HOME, 'session_panel', value, 'C_SHARED'));
    const calls = t.api.of('chat.postEphemeral');
    assert.equal(calls.length, 1);
    const p = calls[0].payload as { channel: string; user: string; thread_ts: string; text: string };
    assert.equal(p.channel, 'C_SHARED');
    assert.equal(p.user, 'U_HUMAN');
    assert.equal(p.thread_ts, '9.0'); // the actual bug: this was previously dropped entirely
    assert.match(p.text, /Session — beta/);
  } finally {
    await t.stop();
  }
});

// ── Answer rating — the click's confirmation is the vote count on the message itself. No
// ephemeral: the first version posted one, and respond() dropped thread_ts so it landed at
// the bottom of the channel. Only the rating row may change; every other block goes back as
// the click payload delivered it (Slack has rewritten the answer to rich_text by then).
test('twin: rating an answer rewrites ONLY the rating labels on that message, nothing else', async () => {
  const t = await twin();
  try {
    const value = JSON.stringify({ t: 'tabc123-1', s: 'beta', k: 'thread:9.2' });
    const blocks = [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'the answer' }] }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '🧭 3 steps · 12s' }] },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'show_trail', text: { type: 'plain_text', text: '🧭 Show steps' }, value: 'tabc123-1' },
          { type: 'button', action_id: 'fb_good', text: { type: 'plain_text', text: '👍 Helped' }, value },
          { type: 'button', action_id: 'fb_bad', text: { type: 'plain_text', text: '👎 Missed' }, value },
        ],
      },
    ];
    await t.receiver.send({ ...blockActionEnvelope(HOME, 'fb_good', value, 'C_SHARED'), message: { ts: '1.0', blocks } });
    assert.equal(t.api.of('chat.postEphemeral').length, 0); // no more channel-bottom notes
    assert.equal(t.api.of('respond').length, 0);
    const updates = t.api.of('chat.update');
    assert.equal(updates.length, 1);
    const p = updates[0].payload as { channel: string; ts: string; blocks: string };
    assert.equal(p.channel, 'C_SHARED');
    assert.equal(p.ts, '1.0');
    const sent = JSON.parse(p.blocks) as typeof blocks; // form-encoded, so a JSON string
    assert.deepEqual(sent[0], blocks[0]); // the rich_text answer went back untouched
    assert.deepEqual(sent[1], blocks[1]);
    const row = (sent[2] as { elements: { action_id: string; text: { text: string } }[] }).elements.map((e) => [e.action_id, e.text.text]);
    assert.deepEqual(row, [
      ['show_trail', '🧭 Show steps'], // other buttons untouched
      ['fb_good', '👍 Helped · 1'], // the click, counted
      ['fb_bad', '👎 Missed'], // zero stays unlabelled
    ]);
    assert.equal(t.ratings.length, 1);
    assert.equal(t.ratings[0].verdict, 'good');
    assert.equal(t.ratings[0].turnId, 'tabc123-1');
    assert.equal(t.ratings[0].user, 'U_HUMAN');
  } finally {
    await t.stop();
  }
});

// ── "🧭 Show steps" — when Slack refuses the modal, the click must still say something ──
// The prod failure this locks in (2026-09-08): views.open answered `internal_error` on every
// click for a whole turn, the handler logged it and returned, and the person clicking got
// nothing at all — no modal, no error, no sign the button had been pressed. A trigger_id is
// single-use, so the fallback is an ephemeral, not a retry of the open.
test('twin: a steps modal Slack refuses leaves a visible ephemeral, not just a log line', async () => {
  const t = await twin();
  try {
    t.api.failures['views.open'] = 'internal_error';
    await t.receiver.send(blockActionEnvelope(HOME, 'show_trail', 'tabc123-1', 'C_SHARED', '9.0'));
    assert.equal(t.api.of('views.open').length, 1); // tried once
    const eph = t.api.of('chat.postEphemeral');
    assert.equal(eph.length, 1);
    const p = eph[0].payload as { channel: string; user: string; thread_ts?: string; text: string };
    assert.equal(p.channel, 'C_SHARED');
    assert.equal(p.user, 'U_HUMAN');
    assert.equal(p.thread_ts, '9.0'); // in the thread, not at the channel bottom
    assert.match(p.text, /steps view/i);
  } finally {
    await t.stop();
  }
});

test('twin: a steps modal that opens fine says nothing extra', async () => {
  const t = await twin();
  try {
    await t.receiver.send(blockActionEnvelope(HOME, 'show_trail', 'tabc123-1', 'C_SHARED', '9.0'));
    assert.equal(t.api.of('views.open').length, 1);
    assert.equal(t.api.of('chat.postEphemeral').length, 0);
  } finally {
    await t.stop();
  }
});

test('twin: a thumbs-down records on click, opens the reason modal, then shows the count', async () => {
  const t = await twin();
  try {
    const value = JSON.stringify({ t: 'tabc123-2', s: 'beta', k: 'thread:9.3' });
    const blocks = [
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'fb_good', text: { type: 'plain_text', text: '👍 Helped' }, value },
          { type: 'button', action_id: 'fb_bad', text: { type: 'plain_text', text: '👎 Missed' }, value },
        ],
      },
    ];
    await t.receiver.send({ ...blockActionEnvelope(HOME, 'fb_bad', value, 'C_SHARED'), message: { ts: '1.0', blocks } });
    // The verdict is written on the CLICK — an abandoned modal still leaves the signal.
    assert.equal(t.ratings.length, 1);
    assert.equal(t.ratings[0].verdict, 'bad');
    assert.equal(t.ratings[0].reason, undefined); // the reason only arrives with the submission
    const opens = t.api.of('views.open');
    assert.equal(opens.length, 1);
    const view = JSON.parse((opens[0].payload as { view: string }).view) as { private_metadata: string };
    assert.deepEqual(JSON.parse(view.private_metadata), { t: 'tabc123-2', s: 'beta', k: 'thread:9.3', c: 'C_SHARED', ts: '1.0' });
    const updates = t.api.of('chat.update');
    assert.equal(updates.length, 1);
    const sent = JSON.parse((updates[0].payload as { blocks: string }).blocks) as typeof blocks;
    assert.deepEqual(sent[0].elements.map((e) => e.text.text), ['👍 Helped', '👎 Missed · 1']);
  } finally {
    await t.stop();
  }
});

test('twin: a message without a rating row is never updated (stale or foreign blocks)', async () => {
  const t = await twin();
  try {
    const value = JSON.stringify({ t: 'tabc123-3', s: 'beta', k: 'thread:9.4' });
    await t.receiver.send(blockActionEnvelope(HOME, 'fb_good', value, 'C_SHARED')); // envelope has no blocks
    assert.equal(t.ratings.length, 1); // the verdict still lands
    assert.equal(t.api.of('chat.update').length, 0); // but nothing to rewrite
  } finally {
    await t.stop();
  }
});

// ── Replays of REAL envelopes (src/fixtures/, captured on prod, scrubbed by src/fixtures.ts) ──
// Everything above this line drives the app with envelopes we composed. These drive it with
// what Slack actually sent — rehomed onto the twin's team/channel/user ids. When Slack changes
// a payload shape, refresh with `scripts/pull-fixtures.sh | npx tsx scripts/scrub-fixtures.ts`.
const HOMED = { team: HOME, channel: 'C_SHARED', actor: 'U_HUMAN', bot: `UBOT_${HOME}` };

test('fixture replay: a real 👍 click passes the real answer (10 blocks, incl. a table) back byte-identical, labels aside', async () => {
  const t = await twin();
  try {
    const fx = loadFixture('block_actions.fb_good');
    const body = rehome(fx, HOMED);
    const before = (body.message as { blocks: Array<{ type: string }> }).blocks;
    assert.ok(before.length >= 8, 'the captured answer should be a real multi-block message');
    assert.ok(before.some((b) => b.type === 'table'), 'the captured answer carries a table block — a shape no hand-written test had');
    await t.receiver.send(body);
    assert.equal(t.ratings.length, 1);
    assert.equal(t.ratings[0].verdict, 'good');
    const updates = t.api.of('chat.update');
    assert.equal(updates.length, 1);
    const sent = JSON.parse((updates[0].payload as { blocks: string }).blocks) as Array<{ type: string; elements?: Array<{ action_id?: string; text?: { text: string } }> }>;
    assert.equal(sent.length, before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i].type !== 'actions') assert.deepEqual(sent[i], before[i], `block ${i} (${before[i].type}) changed on the way back`);
    }
    const row = sent.find((b) => b.type === 'actions')!.elements!;
    assert.deepEqual(row.map((e) => e.action_id), ['show_trail', 'session_panel', 'fb_good', 'fb_bad']);
    assert.equal(row[2].text!.text, '👍 Helped · 1');
    assert.equal(row[3].text!.text, '👎 Missed');
    assert.equal(t.api.of('chat.postEphemeral').length, 0);
  } finally {
    await t.stop();
  }
});

test('fixture replay: a real 👎 click records, opens the modal, updates the count', async () => {
  const t = await twin();
  try {
    await t.receiver.send(rehome(loadFixture('block_actions.fb_bad'), HOMED));
    assert.equal(t.ratings.length, 1);
    assert.equal(t.ratings[0].verdict, 'bad');
    assert.equal(t.api.of('views.open').length, 1);
    assert.equal(t.api.of('chat.update').length, 1);
  } finally {
    await t.stop();
  }
});

test('fixture replay: a real reason-modal submission records the reason against the turn', async () => {
  const t = await twin();
  try {
    const fx = loadFixture('view_submission.fb_reason_modal');
    await t.receiver.send(rehome(fx, HOMED));
    assert.equal(t.ratings.length, 1);
    assert.equal(t.ratings[0].verdict, 'bad');
    assert.ok(t.ratings[0].reason, 'the radio choice should come through view.state');
    assert.equal(t.ratings[0].user, 'U_HUMAN');
    assert.equal(t.ratings[0].channel, 'C_SHARED'); // reached inside private_metadata's JSON
  } finally {
    await t.stop();
  }
});

test('fixture replay: a real @-mention starts a turn on the channel\'s project with the home token', async () => {
  const t = await twin();
  try {
    await t.receiver.send(rehome(loadFixture('app_mention'), HOMED));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].slug, 'beta'); // C_SHARED → bluefin-aven-beta
    assert.equal(t.turns[0].token, `xoxb-${HOME}`);
    assert.match(t.turns[0].key, /^thread:/);
  } finally {
    await t.stop();
  }
});

// ── "🔄 Restart session" — regression coverage for its respond()-based edit-in-place flow
// (unaffected by the chat.postEphemeral switch above — it edits the panel via the click's
// own response_url, which works the same regardless of how the panel itself was posted).
test('twin: "🔄 Restart session" clears the thread\'s session and edits the panel in place', async () => {
  const t = await twin();
  try {
    t.store.patchChat('thread:9.1', 'beta', { sessionId: 'sess-1', sessionKey: 'sk-1', cmdId: 'cmd-1' });
    const value = JSON.stringify({ key: 'thread:9.1', channel: 'C_SHARED', threadTs: '9.1' });
    await t.receiver.send(blockActionEnvelope(HOME, 'session_restart', value, 'C_SHARED'));
    assert.deepEqual(t.restarts, [{ key: 'thread:9.1', slug: 'beta' }]);
    const respond = t.api.of('respond');
    assert.equal(respond.length, 1);
    const p = respond[0].payload as { replace_original: boolean; text: string };
    assert.equal(p.replace_original, true); // edits the already-ephemeral panel, not the answer
    assert.match(p.text, /restarted/i);
  } finally {
    await t.stop();
  }
});

test('twin: "🔄 Restart session" refuses while a turn is running for this thread', async () => {
  const t = await twin();
  try {
    t.store.patchChat('thread:9.2', 'beta', { sessionId: 'sess-1' });
    t.busyKeys.add('thread:9.2');
    const value = JSON.stringify({ key: 'thread:9.2', channel: 'C_SHARED', threadTs: '9.2' });
    await t.receiver.send(blockActionEnvelope(HOME, 'session_restart', value, 'C_SHARED'));
    assert.equal(t.restarts.length, 0); // never reached engine.restartSession
    const p = t.api.of('respond')[0].payload as { text: string };
    assert.match(p.text, /cancel it first/);
  } finally {
    await t.stop();
  }
});

test('twin: app_uninstalled removes the tenant installation (data kept)', async () => {
  const t = await twin();
  try {
    t.store.setInstallation(CLIENT, { bot: { token: 'xoxb-dead' } });
    t.store.patchChat(`${CLIENT}:thread:7.0`, 'beta', {}); // tenant data that must SURVIVE
    await t.receiver.send({
      team_id: CLIENT,
      api_app_id: 'A0TWIN',
      type: 'event_callback',
      event: { type: 'app_uninstalled' },
    });
    assert.equal(t.store.getInstallation(CLIENT), undefined);
    assert.equal(t.store.getChat(`${CLIENT}:thread:7.0`)?.slug, 'beta'); // purge stays manual
  } finally {
    await t.stop();
  }
});

// Regression for the 2026-07-14 caldora incident: in a Slack Connect channel the message
// event carries file TOMBSTONES ({ id, file_access: 'check_file_info' } — no url/name/mime),
// which the old slackFilesToRefs silently dropped. The pipeline must now hydrate them via
// files.info with the envelope workspace's token — and keep a file the workspace CAN'T
// access as a url-less ref, so the turn engine's skippedNotice tells the user about it.
test('twin: Connect tombstone files — hydrated via files.info; inaccessible ones survive as skipped refs', async () => {
  const t = await twin({
    F_OK: {
      id: 'F_OK',
      name: 'trip-response.json',
      mimetype: 'application/json',
      size: 42,
      url_private_download: 'https://files.slack.com/dl/F_OK',
    },
    // F_DENIED deliberately absent → files.info answers with no file (access denied).
  });
  try {
    t.store.patchChat('thread:5.0', 'beta', {}); // home owns this shared-channel thread
    await t.receiver.send(
      messageEnvelope({
        team: HOME,
        channel: 'C_SHARED',
        ts: '5.2',
        threadTs: '5.0',
        text: '', // file-only message — the tombstones alone must still fire the turn
        extShared: true,
        files: [
          { id: 'F_OK', file_access: 'check_file_info', created: 0, timestamp: 0, user: '', filetype: 'json' },
          { id: 'F_DENIED', file_access: 'check_file_info', created: 0, timestamp: 0, user: '', filetype: 'json' },
        ],
      }),
    );
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].question, 'Please take a look at the attached file(s).');
    const att = t.turns[0].attachments!;
    assert.equal(att.bearer, `xoxb-${HOME}`);
    assert.deepEqual(
      att.refs.map((r) => ({ name: r.name, url: r.url })),
      [
        { name: 'trip-response.json', url: 'https://files.slack.com/dl/F_OK' },
        { name: 'F_DENIED.json', url: '' }, // kept, not vanished — becomes a user-visible skip
      ],
    );
    // Hydration used the envelope workspace's own token (the Connect requirement).
    const infos = t.api.of('files.info');
    assert.deepEqual(infos.map((c) => c.token), [`xoxb-${HOME}`, `xoxb-${HOME}`]);
  } finally {
    await t.stop();
  }
});
