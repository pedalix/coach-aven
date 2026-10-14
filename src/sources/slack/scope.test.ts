import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelKey, conversationKind, joinPlan, selectConversations } from './scope.js';
import type { RawConversation } from './normalise.js';

const CONVS: RawConversation[] = [
  { id: 'C0BBTB2RYM8', name: 'bluefin-aven-caldora', is_channel: true, is_ext_shared: true },
  { id: 'C0BBX082QNQ', name: 'bluefin-aven-bluefin-infra', is_channel: true },
  { id: 'G0INTERNAL1', name: 'pedalix-internal', is_group: true, is_private: true },
  { id: 'D0DMNICK01', is_im: true, user: 'U0NICK' },
  { id: 'G0MPIM0001', name: 'mpdm-owen--noel--vincent-1', is_mpim: true, is_private: true },
  { id: 'C0OLDARCHV', name: 'old-channel', is_channel: true, is_archived: true },
];
const ids = (xs: RawConversation[]) => xs.map((c) => c.id);

test('no scope keeps every conversation, in order, and reports scoped=false (today\'s behaviour)', () => {
  const r = selectConversations(CONVS, {});
  assert.deepEqual(ids(r.kept), ids(CONVS));
  assert.deepEqual(r.skipped, []);
  assert.equal(r.scoped, false);
});

test('channels: listed by name (with or without #, any case) or by id; DMs only by id; the rest is skipped', () => {
  const r = selectConversations(CONVS, { channels: ['#Bluefin-Aven-Caldora', 'c0bbx082qnq', 'D0DMNICK01'] });
  assert.deepEqual(ids(r.kept), ['C0BBTB2RYM8', 'C0BBX082QNQ', 'D0DMNICK01']);
  assert.deepEqual(ids(r.skipped), ['G0INTERNAL1', 'G0MPIM0001', 'C0OLDARCHV']);
  assert.equal(r.scoped, true);
  // a name that matches nothing keeps nothing — never "everything"
  assert.deepEqual(ids(selectConversations(CONVS, { channels: ['renamed-channel'] }).kept), []);
});

test('kinds: channel/group/im/mpim from the conversation flags; combined with channels it narrows further', () => {
  assert.deepEqual(CONVS.map(conversationKind), ['channel', 'channel', 'group', 'im', 'mpim', 'channel']);
  assert.deepEqual(ids(selectConversations(CONVS, { kinds: ['channel', 'group'] }).kept), ['C0BBTB2RYM8', 'C0BBX082QNQ', 'G0INTERNAL1', 'C0OLDARCHV']);
  assert.deepEqual(ids(selectConversations(CONVS, { kinds: ['im'] }).kept), ['D0DMNICK01']);
  // the DM is listed by id but its kind is not allowed
  assert.deepEqual(ids(selectConversations(CONVS, { channels: ['bluefin-aven-caldora', 'D0DMNICK01'], kinds: ['channel'] }).kept), ['C0BBTB2RYM8']);
});

test('channelKey strips the hash and case', () => {
  assert.equal(channelKey('#Bluefin-Aven-Caldora '), 'bluefin-aven-caldora');
  assert.equal(channelKey('C0BBTB2RYM8'), 'c0bbtb2rym8');
});

test('joinPlan — a bot joins listed public channels it is not in (and all of them with joinPublic); private ones need an invite; a user token joins nothing', () => {
  const member = CONVS.slice(0, 1); // in #bluefin-aven-caldora only
  const pub = [CONVS[0]!, CONVS[1]!, { id: 'C0GENERAL1', name: 'general', is_channel: true }];
  const u = joinPlan({ kind: 'user', memberships: member, publicChannels: pub, channels: ['bluefin-aven-bluefin-infra'] });
  assert.deepEqual(u, { join: [], unreadable: [] });
  const b = joinPlan({ kind: 'bot', memberships: member, publicChannels: pub, channels: ['#Bluefin-Aven-Bluefin-Infra', 'bluefin-aven-caldora', 'pedalix-internal', 'ghost-channel', 'C0OLDARCHV'] });
  assert.deepEqual(b.join.map((c) => c.id), ['C0BBX082QNQ'], 'listed, public, not a member → join; already a member → nothing');
  assert.deepEqual(b.unreadable, ['pedalix-internal (not found or private without an invite)', 'ghost-channel (not found or private without an invite)', 'C0OLDARCHV (not found or private without an invite)']);
  const priv = joinPlan({ kind: 'bot', memberships: member, publicChannels: [...pub, CONVS[2]!], channels: ['pedalix-internal'] });
  assert.deepEqual(priv.unreadable, ['pedalix-internal (private, not invited)']);
  const all = joinPlan({ kind: 'bot', memberships: member, publicChannels: pub, joinPublic: true, channels: ['bluefin-aven-bluefin-infra'] });
  assert.deepEqual(all.join.map((c) => c.id).sort(), ['C0BBX082QNQ', 'C0GENERAL1'], 'joinPublic adds every public channel once');
});

