// The normalizers over the recorded activities (src/fixtures/chat/teams/activities/, scrubbed
// from a real tenant): what the core receives for each shape Teams delivers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAction, normalizeMessage, normalizeSubmit, registerEvents, type InboundActivity, type TeamsAppLike } from './events.js';
import type { TeamsActionCtx } from './driver.js';
import type { ChatCommand, ChatMessage } from '../driver.js';

const DIR = new URL('../../fixtures/chat/teams/activities/', import.meta.url).pathname;
const load = (name: string): InboundActivity => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
const TENANT = '00000000-0000-4000-8000-00000000000a';
const CH = '19:CHANNEL1@thread.tacv2';

test('a channel mention starts a thread on its own id, text stripped of the mention', () => {
  const n = normalizeMessage(load('message-channel-mention'), TENANT);
  assert.equal(n.kind, 'mention');
  if (n.kind !== 'mention') return;
  assert.equal(n.msg.conv, CH);
  assert.equal(n.msg.thread, undefined);
  assert.equal(n.msg.text, 'hello');
  assert.equal(n.msg.direct, false);
  assert.deepEqual(n.msg.actor, { tenant: TENANT, user: '29:USER1' });
  assert.equal(n.msg.claim('mention'), true);
});

test('a person mentioned beside the bot reaches the core as <@id> (what `/users allow` parses)', () => {
  const raw = load('message-channel-mention');
  raw.text = '<at>Aven</at> /users allow <at>Example Admin</at>';
  raw.entities = [...(raw.entities ?? []), { type: 'mention', mentioned: { id: '29:USER2', name: 'Example Admin' }, text: '<at>Example Admin</at>' }];
  const n = normalizeMessage(raw, TENANT);
  assert.equal(n.kind, 'command');
  if (n.kind === 'command') assert.equal(n.cmd.text, 'users allow <@29:USER2>');
});

test('a channel reply without a mention continues its chain', () => {
  const a = load('message-channel-reply');
  const n = normalizeMessage(a, TENANT);
  assert.equal(n.kind, 'message');
  if (n.kind !== 'message') return;
  assert.equal(n.msg.conv, CH);
  assert.equal(n.msg.thread, a.conversation.id.split('messageid=')[1]);
  assert.notEqual(n.msg.thread, a.id);
});

test('a personal message is direct; `/verb` there is a command', () => {
  const m = normalizeMessage(load('message-personal'), TENANT);
  assert.equal(m.kind, 'message');
  // even with a mention entity attached (typing "@Aven" in the 1:1), it stays a direct message
  const raw = load('message-personal');
  raw.entities = [...(raw.entities ?? []), { type: 'mention', mentioned: { id: raw.recipient.id, name: 'Aven' }, text: '<at>Aven</at>' }];
  raw.text = `<at>Aven</at> ${raw.text ?? ''}`;
  const withMention = normalizeMessage(raw, TENANT);
  assert.equal(withMention.kind, 'message');
  if (withMention.kind === 'message') assert.equal(withMention.msg.direct, true);
  if (m.kind === 'message') {
    assert.equal(m.msg.direct, true);
    assert.equal(m.msg.thread, undefined);
    assert.equal(m.msg.conv, 'a:PERSONAL1');
  }
  const c = normalizeMessage(load('message-personal-command'), TENANT);
  assert.equal(c.kind, 'command');
  if (c.kind === 'command') {
    assert.equal(c.cmd.text, 'status');
    assert.equal(c.cmd.conv, 'a:PERSONAL1');
    assert.equal((c.cmd.ctx as TeamsActionCtx).direct, true);
  }
});

test('a `/verb` typed in a reply chain is a command too (a mention is not required there)', () => {
  const n = normalizeMessage(load('message-channel-command'), TENANT);
  assert.equal(n.kind, 'command');
  if (n.kind === 'command') assert.equal(n.cmd.text, 'status');
});

