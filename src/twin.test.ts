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
import { createChannels } from './channels.js';
import { registerEvents } from './events.js';
import { slugOfBase, isThreadKey } from './teamkeys.js';
import type { TurnEngine } from './turn.js';
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
  const busyKeys = new Set<string>();
  const engine = {
    liveTurn: async (
      client: bolt.webApi.WebClient,
      channel: string,
      _m: unknown,
      _t: unknown,
      key: string,
      project: { slug: string },
      question: string,
      attachments?: RecordedAttachments,
    ) => {
      turns.push({ key, channel, question, slug: project.slug, token: (client as { token?: string }).token, attachments });
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
  } as unknown as TurnEngine;
  return { engine, turns, restarts, busyKeys };
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
  const { engine, turns, restarts, busyKeys } = fakeEngine(store);
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
  return { receiver, api, store, turns, restarts, busyKeys, stop };
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
    t.store.patchChat('thread:5.0', 'beta', {}); // the button's target exists and is real
    const value = JSON.stringify({ key: 'thread:5.0', channel: 'C_SHARED' });
    await t.receiver.send(blockActionEnvelope(STRANGER, 'make_pr', value, 'C_SHARED'));
    assert.equal(t.turns.length, 0);
    // …while the SAME click from a served tenant does fire.
    await t.receiver.send(blockActionEnvelope(HOME, 'make_pr', value, 'C_SHARED'));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, 'thread:5.0');
  } finally {
    await t.stop();
  }
});

// ── "🔄 Restart session" — regression coverage for its respond()-based edit-in-place flow.
// (session_panel itself moved off respond() entirely in a follow-up fix — it now posts via
// chat.postEphemeral so it can carry thread_ts; that fix carries its own regression test
// against the plain Web API recording, no harness change needed.) Driving the REAL
// registerEvents handler (not a reimplementation) is still the point here.
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
