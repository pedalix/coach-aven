// The Teams driver against a recording API seam: what the Connector receives for each
// ChatDriver call, the edit coalescing under a fake clock, the private-reply routing and the
// dialog deferred.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { teamsDriver, type TeamsActionCtx } from './driver.js';
import { Recorder } from './twin.js';
import type { ChatAction } from '../driver.js';

const SNAP = new URL('../../fixtures/chat/teams/calls.json', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const CH = '19:CHANNEL1@thread.tacv2';
const TENANT = '00000000-0000-4000-8000-00000000000a';

function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimeout: ((fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ id, at: t + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearTimeout,
    async advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers.splice(0, timers.length, ...timers.filter((x) => x.at > t));
      for (const d of due) d.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

test('the recorded calls of one thread turn match the snapshot', async () => {
  const api = new Recorder();
  const clock = fakeClock();
  const d = teamsDriver(api, { tenantId: TENANT, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const where = { conv: CH, thread: '100' };
  d.remember({ conv: CH, id: '100' }, '100'); // the mention that started the chain (events.ts)
  await d.mark({ conv: CH, id: '100' }, 'working', 'add'); // 👀 on the person's message, in its chain
  await d.mark({ conv: 'a:PERSONAL1', id: '7' }, 'working', 'add'); // 1:1: addressed by the conversation alone
  const status = await d.post(where, { kind: 'status', line: '*Working* — 0:01', turnId: 't1', notify: 'Working…' });
  assert.deepEqual(status, { conv: CH, id: 'm1' }); // reactions are not sends: the status is the first message
  await d.update(status, { kind: 'status', line: '*Working* — 0:02', turnId: 't1', notify: 'Working…' }); // first edit lands at once
  await d.update(status, { kind: 'text', text: '🚫 Canceled' }); // urgent: lands at once
  await d.post(where, { kind: 'answer', markdown: 'Done — see https://github.com/Org/alpha/pull/7', opts: { trail: { turnId: 't1', steps: 3, elapsedMs: 5000 } } });
  const link = await d.permalink({ conv: CH, id: '100' });
  assert.ok(link?.startsWith('https://teams.microsoft.com/l/message/'));
  await d.mark({ conv: CH, id: '100' }, 'working', 'remove');
  await d.mark({ conv: CH, id: '100' }, 'done', 'add');
  if (UPDATE || !existsSync(SNAP)) writeFileSync(SNAP, JSON.stringify(api.calls, null, 2) + '\n');
  assert.deepEqual(api.calls, JSON.parse(readFileSync(SNAP, 'utf8')));
});

test('status edits coalesce to one per window and the final one always lands', async () => {
  const api = new Recorder();
  const clock = fakeClock();
  const d = teamsDriver(api, { tenantId: TENANT, statusMinMs: 2000, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const status = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: 's0', turnId: 't1', notify: 's0' });
  const pending: Promise<void>[] = [];
  for (let i = 1; i <= 50; i++) {
    pending.push(d.update(status, { kind: 'status', line: `s${i}`, turnId: 't1', notify: `s${i}` }));
    await clock.advance(20); // 50 updates over one second
  }
  await clock.advance(2000);
  await Promise.all(pending);
  const edits = api.calls.filter((c) => c.op === 'update');
  assert.ok(edits.length <= 2, `expected ≤ 2 edits, got ${edits.length}`);
  const last = edits.at(-1)!.activity!.attachments![0].content.body[0] as { text: string };
  assert.equal(last.text, 's50');
});

test('an answer never edits the status card: the card becomes a receipt, the answer lands after it as text then card', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const status = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: 'working', turnId: 't1', notify: 'w' });
  await d.update(status, { kind: 'answer', markdown: 'Done, see https://github.com/Org/alpha/pull/7', opts: { trail: { turnId: 't1', steps: 3, elapsedMs: 1 } } });
  assert.deepEqual(
    api.calls.slice(1).map((c) => [c.op, c.id, c.activity!.text, !!c.activity!.attachments]),
    [
      ['update', 'm1', '✅ Done — answer below', false],
      ['send', undefined, 'Done, see https://github.com/Org/alpha/pull/7', false],
      ['send', undefined, undefined, true],
    ],
  );
  assert.ok(api.calls.slice(1).every((c) => c.conv === `${CH};messageid=100`));
  // A text-only answer (no buttons to offer) takes the same route, so the answer is always the
  // newest message of its chain.
  api.calls = [];
  const s2 = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: 'working', turnId: 't2', notify: 'w' });
  await d.update(s2, { kind: 'answer', markdown: 'Nothing to do.' });
  assert.deepEqual(api.calls.slice(1).map((c) => [c.op, c.activity!.text]), [
    ['update', '✅ Done — answer below'],
    ['send', 'Nothing to do.'],
  ]);
});

