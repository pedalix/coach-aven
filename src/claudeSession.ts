import type { SandboxHandle } from './driver.js';
import { CC_TOKEN_ENV } from './project.js';
import { narrationLabel } from './format.js';
import { stepLabel } from './steps.js';

// Single-quote a string for safe embedding in a bash command.
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// AskUserQuestion tool shape (verified against the live CLI). The agent asks one or
// more questions; we answer via control_response allow+updatedInput.answers, keyed by
// question TEXT → chosen label(s) (multi-select: labels comma-joined, per Happy).
import { parseRateLimitEvent, type RateLimitInfo } from './ratelimit.js';
import { CLI_PATH_ENV } from './cliversion.js';
import { log } from './log.js';
import { scrubSummary, scrubText } from './scrub.js';
import { ATTRIBUTION_SETTINGS, GIT_EMAIL, GIT_NAME, gitIdentityEnv } from './gitidentity.js';
import type { HostServerRoute, JsonRpc } from './hosttools.js';

// The CLI's command line for one session — the ONE place the bot's flags live. ClaudeSession runs
// `command(cwd)` in the sandbox; the CLI probe (src/cliprobe/, OpenSpec `cli-probe`) spawns the same
// `args` with the same `env` locally, or runs the same `command(cwd)` in a throwaway sandbox, so a
// probe always tests what the bot runs. `settings` and `extraArgs` are the probe's instruments (hooks,
// --replay-user-messages, …); the bot passes neither, and its command stays byte-identical
// (claudeSession.test.ts pins it).
export interface ClaudeLaunchOpts {
  model?: string;
  mcpConfigPath?: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  avenSession?: string;
  // Merged into the single --settings JSON beside the attribution settings.
  settings?: Record<string, unknown>;
  // Appended after the bot's own flags.
  extraArgs?: readonly string[];
}
export interface ClaudeLaunch {
  // The variables every spawn sets besides PATH and the token: behaviour + git identity (+ AVEN_SESSION).
  env: Record<string, string>;
  // The flags, as argv (no binary).
  args: string[];
  // The sandbox command line: cd, the pinned CLI first on PATH, the token from its file, env, claude + flags.
  command(cwd: string): string;
}
export function claudeLaunch(o: ClaudeLaunchOpts): ClaudeLaunch {
  const settings = o.settings ? { ...ATTRIBUTION_SETTINGS, ...o.settings } : ATTRIBUTION_SETTINGS;
  const extra = o.extraArgs ?? [];
  // No positional prompt → persistent mode (turns stream in via stdin). --verbose is
  // mandatory with stream-json. --strict-mcp-config ignores the repo's own .mcp.json;
  // --mcp-config adds ONLY our per-project servers (e.g. Grafana). Without it,
  // --strict-mcp-config = no servers.
  // BOTH --dangerously-skip-permissions AND --permission-prompt-tool stdio: verified
  // to coexist — normal tools auto-run (bypass, no round-trip) while AskUserQuestion
  // STILL fires a can_use_tool control_request we answer (→ Slack buttons).
  // --settings attribution: commits and PRs credit coach-aven[bot] (gitidentity.ts).
  const args = [
    '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--permission-prompt-tool', 'stdio', '--strict-mcp-config',
    '--settings', JSON.stringify(settings),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.mcpConfigPath ? ['--mcp-config', o.mcpConfigPath] : []),
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
    ...(o.systemPrompt ? ['--append-system-prompt', o.systemPrompt] : []),
    ...extra,
  ];
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: GIT_NAME,
    GIT_AUTHOR_EMAIL: GIT_EMAIL,
    GIT_COMMITTER_NAME: GIT_NAME,
    GIT_COMMITTER_EMAIL: GIT_EMAIL,
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
    ...(o.avenSession ? { AVEN_SESSION: o.avenSession } : {}),
  };
  const command = (cwd: string): string => {
    const resume = o.resumeSessionId ? `--resume ${o.resumeSessionId} ` : '';
    const sys = o.systemPrompt ? `--append-system-prompt ${sq(o.systemPrompt)} ` : '';
    const mcp = o.mcpConfigPath ? `--mcp-config ${sq(o.mcpConfigPath)} ` : '';
    const model = o.model ? `--model ${sq(o.model)} ` : '';
    return (
      // CLI_PATH_ENV: the pinned per-sandbox Claude Code (cliversion.ts) wins over the image's.
      // gitIdentityEnv + --settings attribution: commits are authored by and credit
      // coach-aven[bot], whatever identity the agent tries to pass (gitidentity.ts).
      `cd ${sq(cwd)} && ${CLI_PATH_ENV} ${CC_TOKEN_ENV} ${gitIdentityEnv()} IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 ` +
      (o.avenSession ? `AVEN_SESSION=${sq(o.avenSession)} ` : '') +
      `claude --output-format stream-json --input-format stream-json --verbose ` +
      `--dangerously-skip-permissions --permission-prompt-tool stdio --strict-mcp-config ` +
      `--settings ${sq(JSON.stringify(settings))} ${model}${mcp}${resume}${sys}` +
      extra.map((a) => `${sq(a)} `).join('')
    );
  };
  return { env, args, command };
}

