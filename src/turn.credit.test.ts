// The subscription quota on a key installation (OpenSpec api-key-credit D5), over the real engine with a scripted
// session factory: a key installation connects no session to the quota tracker — a `rejected` rate-limit event
// raises no alert and leaves no `/aven status` line — while a token installation behaves as it always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from './config.js';
import { Store } from './state.js';
import { QueueJournal } from './queuejournal.js';
import { UsageLog } from './metering.js';
import { FeedbackLog } from './feedback.js';
import { DraftStore } from './drafts.js';
import type { ProjectConfig, RegistryRef } from './projects.js';
import type { openChat } from './tasks.js';
import { createTurnEngine } from './turn.js';
import { parseRateLimitEvent, statusQuotaLine, type RateLimitInfo } from './ratelimit.js';
import { setAlertSink } from './chat/slack/blocks.js';
import type { CreditKind } from './credit.js';

const ALPHA = { slug: 'alpha', repos: ['Org/alpha'] } as ProjectConfig;
const reg = { current: { projects: [ALPHA] } } as unknown as RegistryRef;
const REJECTED = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_900_000_000 } };

async function opened(kind: CreditKind | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'aven-credit-'));
  const cfg = { sandbox: { namePrefix: 'proj-', workDir: '/w', autoStopMinutes: 30 }, ...(kind ? { credit: { kind, value: 'sk-ant-test', source: 'ANTHROPIC_API_KEY' } } : {}) } as unknown as Config;
  let onRateLimit: ((i: RateLimitInfo) => void) | undefined;
  const open = (async (_c: unknown, _s: unknown, opts: { onRateLimit?: (i: RateLimitInfo) => void }) => {
    onRateLimit = opts.onRateLimit;
    return { close: async () => {} };
  }) as unknown as typeof openChat;
  const engine = createTurnEngine(cfg, new Store(join(dir, 'state.json')), reg, {
    openChat: open,
    journal: new QueueJournal(join(dir, 'queue.jsonl')),
    usageLog: new UsageLog(join(dir, 'usage')),
    feedbackLog: new FeedbackLog(join(dir, 'feedback')),
    drafts: new DraftStore(join(dir, 'drafts')),
  });
  await engine.sessionFor('thread:1700000000.000001', ALPHA);
  return { engine, onRateLimit };
}

test('a key installation: a rejected rate-limit event reaches no tracker — no alert, and /aven status shows no quota line', async () => {
  const alerts: string[] = [];
  setAlertSink((text) => void alerts.push(text));
  try {
    const { engine, onRateLimit } = await opened('api-key');
    assert.equal(onRateLimit, undefined, 'the session is not connected to the tracker');
    assert.equal(engine.quotaTracked?.(), false);
    assert.equal(statusQuotaLine(engine.quotaTracked?.() !== false, engine.claudeQuota()), undefined);
    assert.deepEqual(alerts, []);
  } finally {
    setAlertSink(() => {});
  }
});

test('a token installation (and an engine whose config predates the credit): the quota alert and the status line as before', async () => {
  for (const kind of ['subscription', undefined] as const) {
    const alerts: string[] = [];
    setAlertSink((text) => void alerts.push(text));
    try {
      const { engine, onRateLimit } = await opened(kind);
      assert.equal(engine.quotaTracked?.(), true);
      assert.equal(statusQuotaLine(true, undefined), 'Claude quota ❔ no turn seen yet');
      onRateLimit!(parseRateLimitEvent(REJECTED)!);
      assert.equal(alerts.length, 1, String(kind));
      assert.equal(engine.claudeQuota()?.status, 'rejected');
      assert.match(statusQuotaLine(engine.quotaTracked?.() !== false, engine.claudeQuota())!, /^Claude quota ⛔ exhausted \(5-hour window\)/);
    } finally {
      setAlertSink(() => {});
    }
  }
});
