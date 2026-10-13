import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession, CostDelta } from './claudeSession.js';
import type { SandboxHandle } from './driver.js';

// A fake sandbox driving the persistent-process protocol entirely in memory: `push`
// feeds a raw NDJSON event straight into ClaudeSession's stdout demux, the same way a
// real driver's streamSessionCommandLogs would deliver it.
// `log` is the stdout a reattach finds already written: sessionCommandLogs returns it and,
// like a real driver, the stream replays it before tailing new output.
function fakeSandbox(log = ''): { handle: SandboxHandle; push: (ev: unknown) => void } {
  let onStdout: ((chunk: string) => void) | undefined;
  const handle: SandboxHandle = {
    name: 'fake',
    started: true,
    exec: async () => ({ exitCode: 0, result: '' }),
    uploadFile: async () => {},
    createSession: async () => {},
    startSessionCommand: async () => ({ cmdId: 'cmd1' }),
    sessionCommandRunning: async () => true,
    sessionCommandLogs: async () => log,
    streamSessionCommandLogs: (_sessionKey, _cmdId, onStdoutCb) => {
      onStdout = onStdoutCb;
      if (log) onStdoutCb(log);
      return new Promise(() => {}); // never resolves — the fake process stays alive
    },
    sendSessionInput: async () => {},
    deleteSession: async () => {},
  };
  return { handle, push: (ev) => onStdout?.(JSON.stringify(ev) + '\n') };
}

async function openFake() {
  const { handle, push } = fakeSandbox();
  const session = new ClaudeSession(handle, { cwd: '/tmp' });
  await session.open();
  return { session, push };
}