test('a long answer is split into text messages, then the card as its own message; the reference is the first text', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const ref = await d.post({ conv: CH, thread: '100' }, { kind: 'answer', markdown: 'x'.repeat(30_000), opts: { trail: { turnId: 't1', steps: 2, elapsedMs: 1 } } });
  const sends = api.calls.filter((c) => c.op === 'send');
  assert.equal(sends.length, 3);
  assert.equal(ref.id, 'm1');
  assert.deepEqual(
    sends.map((s) => [s.activity!.text !== undefined, !!s.activity!.attachments]),
    [
      [true, false],
      [true, false],
      [false, true],
    ],
  );
  assert.equal(sends.slice(0, 2).map((s) => s.activity!.text).join(''), 'x'.repeat(30_000));
});

test('private replies go to the 1:1 chat with a pointer, or stay in place when already there', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const inChannel: TeamsActionCtx = { conv: CH, thread: '100', user: '29:USER1', direct: false };
  await d.reply({ ctx: inChannel }, { kind: 'text', text: 'status: fine' });
  assert.deepEqual(
    api.calls.map((c) => [c.op, c.conv]),
    [
      ['openPersonal', '29:USER1'],
      ['send', 'a:PERSONAL1'],
      ['send', `${CH};messageid=100`],
    ],
  );
  api.calls = [];
  const inPersonal: TeamsActionCtx = { conv: 'a:PERSONAL1', user: '29:USER1', direct: true };
  await d.reply({ ctx: inPersonal }, { kind: 'text', text: 'status: fine' });
  assert.deepEqual(api.calls.map((c) => [c.op, c.conv]), [['send', 'a:PERSONAL1']]);
  api.calls = [];
  api.personal = undefined; // the platform refuses the 1:1 → visible in place beats lost
  await d.postPrivate({ conv: CH, thread: '100' }, '29:USER1', { kind: 'text', text: 'denied' });
  assert.deepEqual(api.calls.map((c) => [c.op, c.conv]), [
    ['openPersonal', '29:USER1'],
    ['send', `${CH};messageid=100`],
  ]);
});

test('with targeted messages on, a private reply stays in the channel for that person only; a refusal falls back to the 1:1', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT, targeted: true });
  const inChannel: TeamsActionCtx = { conv: CH, thread: '100', user: '29:USER1', direct: false };
  await d.reply({ ctx: inChannel }, { kind: 'text', text: 'status: fine' });
  assert.deepEqual(
    api.calls.map((c) => [c.op, c.conv, c.activity?.recipient]),
    [['sendTargeted', `${CH};messageid=100`, { id: '29:USER1', isTargeted: true }]],
  );
  api.calls = [];
  api.targetedFails = true;
  await d.reply({ ctx: inChannel }, { kind: 'text', text: 'status: fine' });
  assert.deepEqual(
    api.calls.map((c) => [c.op, c.conv]),
    [
      ['sendTargeted', `${CH};messageid=100`],
      ['openPersonal', '29:USER1'],
      ['send', 'a:PERSONAL1'],
      ['send', `${CH};messageid=100`],
    ],
  );
  // in a 1:1 there is nothing to target: in place, as before
  api.calls = [];
  await d.reply({ ctx: { conv: 'a:PERSONAL1', user: '29:USER1', direct: true } }, { kind: 'text', text: 'hi' });
  assert.deepEqual(api.calls.map((c) => c.op), ['send']);
});

test('`<@id>` renders as a Teams mention once the person’s name is known, a plain @id before', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  await d.post({ conv: CH, thread: '100' }, { kind: 'text', text: 'Admins: <@29:USER2>' });
  const sends = () => api.calls.filter((c) => c.op === 'send');
  assert.equal(sends()[0].activity!.text, 'Admins: @29:USER2'); // the roster did not know them either
  assert.equal(sends()[0].activity!.entities, undefined);
  d.knowPerson('29:USER2', 'Example Admin');
  await d.post({ conv: CH, thread: '100' }, { kind: 'text', text: 'Admins: <@29:USER2>, <@29:USER9>' });
  assert.equal(sends()[1].activity!.text, 'Admins: <at>Example Admin</at>, @29:USER9');
  assert.deepEqual(sends()[1].activity!.entities, [{ type: 'mention', mentioned: { id: '29:USER2', name: 'Example Admin' }, text: '<at>Example Admin</at>' }]);
  // one roster lookup per unknown person, never repeated
  assert.deepEqual(api.calls.filter((c) => c.op === 'memberName').map((c) => c.id), ['29:USER2', '29:USER9']);
});

