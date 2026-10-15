// The interaction core without any chat platform: a fake ChatDriver records what the core
// asked for. (The Slack rendering of the same flows is pinned in
// src/chat/slack/events.record.test.ts.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../state.js';
import type { Config } from '../../config.js';
import type { PendingQuestion, TurnEngine } from '../../turn.js';
import type { ChatAction, ChatDriver } from '../driver.js';
import { createActorGate } from './gates.js';
import { createInteractions } from './interactions.js';

function fakeDriver() {
  const calls: { op: string; args: unknown[] }[] = [];
  const rec =
    (op: string, ret?: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ op, args });
      return ret;
    };
  const d: ChatDriver = {
    capabilities: { reactions: false, privateReplies: 'fallback', threadRepliesNeedMention: true },
    post: rec('post', { conv: 'c', id: 'm1' }) as ChatDriver['post'],
    update: rec('update') as ChatDriver['update'],
    mark: rec('mark') as ChatDriver['mark'],
    permalink: rec('permalink') as ChatDriver['permalink'],
    reply: rec('reply') as ChatDriver['reply'],
    postPrivate: rec('postPrivate') as ChatDriver['postPrivate'],
    openDialog: rec('openDialog', { id: 'dlg1' }) as ChatDriver['openDialog'],
    updateDialog: rec('updateDialog') as ChatDriver['updateDialog'],
    refreshRating: rec('refreshRating') as ChatDriver['refreshRating'],
    publishHome: rec('publishHome') as ChatDriver['publishHome'],
    conversationName: rec('conversationName') as ChatDriver['conversationName'],
    openDirect: rec('openDirect') as ChatDriver['openDirect'],
    findConversation: rec('findConversation') as ChatDriver['findConversation'],
  };
  return { d, calls };
}

function setup() {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'aven-core-')), 'state.json'));
  const canceled: string[] = [];
  const questions = new Map<string, PendingQuestion>();
  const finalized: string[] = [];
  const engine = {
    cancel: (id: string) => canceled.push(id),
    recordFeedback: () => ({ good: 1, bad: 0 }),
    questions: {
      get: (q: string) => questions.get(q),
      isCompleted: () => false,
      answeredAll: (e: PendingQuestion) => e.questions.every((_, i) => (e.picks.get(i)?.size ?? 0) > 0),
      finalize: (e: PendingQuestion, q: string) => {
        e.done = true;
        finalized.push(q);
      },
    },
  } as unknown as TurnEngine;
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }], workspaces: { H: ['alpha'], C: ['alpha'] } } };
  const core = createInteractions({
    cfg: {} as Config,
    store,
    reg: reg as never,
    engine,
    homeTeamId: 'H',
    servedTenant: (t) => t === 'H' || t === 'C',
    actor: createActorGate(store, 'H'),
    prefixFor: () => 'aven-',
  });
  return { store, core, canceled, questions, finalized };
}

const click = (id: string, value: string, tenant = 'H', user = 'u1'): ChatAction => ({
  id,
  value,
  actor: { tenant, user },
  where: { conv: 'c' },
  msg: { conv: 'c', id: 'm1' },
  canDialog: true,
  ctx: undefined,
});

test('core: cancel by a cleared user aborts the turn and says nothing', async () => {
  const { core, canceled } = setup();
  const { d, calls } = fakeDriver();
  await core.actions.cancel_turn(click('cancel_turn', 't1-1'), d);
  assert.deepEqual(canceled, ['t1-1']);
  assert.deepEqual(calls, []);
});

test('core: a non-cleared user gets the denial privately and nothing happens', async () => {
  const { core, store, canceled } = setup();
  store.setTeamAccess('C', { mode: 'allowlist', users: [], admins: ['admin'] });
  const { d, calls } = fakeDriver();
  await core.actions.cancel_turn(click('cancel_turn', 't1-1', 'C'), d);
  assert.deepEqual(canceled, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'reply');
});

test('core: a rating records and refreshes the count; 👎 also opens the reason dialog', async () => {
  const { core } = setup();
  const { d, calls } = fakeDriver();
  const value = JSON.stringify({ t: 'tabc-1', s: 'alpha', k: 'thread:1.0' });
  await core.actions.fb_bad(click('fb_bad', value), d);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['openDialog', 'refreshRating'],
  );
});

test('core: a single-select answer resolves the question and shows the summary', async () => {
  const { core, questions, finalized } = setup();
  questions.set('q1', {
    questions: [{ question: 'DB?', options: [{ label: 'A' }, { label: 'B' }] }],
    picks: new Map(),
    multi: false,
    resolve: () => {},
    channel: 'c',
    ts: 'm9',
    done: false,
  });
  const { d, calls } = fakeDriver();
  await core.actions.answer_q(click('answer_q', JSON.stringify({ qid: 'q1', qi: 0, oi: 1 })), d);
  assert.deepEqual(finalized, ['q1']);
  assert.equal(calls[0].op, 'update');
  assert.deepEqual(calls[0].args[0], { conv: 'c', id: 'm9' });
  assert.equal((calls[0].args[1] as { done: boolean }).done, true);
});

test('core: the home surface lists only the viewer tenant\'s projects; unserved → onboarding', async () => {
  const { core } = setup();
  const { d, calls } = fakeDriver();
  await core.home({ tenant: 'H', user: 'u1' }, d);
  await core.home({ tenant: 'NOPE', user: 'u2' }, d);
  assert.equal((calls[0].args[1] as { kind: string }).kind, 'home');
  assert.equal((calls[1].args[1] as { kind: string }).kind, 'onboarding');
});
