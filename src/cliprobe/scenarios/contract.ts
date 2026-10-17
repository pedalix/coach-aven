// The contract scenarios (design D7): what the bot relies on today. src/claudeSession.recorded.test.ts
// replays each recording through ClaudeSession; the probed set requires every one of them to hold.
import { mcpServer } from '../../hosttools.js';
import { parseRateLimitEvent } from '../../ratelimit.js';
import type { ProbeCtx } from '../ctx.js';
import type { Frame, Scenario } from '../types.js';
import { kindOf, resultTextOf, toolResults, toolUses } from './lib.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const S = 1000;

const turn: Scenario<ProbeCtx> = {
  meta: {
    id: 'turn',
    contract: true,
    runs: 1,
    hypothesis:
      '`system/init` comes first (the rate-limit event aside), with `session_id` and only the CLI’s built-in plugins; `assistant` events carry `text` and `tool_use` blocks; the turn ends with one `result` carrying `result`, `is_error`, `session_id`, `total_cost_usd`, `usage` and `duration_ms`.',
  },
  async run(ctx) {
    await ctx.send('Use the Bash tool once to run `echo PROBE-TURN`, then reply with its output.');
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model calls Bash');
    const result = await ctx.expect(ctx.is.result, 120 * S, 'a result');
    await ctx.sleep(3 * S);
    const init = ctx.frames.find(ctx.is.init) as Any;
    const first = ctx.frames.find((f) => f.type !== 'rate_limit_event');
    ctx.check(first && ctx.is.init(first), `system/init comes first (got ${first ? kindOf(first) : 'nothing'})`);
    ctx.check(typeof init?.session_id === 'string', 'system/init carries session_id');
    const outside = (init?.plugins ?? []).filter((p: Any) => p?.path !== 'builtin');
    ctx.check(outside.length === 0, `only the CLI's built-in plugins (got ${JSON.stringify(outside.map((p: Any) => p?.name))})`);
    ctx.require(ctx.frames.some(ctx.is.text), 'the model replied with text');
    const r = result as Any;
    ctx.check(typeof r.result === 'string' && typeof r.is_error === 'boolean', 'result carries result and is_error');
    ctx.check(r.session_id === init.session_id, 'result carries the session id of system/init');
    ctx.check(typeof r.total_cost_usd === 'number' && r.usage && typeof r.usage === 'object' && typeof r.duration_ms === 'number', 'result carries total_cost_usd, usage and duration_ms');
    ctx.check(ctx.results.length === 1, `one result for the turn (got ${ctx.results.length})`);
    return { resultSubtype: r.subtype, tools: (init.tools ?? []).length, skills: (init.skills ?? []).length, plugins: (init.plugins ?? []).map((p: Any) => p?.name) };
  },
};

const hostTool: Scenario<ProbeCtx> = {
  meta: {
    id: 'host-tool',
    contract: true,
    runs: 1,
    hypothesis:
      'After `initialize` with `sdkMcpServers`, the MCP handshake and the model’s call of a host tool come as `control_request {mcp_message}`, and the host’s `control_response` reaches the model as the tool result.',
  },
  async run(ctx) {
    const tools = [
      {
        name: 'probe_echo',
        description: 'Echo a text back. A tool of the CLI probe.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        call: (a: Record<string, unknown>) => ({ text: `echo:${String(a.text)}` }),
      },
    ];
    await ctx.initialize([{ name: 'probe', handle: mcpServer('probe', tools) }]);
    await ctx.send('Call the `probe_echo` tool of the `probe` MCP server with the text "ping-7", then reply with exactly the text it returned.');
    const mcp = (m: string) => (f: Frame) => ctx.is.control('mcp_message')(f) && (f as Any).request?.message?.method === m;
    await ctx.expect(mcp('initialize'), 60 * S, 'the MCP handshake comes as mcp_message', { past: true });
    await ctx.precondition(mcp('tools/call'), 90 * S, 'the model calls the host tool');
    await ctx.expect(ctx.is.result, 120 * S, 'a result');
    const call = ctx.frames.flatMap(toolUses).find((b) => String(b.name).includes('probe_echo'));
    const back = toolResults(ctx.frames).find((r) => r.id === call?.id);
    ctx.check(back?.text.includes('echo:ping-7'), 'the host’s answer reached the model as the tool result');
    const methods = ctx.frames.filter(ctx.is.control('mcp_message')).map((f) => (f as Any).request?.message?.method ?? '(response)');
    return { toolName: call?.name, mcpMethods: methods };
  },
};