test('ClaudeSession — a normal turn still resolves via settle, not onIdleResult', async () => {
  const { session, push } = await openFake();
  let idleCalls = 0;
  session.onIdleResult = () => idleCalls++;

  const turn = session.send('hello');
  push({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  push({ type: 'result', result: 'hi', is_error: false, session_id: 's1' });

  const r = await turn;
  assert.equal(r.status, 'ok');
  assert.equal(r.resultText, 'hi');
  assert.equal(idleCalls, 0);
});

test('ClaudeSession — a result with no pending turn fires onIdleResult (background task finished)', async () => {
  const { session, push } = await openFake();
  const seen: string[] = [];
  session.onIdleResult = (text) => seen.push(text);

  // No send() in flight — mirrors the CLI's spontaneous init/assistant/result sequence
  // emitted when a background Task/Agent completes after its owning turn already settled.
  push({ type: 'system', subtype: 'init', session_id: 's1' });
  push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Background agent finished.' }] } });
  push({ type: 'result', result: 'Background agent finished: output was `X`.', is_error: false, session_id: 's1' });

  await new Promise((r) => setImmediate(r)); // let the microtask queue drain
  assert.deepEqual(seen, ['Background agent finished: output was `X`.']);
});

test('ClaudeSession — every unsolicited result is metered via onIdleUsage, even empty/error ones', async () => {
  const { session, push } = await openFake();
  const usage: { costUsd?: number; isError: boolean; durationMs: number }[] = [];
  const texts: string[] = [];
  session.onIdleUsage = (u) => usage.push({ costUsd: u.usage?.costUsd, isError: u.isError, durationMs: u.durationMs });
  session.onIdleResult = (text) => texts.push(text);

  push({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0.42, duration_ms: 5000, session_id: 's1' });
  push({ type: 'result', result: '', is_error: true, total_cost_usd: 0.1, session_id: 's1' });
  await new Promise((r) => setImmediate(r));

  // Both cost money → both metered; only the clean one is worth a Slack post.
  assert.deepEqual(usage, [
    { costUsd: 0.42, isError: false, durationMs: 5000 },
    { costUsd: 0.1, isError: true, durationMs: 0 },
  ]);
  assert.deepEqual(texts, ['done']);
});

test('ClaudeSession — a settled turn is not double-metered via onIdleUsage', async () => {
  const { session, push } = await openFake();
  let idleUsage = 0;
  session.onIdleUsage = () => idleUsage++;
  const turn = session.send('hello');
  push({ type: 'result', result: 'hi', is_error: false, total_cost_usd: 1, session_id: 's1' });
  await turn;
  assert.equal(idleUsage, 0);
});

test('ClaudeSession — a result while a turn IS pending goes to settle, never onIdleResult', async () => {
  const { session, push } = await openFake();
  let idleCalls = 0;
  session.onIdleResult = () => idleCalls++;

  const turn = session.send('hello');
  push({ type: 'result', result: 'the real answer', is_error: false, session_id: 's1' });
  const r = await turn;

  assert.equal(r.resultText, 'the real answer');
  assert.equal(idleCalls, 0);
});

// --- per-turn cost: total_cost_usd is the process's running total, costUsd must be the delta

const ndjson = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('ClaudeSession — costUsd is the per-turn delta of the CLI running total; the raw total rides along', async () => {
  const { session, push } = await openFake();
  const idle: (number | undefined)[] = [];
  session.onIdleUsage = (u) => idle.push(u.usage?.costUsd);

  // One home-bot thread, as the CLI reported it: total_cost_usd 0.19 → 0.31 → 0.334 while
  // the per-turn tokens were 8 / 8 / 2 input. Recorded verbatim that summed to $0.83 for a
  // conversation that cost $0.334.
  const turn = async (ev: Record<string, unknown>) => {
    const t = session.send('x');
    push({ type: 'result', is_error: false, session_id: 's1', ...ev });
    return (await t).usage;
  };
  const u1 = await turn({ result: 'a', total_cost_usd: 0.19, usage: { input_tokens: 8, output_tokens: 2443 } });
  const u2 = await turn({ result: 'b', total_cost_usd: 0.31, usage: { input_tokens: 8, output_tokens: 3047 } });
  const u3 = await turn({ result: 'c', total_cost_usd: 0.334, usage: { input_tokens: 2, output_tokens: 573 } });
  const near = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  near(u1?.costUsd, 0.19);
  near(u2?.costUsd, 0.12);
  near(u3?.costUsd, 0.024);
  assert.deepEqual([u1?.costUsdCumulative, u2?.costUsdCumulative, u3?.costUsdCumulative], [0.19, 0.31, 0.334]);
  assert.equal(u3?.inputTokens, 2); // tokens are per turn on the wire — untouched

  // A canceled turn that never reached the model: zero tokens, and the CLI repeats the
  // running total. Pre-fix this was metered as another $0.334 — the proof of the bug.
  const ac = new AbortController();
  const canceled = session.send('y', undefined, ac.signal);
  ac.abort();
  push({ type: 'result', result: '', is_error: true, session_id: 's1', total_cost_usd: 0.334, usage: { input_tokens: 0, output_tokens: 0 } });
  const c = await canceled;
  assert.equal(c.status, 'canceled');
  near(c.usage?.costUsd, 0);
  assert.equal(c.usage?.costUsdCumulative, 0.334);

  // A background turn the CLI runs on its own is the same counter: metered as its delta, and
  // the next live turn is charged only for itself, not for the background work.
  push({ type: 'result', result: 'bg', is_error: false, session_id: 's1', total_cost_usd: 0.4 });
  await new Promise((r) => setImmediate(r));
  near(idle[0], 0.066);
  near((await turn({ result: 'd', total_cost_usd: 0.45 }))?.costUsd, 0.05);
});

test('CostDelta — a counter that runs backwards, or a new conversation id, restarts the baseline', () => {
  const costs = new CostDelta();
  assert.equal(costs.next(0.5, 's1'), 0.5);
  assert.ok(Math.abs(costs.next(0.8, 's1') - 0.3) < 1e-9);
  assert.equal(costs.next(0.1, 's1'), 0.1); // below the last reading → the process reset its counter; charge what it shows
  assert.equal(costs.next(0.7, 's2'), 0.7); // another conversation → another counter, even though 0.7 > 0.1
  assert.ok(Math.abs(costs.next(0.9) - 0.2) < 1e-9); // no id on the event → stays with the current counter
  assert.ok(Math.abs(costs.next(1.0, 's2') - 0.1) < 1e-9);
});

test('ClaudeSession — a reattach seeds the baseline from the replayed log, so the next turn is not charged the whole total', async () => {
  // The old bot drove two turns (totals 0.19, 0.31) and died; the claude process kept
  // running. The log the new bot finds ends on that second result.
  const log = ndjson([
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'result', result: 'a', is_error: false, session_id: 's1', total_cost_usd: 0.19 },
    { type: 'result', result: 'b', is_error: false, session_id: 's1', total_cost_usd: 0.31 },
  ]);
  const { handle, push } = fakeSandbox(log);
  const session = new ClaudeSession(handle, { cwd: '/tmp', resumeSessionId: 's1', attach: { sessionKey: 'k', cmdId: 'cmd1' } });
  await session.open();

  // The turn that completed during the downtime is handed back with ITS delta…
  const adopted = await session.adoptInflight();
  assert.equal(adopted.resultText, 'b');
  assert.ok(Math.abs((adopted.usage?.costUsd ?? -1) - 0.12) < 1e-9);
  assert.equal(adopted.usage?.costUsdCumulative, 0.31);

  // …and the first live turn after the reattach is charged only for itself.
  const turn = session.send('x');
  push({ type: 'result', result: 'c', is_error: false, session_id: 's1', total_cost_usd: 0.334 });
  const r = await turn;
  assert.ok(Math.abs((r.usage?.costUsd ?? -1) - 0.024) < 1e-9);
});
