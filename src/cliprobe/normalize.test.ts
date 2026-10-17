import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePath, normalizeRecording } from './normalize.js';
import type { RecordLine } from './types.js';

const RUN = '/tmp/cli-probe-AbC123';
const HOME = '/home/owen';
const CACHE = '/home/owen/.cache/coach-aven/cli-probe';
const SESSION = '3f2b9c1e-8d4a-4b6f-9e21-7c5d0a1b2c3d';
const HOOK = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TOOLU = 'toolu_01ABCdefGHIjklMNOpqr';
const MSG = 'msg_01XYZabcDEFghiJKLmno';
const REQ = 'req_011CgABCdefGHIjkl';
const RUN_ID = '0mvc4ts57-8a12bc3d';
const AGENT = 'a3f09b2c41d7e8f60';
const SHELL = 'b4bkj2c1x';
const SIG = 'CAQSjwYKEAgSGAI0AUIIxGhpbmtpbmcSDJT0/CNU'.repeat(20);
const ENCODED_WORK = encodePath(`${RUN}/work`);

// The shapes the scratchpad recordings carried, on a fictional machine.
const recording: RecordLine[] = [
  { t: 0, proc: 'start', argv: ['claude', '--resume', SESSION, '--settings', '{"hooks":{}}'] },
  {
    t: 10,
    dir: 'out',
    frame: {
      type: 'system',
      subtype: 'init',
      session_id: SESSION,
      cwd: `${RUN}/work`,
      memory_paths: { auto: `${HOME}/.claude/projects/${ENCODED_WORK}/memory` },
      messaging_socket_path: '/run/user/1000/cc-socks/4242.sock',
      plugins: [],
    },
  },
  { t: 11, dir: 'out', frame: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792256400, rateLimitType: 'seven_day', utilization: 0.97, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1792256400 } } }, session_id: SESSION, uuid: HOOK } },
  { t: 20, dir: 'out', frame: { type: 'assistant', message: { id: MSG, content: [{ type: 'thinking', thinking: 'plan', signature: SIG }, { type: 'tool_use', id: TOOLU, name: 'Bash', input: { command: 'echo A1' } }] }, session_id: SESSION, request_id: REQ, timestamp: '2026-10-17T08:26:04.000Z' } },
  { t: 30, dir: 'out', frame: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: TOOLU, content: `A1 (written to /tmp/claude-1000/${ENCODED_WORK}/${SESSION}/tasks/${SHELL}.output)` }] }, session_id: SESSION } },
  { t: 31, dir: 'out', frame: { type: 'system', subtype: 'task_started', task_id: SHELL, run_id: RUN_ID, agent_id: AGENT, parent_task_id: AGENT, blocked_path: `${HOME}/projects/ledger`, output_file: `/tmp/claude-1000/${ENCODED_WORK}/x.output` } },
  { t: 40, dir: 'out', frame: { type: 'stream_event', event: { type: 'message_start' } } },
  { t: 41, dir: 'out', frame: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } } },
  { t: 42, dir: 'out', frame: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } } },
  { t: 50, dir: 'in', frame: { type: 'user', message: { role: 'user', content: `the earlier call was ${TOOLU}` } } },
  { t: 55, dir: 'out', frame: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_01MEMwriteXYZ', name: 'Write', input: { content: '---\nmodified: 2026-10-17T16:36:13.101Z\n---\nSaved on 2026-10-17.' } }] } } },
  { t: 58, dir: 'out', frame: { type: 'control_request', request_id: 'r9', request: { subtype: 'mcp_message', server_name: 'probe', message: { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } } } } },
  { t: 60, proc: 'exit', code: null, signal: 'SIGKILL' },
];

