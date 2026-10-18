import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession, CostDelta, claudeLaunch, type InjectOutcome } from './claudeSession.js';
import { PROBED_CLI_VERSIONS } from './cliversion.js';
import { mcpServer } from './hosttools.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
import type { SandboxHandle } from './driver.js';
import { ATTRIBUTION_SETTINGS, GIT_EMAIL, GIT_NAME, gitIdentityEnv } from './gitidentity.js';

// A fake sandbox driving the persistent-process protocol entirely in memory: `push`
// feeds a raw NDJSON event straight into ClaudeSession's stdout demux, the same way a
// real driver's streamSessionCommandLogs would deliver it.
// `log` is the stdout a reattach finds already written: sessionCommandLogs returns it and,
// like a real driver, the stream replays it before tailing new output.
function fakeSandbox(log = ''): { handle: SandboxHandle; push: (ev: unknown) => void; writes: unknown[] } {
  let onStdout: ((chunk: string) => void) | undefined;
  const writes: unknown[] = []; // every line the session wrote to the process's stdin, parsed
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
    sendSessionInput: async (_k, _c, line) => {
      for (const l of line.split('\n')) if (l.trim()) writes.push(JSON.parse(l));
    },
    deleteSession: async () => {},
  };
  return { handle, push: (ev) => onStdout?.(JSON.stringify(ev) + '\n'), writes };
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

// ── host tools over the control channel (hosttools.ts / hostrouter.ts) ─────────────────────

const tick = () => new Promise((r) => setImmediate(r));
const hostRoute = (seen: unknown[] = []) => ({
  name: 'host',
  timeoutMs: 30_000,
  handle: async (m: { id?: number | string | null; method?: string }) => {
    seen.push(m);
    if (m.id === undefined || m.id === null) return undefined;
    if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'registry' }] } };
    if (m.method === 'boom') throw new Error('kaboom');
    return { jsonrpc: '2.0', id: m.id, result: {} };
  },
});

test('ClaudeSession — host servers are registered right after spawn, before the first user turn; nothing is written without them', async () => {
  const none = fakeSandbox();
  await new ClaudeSession(none.handle, { cwd: '/tmp' }).open();
  assert.deepEqual(none.writes, [], 'no host servers → the process sees exactly what it saw before');

  const { handle, push, writes } = fakeSandbox();
  const session = new ClaudeSession(handle, { cwd: '/tmp', hostServers: [hostRoute(), { name: 'sources', timeoutMs: 90_000, handle: () => undefined }] });
  await session.open();
  assert.equal(writes.length, 1);
  const init = writes[0] as { type: string; request: { subtype: string; sdkMcpServers: string[]; sdkMcpServerConfigs: Record<string, { timeout: number }> } };
  assert.equal(init.type, 'control_request');
  assert.equal(init.request.subtype, 'initialize');
  assert.deepEqual(init.request.sdkMcpServers, ['host', 'sources']);
  assert.deepEqual(init.request.sdkMcpServerConfigs, { host: { timeout: 30_000 }, sources: { timeout: 90_000 } });
  const turn = session.send('hello');
  await tick();
  assert.equal((writes[1] as { type: string }).type, 'user', 'the registration precedes the first turn on stdin');
  push({ type: 'result', result: 'hi', is_error: false, session_id: 's1' });
  assert.equal((await turn).status, 'ok');
});

test('ClaudeSession — an mcp_message request is answered with the route\'s reply in mcp_response; a notification is acknowledged; a thrown handler and an unknown server become errors', async () => {
  const seen: unknown[] = [];
  const { handle, push, writes } = fakeSandbox();
  const session = new ClaudeSession(handle, { cwd: '/tmp', hostServers: [hostRoute(seen)] });
  await session.open();
  writes.length = 0;
  const req = (request_id: string, server_name: string, message: unknown) => push({ type: 'control_request', request_id, request: { subtype: 'mcp_message', server_name, message } });

  req('r1', 'host', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await tick();
  assert.deepEqual(writes[0], { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { mcp_response: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'registry' }] } } } } });

  req('r2', 'host', { jsonrpc: '2.0', method: 'notifications/initialized' });
  await tick();
  assert.deepEqual(writes[1], { type: 'control_response', response: { subtype: 'success', request_id: 'r2', response: { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } } } }, 'the SDK\'s empty result for a notification');
  assert.equal(seen.length, 2, 'the notification was delivered to the route');

  req('r3', 'host', { jsonrpc: '2.0', id: 3, method: 'boom' });
  await tick();
  assert.deepEqual((writes[2] as { response: { response: { mcp_response: { error: { code: number; message: string } } } } }).response.response.mcp_response.error, { code: -32603, message: 'kaboom' });

  req('r4', 'nope', { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  await tick();
  assert.deepEqual(writes[3], { type: 'control_response', response: { subtype: 'error', request_id: 'r4', error: 'no host server "nope" in this session' } });
});

