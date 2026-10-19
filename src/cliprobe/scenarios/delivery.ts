// How a message written to a busy session reaches it (agent-messaging design D12). The rows its delivery
// relies on are contract scenarios, judged on the frames (agent-messaging task 0.2): `fold-in`,
// `echo-at-take-up`, `echo-carries-uuid`, `interrupt-after-inject`, `kill-resume`,
// `background-tasks-changed`. Their replay tests through ClaudeSession come with the session's message
// ledger (agent-messaging 4.1/4.2). The rest are exploratory: they record facts for decisions and gate
// nothing. With `--replay-user-messages` every message the probe writes carries a fresh `uuid`, as the
// bot's ledger writes them.
import { randomUUID } from 'node:crypto';
import { LEDGER_ARGS } from '../../claudeSession.js';
import type { ProbeCtx } from '../ctx.js';
import type { Frame, Scenario } from '../types.js';
import { answeredIn, blocks, CAPITAL, CHAIN, kindOf, resultTextOf, SIDE, toolResults, toolUses } from './lib.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const S = 1000;
// The message ledger's flags: what a session with the ledger runs (claudeSession.ts LEDGER_ARGS).
const ECHO = { args: [...LEDGER_ARGS] };

/** The echo of the side message (and when it came), and when the last tool result before it came. */
function echoOf(ctx: ProbeCtx, country: string): { echoAt?: number; lastToolResultBefore?: number } {
  const echo = ctx.frames.find(ctx.is.replayOf(country));
  const echoAt = ctx.timeOf(echo);
  const before = ctx.frames.filter((f) => ctx.is.toolResult(f) && (echoAt === undefined || (ctx.timeOf(f) ?? 0) <= echoAt));
  return { echoAt, lastToolResultBefore: ctx.timeOf(before.at(-1)) };
}

/** Wait for the first result (the model's part), then give a second one `graceMs` to show up. */
async function results(ctx: ProbeCtx, firstMs: number, graceMs: number): Promise<void> {
  await ctx.precondition(ctx.is.result, firstMs, 'the turn finishes');
  await ctx.sleep(graceMs);
}

const chainPriority: Scenario<ProbeCtx> = {
  meta: {
    id: 'chain-priority',
    contract: false,
    runs: 1,
    variants: ['none', 'next', 'later', 'now'],
    extras: ECHO,
    hypothesis:
      'A message written while a tool chain runs: with no priority or `next` it is folded in at the next tool boundary and answered in the same result; `later` gets its own turn after the running one; `now` ends the turn at the boundary with an empty result, and a new turn answers.',
  },
  async run(ctx, v) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('France'), v === 'none' || !v ? {} : { priority: v as 'next' | 'later' | 'now' });
    await results(ctx, 150 * S, 20 * S);
    const w = answeredIn(ctx.results, 'France');
    const { echoAt } = echoOf(ctx, 'France');
    if (v === 'later') ctx.check(w.results === 2 && w.answeredIn === 2, `its own turn after the running one (results ${w.results}, answered in #${w.answeredIn})`);
    else if (v === 'now') ctx.check(w.results === 2 && w.emptyResults === 1 && w.answeredIn === 2, `an empty result, then a new turn answers (results ${w.results}, empty ${w.emptyResults}, answered in #${w.answeredIn})`);
    else ctx.check(w.results === 1 && w.answeredIn === 1, `folded into the running turn (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, echoAfterSendMs: echoAt === undefined ? null : echoAt - sentAt };
  },
};

const longTool: Scenario<ProbeCtx> = {
  meta: {
    id: 'long-tool',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'A message written during one long tool waits for the tool to finish: its echo follows the tool result, and one result answers both.',
  },
  async run(ctx) {
    await ctx.send('Run exactly one Bash command: `sleep 20; echo DONE`. Then reply with its output.');
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model runs the long command');
    await ctx.sleep(3000);
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('France'));
    await results(ctx, 120 * S, 15 * S);
    const w = answeredIn(ctx.results, 'France');
    const e = echoOf(ctx, 'France');
    ctx.check(e.echoAt !== undefined && e.lastToolResultBefore !== undefined, 'the echo follows the tool result');
    ctx.check(w.results === 1 && w.answeredIn === 1, `one result answers both (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, echoAfterSendMs: e.echoAt === undefined ? null : e.echoAt - sentAt };
  },
};

