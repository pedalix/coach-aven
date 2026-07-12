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

// A turn engine that records liveTurn calls instead of driving sandboxes.
function fakeEngine(store: Store) {
  const turns: Array<{ key: string; channel: string; question: string; slug: string; token?: string }> = [];
  const engine = {
    liveTurn: async (client: bolt.webApi.WebClient, channel: string, _m: unknown, _t: unknown, key: string, project: { slug: string }, question: string) => {
      turns.push({ key, channel, question, slug: project.slug, token: (client as { token?: string }).token });
    },
    runAsk: async () => 'ok',
    persist: () => {},
    cancel: () => {},
    hasKey: () => false,
    hasLive: () => false,
    activeKeys: () => [],
    runningCount: () => 0,
    projectBusy: () => false,
    slugForKey: (key: string) => (isThreadKey(key) ? store.getChat(key)?.slug : slugOfBase(key)),
    resumeInflightTurns: () => new Map(),
    resumeQueuedTurns: () => {},
    questions: { get: () => undefined, isCompleted: () => false, answeredAll: () => false, finalize: () => {} },
    trail: () => undefined,
    ytDraft: () => undefined,
    usageReport: () => '',
  } as unknown as TurnEngine;
  return { engine, turns };
}

// One fully-wired twin: registry with a home-only project (alpha) and a SHARED one
// (beta, home first → home owns it), channel names for the wildcard binding, and the
// same servedTenant rule slack.ts builds.
async function twin() {
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
  const { engine, turns } = fakeEngine(store);
  const channels = createChannels(reg, () => HOME);
  const servedTenant = (t: string | undefined) =>
    !!t && (t === HOME || (reg.current.workspaces[t as keyof typeof reg.current.workspaces]?.length ?? 0) > 0);
  const { app, receiver, api, stop } = await createTwinApp({
    C_HOME: 'bluefin-aven-alpha',
    C_CLIENT: 'bluefin-aven-beta',
    C_SHARED: 'bluefin-aven-beta',
  });
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
  return { receiver, api, store, turns, stop };
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
    await t.receiver.send(mentionEnvelope({ team: CLIENT, channel: 'C_CLIENT', ts: '2.1', text: `<@UBOT_${CLIENT}> hi` }));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0].key, `${CLIENT}:thread:2.1`);
    assert.equal(t.turns[0].slug, 'beta');
    assert.equal(t.turns[0].token, `xoxb-${CLIENT}`);
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