test('ClaudeSession — a reattach whose snapshot ends on an unanswered mcp_message serves it for real', async () => {
  const pending = { type: 'control_request', request_id: 'old-9', request: { subtype: 'mcp_message', server_name: 'host', message: { jsonrpc: '2.0', id: 9, method: 'tools/list' } } };
  const log = [{ type: 'system', subtype: 'init', session_id: 's1' }, pending].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const { handle, push, writes } = fakeSandbox(log);
  const session = new ClaudeSession(handle, { cwd: '/tmp', resumeSessionId: 's1', attach: { sessionKey: 'k', cmdId: 'cmd1' }, hostServers: [hostRoute()] });
  await session.open();
  assert.deepEqual(writes, [], 'no registration on attach — the running process already knows the servers');
  const adopted = session.adoptInflight();
  await tick();
  assert.deepEqual(writes[0], { type: 'control_response', response: { subtype: 'success', request_id: 'old-9', response: { mcp_response: { jsonrpc: '2.0', id: 9, result: { tools: [{ name: 'registry' }] } } } } });
  push({ type: 'result', result: 'done', is_error: false, session_id: 's1' });
  assert.equal((await adopted).status, 'ok');
});

// The spawn command pinned byte for byte: it is what every production session runs, and the CLI
// probe (src/cliprobe/) runs the same command line — so a change here is a change on purpose.
async function spawnCommand(opts: ConstructorParameters<typeof ClaudeSession>[1]): Promise<string> {
  const { handle } = fakeSandbox();
  let command = '';
  const session = new ClaudeSession(
    { ...handle, startSessionCommand: async (_k: string, c: string) => ((command = c), { cmdId: 'cmd1' }) },
    opts,
  );
  await session.open();
  return command;
}

test('ClaudeSession — the spawn command, byte for byte (no options, all options)', async () => {
  const env = `PATH=/root/.local/bin:$PATH CLAUDE_CODE_OAUTH_TOKEN=$(cat /root/.cc-token) ${gitIdentityEnv()} IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 `;
  const flags =
    `claude --output-format stream-json --input-format stream-json --verbose ` +
    `--dangerously-skip-permissions --permission-prompt-tool stdio --strict-mcp-config ` +
    `--settings '${JSON.stringify(ATTRIBUTION_SETTINGS)}' `;
  assert.equal(await spawnCommand({ cwd: '/root/work/caldora' }), `cd '/root/work/caldora' && ${env}${flags}`);
  assert.equal(
    await spawnCommand({
      cwd: '/root/work/caldora',
      model: 'claude-opus-5-5',
      mcpConfigPath: '/root/.mcp-config.json',
      resumeSessionId: '00000000-0000-4000-8000-000000000001',
      systemPrompt: "You are Nora's agent.",
      avenSession: 'owen-ops:C0123ABCD',
    }),
    `cd '/root/work/caldora' && ${env}AVEN_SESSION='owen-ops:C0123ABCD' ${flags}` +
      `--model 'claude-opus-5-5' --mcp-config '/root/.mcp-config.json' --resume 00000000-0000-4000-8000-000000000001 ` +
      `--append-system-prompt 'You are Nora'\\''s agent.' `,
  );
});