test('a card click carries the family, the value, where it happened and the card message', () => {
  const a = normalizeAction(load('invoke-card-action-channel'), TENANT);
  assert.ok(a);
  assert.equal(a.id, 'ping');
  assert.equal(a.value, '');
  assert.equal(a.where?.conv, CH);
  assert.ok(a.where?.thread);
  assert.equal(a.msg?.id, load('invoke-card-action-channel').replyToId);
  assert.equal(a.canDialog, false);
  const p = normalizeAction(load('invoke-card-action-personal'), TENANT);
  assert.equal(p?.where?.thread, undefined);
  assert.equal((p?.ctx as TeamsActionCtx).direct, true);
});

test('a dialog opener gets the deferred; a submit yields the form values', () => {
  // The probe's opener carried no `action` family — not ours to route.
  assert.equal(normalizeAction(load('invoke-task-fetch'), TENANT, () => {}), undefined);
  const fetch = load('invoke-task-fetch');
  (fetch.value as { data: Record<string, unknown> }).data.action = 'show_trail';
  (fetch.value as { data: Record<string, unknown> }).data.value = 't1';
  const b = normalizeAction(fetch, TENANT, () => {});
  assert.equal(b?.id, 'show_trail');
  assert.equal(b?.value, 't1');
  const submit = load('invoke-task-submit');
  (submit.value as { data: Record<string, unknown> }).data = { dialog: 'feedback', meta: 'm1', reason: 'wrong', note: 'x', msteams: {} };
  const s = normalizeSubmit(submit, TENANT);
  assert.deepEqual(s, { id: 'feedback', meta: 'm1', values: { reason: 'wrong', note: 'x' }, actor: { tenant: TENANT, user: '29:USER1' } });
});

test('the tenant gate drops a foreign tenant before any handler and logs it once', async () => {
  const routes = new Map<string, (ctx: { activity: InboundActivity; next: () => unknown }) => unknown>();
  const app: TeamsAppLike = { on: (route, h) => routes.set(route, h) };
  const seen: string[] = [];
  registerEvents(app, {
    tenantId: TENANT,
    driver: { remember: (m: { id: string }, thread: string | undefined) => seen.push(`remember:${m.id}:${thread ?? '-'}`) } as never,
    messages: { onMention: async (m: ChatMessage) => void seen.push(`mention:${m.text}`), onMessage: async (m: ChatMessage) => void seen.push(`message:${m.text}`) } as never,
    core: { actions: {}, submits: {}, home: async () => {}, parkDmPick: () => '' },
    commands: { run: async (c: ChatCommand) => void seen.push(`command:${c.text}`) } as never,
    onServiceUrl: (u) => seen.push(`url:${u}`),
    onPerson: (id, name, aad) => seen.push(`person:${id}:${name ?? '-'}:${aad ?? '-'}`),
  });
  const gate = routes.get('activity')!;
  let passed = 0;
  const foreign = { ...load('message-channel-mention'), conversation: { ...load('message-channel-mention').conversation, tenantId: 'other' } };
  await gate({ activity: foreign, next: () => void passed++ });
  await gate({ activity: foreign, next: () => void passed++ });
  assert.equal(passed, 0);
  await gate({ activity: load('message-channel-mention'), next: () => void passed++ });
  assert.equal(passed, 1);
  assert.ok(seen.some((s) => s.startsWith('url:https://')));
  // the sender is a known person now (name for mentions, Entra id for the operator list)
  const m0 = load('message-channel-mention');
  assert.deepEqual(seen.filter((s) => s.startsWith('person:')), [`person:${m0.from.id}:${m0.from.name}:${m0.from.aadObjectId}`]);
  await routes.get('message')!({ activity: load('message-channel-mention'), next: () => {} });
  await routes.get('message')!({ activity: load('message-personal-command'), next: () => {} });
  assert.deepEqual(seen.filter((s) => !s.startsWith('url:') && !s.startsWith('remember:') && !s.startsWith('person:')), ['mention:hello', 'command:status']);
  const mention = load('message-channel-mention');
  assert.deepEqual(seen.filter((s) => s.startsWith('remember:')), [`remember:${mention.id}:${mention.id}`]);
  // Teams re-delivers an activity it had to wait on: the same id again acts at most once.
  // (The mention core claims per kind at the moment it acts; a command claims up front.)
  await routes.get('message')!({ activity: load('message-personal-command'), next: () => {} });
  assert.deepEqual(seen.filter((s) => s.startsWith('command:')), ['command:status']);
});
