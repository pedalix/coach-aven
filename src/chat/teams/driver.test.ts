// The Teams driver against a recording API seam: what the Connector receives for each
// ChatDriver call, the edit coalescing under a fake clock, the private-reply routing and the
// dialog deferred.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { teamsDriver, type OutActivity, type TeamsApi, type TeamsActionCtx } from './driver.js';
import type { ChatAction } from '../driver.js';

const SNAP = new URL('../../fixtures/chat/teams/calls.json', import.meta.url).pathname;
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const CH = '19:CHANNEL1@thread.tacv2';
const TENANT = '00000000-0000-4000-8000-00000000000a';

class Recorder implements TeamsApi {
  calls: { op: string; conv: string; id?: string; activity?: OutActivity }[] = [];
  seq = 0;
  personal: string | undefined = 'a:PERSONAL1';
  async send(conv: string, activity: OutActivity) {
    this.calls.push({ op: 'send', conv, activity });
    return { id: `m${++this.seq}` };
  }
  async update(conv: string, id: string, activity: OutActivity) {
    // The Connector's rule, learnt on the real tenant: an edit may carry text or a card, not both.
    if (activity.text !== undefined && activity.attachments?.length) {
      const err = new Error('Request failed with status code 400') as Error & { response?: unknown };
      err.response = { status: 400, data: { error: { code: 'BadSyntax', message: 'Activity resulted into multiple skype activities' } } };
      throw err;
    }
    this.calls.push({ op: 'update', conv, id, activity });
  }
  async openPersonal(user: string) {
    this.calls.push({ op: 'openPersonal', conv: user });
    return this.personal;
  }
  async react(conv: string, id: string, type: string, op: 'add' | 'remove') {
    this.calls.push({ op: `react:${op}:${type}`, conv, id });
  }
}

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

test('an answer that replaces the status card edits the text in place and posts the buttons after it', async () => {
  const api = new Recorder();
  const d = teamsDriver(api, { tenantId: TENANT });
  const status = await d.post({ conv: CH, thread: '100' }, { kind: 'status', line: 'working', turnId: 't1', notify: 'w' });
  await d.update(status, { kind: 'answer', markdown: 'Done, see https://github.com/Org/alpha/pull/7', opts: { trail: { turnId: 't1', steps: 3, elapsedMs: 1 } } });
  assert.deepEqual(
    api.calls.slice(1).map((c) => [c.op, c.activity!.text !== undefined, !!c.activity!.attachments]),
    [
      ['update', true, false],
      ['send', false, true],
    ],
  );
  assert.equal(api.calls[2].conv, `${CH};messageid=100`);
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