test('claudeLaunch — argv, env and command agree; probe extras merge into the one --settings', () => {
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] };
  const l = claudeLaunch({ model: 'claude-haiku-5-5', resumeSessionId: 'sess-1', settings: { hooks }, extraArgs: ['--replay-user-messages'] });
  assert.equal(l.args.filter((a) => a === '--settings').length, 1);
  assert.deepEqual(JSON.parse(l.args[l.args.indexOf('--settings') + 1]!), { ...ATTRIBUTION_SETTINGS, hooks });
  assert.deepEqual(l.args.slice(-5), ['--model', 'claude-haiku-5-5', '--resume', 'sess-1', '--replay-user-messages']);
  assert.deepEqual(l.env, {
    GIT_AUTHOR_NAME: GIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_EMAIL,
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
  });
  const cmd = l.command('/w');
  assert.ok(cmd.includes(`--settings '${JSON.stringify({ ...ATTRIBUTION_SETTINGS, hooks })}' --model 'claude-haiku-5-5' --resume sess-1 '--replay-user-messages' `));
  assert.equal(claudeLaunch({ avenSession: 'a:b' }).env.AVEN_SESSION, 'a:b');
});


// ── the message ledger (agent-messaging D13, tasks 4.1–4.3) ─────────────────────────────────────
const init = (version = PROBED_CLI_VERSIONS.at(-1)!) => ({ type: 'system', subtype: 'init', session_id: 's1', claude_code_version: version, capabilities: [] });
const echo = (uuid: string, text = 'm', origin?: Record<string, unknown>) => ({ type: 'user', isReplay: true, uuid, message: { role: 'user', content: text }, ...(origin ? { origin } : {}) });
const result = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', result: text, is_error: false, session_id: 's1', ...extra });
const U1 = '00000000-0000-4000-8000-0000000000a1';
const U2 = '00000000-0000-4000-8000-0000000000a2';
const U3 = '00000000-0000-4000-8000-0000000000a3';
const flushAll = () => new Promise((r) => setImmediate(r));

async function openLedger(log = '', attach = false) {
  const sb = fakeSandbox(log);
  const session = new ClaudeSession(sb.handle, { cwd: '/tmp', ledger: true, ...(attach ? { attach: { sessionKey: 'k', cmdId: 'c' } } : {}) });
  await session.open();
  return { session, push: sb.push, writes: sb.writes };
}

test('ledger — the spawn line gains exactly the ledger flags; without the ledger it is unchanged', async () => {
  const plain = await spawnCommand({ cwd: '/w' });
  const ledger = await spawnCommand({ cwd: '/w', ledger: true });
  assert.equal(ledger, `${plain}'--replay-user-messages' `);
});

test('repo skills (agent-skills) — a multi-repo session gains `--add-dir` with every checkout, last on the line (after the ledger flags); none → byte-identical', async () => {
  const plain = await spawnCommand({ cwd: '/w' });
  assert.equal(await spawnCommand({ cwd: '/w', addDirs: [] }), plain);
  const dirs = ['/root/work/acme-suite/acme-admin', '/root/work/acme-suite/acme-shop'];
  assert.equal(await spawnCommand({ cwd: '/w', addDirs: dirs }), `${plain}'--add-dir' '/root/work/acme-suite/acme-admin' '/root/work/acme-suite/acme-shop' `);
  assert.equal(
    await spawnCommand({ cwd: '/w', ledger: true, addDirs: dirs }),
    `${plain}'--replay-user-messages' '--add-dir' '/root/work/acme-suite/acme-admin' '/root/work/acme-suite/acme-shop' `,
  );
});

test('ledger — every message carries a uuid; a result before the turn’s own echo is not its result (a background report), the one after it is', async () => {
  const { session, push, writes } = await openLedger();
  const idle: string[] = [];
  session.onIdleResult = (t) => idle.push(t);
  const turn = session.send('hello', undefined, undefined, undefined, undefined, U1);
  await flushAll();
  assert.deepEqual(writes, [{ type: 'user', message: { role: 'user', content: 'hello' }, uuid: U1 }]);
  push(init());
  push(echo(U3, '<task-notification>…', { kind: 'task-notification' })); // the CLI reports a background task first
  push(result('Background task finished.'));
  push(echo(U1, 'hello'));
  push(result('hi'));
  const r = await turn;
  assert.equal(r.resultText, 'hi');
  assert.deepEqual(idle, ['Background task finished.']);
});

