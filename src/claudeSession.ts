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
  costUsd?: number;
}

// Pull the token counters out of a `result` event, defensively — every field is
// optional on the wire and shapes have drifted across CLI versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function usageOf(ev: any): TurnUsage | undefined {
  const u = ev?.usage;
  const cost = typeof ev?.total_cost_usd === 'number' ? ev.total_cost_usd : undefined;
  if (!u && cost === undefined) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return {
    inputTokens: num(u?.input_tokens),
    outputTokens: num(u?.output_tokens),
    cacheCreationTokens: num(u?.cache_creation_input_tokens),
    cacheReadTokens: num(u?.cache_read_input_tokens),
    costUsd: cost,
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
  private attached = false; // opened by reattaching to a running command (vs fresh spawn)

  // Fires when a `result` event arrives with NO turn pending — i.e. the CLI process,
  // otherwise idle, spontaneously completed a fresh turn on its own. This happens when a
  // background Task/Agent (or a backgrounded Bash) launched by an earlier turn finishes
  // after that turn's own `result` already settled: the CLI emits a whole new
  // system/init → assistant → result sequence, unprompted by any new stdin. Mutable (not
  // constructor-only) so the caller can re-point it at the CURRENT turn's Slack
  // channel/thread on every turn — see tasks.ts's ChatSession.setIdleNotify.
  onIdleResult?: (text: string) => void;
  // Fires on every `rate_limit_event` (subscription quota state, emitted right before
  // system/init at the start of each turn) — see ratelimit.ts. Mutable like onIdleResult.
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
    const resume = this.opts.resumeSessionId ? `--resume ${this.opts.resumeSessionId} ` : '';
    const sys = this.opts.systemPrompt ? `--append-system-prompt ${sq(this.opts.systemPrompt)} ` : '';
    // --strict-mcp-config ignores the repo's own .mcp.json; --mcp-config adds ONLY our
    // per-project servers (e.g. Grafana). Without it, --strict-mcp-config = no servers.
    const mcp = this.opts.mcpConfigPath ? `--mcp-config ${sq(this.opts.mcpConfigPath)} ` : '';
    const model = this.opts.model ? `--model ${sq(this.opts.model)} ` : '';
    // No positional prompt → persistent mode (turns stream in via stdin). --verbose is
    // mandatory with stream-json. --strict-mcp-config ignores the repo's own .mcp.json.
    // BOTH --dangerously-skip-permissions AND --permission-prompt-tool stdio: verified
    // to coexist — normal tools auto-run (bypass, no round-trip) while AskUserQuestion
    // STILL fires a can_use_tool control_request we answer (→ Slack buttons).
    const command =
      // CLI_PATH_ENV: the pinned per-sandbox Claude Code (cliversion.ts) wins over the image's.
      `cd ${sq(this.opts.cwd)} && ${CLI_PATH_ENV} ${CC_TOKEN_ENV} IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 ` +
      (this.opts.avenSession ? `AVEN_SESSION=${sq(this.opts.avenSession)} ` : '') +
      `claude --output-format stream-json --input-format stream-json --verbose ` +
      `--dangerously-skip-permissions --permission-prompt-tool stdio --strict-mcp-config ${model}${mcp}${resume}${sys}`;
    const started = await this.sandbox.startSessionCommand(this.sessionKey, command);
    this.cmdId = started.cmdId;
    // Stream stdout until the process exits; resolution/rejection both mean "process gone".
    void this.sandbox
      .streamSessionCommandLogs(this.sessionKey, this.cmdId, (c) => this.onChunk(c))
      .then(() => this.onExit())
      .catch(() => this.onExit());
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
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: this.scrub(text, 'turn') } }) + '\n';
      void this.sandbox
        .sendSessionInput(this.sessionKey, this.cmdId!, line)
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
    for (const ln of stdout.split('\n')) {
      const t = ln.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t);
        lastEvent = ev;
        if (ev.session_id) this.claudeSessionId = ev.session_id;
        if (ev.type === 'result') lastResult = ev;
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
        usage: usageOf(lastResult),
      };
    } else if (lastEvent?.type === 'control_request' && lastEvent.request?.subtype === 'can_use_tool') {
      // The snapshot ends on an unanswered question. Heuristic: we can't see our own
      // stdin responses in the log, but an ANSWERED question is followed by more output —
      // only a still-pending one can be the final event. (A response sent in the same
      // instant the old bot died could make this a duplicate reply; worst case the turn
      // errors and the user resends — still far better than the guaranteed 15-min hang.)
      this.snapshotPendingTool = { requestId: lastEvent.request_id, input: lastEvent.request.input ?? {} };
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
    });
  }

  // Write a control_request{interrupt} to stdin — aborts the current turn cleanly.
  async interrupt(): Promise<void> {
    await this.write({
      request_id: `int-${Date.now()}`,
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async write(obj: any): Promise<void> {
    if (this.dead || !this.cmdId) return;
    await this.sandbox
      .sendSessionInput(this.sessionKey, this.cmdId, JSON.stringify(obj) + '\n')
      .catch(() => {});
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
        this.settle({ status, resultText, isError: !!ev.is_error, usage: usageOf(ev) });
      } else if (resultText && !ev.is_error) {
        // No turn was waiting on this — a background task finished on its own.
        this.onIdleResult?.(resultText);
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
    const allow = (updatedInput: unknown) =>
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput } },
      });

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
