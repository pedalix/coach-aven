import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionSig, cardKeyOf, dialogSig, signActivity, signCard, verifyAction, verifyDialog } from './cardsig.js';
import { normalizeAction, normalizeSubmit, type InboundActivity } from './events.js';
import { renderDialogView, renderMessageView } from './cards.js';

const KEY = cardKeyOf('app-secret-for-tests');
const TENANT = 'tenant-1';
const DIR = new URL('../../fixtures/chat/teams/activities/', import.meta.url).pathname;
const load = (name: string): InboundActivity => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
const dataOf = (a: InboundActivity) => (a.value as { action?: { data: Record<string, unknown> }; data?: Record<string, unknown> });

test('signCard: every button carries the signature of its action and value; a dialog form is bound to its person; nothing else changes', () => {
  const card = {
    type: 'AdaptiveCard',
    body: [{ type: 'ActionSet', actions: [{ type: 'Action.Execute', title: 'Cancel', data: { action: 'cancel_turn', value: 't1-2' } }] }],
    actions: [
      { type: 'Action.Submit', title: 'Steps', data: { msteams: { type: 'task/fetch' }, action: 'show_trail', value: 't1-2' } },
      { type: 'Action.Submit', title: 'Send', data: { dialog: 'feedback', meta: '{"t":"t1-2"}' } },
      { type: 'Action.OpenUrl', url: 'https://github.example/pr/1' },
    ],
  };
  const out = signCard(KEY, card, '29:ann');
  assert.equal((out.body[0]!.actions[0]!.data as Record<string, unknown>).sig, actionSig(KEY, 'cancel_turn', 't1-2'));
  assert.equal((out.actions[0]!.data as Record<string, unknown>).sig, actionSig(KEY, 'show_trail', 't1-2'));
  assert.equal((out.actions[1]!.data as Record<string, unknown>).msig, dialogSig(KEY, 'feedback', '{"t":"t1-2"}', '29:ann'));
  assert.deepEqual(out.actions[2], card.actions[2]);
  assert.equal('sig' in card.actions[0]!.data!, false, 'the input is not mutated');
  // No person: a dialog form is left unsigned (it can only come back through a dialog opened for someone).
  assert.equal('msig' in (signCard(KEY, card).actions[1]!.data as object), false);
});

test('verifyAction / verifyDialog: the issued pair passes; another value, action, person or key does not', () => {
  const sig = actionSig(KEY, 'cancel_turn', 't1-2');
  assert.ok(verifyAction(KEY, { action: 'cancel_turn', value: 't1-2', sig }));
  assert.ok(!verifyAction(KEY, { action: 'cancel_turn', value: 't1-3', sig }), 'an enumerated turn id');
  assert.ok(!verifyAction(KEY, { action: 'session_restart', value: 't1-2', sig }));
  assert.ok(!verifyAction(cardKeyOf('another-secret'), { action: 'cancel_turn', value: 't1-2', sig }));
  assert.ok(!verifyAction(KEY, { action: 'cancel_turn', value: 't1-2' }));
  const msig = dialogSig(KEY, 'yt_prompt', '{"key":"teams:a"}', '29:ann');
  assert.ok(verifyDialog(KEY, { dialog: 'yt_prompt', meta: '{"key":"teams:a"}', msig }, '29:ann'));
  assert.ok(!verifyDialog(KEY, { dialog: 'yt_prompt', meta: '{"key":"teams:a"}', msig }, '29:bo'), 'someone else’s dialog');
  assert.ok(!verifyDialog(KEY, { dialog: 'yt_prompt', meta: '{"key":"teams:victim"}', msig }, '29:ann'), 'metadata of their choosing');
});

test('signActivity: only Adaptive Card attachments are signed; an activity without one is returned as is', () => {
  const plain = { type: 'message', text: 'hi' };
  assert.equal(signActivity(KEY, plain), plain);
  const card = renderMessageView({ kind: 'status', line: 'Working…', turnId: 't9-1', notify: 'Working…' } as never);
  const act = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: (card as { card?: unknown }).card ?? card }] };
  const out = JSON.stringify(signActivity(KEY, act));
  assert.match(out, /"sig":"/, 'the status card’s controls are signed');
});

test('with the key, an invoke is taken only with the signature the bot put on the control', () => {
  const click = load('invoke-card-action-channel');
  assert.equal(normalizeAction(click, TENANT, undefined, KEY), undefined, 'the recorded click carries no signature');
  dataOf(click).action!.data.sig = actionSig(KEY, 'ping', '');
  assert.equal(normalizeAction(click, TENANT, undefined, KEY)?.id, 'ping');
  dataOf(click).action!.data.value = 'someone-else';
  assert.equal(normalizeAction(click, TENANT, undefined, KEY), undefined, 'a value the bot never rendered');

  const submit = load('invoke-task-submit');
  const user = (submit as { from: { id: string } }).from.id;
  dataOf(submit).data = { dialog: 'feedback', meta: 'm1', reason: 'wrong', msteams: {}, msig: dialogSig(KEY, 'feedback', 'm1', user) };
  assert.deepEqual(normalizeSubmit(submit, TENANT, KEY)?.values, { reason: 'wrong' }, 'the routing fields and the signature are not form values');
  dataOf(submit).data = { dialog: 'feedback', meta: 'forged', reason: 'wrong', msig: dialogSig(KEY, 'feedback', 'm1', user) };
  assert.equal(normalizeSubmit(submit, TENANT, KEY), undefined);
});

test('a dialog as the bot renders it, signed for its person, submits; for anyone else it does not', () => {
  const d = renderDialogView({ kind: 'feedback', meta: { turnId: 't1', slug: 'alpha', key: 'teams:thread:r1', channel: '19:c' } } as never);
  const signed = JSON.stringify(signCard(KEY, d.card, '29:ann'));
  const form = (JSON.parse(signed) as { actions: { data: Record<string, unknown> }[] }).actions.find((x) => x.data?.dialog)!.data;
  const submit = load('invoke-task-submit');
  (submit as { from: { id: string } }).from.id = '29:ann';
  dataOf(submit).data = { ...form, reason: 'wrong' };
  assert.equal(normalizeSubmit(submit, TENANT, KEY)?.id, 'feedback');
  (submit as { from: { id: string } }).from.id = '29:bo';
  assert.equal(normalizeSubmit(submit, TENANT, KEY), undefined);
});