test('ledger — an injected message while idle gets its own turn: `answered` by the result after its echo, not a background update', async () => {
  const { session, push } = await openLedger();
  const idle: string[] = [];
  session.onIdleResult = (t) => idle.push(t);
  push(init());
  push(result('', { subtype: 'success' })); // an earlier turn ended: the process is idle
  const o = session.inject('Answer from bluefin/caldora …', { uuid: U2 });
  await flushAll();
  push(echo(U2));
  push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Thanks — orders dropped because…' }] } });
  push(result('Orders dropped because…', { total_cost_usd: 0.2 }));
  const out = await o;
  assert.equal(out.kind, 'answered');
  assert.equal((out as Extract<InjectOutcome, { kind: 'answered' }>).result.resultText, 'Orders dropped because…');
  assert.equal((out as Extract<InjectOutcome, { kind: 'answered' }>).result.usage?.costUsd, 0.2, 'metered by the caller with the task’s origin');
  assert.deepEqual(idle, []);
});

test('ledger — two messages taken up together: the first is answered, the second folded into that turn; one result covers both', async () => {
  const { session, push } = await openLedger();
  push(init());
  const a = session.inject('answer A', { uuid: U1 });
  const b = session.inject('answer B', { uuid: U2 });
  await flushAll();
  push(echo(U1));
  push(echo(U2));
  push(result('both'));
  assert.equal((await a).kind, 'answered');
  assert.deepEqual(await b, { kind: 'folded', into: 'delivery' });
});

test('ledger — a result after echoes nobody here wrote is a mismatch: reported, and treated as unsolicited', async () => {
  const { session, push } = await openLedger();
  const mismatches: unknown[] = [];
  const idle: string[] = [];
  session.onLedgerMismatch = (m) => mismatches.push(m);
  session.onIdleResult = (t) => idle.push(t);
  const turn = session.send('hello', undefined, undefined, undefined, undefined, U1);
  push(init());
  push(echo(U3, 'a message from nowhere'));
  push(result('not yours'));
  assert.deepEqual(mismatches, [{ expected: U1, actual: [U3] }]);
  assert.deepEqual(idle, ['not yours']);
  push(echo(U1, 'hello'));
  push(result('yours'));
  assert.equal((await turn).resultText, 'yours');
});

test('ledger — the background-task list follows background_tasks_changed and is cleared when the process ends', async () => {
  const sb = fakeSandbox();
  let end!: () => void;
  const session = new ClaudeSession({ ...sb.handle, streamSessionCommandLogs: (_k, _c, cb) => (sb.handle.streamSessionCommandLogs(_k, _c, cb), new Promise<void>((r) => (end = r))) }, { cwd: '/tmp', ledger: true });
  await session.open();
  sb.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'b1' }] });
  assert.equal(session.backgroundTasks().length, 1);
  sb.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  assert.equal(session.backgroundTasks().length, 0);
  sb.push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'b2' }] });
  end();
  await flushAll();
  assert.deepEqual(session.backgroundTasks(), [], 'background work ends with its process');
});

test('ledger — the contract check: inject only with the ledger, on a probed CLI; otherwise refused with the reason', async () => {
  const plain = await openFake();
  assert.match(plain.session.injectRefusal()!, /without the message ledger/);
  assert.deepEqual(await plain.session.inject('x', { uuid: U1 }), { kind: 'refused', reason: 'spawned without the message ledger' });
  const { session, push } = await openLedger();
  assert.match(session.injectRefusal()!, /not known yet/);
  push(init('2.1.183'));
  assert.equal(session.injectRefusal(), 'CLI 2.1.183 is not a probed version');
  push(init());
  assert.equal(session.injectRefusal(), undefined);
  assert.equal(session.cliVersion(), PROBED_CLI_VERSIONS.at(-1));
});

test('ledger — a long tool: no echo for 10 minutes is a warning once, and the message keeps waiting', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-17T08:00:00.000Z') });
  const { session, push } = await openLedger();
  push(init());
  const turn = session.send('run the long thing', undefined, undefined, undefined, undefined, U1);
  push(echo(U1));
  push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 900' } }] } });
  let slow = 0;
  let outcome: InjectOutcome | undefined;
  void session.inject('answer', { uuid: U2, onSlow: () => void slow++ }).then((o) => (outcome = o));
  t.mock.timers.tick(11 * 60_000);
  assert.equal(slow, 1);
  t.mock.timers.tick(20 * 60_000);
  assert.equal(slow, 1, 'once');
  assert.equal(outcome, undefined, 'still waiting: a tool may run that long');
  push(echo(U2));
  push(result('done, and the answer folded in'));
  await turn;
  await flushAll();
  assert.deepEqual(outcome, { kind: 'folded', into: 'turn' });
});