const askUserQuestion: Scenario<ProbeCtx> = {
  meta: {
    id: 'ask-user-question',
    contract: true,
    runs: 1,
    hypothesis:
      'With `--dangerously-skip-permissions` and `--permission-prompt-tool stdio`, Bash runs with no permission round trip, `AskUserQuestion` sends `can_use_tool`, and the answers given in `updatedInput` reach the model.',
  },
  async run(ctx) {
    const prompted: string[] = [];
    ctx.onCanUseTool = (f) => {
      const req = (f as Any).request;
      prompted.push(req.tool_name);
      if (req.tool_name !== 'AskUserQuestion') return req.input;
      const qs: Any[] = req.input?.questions ?? [];
      const answers = Object.fromEntries(qs.map((q) => [q.question, q.options?.find((o: Any) => /blue/i.test(o.label))?.label ?? q.options?.[0]?.label ?? 'blue']));
      return { ...req.input, answers };
    };
    await ctx.send(
      'First run the Bash command `echo PROBE-ASK`. Then use the AskUserQuestion tool to ask me exactly one question, "Which color?", with the options "red" and "blue". After I answer, reply with only the color I chose.',
    );
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model calls Bash');
    await ctx.precondition(ctx.is.toolUse('AskUserQuestion'), 120 * S, 'the model calls AskUserQuestion');
    await ctx.expect((f) => ctx.is.control('can_use_tool')(f) && (f as Any).request?.tool_name === 'AskUserQuestion', 30 * S, 'AskUserQuestion sends can_use_tool', { past: true });
    await ctx.expect(ctx.is.result, 120 * S, 'a result');
    ctx.check(!prompted.includes('Bash'), 'Bash ran without a permission round trip');
    const ask = ctx.frames.flatMap(toolUses).find((b) => b.name === 'AskUserQuestion');
    const back = toolResults(ctx.frames).find((r) => r.id === ask?.id);
    ctx.check(back && /blue/i.test(back.text), 'the answer reached the model as the tool result');
    return { prompted, answerReached: back?.text.slice(0, 120) };
  },
};

const questionWithdrawn: Scenario<ProbeCtx> = {
  meta: {
    id: 'question-withdrawn',
    contract: true,
    runs: 1,
    hypothesis: 'An interrupt while an `AskUserQuestion` `can_use_tool` is open sends `control_cancel_request` for that request id.',
  },
  async run(ctx) {
    ctx.onCanUseTool = (f) => ((f as Any).request?.tool_name === 'AskUserQuestion' ? undefined : (f as Any).request?.input);
    await ctx.send('Use the AskUserQuestion tool to ask me exactly one question, "Which color?", with the options "red" and "blue".');
    const req = (await ctx.precondition(
      (f) => ctx.is.control('can_use_tool')(f) && (f as Any).request?.tool_name === 'AskUserQuestion',
      120 * S,
      'the model asks with AskUserQuestion',
    )) as Any;
    await ctx.sleep(500);
    const t = Date.now();
    await ctx.interrupt();
    await ctx.expect((f) => f.type === 'control_cancel_request' && (f as Any).request_id === req.request_id, 15 * S, 'control_cancel_request for the open request');
    return { cancelAfterMs: Date.now() - t };
  },
};

const interrupt: Scenario<ProbeCtx> = {
  meta: {
    id: 'interrupt',
    contract: true,
    runs: 3,
    hypothesis: '`control_request {interrupt}` during a tool produces a `result` within 10 s (the bot’s CANCEL_GRACE_MS), and the process takes the next message.',
  },
  async run(ctx) {
    await ctx.send('Run the Bash command `sleep 20; echo PROBE-LATE`, then reply with its output.');
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model calls Bash');
    await ctx.sleep(1500);
    const t = Date.now();
    await ctx.interrupt();
    const r = (await ctx.expect(ctx.is.result, 10 * S, 'a result within 10 s of the interrupt')) as Any;
    const afterMs = Date.now() - t;
    await ctx.send('Reply with exactly: PROBE-AFTER');
    const r2 = await ctx.expect((f) => ctx.is.result(f) && f !== r, 90 * S, 'the next message gets its own result');
    return { afterMs, subtype: r.subtype, isError: r.is_error, next: resultTextOf(r2).slice(0, 40) };
  },
};

