import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowFrame, claudeLaunch, userFrame, type ClaudeLaunch } from '../claudeSession.js';
import { mcpServer } from '../hosttools.js';
import { PreconditionMissed, PredictionMissed, ProbeCtx, VersionMismatch, is, type ProcessHandlers, type Transport } from './ctx.js';
import { localEnv } from './local.js';
import type { Frame } from './types.js';

// A fake CLI: each process gets the frames written to its stdin and answers through `emit`.
type Script = (written: Frame, emit: (f: Frame) => void, exit: (code?: number) => void, n: number) => void;
function fakeTransport(script: Script, onStart?: (emit: (f: Frame) => void) => void) {
  const launches: ClaudeLaunch[] = [];
  const kills: string[] = [];
  const transport: Transport = {
    kind: 'local',
    async start(launch: ClaudeLaunch, h: ProcessHandlers) {
      launches.push(launch);
      const n = launches.length;
      let alive = true;
      const emit = (f: Frame): void => void setImmediate(() => alive && h.onLine(JSON.stringify(f)));
      const exit = (code = 0): void => {
        if (!alive) return;
        alive = false;
        setImmediate(() => h.onExit(code, null));
      };
      setImmediate(() => onStart?.(emit));
      return {
        write: async (line: string) => script(JSON.parse(line), emit, exit, n),
        end: () => exit(0),
        kill: (signal?: string) => {
          kills.push(signal ?? 'SIGKILL');
          if (alive) {
            alive = false;
            setImmediate(() => h.onExit(null, signal ?? 'SIGKILL'));
          }
        },
      };
    },
    async dispose() {},
  };
  return { transport, launches, kills };
}

const init = (v = '2.1.282', session_id = 's-1'): Frame => ({ type: 'system', subtype: 'init', session_id, claude_code_version: v });
const result = (text: string, cost: number, session_id = 's-1'): Frame => ({ type: 'result', subtype: 'success', result: text, is_error: false, session_id, total_cost_usd: cost });

test('ProbeCtx — the bot’s flags change: the probe starts the CLI with claudeLaunch’s argv, extras merged into one --settings', async () => {
  const { transport, launches } = fakeTransport(() => {});
  const launch = { model: 'claude-haiku-5-5', settings: { hooks: { Stop: [] } }, extraArgs: ['--replay-user-messages'] };
  const ctx = new ProbeCtx({ transport, launch });
  await ctx.start();
  assert.deepEqual(launches[0]!.args, claudeLaunch(launch).args);
  assert.deepEqual(ctx.recording[0], { t: (ctx.recording[0] as { t: number }).t, proc: 'start', argv: ['claude', ...claudeLaunch(launch).args] });
  assert.equal(launches[0]!.args.filter((a) => a === '--settings').length, 1);
});

