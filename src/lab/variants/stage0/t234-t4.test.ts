// Stage 0 T4: the kind and addressee rungs, pure. Fictional people and texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addresseeOf, containerKind, kindOf, openingName, type AddresseeInput, type KindInput } from './t234-t4.js';

const k = (o: Partial<KindInput>) => kindOf({ cls: 'human', human: true, cues: [], alert: null, smallTalk: false, ...o });

test('kind: integrations are noise unless they fire, report an error, ask, or relay somebody — those ask', () => {
  assert.deepEqual([k({ cls: 'bot', human: false, alert: { state: 'resolved', key: 'x' } }).label, k({ cls: 'bot', human: false, alert: { state: 'resolved', key: 'x' } }).conf], ['noise', 0.95]);
  const firing = k({ cls: 'bot', human: false, alert: { state: 'firing', key: 'x' }, cues: ['I'] });
  assert.deepEqual([firing.label, firing.rung, firing.candidates], [null, 'auto:firing', ['incident', 'noise']], 'incident or routine: the tenant decides');
  const err = k({ cls: 'bot', human: false, cues: ['I'] });
  assert.deepEqual([err.label, err.rung, err.candidates], [null, 'auto:incident?', ['incident']]);
  assert.equal(k({ cls: 'bot', human: false, cues: ['R'] }).label, null, 'a bot asking for something');
  assert.equal(k({ cls: 'bot', human: false, relay: true }).rung, 'auto:relay');
  assert.deepEqual([k({ cls: 'bot', human: false }).label, k({ cls: 'bot', human: false }).conf], ['noise', 0.9]);
  assert.deepEqual([k({ cls: 'bulk', human: false, cues: ['Q'] }).label, k({ cls: 'bulk', human: false }).conf], ['noise', 0.95]);
  assert.equal(k({ cls: 'bulk', human: false, cues: ['R'] }).rung, 'bulk:asks', 'cold outreach asks for something');
  assert.deepEqual([k({ cls: 'system', human: false }).label, k({ cls: 'system', human: false }).conf], ['noise', 0.85]);
  assert.equal(k({ cls: 'system', human: false, alert: { state: 'resolved', key: 'x' } }).conf, 0.85, 'a role mailbox saying "ok" is no monitor');
});

test('kind: a person’s small talk is noise .85; anything else abstains and carries its cues', () => {
  assert.deepEqual([k({ smallTalk: true }).label, k({ smallTalk: true }).conf, k({ smallTalk: true }).rung], ['noise', 0.85, 'smalltalk']);
  const q = k({ cues: ['Q', 'R'] });
  assert.equal(q.label, null);
  assert.deepEqual(q.cues, ['Q', 'R']);
  assert.equal(q.hint, 'cues QR');
});

test('containerKind: DMs, group chats, channels, mail, trackers, meetings', () => {
  assert.equal(containerKind('slack', 'dm:@lena', false, 'message'), 'dm');
  assert.equal(containerKind('msgraph', 'chat:@Lena Park', false, 'message'), 'dm');
  assert.equal(containerKind('slack', 'mpim:@lena+@omar', false, 'message'), 'group');
  assert.equal(containerKind('msgraph', 'chat:group:Launch', false, 'message'), 'group');
  assert.equal(containerKind('slack', '#general', false, 'message'), 'channel');
  assert.equal(containerKind('msgraph', 'chat:meeting:Weekly', false, 'message'), 'channel');
  assert.equal(containerKind('gmail', 'inbox', true, 'message'), 'mail');
  assert.equal(containerKind('youtrack', 'SH', false, 'comment'), 'tracker');
  assert.equal(containerKind('granola', null, false, 'meeting'), 'meeting');
});

const a = (o: Partial<AddresseeInput>) =>
  addresseeOf({ human: true, type: 'message', author: 'omar', subject: 'lena', where: 'channel', asks: false, mentions: [], members: [], assignee: null, vocative: null, parent: null, smallTalk: false, ...o });

test('addressee: integrations address nobody .95 — unless a machine mail asks the account owner to act', () => {
  assert.deepEqual([a({ human: false }).label, a({ human: false }).conf, a({ human: false }).rung], ['none', 0.95, 'auto:none']);
  const asks = a({ human: false, where: 'mail', asks: true });
  assert.deepEqual([asks.label, asks.rung, asks.candidates], [null, 'auto:asks', ['lena']]);
});

test('addressee: small talk → none; mentions (never the author); the DM counterpart; the mail’s first recipient', () => {
  assert.deepEqual([a({ smallTalk: true, mentions: [{ pid: 'lena', conf: 0.95 }] }).label, a({ smallTalk: true }).rung], ['none', 'smalltalk']);
  const m = a({ mentions: [{ pid: 'nina', conf: 0.95 }, { pid: 'lena', conf: 0.9 }, { pid: 'omar', conf: 0.95 }] });
  assert.deepEqual([m.label, m.conf, m.rung], ['lena|nina', 0.9, 'explicit:mention']);
  assert.deepEqual([a({ where: 'dm', members: ['lena', 'omar'] }).label, a({ where: 'dm', members: ['lena', 'omar'] }).conf], ['lena', 0.9]);
  assert.equal(a({ where: 'group', members: ['lena', 'omar', 'nina'] }).conf, 0.6, 'in a group chat the owner is a guess');
  assert.deepEqual([a({ where: 'dm', subject: null, members: ['nina', 'omar'] }).label], ['nina'], 'no subject: the counterpart');
  assert.deepEqual([a({ where: 'mail', members: ['lena', ''] }).label, a({ where: 'mail', members: ['lena', ''] }).rung], ['lena', 'explicit:to']);
  assert.equal(a({ where: 'mail', members: ['', 'lena'] }).rung, 'explicit:to?', 'after another recipient it may be Cc');
});

test('addressee: a ticket’s assignee, then a vocative, then the author the reply answers, then nobody', () => {
  assert.deepEqual([a({ type: 'task', where: 'tracker', assignee: 'nina' }).label, a({ type: 'task', where: 'tracker', assignee: 'nina' }).rung], ['nina', 'explicit:assignee']);
  assert.equal(a({ type: 'task', where: 'tracker', assignee: 'omar' }).label, 'none', 'assigned to its own author');
  assert.deepEqual([a({ vocative: { pid: 'nina', conf: 0.85 }, parent: 'lena' }).label, a({ vocative: { pid: 'nina', conf: 0.85 } }).rung], ['nina', 'vocative']);
  assert.equal(a({ vocative: { pid: 'nina', conf: 0.8 } }).rung, 'vocative~');
  assert.deepEqual([a({ parent: 'lena' }).label, a({ parent: 'lena' }).rung], ['lena', 'implicit']);
  assert.deepEqual([a({}).label, a({}).conf, a({}).rung], ['none', 0.7, 'none']);
});

test('openingName: the name a message opens with, after up to two greeting words; a surname after an honorific', () => {
  assert.deepEqual(openingName('Lena, can you check the import?'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Hi Lena — the import failed again'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Ciao Nina!'), { word: 'Nina', surname: false });
  assert.deepEqual(openingName('@omar Lena: please look'), { word: 'Lena', surname: false });
  assert.deepEqual(openingName('Guten Tag Frau Park, wann ist es fertig?'), { word: 'Park', surname: true });
  assert.equal(openingName('Lena said yesterday it works'), null, 'a name used as a subject is no vocative');
  assert.equal(openingName('the import failed'), null);
});
