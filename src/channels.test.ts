// pickProject's single-project fallback: any conversation of a one-project installation maps to that
// project — except conversations the driver declares bound-only (Teams team channels), which need an
// explicit binding and are told so (OpenSpec teams-chat-driver; the canary of 2026-10-19).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from './channels.js';
import { hasReplyChains } from './chat/teams/keys.js';

const BOUND = '19:bound0000@thread.tacv2';
const OTHER = '19:other0000@thread.tacv2';
const PERSONAL = 'a:1personalchat';
const names = { conversationName: async () => undefined };
const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'], teamsChannel: BOUND }] } };

test('one project, no bound-only rule (Slack): every conversation maps to it', async () => {
  const ch = createChannels(reg as never, () => undefined);
  assert.equal((await ch.pickProject(names, OTHER, 'hi')).project?.slug, 'alpha');
  assert.equal((await ch.pickProject(names, PERSONAL, 'hi')).project?.slug, 'alpha');
});

test('one project, Teams team channels bound-only: the bound channel and a 1:1 map, another channel is not connected', async () => {
  const ch = createChannels(reg as never, () => undefined, { boundOnly: hasReplyChains });
  assert.equal((await ch.pickProject(names, BOUND, 'hi')).project?.slug, 'alpha');
  assert.equal((await ch.pickProject(names, PERSONAL, 'hi')).project?.slug, 'alpha');
  const other = await ch.pickProject(names, OTHER, 'hi');
  assert.equal(other.project, undefined);
  assert.match(other.error ?? '', /isn't connected to a project/);
  // A slug prefix still names the project explicitly, in any conversation.
  assert.equal((await ch.pickProject(names, OTHER, 'alpha hi')).project?.slug, 'alpha');
});
