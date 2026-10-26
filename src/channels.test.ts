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

test('a surface that binds by construction (the web): projectOf resolves its conversations first, conversationFor answers the directory, no name lookup', async () => {
  const two = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }, { slug: 'beta', repos: ['Org/beta'], webRoom: false }] } };
  let lookups = 0;
  const counting = { conversationName: async () => (lookups++, undefined), findConversation: async () => (lookups++, 'never') };
  const ch = createChannels(two as never, () => undefined, {
    binding: 'web',
    boundOnly: () => true,
    projectOf: (conv) => (conv.startsWith('room:') ? conv.slice(5) : conv.startsWith('pc:') ? conv.slice(conv.lastIndexOf(':') + 1) : undefined),
    conversationFor: (p) => (p.webRoom === false ? undefined : `room:${p.slug}`),
  });
  assert.equal((await ch.pickProject(counting, 'room:alpha', 'hi')).project?.slug, 'alpha');
  assert.equal((await ch.pickProject(counting, 'pc:u1:alpha', 'hi')).project?.slug, 'alpha');
  // A slug prefix in the text is still a slug prefix (the DM convention), only after the surface's own rule.
  assert.deepEqual(await ch.pickProject(counting, 'pc:u1:alpha', 'beta hi').then((r) => [r.project?.slug, r.question]), ['alpha', 'beta hi']);
  assert.equal(await ch.channelIdForSlug(counting, two.current.projects[0] as never), 'room:alpha');
  assert.equal(await ch.channelIdForSlug(counting, two.current.projects[1] as never), undefined);
  assert.equal(lookups, 0, 'a web conversation and a project are resolved without asking the driver');
  // A conversation the surface does not own falls through the usual rules (one name lookup, which the web answers with nothing) and is not connected.
  const foreign = await ch.pickProject(counting, 'C123', 'hi');
  assert.equal(foreign.project, undefined);
  assert.match(foreign.error ?? '', /isn't connected to a project/);
});