// The frames the bot writes to the CLI's stdin, as pure functions: ClaudeSession writes them, and the
// CLI probe writes the very same ones, so a probe's recording shows what the bot sends (key order
// included — JSON.stringify keeps it, and the probe's recordings are compared as text).
export const userFrame = (content: string) => ({ type: 'user', message: { role: 'user', content } });
export const interruptFrame = (requestId = `int-${Date.now()}`) => ({
  request_id: requestId,
  type: 'control_request',
  request: { subtype: 'interrupt' },
});
// Register the bot-served MCP servers (`initialize` with `sdkMcpServers`), exactly as the Agent SDK does.
export function initializeFrame(servers: readonly HostServerRoute[], requestId = `init-${Date.now()}`) {
  const sdkMcpServerConfigs: Record<string, { timeout: number }> = {};
  for (const s of servers) if (s.timeoutMs) sdkMcpServerConfigs[s.name] = { timeout: s.timeoutMs };
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'initialize', sdkMcpServers: servers.map((s) => s.name), sdkMcpServerConfigs },
  };
}
// Answer a can_use_tool request: allow, with the (possibly answered) input.
export const allowFrame = (requestId: unknown, updatedInput: unknown) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput } },
});
// Answer a control_request{mcp_message} for a bot-served server: the server's JSON-RPC reply in
// `mcp_response`; a notification is acknowledged the way the SDK does; an unknown server is an error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mcpAnswerFrame(ev: any, routes: readonly HostServerRoute[]): Promise<Record<string, unknown>> {
  const requestId = ev.request_id;
  const serverName = String(ev.request?.server_name ?? '');
  const message = ev.request?.message as JsonRpc | undefined;
  const route = routes.find((s) => s.name === serverName);
  const success = (mcp_response: unknown) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { mcp_response } } });
  if (!route || !message || typeof message !== 'object') {
    return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `no host server "${serverName}" in this session` } };
  }
  if (message.id === undefined || message.id === null) {
    try {
      await route.handle(message);
    } catch {
      /* a notification has no error channel */
    }
    return success({ jsonrpc: '2.0', result: {}, id: 0 });
  }
  let reply: JsonRpc | undefined;
  try {
    reply = await route.handle(message);
  } catch (e) {
    reply = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
  }
  return success(reply ?? { jsonrpc: '2.0', id: message.id, result: {} });
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}
export type QuestionAnswers = Record<string, string>; // question text → label(s)
// signal aborts THIS question specifically (claude withdrew its can_use_tool) — distinct
// from the turn-level cancel the consumer may also listen to.
export type OnQuestion = (questions: AskQuestion[], signal?: AbortSignal) => Promise<QuestionAnswers>;

export interface TurnResult {
  status: 'ok' | 'canceled' | 'timeout' | 'error' | 'busy';
  resultText: string;
  isError: boolean;
  // Whether the turn produced ANY output before ending. A turn that died with
  // started=false never ran tools → safe to auto-retry; started=true may have already
  // mutated the repo → must NOT be blindly re-sent (avoids double-apply).
  started: boolean;
  // Token/cost accounting from the `result` event (absent on timeout/cancel-without-
  // result and on older CLIs). Consumed by the usage metering (metering.ts).
  usage?: TurnUsage;
}

// Shape shared with metering.ts (declared here to keep this file's imports one-way).
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  // This turn's own cost: the CHANGE in the CLI's running total since the previous
  // `result` of the same process (CostDelta). The token fields above are per turn on the
  // wire; the dollar figure is not — see costUsdCumulative.
  costUsd?: number;
  // The CLI's `total_cost_usd` as received: everything this process has spent so far, not
  // this turn. Kept raw so a record can always be re-derived — and because its presence is
  // what tells metering.ts the record was written with per-turn cost (records from before
  // the fix carry the running total in costUsd and nothing here).
  costUsdCumulative?: number;
}

