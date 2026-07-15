import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession } from './claudeSession.js';
import type { SandboxHandle } from './driver.js';

// A fake sandbox driving the persistent-process protocol entirely in memory: `push`
// feeds a raw NDJSON event straight into ClaudeSession's stdout demux, the same way a
// real driver's streamSessionCommandLogs would deliver it.
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