test('openDialog resolves the click’s deferred with the rendered dialog, and is a no-op without one', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  let got: { title: string } | undefined;
  const ctx: TeamsActionCtx = { conv: CH, thread: '100', user: '29:USER1', direct: false, dialog: (x) => (got = x) };
  const action = { id: 'show_trail', value: 't1', actor: { user: '29:USER1' }, canDialog: true, ctx } as ChatAction;
  const ref = await d.openDialog(action, { kind: 'trail', trail: { steps: ['a'], elapsedMs: 1, done: true } });
  assert.deepEqual(ref, { id: 'dialog' });
  assert.equal(got?.title, '🧭 Steps');
  const plain = { ...action, canDialog: false, ctx: { ...ctx, dialog: undefined } } as ChatAction;
  assert.equal(await d.openDialog(plain, { kind: 'trail', trail: undefined }), undefined);
  assert.equal(api.calls.length, 0);
});

test('a loading dialog is held for its data: updateDialog answers the click; the hold expiring shows the placeholder', async () => {
  const api = new Recorder();
  const clock = fakeClock();
  const d = teamsDriver(api, { tenantId: TENANT, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const shown: { title: string }[] = [];
  const ctx: TeamsActionCtx = { conv: CH, thread: '100', user: '29:USER1', direct: false, dialog: (x) => shown.push(x) };
  const click = { id: 'ticket_modal', value: 'SUP-1', actor: { user: '29:USER1' }, canDialog: true, ctx } as ChatAction;
  const ref = await d.openDialog(click, { kind: 'ticketLoading', id: 'SUP-1' });
  assert.equal(shown.length, 0); // nothing answered yet — the data is on its way
  await d.updateDialog(ref!, { kind: 'ticketUnavailable', id: 'SUP-1', url: 'https://yt.example/issue/SUP-1' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'SUP-1');
  await clock.advance(5000);
  assert.equal(shown.length, 1); // the expired hold does not show the placeholder on top
  // the slow path: no data within the hold → the placeholder, and a late update is ignored
  const ref2 = await d.openDialog(click, { kind: 'ticketLoading', id: 'SUP-2' });
  await clock.advance(4000);
  assert.equal(shown.length, 2);
  await d.updateDialog(ref2!, { kind: 'ticketUnavailable', id: 'SUP-2', url: 'https://yt.example/issue/SUP-2' });
  assert.equal(shown.length, 2);
});

test('the home card goes to the person’s 1:1 chat', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  await d.publishHome('29:USER1', { kind: 'onboarding' });
  assert.deepEqual(api.calls.map((c) => [c.op, c.conv]), [
    ['openPersonal', '29:USER1'],
    ['send', 'a:PERSONAL1'],
  ]);
});

test('a queued turn gets no placeholder card: the status is pending until its first update materialises it', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const ref = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: '⏳ In queue', turnId: 't2', notify: 'In queue…', queued: true });
  assert.match(ref.id, /^pending:/);
  assert.equal(api.calls.length, 0);
  await d.update(ref, { kind: 'status', line: '🛠 Preparing…', turnId: 't2', notify: 'Working…' });
  assert.deepEqual(api.calls.map((c) => c.op), ['send']);
  await d.update(ref, { kind: 'text', text: 'Done.' });
  assert.deepEqual(api.calls.map((c) => [c.op, c.id]), [
    ['send', undefined],
    ['update', 'm1'],
  ]);
  await d.mark({ conv: CH, id: '101' }, 'working', 'add'); // the person's queued message still gets 👀
  assert.equal(api.calls.at(-1)!.op, 'react:add:1f440_eyes');
});