// Claude Code's `result.total_cost_usd` is the PROCESS's running total — every turn of a
// persistent session reports all the money the process has spent so far. From v0.22.0 it
// was recorded verbatim and summed per turn, which overstated ~2× (a canceled zero-token
// turn carried the previous turn's exact figure). This turns the running total into a
// per-turn delta. One instance per ClaudeSession = per CLI process: a fresh spawn starts
// at 0 (a `--resume`d process starts its own counter at 0 too — in the home bot's usage
// log the first turn after a restart reads below the previous process's total), a reattach
// seeds it from the replayed log (parseSnapshot), and it restarts when the counter runs
// backwards (a reset we did not see coming) or when the conversation id changes.
export class CostDelta {
  private last = 0;
  private sessionId?: string;

  // Per-turn cost for a `result` whose total_cost_usd is `cumulative`.
  next(cumulative: number, sessionId?: string): number {
    if (sessionId && this.sessionId && sessionId !== this.sessionId) this.last = 0; // another conversation → another counter
    if (sessionId) this.sessionId = sessionId;
    const delta = cumulative < this.last ? cumulative : cumulative - this.last;
    this.last = cumulative;
    return delta;
  }
}

// Pull the token counters out of a `result` event, defensively — every field is
// optional on the wire and shapes have drifted across CLI versions. `costs` is the
// process's running-total tracker (CostDelta): it must see every `result` of the process,
// in order, or the next delta is wrong.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageOf(ev: any, costs: CostDelta): TurnUsage | undefined {
  const u = ev?.usage;
  const cumulative = typeof ev?.total_cost_usd === 'number' ? ev.total_cost_usd : undefined;
  if (!u && cumulative === undefined) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return {
    inputTokens: num(u?.input_tokens),
    outputTokens: num(u?.output_tokens),
    cacheCreationTokens: num(u?.cache_creation_input_tokens),
    cacheReadTokens: num(u?.cache_read_input_tokens),
    costUsd: cumulative === undefined ? undefined : costs.next(cumulative, typeof ev.session_id === 'string' ? ev.session_id : undefined),
    costUsdCumulative: cumulative,
  };
}

// Two-stage turn watchdog. STREAM_MAX_MS is the SOFT deadline: a turn that long is
// almost always legitimately large work (multi-repo change, full test suite), not a hang
// — so when the caller wired onLongRunning we notify once ("still working…") and keep
// waiting. STREAM_HARD_MAX_MS is the real kill: past it the process state is unknown, so
// the turn dies and the session is retired. Callers that did NOT wire onLongRunning keep
// the old kill-at-soft behavior — a silent 60-minute wait would be worse than the error.
const STREAM_MAX_MS = (Number(process.env.STREAM_MAX_MINUTES) || 15) * 60_000;
const STREAM_HARD_MAX_MS = (Number(process.env.STREAM_HARD_MAX_MINUTES) || 60) * 60_000;
const CANCEL_GRACE_MS = 10_000; // after interrupt, wait this long for the canceled result

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  onStep?: (s: string) => void;
  onQuestion?: OnQuestion;
  // Fires ONCE when the turn outlives the soft deadline — the turn then continues to the
  // hard cap instead of being killed (→ "still working, result will follow" in Slack).
  onLongRunning?: () => void;
  settled: boolean;
  canceled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