test('ProbeCtx — started from inside a Claude Code session: the local child sees none of its variables', () => {
  const launch = claudeLaunch({});
  const env = localEnv({ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/home/owen/.claude' }, { configDir: '/tmp/r/config', token: 't' }, launch);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/r/config');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 't');
  assert.equal(env.IS_SANDBOX, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
});

test('ProbeCtx — the wrong CLI answers: a mismatching system/init ends the run as an error and kills the process', async () => {
  const { transport, kills } = fakeTransport((w, emit) => {
    if (w.type === 'user') emit(init('2.1.302'));
  });
  const ctx = new ProbeCtx({ transport, launch: {}, expectedVersion: '2.1.282' });
  await ctx.start();
  await ctx.send('hello');
  await assert.rejects(ctx.expect(is.result, 2_000, 'a result'), (e: unknown) => e instanceof VersionMismatch && /2\.1\.302.*2\.1\.282/.test((e as Error).message));
  assert.deepEqual(kills, ['SIGKILL']);
});

test('ProbeCtx — a missed precondition is PreconditionMissed, a missed prediction PredictionMissed; an exit ends the wait', async () => {
  const { transport } = fakeTransport((w, emit, exit) => {
    if (w.type === 'user' && userFrame('quit').message.content === (w as { message: { content: string } }).message.content) exit(1);
  });
  const ctx = new ProbeCtx({ transport, launch: {} });
  await ctx.start();
  await assert.rejects(ctx.precondition(is.toolUse('Bash'), 30, 'the model calls Bash'), (e: unknown) => e instanceof PreconditionMissed && /the model calls Bash — not within 30 ms/.test((e as Error).message));
  await assert.rejects(ctx.expect(is.result, 30, 'a result'), PredictionMissed);
  assert.throws(() => ctx.require(false, 'the model used Task'), PreconditionMissed);
  assert.throws(() => ctx.check(false, 'parent id matches'), PredictionMissed);
  const waiting = ctx.expect(is.result, 5_000, 'a result');
  await ctx.send('quit');
  await assert.rejects(waiting, (e: unknown) => e instanceof PredictionMissed && /exited first/.test((e as Error).message));
});

test('ProbeCtx — answers like the bot: can_use_tool allowed as sent, mcp_message through the bot’s framing; frames recorded both ways', async () => {
  const ask = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo A' } } };
  const mcp = { type: 'control_request', request_id: 'r2', request: { subtype: 'mcp_message', server_name: 'probe', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } };
  const { transport } = fakeTransport((w, emit) => {
    if (w.type === 'user') {
      emit(init());
      emit(ask);
      emit(mcp);
    }
  });
  const ctx = new ProbeCtx({ transport, launch: {} });
  await ctx.start();
  const tools = [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, call: () => ({ text: 'x' }) }];
  await ctx.initialize([{ name: 'probe', handle: mcpServer('probe', tools) }]);
  await ctx.send('go', { priority: 'next' });
  await ctx.expect(is.control('mcp_message'), 2_000, 'the mcp request');
  await ctx.sleep(20);
  const written = ctx.recording.filter((l) => 'dir' in l && l.dir === 'in').map((l) => (l as { frame: Frame }).frame);
  assert.deepEqual(written[0], {
    type: 'control_request',
    request_id: 'probe-init-1',
    request: { subtype: 'initialize', sdkMcpServers: ['probe'], sdkMcpServerConfigs: {} },
  });
  assert.deepEqual(written[1], { ...userFrame('go'), priority: 'next' });
  assert.deepEqual(written[2], allowFrame('r1', { command: 'echo A' }));
  assert.deepEqual(written[3], {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r2', response: { mcp_response: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] } } } },
  });
  assert.equal(ctx.recording.filter((l) => 'dir' in l && l.dir === 'out').length, 3);
});

test('ProbeCtx — restart with --resume records the boundary; cost sums each process’s running total', async () => {
  const { transport, launches } = fakeTransport((w, emit, _exit, n) => {
    if (w.type === 'user') {
      emit(init('2.1.282', `s-${n}`));
      emit(result('ok', n === 1 ? 0.02 : 0.03, `s-${n}`));
      emit(result('ok again', n === 1 ? 0.05 : 0.04, `s-${n}`));
    }
  });
  const ctx = new ProbeCtx({ transport, launch: { model: 'claude-haiku-5-5' }, expectedVersion: '2.1.282' });
  await ctx.start();
  await ctx.send('one');
  await ctx.expect((f) => is.result(f) && f.result === 'ok again', 2_000, 'two results');
  await ctx.restart({ resume: ctx.sessionId });
  await ctx.send('two');
  await ctx.expect((f) => is.result(f) && f.session_id === 's-2' && f.result === 'ok again', 2_000, 'two more');
  assert.deepEqual(launches[1]!.args.slice(-2), ['--resume', 's-1']);
  const procs = ctx.recording.filter((l) => 'proc' in l).map((l) => ('signal' in l ? `exit:${l.signal}` : `start:${(l as { argv: string[] }).argv.includes('--resume')}`));
  assert.deepEqual(procs, ['start:false', 'exit:SIGKILL', 'start:true']);
  assert.equal(Math.round(ctx.costUsd() * 100) / 100, 0.09);
  await ctx.close();
  assert.equal(ctx.running, false);
});