test('normalizeRecording — a recording is normalized: no machine path, issued id, wall-clock time or signature remains', () => {
  const out = normalizeRecording(recording, { runRoot: RUN, home: HOME, cache: CACHE, uid: 1000 });
  const text = JSON.stringify(out);
  for (const leak of [RUN, HOME, 'owen', '/run/user/1000', '/tmp/claude-1000', ENCODED_WORK, SESSION, HOOK, TOOLU, MSG, REQ, RUN_ID, AGENT, SHELL, SIG.slice(0, 30), '2026-10-17', '1792256400', 'out_of_credits', '0.97']) {
    assert.ok(!text.includes(leak), `leaked: ${leak}`);
  }
  const init = (out[1] as { frame: Record<string, unknown> }).frame;
  assert.equal(init.cwd, '/probe/work');
  const memory = (out.find((l) => JSON.stringify(l).includes('modified:')) as unknown as { frame: { message: { content: { input: { content: string } }[] } } }).frame;
  assert.ok(JSON.stringify(out).includes('"protocolVersion":"2025-11-25"'), 'a date-shaped protocol revision is not a time');
  assert.equal(memory.message.content[0]!.input.content, '---\nmodified: 2000-01-01T00:00:00.000Z\n---\nSaved on 2000-01-01.', 'times and dates inside text are fixed too');
  assert.equal(init.session_id, '00000000-0000-4000-8000-000000000001', 'a UUID placeholder is itself a UUID');
  assert.equal(init.messaging_socket_path, '/probe/run/cc-socks/4242.sock');
  assert.equal((init.memory_paths as { auto: string }).auto, `/probe/home/.claude/projects/${encodePath('/probe/work')}/memory`);
});

test('normalizeRecording — cross-references survive: the same id maps to the same placeholder everywhere, shape kept', () => {
  const out = normalizeRecording(recording, { runRoot: RUN, home: HOME, cache: CACHE, uid: 1000 }) as Array<{ frame?: any; argv?: string[] }>;
  const toolUseId = out[3]!.frame.message.content[1].id;
  assert.equal(toolUseId, 'toolu_probe_1');
  assert.equal(out[4]!.frame.message.content[0].tool_use_id, toolUseId);
  assert.equal(out[0]!.argv![2], out[1]!.frame.session_id, 'the --resume argument maps like the session id');
  const task = out[5]!.frame;
  assert.match(task.run_id, /^0{8}[0-9a-z]-0{7}[0-9a-f]$/, 'run id: same length and alphabet, no time');
  assert.equal(task.agent_id.length, AGENT.length);
  assert.equal(task.parent_task_id, task.agent_id);
  assert.equal(task.task_id.length, SHELL.length);
  assert.ok(out[4]!.frame.message.content[0].content.includes(`/tasks/${task.task_id}.output`), 'an id inside a path follows the same map');
  const written = out.find((l) => (l as { dir?: string }).dir === 'in')!;
  assert.equal(written.frame.message.content, 'the earlier call was toolu_probe_1', 'ids inside text the probe wrote too');
});

test('normalizeRecording — fixed values keep their types; deltas collapse unless kept', () => {
  const out = normalizeRecording(recording, { runRoot: RUN, home: HOME, cache: CACHE, uid: 1000 }) as Array<{ frame?: any; proc?: string }>;
  assert.deepEqual(out[2]!.frame.rate_limit_info, {
    status: 'allowed',
    resetsAt: 4102444800,
    rateLimitType: 'five_hour',
    utilization: 0.5,
    overageStatus: 'rejected',
    overageDisabledReason: 'unknown',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 4102444800 } },
  });
  assert.equal(out[3]!.frame.message.content[0].signature, 'probe-signature');
  assert.equal(out[3]!.frame.timestamp, '2000-01-01T00:00:00.000Z');
  const deltas = out.filter((l) => l.frame?.event?.type === 'content_block_delta');
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0]!.frame.event.delta.text, 'Hello');
  assert.deepEqual(out.at(-1), { t: 60, proc: 'exit', code: null, signal: 'SIGKILL' });
  const kept = normalizeRecording(recording, { runRoot: RUN, home: HOME, cache: CACHE, uid: 1000 }, { keepPartials: true });
  assert.equal(kept.length, recording.length);
});