const resume: Scenario<ProbeCtx> = {
  meta: {
    id: 'resume',
    contract: true,
    runs: 1,
    hypothesis: 'After the process exits, `--resume` with the last `result`’s session id continues the conversation.',
  },
  async run(ctx) {
    await ctx.send('Remember the code word PROBE-ZEBRA-41. Reply with only: OK');
    const r1 = (await ctx.expect(ctx.is.result, 90 * S, 'a result')) as Any;
    const sid = String(r1.session_id);
    await ctx.close();
    await ctx.start({ resume: sid });
    await ctx.send('What was the code word I asked you to remember? Reply with only the code word.');
    const r2 = (await ctx.expect((f) => ctx.is.result(f) && f !== r1, 90 * S, 'a result after --resume')) as Any;
    ctx.check(resultTextOf(r2).includes('PROBE-ZEBRA-41'), 'the resumed session remembers the earlier turn');
    return { sameSessionId: r2.session_id === sid };
  },
};

const backgroundReport: Scenario<ProbeCtx> = {
  meta: {
    id: 'background-report',
    contract: true,
    runs: 3,
    hypothesis: 'A background Bash task that outlives its turn produces an unsolicited turn with its own `result` once it ends.',
  },
  async run(ctx) {
    await ctx.send(
      'Start the Bash command `sleep 8; echo PROBE-BG-DONE` in the background (run_in_background: true). Do not wait for it and do not check on it: reply right away with only: STARTED',
    );
    await ctx.precondition((f) => toolUses(f).some((b) => b.name === 'Bash' && b.input?.run_in_background === true), 90 * S, 'the model starts a background Bash');
    const r1 = await ctx.precondition(ctx.is.result, 60 * S, 'the turn ends before the task');
    const t = Date.now();
    const r2 = await ctx.expect((f) => ctx.is.result(f) && f !== r1, 90 * S, 'an unsolicited turn with its own result after the task ends');
    return { secondAfterMs: Date.now() - t, second: resultTextOf(r2).slice(0, 60) };
  },
};

const subagentParent: Scenario<ProbeCtx> = {
  meta: {
    id: 'subagent-parent',
    contract: true,
    runs: 1,
    hypothesis: 'A subagent’s events carry `parent_tool_use_id` equal to the id of the `Task` / `Agent` call that started it.',
  },
  async run(ctx) {
    await ctx.send('Use your subagent tool (Agent or Task) to have a subagent run the Bash command `echo PROBE-SUB` and report its output. Then reply with that output.');
    const call = await ctx.precondition((f) => toolUses(f).some((b) => b.name === 'Agent' || b.name === 'Task'), 120 * S, 'the model starts a subagent');
    const id = toolUses(call).find((b) => b.name === 'Agent' || b.name === 'Task')?.id;
    await ctx.expect((f) => (f as Any).parent_tool_use_id === id, 120 * S, 'subagent events carry the call’s id as parent_tool_use_id', { past: true });
    await ctx.precondition(ctx.is.result, 120 * S, 'the turn ends').catch(() => undefined); // for the cost only
    const name = toolUses(call).find((b) => b.id === id)?.name;
    return { toolName: name, subagentFrames: ctx.frames.filter((f) => (f as Any).parent_tool_use_id === id).length };
  },
};

const rateLimitEvent: Scenario<ProbeCtx> = {
  meta: {
    id: 'rate-limit-event',
    contract: true,
    runs: 1,
    hypothesis: '`rate_limit_event` carries the fields `src/ratelimit.ts` reads (status, resets, window type, windows).',
  },
  async run(ctx) {
    await ctx.send('Reply with only: OK');
    const ev = (await ctx.expect((f) => f.type === 'rate_limit_event', 60 * S, 'a rate_limit_event', { past: true })) as Any;
    const info = parseRateLimitEvent(ev);
    ctx.check(info && typeof info.status === 'string', 'the bot’s parser reads its status');
    return { fields: Object.keys(ev.rate_limit_info ?? {}).sort(), parsed: info ? Object.keys(info).filter((k) => k !== 'at').sort() : [] };
  },
};

export const CONTRACT: Scenario<ProbeCtx>[] = [turn, hostTool, askUserQuestion, questionWithdrawn, interrupt, resume, backgroundReport, subagentParent, rateLimitEvent];
