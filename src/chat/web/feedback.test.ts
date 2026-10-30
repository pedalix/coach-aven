// Ratings on the web (web-chat-driver 3.2): the real interaction core over the web driver — 👎 writes the verdict
// on the click, re-renders the answer with the count, opens the reason dialog on the person's stream; the submitted
// reason is a second record; 👍 is a record and a count. One verdict per turn and person, as everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../config.js';
import { Store } from '../../state.js';
import type { TurnEngine } from '../../turn.js';
import type { FeedbackRecord } from '../../feedback.js';
import { createInteractions } from '../core/interactions.js';
import { createActorGate } from '../core/gates.js';
import type { ChatAction } from '../driver.js';
import { History } from './history.js';
import { webDriver, type UserPush } from './driver.js';

const ORG = 'corp.example';
const ROOM = 'room:alpha';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aven-web-fb-'));
  const store = new Store(join(dir, 'state.json'));
  const records: FeedbackRecord[] = [];
  const engine = {
    recordFeedback: (rec: FeedbackRecord) => {
      records.push(rec);
      const mine = records.filter((r) => r.turnId === rec.turnId);
      return { good: mine.filter((r) => r.verdict === 'good').length, bad: mine.filter((r) => r.verdict === 'bad').length };
    },
    trail: () => ({ steps: ['📖 Read'], elapsedMs: 1000, done: true }),
  } as unknown as TurnEngine;
  const history = new History(join(dir, 'web'));
  let seq = 0;
  const driver = webDriver({ history, baseUrl: 'https://chat.example', nameOf: () => undefined, ids: () => `m${++seq}` });
  const reg = { current: { projects: [{ slug: 'alpha', repos: ['Org/alpha'] }] } };
  const core = createInteractions({ cfg: {} as Config, store, reg: reg as never, engine, homeTeamId: ORG, servedTenant: (t) => t === ORG, actor: createActorGate(store, ORG), prefixFor: () => '' });
  const pushes: UserPush[] = [];
  driver.onUser('u1', (p) => pushes.push(p));
  return { store, history, driver, core, records, pushes };
}

const rate = JSON.stringify({ t: 't1-1', s: 'alpha', k: 'web:thread:r1' });
const click = (id: string, value: string, user = 'u1'): ChatAction => ({ id, value, actor: { tenant: ORG, user }, where: { conv: ROOM, thread: 'r1' }, msg: { conv: ROOM, id: 'm1', thread: 'r1' }, canDialog: true, ctx: { conv: ROOM, thread: 'r1', user } });

test('👎 records the verdict, re-renders the answer with the count and opens the reason dialog; the reason is a second record', async () => {
  const { history, driver, core, records, pushes } = setup();
  const conv = history.conversation(ROOM);
  conv.append({ t: 'post', id: 'r1', by: { id: 'u1', name: 'Ann' }, text: 'fix it' });
  await driver.post({ conv: ROOM, thread: 'r1' }, { kind: 'answer', markdown: 'Done.', opts: { rate: { turnId: 't1-1', slug: 'alpha', key: 'web:thread:r1' } } });
  await core.actions.fb_bad(click('fb_bad', rate), driver);
  assert.deepEqual(records.map((r) => [r.user, r.verdict, r.reason]), [['u1', 'bad', undefined]]);
  assert.deepEqual(conv.message('m1')!.tally, { good: 0, bad: 1 });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '👎 What went wrong?');
  assert.match(pushes[0].html, /data-dialog="feedback"/);
  const meta = driver.dialogOf(pushes[0].id)!.submit!.meta; // kept by the driver, never in the page
  await core.submits.feedback({ id: 'feedback', meta, values: { reason: 'missed', note: 'it rewrote the wrong file' }, actor: { tenant: ORG, user: 'u1' } }, driver);
  assert.deepEqual(records.map((r) => [r.verdict, r.reason, r.note]), [['bad', undefined, undefined], ['bad', 'missed', 'it rewrote the wrong file']]);
  // 👍 by another person: a record and the count on the same message.
  await core.actions.fb_good(click('fb_good', rate, 'u2'), driver);
  assert.deepEqual(conv.message('m1')!.tally, { good: 1, bad: 2 });
  assert.equal(records.length, 3);
});

test('🧭 Show steps opens the trail dialog on the clicker’s stream; a dialog for someone without a page waits for the page that opens next', async () => {
  const { driver, core, pushes } = setup();
  await core.actions.show_trail(click('show_trail', 't1-1'), driver);
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].html, /📖 Read/);
  await core.actions.show_trail(click('show_trail', 't1-1', 'u9'), driver);
  assert.equal(pushes.length, 1, 'nothing reached u1');
  // u9 opens a page a moment later: the dialog arrives there (a command's thread page opening after the command).
  const late: unknown[] = [];
  driver.onUser('u9', (p) => late.push(p));
  assert.equal(late.length, 1);
  // A second page of the same person gets it again (another tab); nothing older than the window.
  const again: unknown[] = [];
  driver.onUser('u9', (p) => again.push(p));
  assert.equal(again.length, 1);
});