const twoInjects: Scenario<ProbeCtx> = {
  meta: {
    id: 'two-injects',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'Two messages written during a tool chain are both folded in at the next boundary and answered in the same result.',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'));
    await ctx.sleep(300);
    await ctx.send(SIDE('Italy'));
    await results(ctx, 150 * S, 20 * S);
    const fr = answeredIn(ctx.results, 'France');
    const it = answeredIn(ctx.results, 'Italy');
    ctx.check(fr.results === 1 && fr.answeredIn === 1 && it.answeredIn === 1, `both folded into the same result (results ${fr.results}, France #${fr.answeredIn}, Italy #${it.answeredIn})`);
    return { results: fr.results, replays: ctx.replays.length };
  },
};

const duringFinalText: Scenario<ProbeCtx> = {
  meta: {
    id: 'during-final-text',
    contract: false,
    runs: 1,
    extras: { args: ['--replay-user-messages', '--include-partial-messages'] },
    hypothesis: 'A message written while the final text streams (no tool left to run) is neither folded in nor lost: it gets its own turn after the running one.',
  },
  async run(ctx) {
    await ctx.send('Write a 300-word story about a lighthouse keeper. Do not use any tools.');
    await ctx.precondition((f) => f.type === 'stream_event' && (f as Any).event?.delta?.type === 'text_delta', 90 * S, 'the final text starts streaming');
    await ctx.send(SIDE('France'));
    await results(ctx, 120 * S, 25 * S);
    const w = answeredIn(ctx.results, 'France');
    ctx.check(w.results === 2 && w.answeredIn === 2, `its own turn after the running one (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w };
  },
};

const parallelTools: Scenario<ProbeCtx> = {
  meta: {
    id: 'parallel-tools',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'A message written while parallel tools run is folded in after all of their results.',
  },
  async run(ctx) {
    await ctx.send(
      'In ONE message, make two parallel Bash tool calls: `sleep 6; echo P1` and `sleep 6; echo P2`. Then make one more Bash call `sleep 3; echo P3`. Then reply with all outputs.',
    );
    // The CLI writes each content block as its own assistant frame; parallel calls share the message id.
    const parallel = (): boolean => {
      const byMessage = new Map<string, number>();
      for (const f of ctx.frames) for (const b of toolUses(f)) if (b.name === 'Bash') byMessage.set(String((f as Any).message?.id), (byMessage.get(String((f as Any).message?.id)) ?? 0) + 1);
      return [...byMessage.values()].some((n) => n >= 2);
    };
    await ctx.precondition(() => parallel(), 90 * S, 'the model makes two parallel calls');
    await ctx.sleep(1500);
    await ctx.send(SIDE('France'));
    await results(ctx, 150 * S, 20 * S);
    const w = answeredIn(ctx.results, 'France');
    const echoAt = ctx.timeOf(ctx.frames.find(ctx.is.replayOf('France')));
    const p = toolResults(ctx.frames).filter((r) => /P1|P2/.test(r.text)).length;
    const parallelResultsBeforeEcho = ctx.frames.filter((f) => ctx.is.toolResult(f) && (ctx.timeOf(f) ?? Infinity) <= (echoAt ?? -1)).length;
    ctx.check(p >= 2 && parallelResultsBeforeEcho >= 2, `the echo follows both parallel results (${parallelResultsBeforeEcho} before it)`);
    ctx.check(w.answeredIn === 1 && w.results === 1, `folded into the running turn (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, parallelResultsBeforeEcho };
  },
};

const subagentSync: Scenario<ProbeCtx> = {
  meta: {
    id: 'subagent-sync',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'A message written while a synchronous subagent runs reaches the parent after the subagent returns; the subagent never sees it.',
  },
  async run(ctx) {
    await ctx.send(
      'Use the Agent tool (a general-purpose subagent) with this task: "Run Bash `sleep 6; echo S1`, then Bash `sleep 6; echo S2`, then report both outputs." Pass run_in_background: false and wait for it. Do not run the commands yourself. When it returns, reply with its report.',
    );
    await ctx.precondition((f) => typeof (f as Any).parent_tool_use_id === 'string' && toolUses(f).length > 0, 90 * S, 'the subagent runs a tool');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'));
    await results(ctx, 180 * S, 20 * S);
    const echo = ctx.frames.find(ctx.is.replayOf('France')) as Any;
    const subSaw = ctx.frames.some((f) => (f as Any).parent_tool_use_id && !ctx.is.replayOf('France')(f) && JSON.stringify(f).includes('France'));
    const w = answeredIn(ctx.results, 'France');
    ctx.check(!subSaw, 'the subagent never sees it');
    ctx.check(w.answeredIn >= 1, 'the parent answers it');
    return { ...w, echoHadParent: Boolean(echo?.parent_tool_use_id) };
  },
};

const subagentBackground: Scenario<ProbeCtx> = {
  meta: {
    id: 'subagent-background',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'With a background subagent (the default) the parent turn ends at once; a message then gets its own turn, and the subagent’s report comes as an unsolicited turn.',
  },
  async run(ctx) {
    await ctx.send(
      'Use the Agent tool (a general-purpose subagent, in the background) with this task: "Run Bash `sleep 10; echo S1` and report the output." Then end your turn; relay the report when it arrives.',
    );
    const first = await ctx.precondition(ctx.is.result, 90 * S, 'the parent turn ends');
    await ctx.send(SIDE('France'));
    await ctx.expect((f) => ctx.is.result(f) && f !== first && resultTextOf(f).includes(CAPITAL.France!), 90 * S, 'the message gets its own turn');
    await ctx.expect((f) => ctx.is.result(f) && /S1/.test(resultTextOf(f)), 120 * S, 'the report comes as an unsolicited turn', { past: true });
    return { results: ctx.results.length };
  },
};

const pendingPermission: Scenario<ProbeCtx> = {
  meta: {
    id: 'pending-permission',
    contract: false,
    runs: 1,
    extras: ECHO,
    hypothesis: 'A message written while a permission request (AskUserQuestion) is pending waits for the answer and the tool’s result, then is folded in.',
  },
  async run(ctx) {
    let answeredAt = 0;
    ctx.onCanUseTool = async (f) => {
      const req = (f as Any).request;
      if (req.tool_name !== 'AskUserQuestion') return req.input;
      await ctx.sleep(500);
      await ctx.send(SIDE('France'));
      await ctx.sleep(5000);
      answeredAt = ctx.elapsed();
      const qs: Any[] = req.input?.questions ?? [];
      return { ...req.input, answers: Object.fromEntries(qs.map((q) => [q.question, q.options?.[0]?.label ?? 'red'])) };
    };
    await ctx.send(
      'Use the AskUserQuestion tool to ask me exactly one question, "Which color?", with the options "red" and "blue". After my answer, run the Bash command `echo PERM-DONE`, then reply with my color and the command output.',
    );
    await ctx.precondition((f) => ctx.is.control('can_use_tool')(f) && (f as Any).request?.tool_name === 'AskUserQuestion', 120 * S, 'the model asks');
    await results(ctx, 150 * S, 20 * S);
    const echoAt = ctx.timeOf(ctx.frames.find(ctx.is.replayOf('France')));
    const w = answeredIn(ctx.results, 'France');
    ctx.check(echoAt !== undefined && echoAt >= answeredAt, 'the echo comes after the answer');
    ctx.check(w.answeredIn === 1 && w.results === 1, `folded into the running turn (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, echoAfterAnswerMs: echoAt === undefined ? null : echoAt - answeredAt };
  },
};

const interruptAfterInject: Scenario<ProbeCtx> = {
  meta: {
    id: 'interrupt-after-inject',
    contract: true,
    runs: 3,
    extras: ECHO,
    hypothesis: 'A message written just before an interrupt is kept: the interrupted turn ends with `error_during_execution`, and the message runs as its own turn.',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'));
    await ctx.sleep(300);
    await ctx.interrupt();
    const first = (await ctx.expect(ctx.is.result, 30 * S, 'the interrupted turn ends')) as Any;
    const firstAt = ctx.timeOf(first) ?? 0;
    // Kept: taken up after the interrupt (its echo), and answered by a turn of its own.
    await ctx.expect((f) => ctx.is.replayOf('France')(f) && (ctx.timeOf(f) ?? 0) >= firstAt, 60 * S, 'the message is taken up after the interrupt');
    const own = await ctx.expect((f) => ctx.is.result(f) && f !== first, 90 * S, 'the message runs as its own turn');
    ctx.check(first.subtype === 'error_during_execution', `the interrupted turn ends with error_during_execution (got ${String(first.subtype)})`);
    return { results: ctx.results.length, subtypes: ctx.results.map((r) => (r as Any).subtype), answeredInOwnTurn: resultTextOf(own).includes(CAPITAL.France!) };
  },
};

const killResume: Scenario<ProbeCtx> = {
  meta: {
    id: 'kill-resume',
    contract: true,
    runs: 3,
    extras: ECHO,
    hypothesis: 'A message written but not yet taken up is lost when the process is killed: after `--resume` it is not in the conversation.',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    await ctx.send(SIDE('France'));
    await ctx.sleep(500);
    const sid = ctx.sessionId;
    ctx.require(sid, 'a session id before the kill');
    const echoedBeforeKill = ctx.frames.some(ctx.is.replayOf('France'));
    await ctx.restart({ resume: sid });
    await ctx.send('Quote verbatim every message in this conversation that mentions a capital city or a country, or say NONE.');
    const r = await ctx.precondition(ctx.is.result, 120 * S, 'the resumed session answers');
    ctx.require(!echoedBeforeKill, 'the message was not taken up before the kill');
    ctx.check(!resultTextOf(r).includes('France'), 'the message is not in the resumed conversation');
    return { answer: resultTextOf(r).slice(0, 120) };
  },
};

const backgroundTasksChanged: Scenario<ProbeCtx> = {
  meta: {
    id: 'background-tasks-changed',
    contract: true,
    runs: 1,
    hypothesis: '`system/background_tasks_changed` lists the running background tasks, then `[]` when the last one ends.',
  },
  async run(ctx) {
    await ctx.send('Start the Bash command `sleep 6; echo BG` in the background (run_in_background: true) and reply right away with only: STARTED');
    await ctx.precondition((f) => toolUses(f).some((b) => b.name === 'Bash' && b.input?.run_in_background === true), 90 * S, 'the model starts a background Bash');
    const tasks = (f: Frame): unknown[] | undefined => (f.type === 'system' && f.subtype === 'background_tasks_changed' ? ((f as Any).tasks as unknown[]) : undefined);
    await ctx.expect((f) => (tasks(f)?.length ?? 0) > 0, 30 * S, 'a list with the running task', { past: true });
    await ctx.expect((f) => Array.isArray(tasks(f)) && tasks(f)!.length === 0, 60 * S, 'an empty list when it ends', { past: true });
    return { changes: ctx.frames.filter((f) => tasks(f)).map((f) => tasks(f)!.length) };
  },
};

const foldIn: Scenario<ProbeCtx> = {
  meta: {
    id: 'fold-in',
    contract: true,
    runs: 3,
    extras: ECHO,
    hypothesis:
      'A message written (no priority) while a tool of a chain runs is folded into the running turn at the next tool boundary: its echo comes between a tool result and the turn’s only `result`.',
  },
  async run(ctx) {
    await ctx.send(CHAIN);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model starts the chain');
    await ctx.sleep(1000);
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('France'));
    const echo = await ctx.expect(ctx.is.replayOf('France'), 60 * S, 'the message is taken up (echoed)');
    const echoAt = ctx.timeOf(echo) ?? 0;
    const result = await ctx.precondition(ctx.is.result, 150 * S, 'the turn finishes');
    await ctx.sleep(15 * S);
    const toolResultsBefore = ctx.frames.filter((f) => ctx.is.toolResult(f) && (ctx.timeOf(f) ?? Infinity) <= echoAt).length;
    ctx.check(toolResultsBefore >= 1, 'the echo comes at a tool boundary (after a tool result)');
    ctx.check(echoAt <= (ctx.timeOf(result) ?? 0), 'the echo comes before the turn’s result');
    ctx.check(ctx.results.length === 1, `the turn has one result (got ${ctx.results.length})`);
    return { echoAfterSendMs: echoAt - sentAt, toolResultsBeforeEcho: toolResultsBefore, answeredInTurn: resultTextOf(result).includes(CAPITAL.France!) };
  },
};

const echoAtTakeUp: Scenario<ProbeCtx> = {
  meta: {
    id: 'echo-at-take-up',
    contract: true,
    runs: 3,
    extras: ECHO,
    hypothesis: 'The echo (`--replay-user-messages`) of a message written while a tool runs comes when the CLI takes it up — after that tool’s result — not when it is written.',
  },
  async run(ctx) {
    await ctx.send('Run exactly one Bash command: `sleep 10; echo DONE`. Then reply with its output.');
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model runs the command');
    await ctx.sleep(2000);
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('Italy'));
    const echo = await ctx.expect(ctx.is.replayOf('Italy'), 60 * S, 'the message is echoed');
    const echoAt = ctx.timeOf(echo) ?? 0;
    const toolResultAt = ctx.timeOf(ctx.frames.find((f) => ctx.is.toolResult(f)));
    ctx.check(toolResultAt !== undefined && toolResultAt <= echoAt, 'the echo comes after the running tool’s result');
    ctx.check(echoAt - sentAt > 3000, `the echo does not come at write time (it came ${echoAt - sentAt} ms after the write)`);
    await ctx.precondition(ctx.is.result, 120 * S, 'the turn finishes');
    return { echoAfterSendMs: echoAt - sentAt, echoAfterToolResultMs: toolResultAt === undefined ? null : echoAt - toolResultAt };
  },
};

const echoCarriesUuid: Scenario<ProbeCtx> = {
  meta: {
    id: 'echo-carries-uuid',
    contract: true,
    runs: 3,
    extras: ECHO,
    hypothesis:
      'A message written with a `uuid` is echoed with that `uuid`: the message that starts a turn when the CLI starts it, and a message written mid-tool when it is taken up. The message ledger tells its messages apart by it (agent-messaging D13).',
  },
  async run(ctx) {
    const first = randomUUID();
    const side = randomUUID();
    await ctx.send('Run exactly one Bash command: `sleep 6; echo DONE`. Then reply with its output.', { uuid: first });
    const e1 = (await ctx.expect(ctx.is.replayOf('sleep 6; echo DONE'), 60 * S, 'the turn’s message is echoed')) as Any;
    ctx.check(e1.uuid === first, `the turn’s echo carries the written uuid (got ${String(e1.uuid)})`);
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model runs the command', { past: true });
    await ctx.sleep(1000);
    await ctx.send(SIDE('Spain'), { uuid: side });
    const e2 = (await ctx.expect(ctx.is.replayOf('Spain'), 60 * S, 'the side message is echoed')) as Any;
    ctx.check(e2.uuid === side, `the side message’s echo carries its uuid (got ${String(e2.uuid)})`);
    const others = ctx.replays.filter((f) => (f as Any).uuid === first || (f as Any).uuid === side).length;
    ctx.check(others === 2, `each uuid is echoed once (got ${others} echoes with them)`);
    await ctx.precondition(ctx.is.result, 120 * S, 'the turn finishes');
    return { turnEchoCarriesUuid: e1.uuid === first, sideEchoCarriesUuid: e2.uuid === side };
  },
};

const finalTextRace: Scenario<ProbeCtx> = {
  meta: {
    id: 'final-text-race',
    contract: false,
    runs: 3,
    variants: ['0ms', '400ms'],
    extras: { args: ['--replay-user-messages', '--include-partial-messages'] },
    hypothesis:
      'A message written right after the last tool result is not folded into that turn, even before the final text starts: it gets its own turn after the running one.',
  },
  async run(ctx, v) {
    await ctx.send('Run exactly one Bash command: `sleep 3; echo ONE`. Then reply with only its output.');
    await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model runs the command');
    const tr = await ctx.precondition(ctx.is.toolResult, 60 * S, 'the tool result');
    await ctx.sleep(Number.parseInt(v ?? '0', 10));
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('Spain'));
    await ctx.precondition(ctx.is.result, 90 * S, 'the turn finishes');
    await ctx.sleep(20 * S);
    const textStarted = ctx.frames.some((f) => f.type === 'stream_event' && (f as Any).event?.delta?.type === 'text_delta' && (ctx.timeOf(f) ?? Infinity) < sentAt);
    const w = answeredIn(ctx.results, 'Spain');
    ctx.check(w.results === 2 && w.answeredIn === 2, `its own turn after the running one (results ${w.results}, answered in #${w.answeredIn})`);
    return { ...w, textStartedBeforeSend: textStarted, sentAfterToolResultMs: sentAt - (ctx.timeOf(tr) ?? 0) };
  },
};

const foldInOpus: Scenario<ProbeCtx> = {
  meta: {
    id: 'fold-in-opus',
    contract: false,
    runs: 3,
    model: 'fleet',
    extras: ECHO,
    timeoutMs: 6 * 60 * S,
    hypothesis: 'On the fleet’s model, in a long turn over a grown context, a message written mid-chain still folds in at the next tool boundary (one result).',
  },
  async run(ctx) {
    await ctx.send(
      'First run the Bash command `seq 1 2500 | sed "s/^/context line /"` and read its output. Then run these Bash commands strictly one after another: `sleep 4; echo B1`, `sleep 4; echo B2`, `sleep 4; echo B3`, `sleep 4; echo B4`, `sleep 4; echo B5`. Then reply with the five outputs and the last context line number.',
    );
    await ctx.precondition((f) => ctx.is.toolUse('Bash')(f) && JSON.stringify(f).includes('sleep 4; echo B2'), 180 * S, 'the model reaches the second step of the chain');
    await ctx.sleep(1000);
    const sentAt = ctx.elapsed();
    await ctx.send(SIDE('Japan'));
    const echo = await ctx.expect(ctx.is.replayOf('Japan'), 90 * S, 'the message is taken up');
    await ctx.precondition(ctx.is.result, 240 * S, 'the turn finishes');
    await ctx.sleep(15 * S);
    const w = answeredIn(ctx.results, 'Japan');
    ctx.check(w.results === 1, `the turn has one result (got ${w.results})`);
    return { ...w, echoAfterSendMs: (ctx.timeOf(echo) ?? 0) - sentAt };
  },
};

// The idle stop (OpenSpec sandbox-idle-stop, design D4) waits for a pending ScheduleWakeup until it is
// due, and reads the call and its result off the stream: `delaySeconds` on the tool_use, `scheduledFor`
// on the tool result's `tool_use_result` (shapes as Claude Code writes them in its transcripts). What a
// headless stream-json session does with it is recorded here: those fields, whether the pending wakeup
// is listed by `background_tasks_changed` (then it would linger as a background task as well), and
// whether it fires at all — as a turn of the CLI's own with no message written, like a background
// completion. The minimum delay is 60 s, aligned to the minute: up to two minutes of waiting.
const scheduleWakeup: Scenario<ProbeCtx> = {
  meta: {
    id: 'schedule-wakeup',
    contract: false,
    runs: 1,
    timeoutMs: 5 * 60 * S,
    hypothesis:
      'A ScheduleWakeup in a headless session schedules a wakeup whose tool result carries `scheduledFor`; it is not listed in `background_tasks_changed`; when due, the CLI runs a turn of its own (`system/init` … `result`) with no message written.',
  },
  async run(ctx) {
    await ctx.send('Call the ScheduleWakeup tool once with delaySeconds 60, reason "probe" and prompt "Reply with only: WOKE". Then reply with only: SCHEDULED');
    const use = await ctx.precondition(ctx.is.toolUse('ScheduleWakeup'), 90 * S, 'the model calls ScheduleWakeup');
    const id = String(toolUses(use).find((b) => b.name === 'ScheduleWakeup')?.id ?? '');
    const first = await ctx.precondition(ctx.is.result, 90 * S, 'the turn finishes');
    const toolResult = ctx.frames.find((f) => f.type === 'user' && blocks(f).some((b) => b?.type === 'tool_result' && b.tool_use_id === id)) as Any;
    const woke = await ctx.expect((f) => ctx.is.result(f) && resultTextOf(f).includes('WOKE'), 200 * S, 'the wakeup runs a turn of its own');
    const between = ctx.frames.slice(ctx.frames.indexOf(first) + 1, ctx.frames.indexOf(woke));
    ctx.check(between.some(ctx.is.init), 'the woken turn starts with system/init');
    const listed = ctx.frames.some((f) => f.type === 'system' && f.subtype === 'background_tasks_changed' && (((f as Any).tasks as unknown[]) ?? []).length > 0);
    return {
      toolUseResultKeys: Object.keys(toolResult?.tool_use_result ?? {}).sort(),
      scheduledForIsNumber: typeof toolResult?.tool_use_result?.scheduledFor === 'number',
      listedInBackgroundTasks: listed,
      firedAfterMs: (ctx.timeOf(woke) ?? 0) - (ctx.timeOf(first) ?? 0),
    };
  },
};

const taskNotificationMidTurn: Scenario<ProbeCtx> = {
  meta: {
    id: 'task-notification-mid-turn',
    contract: false,
    runs: 3,
    extras: ECHO,
    hypothesis:
      'A background task that ends while the turn still runs is reported into that turn: a `<task-notification>` message is taken up at a tool boundary before the turn’s result (claude-code#102220 reports that in headless mode it never is).',
  },
  async run(ctx) {
    await ctx.send(
      'Start the Bash command `sleep 4; echo BG-NOTE-77` in the background (run_in_background: true). Do not check on it with any tool. Then run these Bash commands strictly one after another: `sleep 5; echo F1`, `sleep 5; echo F2`, `sleep 5; echo F3`. Then reply with all outputs you have seen, including any output of the background command.',
    );
    await ctx.precondition((f) => toolUses(f).some((b) => b.name === 'Bash' && b.input?.run_in_background === true), 90 * S, 'the model starts the background command');
    const result = await ctx.precondition(ctx.is.result, 150 * S, 'the turn finishes');
    await ctx.sleep(10 * S);
    const resultAt = ctx.timeOf(result) ?? 0;
    const notified = ctx.frames.filter((f) => f.type === 'system' && f.subtype === 'task_notification' && (ctx.timeOf(f) ?? Infinity) < resultAt).length;
    const checkedWithTool = ctx.frames.flatMap(toolUses).some((b) => /BashOutput|TaskOutput/.test(String(b.name)));
    ctx.require(!checkedWithTool, 'the model did not check on the task with a tool');
    // The CLI's own frame, not the model's reply: the notification queued as a user message of the turn,
    // echoed when it is taken up (on 2.1.282 it comes as a replay, with an `origin`).
    const injected = ctx.frames.find((f) => f.type === 'user' && typeof (f as Any).message?.content === 'string' && (f as Any).message.content.includes('<task-notification>'));
    const injectedAt = ctx.timeOf(injected);
    ctx.check(injectedAt !== undefined && injectedAt < resultAt, 'a <task-notification> message is taken up before the turn’s result');
    const afterToolResult = ctx.frames.some((f) => ctx.is.toolResult(f) && (ctx.timeOf(f) ?? Infinity) <= (injectedAt ?? -1));
    return {
      notificationsBeforeResult: notified,
      takenUpAfterToolResult: afterToolResult,
      echoed: Boolean((injected as Any)?.isReplay),
      origin: (injected as Any)?.origin ?? null,
      modelQuotedOutput: resultTextOf(result).includes('BG-NOTE-77'),
    };
  },
};

function eventKinds(id: string, extras: { args: string[]; settings?: Record<string, unknown> }, hypothesis: string, hooks: boolean): Scenario<ProbeCtx> {
  return {
    meta: { id, contract: false, runs: 1, extras, hypothesis },
    async run(ctx) {
      await ctx.send('Use the Bash tool once: `sleep 4; echo X1`. Then reply with its output in one line.');
      await ctx.precondition(ctx.is.toolUse('Bash'), 90 * S, 'the model runs Bash');
      await ctx.sleep(800);
      const from = ctx.frames.length;
      await ctx.send(SIDE('Italy'));
      await results(ctx, 90 * S, 8 * S);
      const after = ctx.frames.slice(from).filter((f) => !(f.type === 'stream_event' && (f as Any).event?.type === 'content_block_delta'));
      // Hook frames name their event `hook_event` (2.1.282) or `hook_event_name`.
      const hookEvent = (f: Frame): string | undefined => (f as Any).hook_event ?? (f as Any).hook_event_name;
      const label = (f: Frame): string => `${kindOf(f)}${hookEvent(f) ? `:${hookEvent(f)}` : ''}${(f as Any).isReplay ? ' (replay)' : ''}`;
      const sequence = after.map(label);
      const echo = sequence.findIndex((k) => k.includes('(replay)'));
      ctx.check(echo >= 0, 'the injected message is echoed');
      const toolResult = after.findIndex((f) => ctx.is.toolResult(f));
      ctx.check(toolResult >= 0 && toolResult < echo, 'the echo comes after the tool result');
      if (hooks) {
        const hook = sequence.findIndex((k, i) => i < echo && k.includes('UserPromptSubmit'));
        ctx.check(hook >= 0 && hook > toolResult, 'the UserPromptSubmit hook fires at the boundary, before the echo');
      }
      const hist: Record<string, number> = {};
      for (const f of ctx.frames) hist[kindOf(f)] = (hist[kindOf(f)] ?? 0) + 1;
      return { untilEcho: sequence.slice(0, echo + 2), kinds: hist };
    },
  };
}

const HOOKS = {
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
  },
};

export const DELIVERY: Scenario<ProbeCtx>[] = [
  foldIn,
  echoAtTakeUp,
  echoCarriesUuid,
  chainPriority,
  longTool,
  twoInjects,
  duringFinalText,
  parallelTools,
  subagentSync,
  subagentBackground,
  pendingPermission,
  interruptAfterInject,
  killResume,
  backgroundTasksChanged,
  finalTextRace,
  foldInOpus,
  taskNotificationMidTurn,
  scheduleWakeup,
  eventKinds('event-kinds', ECHO, 'The echo of a message written mid-tool comes after that tool’s result.', false),
  eventKinds(
    'event-kinds-hooks',
    { args: ['--replay-user-messages', '--include-hook-events', '--include-partial-messages'], settings: HOOKS },
    'With hooks configured, the UserPromptSubmit hook fires for an injected message at the tool boundary, right before its echo.',
    true,
  ),
];
