// Golden payloads for the Slack driver's message views that the recorded scenarios can't
// reach without network (the autofix and YouTrack pollers read GitHub/YouTrack first): each
// view must produce EXACTLY the chat.postMessage payload the pollers used to build inline.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bolt from '@slack/bolt';
import { RecordingApi } from './twin.js';
import { slackDriver } from './driver.js';
import { autofixNotifyBlocks, shortRepo, ticketCardBlocks } from './blocks.js';
import type { PrWatch } from '../../state.js';
import type { YouTrackIssue } from '../../youtrack.js';

let api: RecordingApi;
let d: ReturnType<typeof slackDriver>;
before(async () => {
  api = new RecordingApi();
  const url = await api.start();
  d = slackDriver(new bolt.webApi.WebClient('xoxb-t', { slackApiUrl: url, retryConfig: { retries: 0 } }));
});
after(() => api.stop());

// What the old inline call sent, through the same client serialization.
async function oldPayload(args: Record<string, unknown>): Promise<unknown> {
  api.reset();
  await d.client.chat.postMessage(args as never);
  return api.calls[0].payload;
}
async function newPayload(run: () => Promise<unknown>): Promise<unknown> {
  api.reset();
  await run();
  return api.calls[0].payload;
}

const watch = { repo: 'Org/alpha', number: 7, slug: 'alpha', channel: 'C1', createdBy: 'U1', createdAt: '2026-10-15T00:00:00.000Z' } as PrWatch;
const ticket: YouTrackIssue = {
  id: 'SUP-12',
  summary: 'Checkout fails on Safari',
  description: 'Steps: open checkout, pay.',
  projectShortName: 'SUP',
  tags: ['aven'],
  createdAt: '2026-10-13T09:00:00.000Z',
  reporter: 'ann',
  fields: [{ name: 'Priority', value: 'Critical' }],
  links: [],
};

test('driver golden: autofix notice', async () => {
  const notes = ['CI failed (build)', 'new review from bob'];
  assert.deepEqual(
    await newPayload(() => d.post({ conv: 'C1' }, { kind: 'autofixNotice', watch, notes })),
    await oldPayload({ channel: 'C1', text: `${shortRepo(watch.repo)}#${watch.number}: ${notes.join('; ')}`, blocks: autofixNotifyBlocks(watch, notes) }),
  );
});

test('driver golden: autofix stopped-watching line', async () => {
  const text = `:checkered_flag: ${shortRepo(watch.repo)}#${watch.number} merged — stopped watching.`;
  assert.deepEqual(await newPayload(() => d.post({ conv: 'C1' }, { kind: 'text', text })), await oldPayload({ channel: 'C1', text }));
});

test('driver golden: routine empty-slot skip line', async () => {
  const text = '📊 Daily digest — ⏭ nothing new since 08:30';
  assert.deepEqual(await newPayload(() => d.post({ conv: 'C1' }, { kind: 'text', text })), await oldPayload({ channel: 'C1', text }));
});

for (const extras of ['', 'P1 · 2d old']) {
  test(`driver golden: ticket header (extras: ${JSON.stringify(extras)})`, async () => {
    const url = 'https://yt.example/issue/SUP-12';
    assert.deepEqual(
      await newPayload(() => d.post({ conv: 'C1' }, { kind: 'ticketHeader', ticket, url, extras })),
      await oldPayload({ channel: 'C1', text: `:ticket: <${url}|${ticket.id}> — ${ticket.summary}${extras ? `  ·  ${extras}` : ''}` }),
    );
  });
}

test('driver golden: ticket card in the thread', async () => {
  const url = 'https://yt.example/issue/SUP-12';
  assert.deepEqual(
    await newPayload(() =>
      d.post({ conv: 'C1', thread: '5.0' }, { kind: 'ticketCard', ticket, url, attachmentNames: ['shot.png'], flaggedBy: 'Ann' }),
    ),
    await oldPayload({ channel: 'C1', thread_ts: '5.0', text: `${ticket.id}: ${ticket.summary}`, blocks: ticketCardBlocks(ticket, url, ['shot.png'], 'Ann') }),
  );
});

test('driver golden: ops alert', async () => {
  const text = ':warning: CoachAven: sandbox disk at 91%';
  assert.deepEqual(await newPayload(() => d.post({ conv: 'C_ALERTS' }, { kind: 'text', text })), await oldPayload({ channel: 'C_ALERTS', text }));
});

test('driver golden: a headline rewrite changes only the text', async () => {
  api.reset();
  await d.update({ conv: 'C1', id: '9.9' }, { kind: 'line', text: '📊 Digest — shipped 3 PRs' });
  assert.deepEqual(api.calls[0].payload, { channel: 'C1', ts: '9.9', text: '📊 Digest — shipped 3 PRs' });
});