// A persistent `claude` process driven over Daytona stdin/stdout in bidirectional
// stream-json mode (the Happy model). Spawn ONCE; push user turns to stdin; read NDJSON
// events from stdout; the `result` event marks turn completion and the process stays
// alive for the next turn. Cancel via a control_request{interrupt} written to stdin —
// NEVER by killing the process (killing corrupts the conversation + zombies the cmd).
export class ClaudeSession {
  private sessionKey: string;
  private cmdId?: string;
  private buf = '';
  private claudeSessionId?: string;
  private pending?: PendingTurn;
  private dead = false;
  private turnStarted = false; // did the current turn emit any output yet?
  // can_use_tool requests still awaiting our reply → AbortControllers so a
  // control_cancel_request can abort the matching pending question (Slack buttons).
  private inflightTools = new Map<string, AbortController>();
  // Subagents spawned by the CURRENT turn: Task/Agent tool_use id → spawn order (1-based).
  // Their stream events carry that id as parent_tool_use_id, so their steps get an ↳N
  // prefix and stay attributable when several subagents run in parallel. Reset per turn.
  private subagents = new Map<string, number>();
  // On reattach: the last turn's result if the conversation was already idle in the
  // snapshot (the turn completed during the bot's downtime). Consumed once by adoptInflight.
  private snapshotResult?: TurnResult;
  // On reattach: a can_use_tool request (AskUserQuestion) the OLD bot never answered — its
  // Slack buttons died with that process, so claude is waiting for a control_response that
  // will never come. adoptInflight dismisses it so the turn can finish instead of hanging
  // to the runtime watchdog (whose kill also retires the whole session).
  private snapshotPendingTool?: { requestId: string; input: unknown };
  // On reattach: an mcp_message (a host tool call) the OLD bot never answered — served for real
  // by adoptInflight, since this process holds the same routes; a tool with an effect (propose)
  // is idempotent on its id, so a reply the old bot did get out is harmless.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private snapshotPendingMcp?: any;
  private attached = false; // opened by reattaching to a running command (vs fresh spawn)
  // Running total → per-turn cost for THIS process; fed every `result` we see, in order.
  private readonly costs = new CostDelta();
  // Every stdin write goes through this chain, one at a time. A host tool answer can be tens of KB
  // (a sources page) and the agent may call tools in parallel; on ssh-docker each write is its own
  // `cat > fifo` process, and two writes over PIPE_BUF to one FIFO may interleave their bytes —
  // two corrupted JSON lines. Serialising keeps every line whole on every driver.
  private stdin: Promise<void> = Promise.resolve();

  // Fires when a `result` event arrives with NO turn pending — i.e. the CLI process,
  // otherwise idle, spontaneously completed a fresh turn on its own. This happens when a
  // background Task/Agent (or a backgrounded Bash) launched by an earlier turn finishes
  // after that turn's own `result` already settled: the CLI emits a whole new
  // system/init → assistant → result sequence, unprompted by any new stdin. Mutable (not
  // constructor-only) so the caller can re-point it at the CURRENT turn's Slack
  // channel/thread on every turn — see tasks.ts's ChatSession.setIdleNotify.
  onIdleResult?: (text: string) => void;
  // Fires on EVERY such unsolicited `result` — including empty or is_error ones, which
  // onIdleResult skips — with what that self-started turn cost. Kept separate from
  // onIdleResult on purpose: that one is a per-turn Slack hook (re-pointed each live turn,
  // never set on no-UI asks/dreams), while metering must hold for every session from the
  // moment it opens, or background work burns tokens no usage record ever sees.
  onIdleUsage?: (info: { usage?: TurnUsage; isError: boolean; durationMs: number }) => void;
  // Fires on every `rate_limit_event` (subscription quota state, once per turn — on 2.1.282 after
  // system/init and the first assistant message, per the CLI probe) — see ratelimit.ts. Mutable like onIdleResult.
  onRateLimit?: (info: RateLimitInfo) => void;

