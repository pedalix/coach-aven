import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRecordings, loadChecker, type FrameChecker } from './typecheck.js';
import type { Frame } from './types.js';

// A small fictional declaration file with the shapes that matter: two members sharing `type` (user /
// replay), members told apart by a field that is neither type nor subtype (hook_event), a nested union
// (content blocks, control requests), a template literal (UUID), an index signature, an unexported union.
const DTS = `
import type { ApiMessage } from '@anthropic-ai/sdk';
declare type UUID = \`\${string}-\${string}-\${string}-\${string}-\${string}\`;
declare type Block = { type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string };
export declare type Init = { type: 'system'; subtype: 'init'; session_id: string; uuid: UUID; tools: string[]; model?: string };
export declare type HookPre = { type: 'system'; subtype: 'hook'; hook_event: 'PreToolUse'; tool: string };
export declare type HookStop = { type: 'system'; subtype: 'hook'; hook_event: 'Stop'; stop_reason: string | null };
export declare type User = { type: 'user'; message: { role: 'user'; content: string | Block[] }; parent_tool_use_id: string | null; uuid?: UUID };
export declare type UserReplay = { type: 'user'; message: { role: 'user'; content: string | Block[] }; isReplay: true; uuid: UUID; parent_tool_use_id: string | null };
export declare type Result = { type: 'result'; subtype: 'success'; result: string; is_error: boolean; session_id: string; usage: { [k: string]: number } };
declare type Inner = { subtype: 'interrupt' } | { subtype: 'can_use_tool'; tool_name: string; input: Record<string, unknown> };
export declare type ControlRequest = { type: 'control_request'; request_id: string; request: Inner };
export declare type Assistant = { type: 'assistant'; message: ApiMessage; session_id: string };
declare type StdoutMessage = Init | HookPre | HookStop | User | UserReplay | Result | ControlRequest | Assistant;
export { };
`;

let dir = '';
let checker: FrameChecker;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliprobe-tc-'));
  writeFileSync(join(dir, 'sdk.d.ts'), DTS);
  // The API's message model, as the agent SDK imports it from @anthropic-ai/sdk.
  mkdirSync(join(dir, 'node_modules', '@anthropic-ai', 'sdk'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), JSON.stringify({ name: '@anthropic-ai/sdk', types: 'index.d.ts' }));
  writeFileSync(
    join(dir, 'node_modules', '@anthropic-ai', 'sdk', 'index.d.ts'),
    "export type Model = 'model-a' | (string & {});\nexport type ApiMessage = { id: string; model: Model; usage: { input_tokens: number; server_tool_use: { web_search_requests: number } | null } };\n",
  );
  checker = loadChecker({ sdkDts: join(dir, 'sdk.d.ts'), inTypes: ['User', 'ControlRequest'] });
});
test.after(() => rmSync(dir, { recursive: true, force: true }));

const U1 = '00000000-0000-4000-8000-000000000001';
const init: Frame = { type: 'system', subtype: 'init', session_id: 's', uuid: U1, tools: ['Bash'] };

test('check — a field of the wrong type is a violation at its path', () => {
  const r = checker.check({ type: 'result', subtype: 'success', result: 'ok', is_error: false, session_id: 42, usage: { input_tokens: 3 } }, 'out');
  assert.deepEqual(r.findings, [{ kind: 'violation', path: '$.session_id', detail: 'a number where string is declared', origin: 'protocol' }]);
});

test('check — several findings in one frame: the missing field AND both extra fields are reported', () => {
  const { tools: _t, ...noTools } = init;
  const r = checker.check({ ...noTools, capabilities: [], view_mode: 'x' }, 'out');
  assert.deepEqual(
    r.findings.map((f) => `${f.kind} ${f.path}`).sort(),
    ['undeclared-field $.capabilities', 'undeclared-field $.view_mode', 'violation $.tools'],
  );
});

test('check — a field the declarations lack is listed, not a violation; an index signature covers extra keys', () => {
  assert.deepEqual(checker.check({ ...init, capabilities: ['x'] }, 'out').findings, [{ kind: 'undeclared-field', path: '$.capabilities', detail: 'not declared', origin: 'protocol' }]);
  assert.deepEqual(checker.check({ type: 'result', subtype: 'success', result: 'ok', is_error: false, session_id: 's', usage: { input_tokens: 3, cache_read: 9 } }, 'out').findings, []);
});

test('check — a kind the declarations lack is an undeclared kind', () => {
  const r = checker.check({ type: 'system', subtype: 'telemetry', x: 1 }, 'out');
  assert.equal(r.undeclaredKind, true);
  assert.equal(r.kind, 'system/telemetry');
});

test('check — members sharing a type: a replay matches the replay kind; members told apart by hook_event', () => {
  assert.deepEqual(checker.check({ type: 'user', isReplay: true, uuid: U1, parent_tool_use_id: null, message: { role: 'user', content: 'hi' } }, 'out').findings, []);
  assert.deepEqual(checker.check({ type: 'system', subtype: 'hook', hook_event: 'Stop', stop_reason: null }, 'out').findings, []);
  assert.deepEqual(checker.check({ type: 'system', subtype: 'hook', hook_event: 'PreToolUse' }, 'out').findings, [{ kind: 'violation', path: '$.tool', detail: 'required, missing', origin: 'protocol' }]);
});

test('check — nested unions and template literals: a content block and a UUID are checked by shape', () => {
  const r = checker.check({ type: 'user', parent_tool_use_id: null, uuid: 'not-a-uuid', message: { role: 'user', content: [{ type: 'tool_result', content: 'A1' }] } }, 'out');
  assert.deepEqual(r.findings.map((f) => `${f.kind} ${f.path}`).sort(), ['violation $.message.content[0].tool_use_id', 'violation $.uuid']);
  assert.deepEqual(checker.check({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' } } }, 'out').findings, []);
});

test('the bot’s own message differs from the declaration: an input finding, listed by checkRecordings', () => {
  const findings = checkRecordings(checker, [
    {
      file: 'turn.jsonl',
      lines: [
        { t: 0, proc: 'start', argv: ['claude'] },
        { t: 1, dir: 'in', frame: { type: 'user', message: { role: 'user', content: 'hello' } } },
        { t: 2, dir: 'out', frame: { ...init, capabilities: [] } },
        { t: 3, dir: 'out', frame: { type: 'keep_alive' } },
      ],
    },
  ]);
  assert.deepEqual(findings, [
    { dir: 'in', file: 'turn.jsonl', line: 2, kind: 'violation', frameKind: 'user', path: '$.parent_tool_use_id', detail: 'required, missing', origin: 'protocol' },
    { dir: 'out', file: 'turn.jsonl', line: 3, kind: 'undeclared-field', frameKind: 'system/init', path: '$.capabilities', detail: 'not declared', origin: 'protocol' },
    { dir: 'out', file: 'turn.jsonl', line: 4, kind: 'undeclared-kind', frameKind: 'keep_alive', path: '$', detail: 'no declared kind matches its literal fields', origin: 'protocol' },
  ]);
});

test('check — a mismatch inside the imported API message model is tagged api; an open string union accepts any string', () => {
  const r = checker.check({ type: 'assistant', session_id: 's', message: { id: 'msg_probe_1', model: 'claude-haiku-5-5', usage: { input_tokens: 3 } } }, 'out');
  assert.deepEqual(r.findings, [{ kind: 'violation', path: '$.message.usage.server_tool_use', detail: 'required, missing', origin: 'api' }]);
});