test('a rating click re-renders the answer card with the tally', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const rate = { turnId: 't1', slug: 'alpha', key: 'thread:100' };
  const followUp = { key: 'thread:100', channel: CH, threadTs: '100' };
  const status = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: 'w', turnId: 't1', notify: 'w' });
  await d.update(status, { kind: 'answer', markdown: 'Done.', opts: { followUp, rate, trail: { turnId: 't1', steps: 2, elapsedMs: 1 } } });
  const cardMsg = api.calls.at(-1)!;
  assert.equal(cardMsg.op, 'send');
  const cardId = `m${api.seq}`;
  const click = { id: 'fb_good', value: JSON.stringify({ t: 't1', s: 'alpha', k: 'thread:100' }), actor: { user: '29:USER1' }, where: { conv: CH, thread: '100' }, msg: { conv: CH, id: cardId, thread: '100' }, canDialog: false, ctx: { conv: CH, thread: '100', direct: false } } as ChatAction;
  await d.refreshRating(click, { good: 2, bad: 0 });
  const edit = api.calls.at(-1)!;
  assert.equal(edit.op, 'update');
  assert.equal(edit.id, cardId);
  const titles = (edit.activity!.attachments![0].content.actions as { title: string }[]).map((a) => a.title);
  assert.deepEqual(titles, ['🧭 Show steps', '⚙️ Session', '👍 Helped · 2', '👎 Missed']);
});

test('a status ref rebuilt after a restart carries its chain: the recovered answer lands in the thread, not at the channel root', async () => {
  // The engine's inflight record (channel, statusTs, msgThreadTs) is all a fresh process has;
  // the canary 2026-10-18 saw the recovered answer posted at the root for want of the chain.
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  await d.update({ conv: CH, id: 'm1', thread: '100' }, { kind: 'text', text: '🔄 Reconnected after a restart — recovering this turn…' });
  await d.update({ conv: CH, id: 'm1', thread: '100' }, { kind: 'answer', markdown: 'Recovered: typecheck passes.' });
  assert.deepEqual(
    api.calls.map((c) => [c.op, c.conv, c.id, c.activity!.text]),
    [
      ['update', `${CH};messageid=100`, 'm1', '🔄 Reconnected after a restart — recovering this turn…'],
      ['update', `${CH};messageid=100`, 'm1', '✅ Done — answer below'],
      ['send', `${CH};messageid=100`, undefined, 'Recovered: typecheck passes.'],
    ],
  );
  // What the driver saw posted wins over the hint (a top-level status edited later with a stale ref).
  api.calls = [];
  const top = await d.post({ conv: CH }, { kind: 'status', line: 'working', turnId: 't9', notify: 'w' });
  await d.update({ ...top, thread: '100' }, { kind: 'text', text: 'still at the root' });
  assert.deepEqual(api.calls.slice(1).map((c) => [c.op, c.conv]), [['update', CH]]);
});

test('private replies in the 1:1 fallback: `replace` edits the last message and posts the thread pointer once', async () => {
  // `/status` says "Gathering…" then replaces it with the report; the canary (2026-10-18) showed
  // two pointers in the thread and two messages in the 1:1 for one command.
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const cmd = { ctx: { conv: CH, thread: '100', user: '29:USER1', direct: false } };
  await d.reply(cmd, { kind: 'text', text: '📊 Gathering status…' });
  await d.reply(cmd, { kind: 'text', text: 'the report' }, { replace: true });
  assert.deepEqual(
    api.calls.map((c) => [c.op, c.conv, c.activity?.text]),
    [
      ['openPersonal', '29:USER1', undefined],
      ['send', 'a:PERSONAL1', '📊 Gathering status…'],
      ['send', `${CH};messageid=100`, '↗ _Answered you privately — see our 1:1 chat._'],
      ['openPersonal', '29:USER1', undefined],
      ['update', 'a:PERSONAL1', 'the report'],
    ],
  );
  // A later, non-replacing reply is a new exchange: a new message and a new pointer.
  api.calls = [];
  await d.reply(cmd, { kind: 'text', text: 'something else' });
  assert.deepEqual(api.calls.map((c) => c.op), ['openPersonal', 'send', 'send']);
});

test('private replies as targeted messages: `replace` sends anew (a targeted message cannot be edited)', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT, targeted: true });
  const cmd = { ctx: { conv: CH, thread: '100', user: '29:USER1', direct: false } };
  await d.reply(cmd, { kind: 'text', text: 'first' });
  await d.reply(cmd, { kind: 'text', text: 'second' }, { replace: true });
  assert.deepEqual(api.calls.map((c) => [c.op, c.activity?.text]), [['sendTargeted', 'first'], ['sendTargeted', 'second']]);
});