  constructor(
    private readonly sandbox: SandboxHandle,
    private readonly opts: {
      cwd: string;
      resumeSessionId?: string;
      systemPrompt?: string;
      mcpConfigPath?: string;
      // Conversation id exported as AVEN_SESSION to the claude process; the MCP gateway's
      // headers helper sends it as x-aven-session (gateway audit ↔ coach-aven event log).
      // Must already be shell-safe (gwtoken.ts avenSessionValue).
      avenSession?: string;
      // Passed as `--model` on spawn. Unset → the CLI's own default. Ignored on attach
      // (the running process already has its model).
      model?: string;
      // Redact pasted secrets from user text before it goes to the process (scrub.ts).
      // undefined/true → on; false → the project opted out (ProjectConfig.scrubSecrets).
      scrubSecrets?: boolean;
      // Reattach to an already-running command (the bot restarted; claude kept running in
      // the sandbox) instead of spawning a fresh process — see open().
      attach?: { sessionKey: string; cmdId: string };
      // In-process MCP servers the BOT serves to this session over the control channel
      // (hosttools.ts / hostrouter.ts): registered right after spawn, answered on every
      // control_request{mcp_message}. On attach the running process already knows them.
      hostServers?: HostServerRoute[];
    },
  ) {
    this.sessionKey =
      opts.attach?.sessionKey ?? `claude-sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // On reattach there's no init event to learn it from until the next turn — seed the
    // known conversation id so sessionId() (→ persistence) is correct immediately.
    if (opts.attach) this.claudeSessionId = opts.resumeSessionId;
  }

  sessionId(): string | undefined {
    return this.claudeSessionId;
  }
  isDead(): boolean {
    return this.dead;
  }
  // The Daytona session-command coordinates, for persistence → a restarted bot reattaches.
  attachInfo(): { sessionKey: string; cmdId: string } | undefined {
    return this.cmdId ? { sessionKey: this.sessionKey, cmdId: this.cmdId } : undefined;
  }

  // Start the persistent process and begin streaming its stdout in the background.
  // When opts.attach is set, REATTACH to the existing command instead of spawning: the
  // bot restarted but the claude process kept running in the sandbox. We verify it's
  // still alive, then re-subscribe to its log stream (which replays history + tails).
  // Throws if the command already finished/vanished, so the caller falls back to a fresh
  // --resume open.
  async open(): Promise<void> {
    if (this.opts.attach) {
      const { sessionKey, cmdId } = this.opts.attach;
      if (!(await this.sandbox.sessionCommandRunning(sessionKey, cmdId)))
        throw new Error('attach: command no longer running');
      // Re-subscribing replays the whole log from the start. Snapshot the current stdout
      // length and skip exactly that many chars so we process only NEW output — otherwise a
      // replayed past `result` would settle the next turn's pending with stale text.
      const stdout = await this.sandbox.sessionCommandLogs(sessionKey, cmdId);
      let skip = stdout.length;
      this.parseSnapshot(stdout); // detect a turn that finished during downtime
      this.cmdId = cmdId;
      this.attached = true;
      const onStdout = (c: string) => {
        if (skip > 0) {
          if (c.length <= skip) {
            skip -= c.length;
            return;
          }
          c = c.slice(skip);
          skip = 0;
        }
        this.onChunk(c);
      };
      void this.sandbox
        .streamSessionCommandLogs(sessionKey, cmdId, onStdout)
        .then(() => this.onExit())
        .catch(() => this.onExit());
      return;
    }
    await this.sandbox.createSession(this.sessionKey);
    const { model, mcpConfigPath, resumeSessionId, systemPrompt, avenSession } = this.opts;
    const command = claudeLaunch({ model, mcpConfigPath, resumeSessionId, systemPrompt, avenSession }).command(this.opts.cwd);
    const started = await this.sandbox.startSessionCommand(this.sessionKey, command);
    this.cmdId = started.cmdId;
    // Stream stdout until the process exits; resolution/rejection both mean "process gone".
    void this.sandbox
      .streamSessionCommandLogs(this.sessionKey, this.cmdId, (c) => this.onChunk(c))
      .then(() => this.onExit())
      .catch(() => this.onExit());
    await this.registerHostServers();
  }

  // Tell the CLI about the bot-served MCP servers — once, right after spawn and before any
  // turn, exactly as the Agent SDK does (`initialize` with `sdkMcpServers`): the CLI then runs
  // each server's MCP handshake and every tools/call back over this channel as
  // control_request{mcp_message} (handleMcpMessage). stdin is ordered, so the first user turn
  // cannot overtake the registration. No-op without servers: the sandbox's MCP list and the
  // control traffic stay byte-identical to a bot without host tools.
  private async registerHostServers(): Promise<void> {
    const servers = this.opts.hostServers ?? [];
    if (!servers.length) return;
    await this.write(initializeFrame(servers));
  }

  // Arm the two-stage watchdog on a pending turn (see the STREAM_*_MS comment): soft
  // deadline → onLongRunning + re-arm for the hard cap; hard cap (or soft with no
  // listener) → `kill`. The caller's kill marks the session dead — the process state is
  // unknown after a hard timeout, so the next turn must go through a fresh --resume.
  private armDeadlines(p: PendingTurn, kill: () => void): void {
    p.timer = setTimeout(() => {
      if (!p.onLongRunning || STREAM_HARD_MAX_MS <= STREAM_MAX_MS) return kill();
      p.onLongRunning();
      p.timer = setTimeout(kill, STREAM_HARD_MAX_MS - STREAM_MAX_MS);
    }, STREAM_MAX_MS);
  }

  // Push a user turn; resolves when its `result` arrives. signal → clean interrupt.
  // onQuestion is invoked when the agent calls AskUserQuestion (→ Slack buttons).
  // onLongRunning turns the runtime limit into a soft deadline — see armDeadlines.
  async send(
    text: string,
    onStep?: (s: string) => void,
    signal?: AbortSignal,
    onQuestion?: OnQuestion,
    onLongRunning?: () => void,
  ): Promise<TurnResult> {
    if (this.dead || !this.cmdId)
      return { status: 'error', resultText: 'session not open', isError: true, started: false };
    if (this.pending)
      return { status: 'busy', resultText: 'session busy', isError: true, started: false };
    this.turnStarted = false;
    this.subagents.clear(); // ↳N numbering restarts each turn

    return await new Promise<TurnResult>((resolve) => {
      const p: PendingTurn = {
        resolve,
        onStep,
        onQuestion,
        onLongRunning,
        settled: false,
        canceled: false,
      };
      this.armDeadlines(p, () => {
        this.dead = true;
        void this.interrupt();
        this.settle({ status: 'timeout', resultText: '', isError: true });
      });
      this.pending = p;

      const onAbort = () => {
        if (p.settled) return;
        p.canceled = true;
        void this.interrupt(); // clean cancel — wait for the resulting `result` to settle
        // Fallback: if the interrupt produces no result, force-settle and retire the session.
        p.cancelTimer = setTimeout(() => {
          this.dead = true;
          this.settle({ status: 'canceled', resultText: '', isError: true });
        }, CANCEL_GRACE_MS);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // The last hop before the API: whatever a person typed in Slack (plus the attachment
      // preamble) becomes model input here, so this is where pasted secrets get redacted.
      const line = JSON.stringify(userFrame(this.scrub(text, 'turn'))) + '\n';
      void this.input(line)
        .catch((e: unknown) =>
          this.settle({
            status: 'error',
            resultText: e instanceof Error ? e.message : String(e),
            isError: true,
          }),
        );
    });
  }

  // Redact secrets from user-originated text (scrub.ts) unless the project opted out. One
  // info line with kinds + count — never the values — so operators can see it happened.
  private scrub(text: string, where: 'turn' | 'answer'): string {
    if (this.opts.scrubSecrets === false || !text) return text;
    const { text: out, findings } = scrubText(text);
    if (findings.length) {
      const { kinds, count } = scrubSummary(findings);
      log.info(`redacted ${count} secret(s) [${kinds.join(',')}] from ${where} input before sending to claude`);
    }
    return out;
  }

  // Scan a reattach snapshot: if its LAST event is a `result`, the conversation is idle —
  // the turn that was in flight when the bot died already completed during the downtime, so
  // capture its result for adoptInflight. (Mid-turn → last event isn't a result → wait live.)
  private parseSnapshot(stdout: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastEvent: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastResult: any;
    let lastUsage: TurnUsage | undefined;
    for (const ln of stdout.split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        lastEvent = ev;
        if (ev.session_id) this.claudeSessionId = ev.session_id;
        // Every replayed result goes through the cost tracker, in order, so it ends on the
        // process's current running total — the next live turn is then metered as a delta
        // against that, not as the whole total the old bot already recorded turn by turn.
        if (ev.type === 'result') {
          lastResult = ev;
          lastUsage = usageOf(ev, this.costs);
        }
      } catch {
        /* skip non-JSON noise */
      }
    }
    if (lastEvent?.type === 'result' && lastResult) {
      this.snapshotResult = {
        status: lastResult.is_error ? 'error' : 'ok',
        resultText: typeof lastResult.result === 'string' ? lastResult.result : '',
        isError: !!lastResult.is_error,
        started: true,
        usage: lastUsage,
      };
    } else if (lastEvent?.type === 'control_request' && lastEvent.request?.subtype === 'can_use_tool') {
      // The snapshot ends on an unanswered question. Heuristic: we can't see our own
      // stdin responses in the log, but an ANSWERED question is followed by more output —
      // only a still-pending one can be the final event. (A response sent in the same
      // instant the old bot died could make this a duplicate reply; worst case the turn
      // errors and the user resends — still far better than the guaranteed 15-min hang.)
      this.snapshotPendingTool = { requestId: lastEvent.request_id, input: lastEvent.request.input ?? {} };
    } else if (lastEvent?.type === 'control_request' && lastEvent.request?.subtype === 'mcp_message') {
      // Same heuristic for a host tool call the old bot never answered: served after reattach.
      this.snapshotPendingMcp = lastEvent;
    }
  }

  // Resume the turn that was in flight when the bot restarted (no stdin write — it's
  // already running, or done). If it completed during the downtime, return that result
  // from the snapshot; otherwise wait for the live `result`.
  async adoptInflight(
    onStep?: (s: string) => void,
    signal?: AbortSignal,
    onLongRunning?: () => void,
  ): Promise<TurnResult> {
    if (this.dead || !this.cmdId)
      return { status: 'error', resultText: 'session not open', isError: true, started: false };
    // Reattach fell back to a fresh spawn (sandbox had stopped, claude gone) → there is no
    // in-flight turn to recover; don't wait for a result that will never come.
    if (!this.attached)
      return { status: 'error', resultText: 'not reattached', isError: true, started: false };
    if (this.snapshotResult) {
      const r = this.snapshotResult;
      this.snapshotResult = undefined;
      return r;
    }
    if (this.pending)
      return { status: 'busy', resultText: 'session busy', isError: true, started: true };
    return await new Promise<TurnResult>((resolve) => {
      const p: PendingTurn = {
        resolve,
        onStep,
        onLongRunning,
        settled: false,
        canceled: false,
      };
      this.armDeadlines(p, () => {
        this.dead = true;
        this.settle({ status: 'timeout', resultText: '', isError: true });
      });
      this.pending = p;
      if (signal) {
        const onAbort = () => this.settle({ status: 'canceled', resultText: '', isError: true });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      // The turn is stuck on an AskUserQuestion whose buttons died with the old process —
      // dismiss it (allow with the original, answers-less input: the same degradation
      // handleCanUseTool applies when a question fails) so the turn proceeds to a result.
      const tool = this.snapshotPendingTool;
      if (tool) {
        this.snapshotPendingTool = undefined;
        void this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: tool.requestId,
            response: { behavior: 'allow', updatedInput: tool.input },
          },
        });
      }
      // A host tool call left waiting: this process has the routes, so answer it for real.
      const mcp = this.snapshotPendingMcp;
      if (mcp) {
        this.snapshotPendingMcp = undefined;
        void this.handleMcpMessage(mcp);
      }
    });
  }

  // Write a control_request{interrupt} to stdin — aborts the current turn cleanly.
  async interrupt(): Promise<void> {
    await this.write(interruptFrame());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async write(obj: any): Promise<void> {
    if (this.dead || !this.cmdId) return;
    await this.input(JSON.stringify(obj) + '\n').catch(() => {});
  }

  // Queue one line for the process's stdin behind every earlier one (see `stdin`). Rejects with
  // the driver's error for THIS line; the chain itself never breaks on a failed write.
  private input(line: string): Promise<void> {
    const cmdId = this.cmdId!;
    const next = this.stdin.then(() => this.sandbox.sendSessionInput(this.sessionKey, cmdId, line));
    this.stdin = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    this.dead = true;
    await this.sandbox.deleteSession(this.sessionKey).catch(() => {});
  }

  // ── stdout demux ───────────────────────────────────────────────────────────
  private onChunk(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!raw) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ev: any;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue; // CLI interleaves non-JSON noise — skip, don't crash the reader
      }
      this.handle(ev);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(ev: any): void {
    const t = ev?.type;
    if (t === 'system' && ev.subtype === 'init') {
      if (ev.session_id) this.claudeSessionId = ev.session_id; // initial + fork/compact
    } else if (t === 'assistant' && Array.isArray(ev.message?.content)) {
      this.turnStarted = true;
      // Subagent events stream through with parent_tool_use_id set — prefix their steps
      // with ↳N (the spawn order of their Task/Agent call) so parallel subagents stay
      // tellable apart. An unknown parent (reattach mid-turn) degrades to a bare ↳.
      const parent = typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined;
      const pfx = parent ? `↳${this.subagents.get(parent) ?? ''} ` : '';
      for (const b of ev.message.content) {
        if (b?.type === 'tool_use') {
          let label: string;
          if (!parent && (b.name === 'Task' || b.name === 'Agent') && typeof b.id === 'string') {
            const seq = this.subagents.size + 1;
            this.subagents.set(b.id, seq);
            label = stepLabel(b.name, b.input ?? {}, seq);
          } else {
            label = stepLabel(b.name, b.input ?? {});
          }
          this.pending?.onStep?.(pfx + label);
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          // Narration between tool calls ("Now let me check the checkout code…") — the
          // reasoning path users asked for; transcripts carry it, so surface it as steps.
          const label = narrationLabel(b.text);
          if (label) this.pending?.onStep?.(pfx + label);
        }
      }
    } else if (t === 'control_request' && ev.request?.subtype === 'can_use_tool') {
      this.turnStarted = true;
      void this.handleCanUseTool(ev); // AskUserQuestion → Slack; everything else auto-allow
    } else if (t === 'control_request' && ev.request?.subtype === 'mcp_message') {
      // A bot-served MCP server's handshake or tool call (hosttools.ts) — answered here, on the
      // channel; the handshake arrives before any turn, a tools/call within one.
      void this.handleMcpMessage(ev);
    } else if (t === 'control_cancel_request') {
      // claude withdrew a still-open can_use_tool (e.g. the turn was interrupted while
      // we were waiting on a Slack answer) — abort the matching question so its buttons
      // close instead of resolving into a dead request id.
      this.inflightTools.get(ev.request_id)?.abort();
    } else if (t === 'rate_limit_event') {
      const info = parseRateLimitEvent(ev);
      if (info) this.onRateLimit?.(info);
    } else if (t === 'result') {
      this.turnStarted = true;
      if (ev.session_id) this.claudeSessionId = ev.session_id; // authoritative per-turn id
      const resultText = typeof ev.result === 'string' ? ev.result : '';
      if (this.pending) {
        const status: TurnResult['status'] = this.pending.canceled ? 'canceled' : 'ok';
        this.settle({ status, resultText, isError: !!ev.is_error, usage: usageOf(ev, this.costs) });
      } else {
        // No turn was waiting on this — a background task finished on its own.
        this.onIdleUsage?.({
          usage: usageOf(ev, this.costs),
          isError: !!ev.is_error,
          durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : 0,
        });
        if (resultText && !ev.is_error) this.onIdleResult?.(resultText);
      }
    }
  }

  // Answer a can_use_tool control_request. With bypass on, normal tools never reach
  // here — only AskUserQuestion does. We escalate that to onQuestion (Slack buttons)
  // and reply allow+updatedInput.answers; anything else is defensively auto-allowed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleCanUseTool(ev: any): Promise<void> {
    const requestId = ev.request_id;
    const input = ev.request?.input ?? {};
    const ac = new AbortController(); // aborted by a control_cancel_request for this id
    this.inflightTools.set(requestId, ac);
    const allow = (updatedInput: unknown) => this.write(allowFrame(requestId, updatedInput));

    try {
      if (ev.request.tool_name === 'AskUserQuestion' && this.pending?.onQuestion) {
        try {
          const answers = await this.pending.onQuestion(input.questions ?? [], ac.signal);
          if (ac.signal.aborted) return; // claude withdrew the request — don't respond
          // Button labels are the agent's own words, but a free-text "Other" answer is user
          // input like any message — scrub the values the same way.
          const safe: QuestionAnswers = {};
          for (const [q, a] of Object.entries(answers)) safe[q] = this.scrub(a, 'answer');
          await allow({ ...input, answers: safe });
        } catch {
          // Withdrawn by claude, or the turn was canceled (interrupt tears it down) —
          // don't ALSO send a control_response (would be a second, racing message).
          if (ac.signal.aborted || this.pending?.canceled) return;
          await allow(input); // a genuine question failure → dismiss (allow w/o answers)
        }
        return;
      }
      await allow(input);
    } finally {
      this.inflightTools.delete(requestId);
    }
  }

  // Answer an mcp_message control_request: route the JSON-RPC message to the bot-served server
  // it names and reply in `mcp_response` — a request gets the server's response, a notification
  // the empty result the Agent SDK sends (the CLI expects an acknowledgement either way). A server
  // this session never registered (a route dropped between restarts) gets a control error, which
  // the CLI turns into a failed tool call the agent can read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMcpMessage(ev: any): Promise<void> {
    await this.write(await mcpAnswerFrame(ev, this.opts.hostServers ?? []));
  }

  private onExit(): void {
    // Flush a trailing partial line — a completed turn's `result` may sit in the buffer
    // with no final newline; parse it so the turn settles ok instead of a false error.
    const tail = this.buf.trim();
    this.buf = '';
    if (tail) {
      try {
        this.handle(JSON.parse(tail));
      } catch {
        /* ignore */
      }
    }
    this.dead = true;
    this.settle({ status: 'error', resultText: 'claude process exited', isError: true });
  }

  private settle(r: Omit<TurnResult, 'started'> & { started?: boolean }): void {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    if (p.cancelTimer) clearTimeout(p.cancelTimer);
    this.pending = undefined;
    p.resolve({ ...r, started: r.started ?? this.turnStarted });
  }
}