test('ledger — a message stuck on an idle process: not taken up within 2 minutes of idling → `stuck`', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-17T08:00:00.000Z') });
  const { session, push } = await openLedger();
  push(init());
  push(result('an earlier turn'));
  let outcome: InjectOutcome | undefined;
  void session.inject('answer', { uuid: U2 }).then((o) => (outcome = o));
  t.mock.timers.tick(60_000);
  await flushAll();
  assert.equal(outcome, undefined);
  t.mock.timers.tick(75_000);
  await flushAll();
  assert.deepEqual(outcome, { kind: 'stuck' });
});

test('ledger — the bot restarts after the write: the reattach snapshot decides what became of each message', async () => {
  const log = ndjson([
    init(),
    echo(U1, 'person'), // a person's turn …
    echo(U2, 'answer folded into it'), // … with a delivery folded in
    result('one answer for both'),
    echo(U3, 'a delivery on its own'),
    result('the delivery’s own answer'),
  ]);
  const { session } = await openLedger(log, true);
  assert.deepEqual(await session.recoverInjected({ uuid: U2, writtenAt: 0 }), { kind: 'folded', into: 'turn' });
  const own = await session.recoverInjected({ uuid: U3, writtenAt: 0 });
  assert.equal(own.kind, 'answered');
  assert.equal((own as Extract<InjectOutcome, { kind: 'answered' }>).result.resultText, 'the delivery’s own answer');
  assert.equal(session.injectRefusal(), undefined, 'the CLI version comes from the snapshot');
});

test('ledger — after a restart, a message the snapshot never echoed on a live process is still waiting; its echo and result come live', async () => {
  const log = ndjson([init(), echo(U1, 'person'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }]);
  const sb = fakeSandbox(log);
  const session = new ClaudeSession(sb.handle, { cwd: '/tmp', ledger: true, attach: { sessionKey: 'k', cmdId: 'c' } });
  await session.open();
  const adopted = session.adoptInflight(undefined, undefined, undefined, U1);
  let outcome: InjectOutcome | undefined;
  void session.recoverInjected({ uuid: U2, writtenAt: Date.now() }).then((o) => (outcome = o));
  sb.push(echo(U2));
  sb.push(result('the person’s answer, with the delivery folded in'));
  assert.equal((await adopted).resultText, 'the person’s answer, with the delivery folded in');
  await flushAll();
  assert.deepEqual(outcome, { kind: 'folded', into: 'turn' });
});

test('restart mid-call, several calls pending: every unanswered host tool call of the turn is served again, an answered one is not', async () => {
  const use = (id: string, text: string) => ({ type: 'tool_use', id, name: 'mcp__probe__probe_echo', input: { text } });
  const call = (rid: string, text: string, id: number) => ({ type: 'control_request', request_id: rid, request: { subtype: 'mcp_message', server_name: 'probe', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'probe_echo', arguments: { text } } } } });
  const log = ndjson([
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [use('toolu_a', 'A')] } },
    { type: 'assistant', message: { content: [use('toolu_b', 'B')] } },
    { type: 'assistant', message: { content: [use('toolu_c', 'C')] } },
    call('req-a', 'A', 1),
    call('req-b', 'B', 2),
    call('req-c', 'C', 3),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'echo:B' }] } }, // answered before the restart
  ]);
  const sb = fakeSandbox(log);
  const tools = [{ name: 'probe_echo', description: 'echo', inputSchema: { type: 'object' }, call: (a: Record<string, unknown>) => ({ text: `echo:${String(a.text)}` }) }];
  const session = new ClaudeSession(sb.handle, { cwd: '/tmp', attach: { sessionKey: 'k', cmdId: 'c' }, hostServers: [{ name: 'probe', handle: mcpServer('probe', tools) }] });
  await session.open();
  const adopted = session.adoptInflight();
  await flushAll();
  await flushAll();
  const served = (sb.writes as Any[]).filter((w) => w.type === 'control_response').map((w) => w.response.request_id);
  assert.deepEqual(served.sort(), ['req-a', 'req-c']);
  sb.push({ type: 'result', result: 'echo:A echo:B echo:C', is_error: false, session_id: 's1' });
  assert.equal((await adopted).status, 'ok', 'the adopted turn then finishes');
});
