import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SandboxHandle } from './driver.js';

// The two deadlines are module-load constants — set SHORT ones before importing the
// module (hence the dynamic import). `node --test` runs each test file in its own
// process, so this doesn't leak into other tests.
process.env.STREAM_MAX_MINUTES = '0.003'; // 180 ms soft deadline
process.env.STREAM_HARD_MAX_MINUTES = '0.008'; // 480 ms hard cap
const { ClaudeSession } = await import('./claudeSession.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same in-memory fake as claudeSession.test.ts: `push` feeds a raw NDJSON event into
// the session's stdout demux, like a real driver's streamSessionCommandLogs would.
function fakeSandbox(): { handle: SandboxHandle; push: (ev: unknown) => void } {
  let onStdout: ((chunk: string) => void) | undefined;
  const handle: SandboxHandle = {
    name: 'fake',
    started: true,
    exec: async () => ({ exitCode: 0, result: '' }),
    uploadFile: async () => {},
    createSession: async () => {},
    startSessionCommand: async () => ({ cmdId: 'cmd1' }),
    sessionCommandRunning: async () => true,
    sessionCommandLogs: async () => '',
    streamSessionCommandLogs: (_sessionKey, _cmdId, onStdoutCb) => {
      onStdout = onStdoutCb;
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

test('soft deadline — onLongRunning fires once, the turn survives and still settles ok', async () => {
  const { session, push } = await openFake();
  let notices = 0;
  const turn = session.send('long task', undefined, undefined, undefined, () => notices++);
  await sleep(300); // past the soft deadline, before the hard cap
  assert.equal(notices, 1); // notified…
  push({ type: 'result', result: 'done', is_error: false, session_id: 's1' });
  const r = await turn; // …but NOT killed: the late result still lands as the answer
  assert.equal(r.status, 'ok');
  assert.equal(r.resultText, 'done');
  assert.equal(session.isDead(), false); // session stays reusable
});

test('hard cap — a wired turn that never produces a result still dies, session retired', async () => {
  const { session } = await openFake();
  let notices = 0;
  const r = await session.send('hung', undefined, undefined, undefined, () => notices++);
  assert.equal(r.status, 'timeout');
  assert.equal(notices, 1);
  assert.equal(session.isDead(), true);
});

test('no onLongRunning — the old kill-at-soft-deadline behavior is preserved', async () => {
  const { session } = await openFake();
  const t0 = Date.now();
  const r = await session.send('hung');
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - t0 < 400, 'must die at the soft deadline, not wait for the hard cap');
  assert.equal(session.isDead(), true);
});
