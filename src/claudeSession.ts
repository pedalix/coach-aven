import type { Sandbox } from '@daytonaio/sdk';
import { CC_TOKEN_ENV } from './project.js';

// Single-quote a string for safe embedding in a bash command.
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// --- tool-call → human progress line (for live UI) ---------------------------
function truncate(s: unknown, n = 50): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function shortPath(p: unknown): string {
  const s = typeof p === 'string' ? p : '';
  return s.length > 56 ? '…' + s.slice(-55) : s;
}
export function stepLabel(name: string, input: Record<string, unknown> = {}): string {
  switch (name) {
    case 'Read':
      return `📖 Read ${shortPath(input.file_path ?? input.path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `✏️ Edit ${shortPath(input.file_path ?? input.notebook_path ?? input.path)}`;
    case 'Grep':
      return `🔍 Grep ${truncate(input.pattern)}`;
    case 'Glob':
      return `🔍 Glob ${truncate(input.pattern)}`;
    case 'Bash':
      return `⚙️ ${truncate(input.command, 70)}`;
    case 'Task':
      return `🤖 Subtask: ${truncate(input.description ?? input.prompt)}`;
    case 'WebFetch':
      return `🌐 Fetch ${truncate(input.url)}`;
    case 'WebSearch':
      return `🌐 Search ${truncate(input.query)}`;
    case 'TodoWrite':
      return '📝 Updating plan…';
    default:
      return `🔧 ${name}`;
  }
}

// AskUserQuestion tool shape (verified against the live CLI). The agent asks one or
// more questions; we answer via control_response allow+updatedInput.answers, keyed by
// question TEXT → chosen label(s) (multi-select: labels comma-joined, per Happy).
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
}

const STREAM_MAX_MS = (Number(process.env.STREAM_MAX_MINUTES) || 15) * 60_000;
const CANCEL_GRACE_MS = 10_000; // after interrupt, wait this long for the canceled result

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  onStep?: (s: string) => void;
  onQuestion?: OnQuestion;
  settled: boolean;
  canceled: boolean;
  timer: ReturnType<typeof setTimeout>;
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

  constructor(
    private readonly sandbox: Sandbox,
    private readonly opts: {
      cwd: string;
      resumeSessionId?: string;
      systemPrompt?: string;
      mcpConfigPath?: string;
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
      const cmd = await this.sandbox.process
        .getSessionCommand(sessionKey, cmdId)
        .catch(() => undefined);
      if (!cmd || cmd.exitCode != null) throw new Error('attach: command no longer running');
      // Re-subscribing replays the whole log from the start. Snapshot the current stdout
      // length and skip exactly that many chars so we process only NEW output — otherwise a
      // replayed past `result` would settle the next turn's pending with stale text.
      const snap = await this.sandbox.process.getSessionCommandLogs(sessionKey, cmdId);
      let skip = (snap.stdout ?? '').length;
      this.cmdId = cmdId;
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
      void this.sandbox.process
        .getSessionCommandLogs(sessionKey, cmdId, onStdout, () => {})
        .then(() => this.onExit())
        .catch(() => this.onExit());
      return;
    }
    await this.sandbox.process.createSession(this.sessionKey);
    const resume = this.opts.resumeSessionId ? `--resume ${this.opts.resumeSessionId} ` : '';
    const sys = this.opts.systemPrompt ? `--append-system-prompt ${sq(this.opts.systemPrompt)} ` : '';
    // --strict-mcp-config ignores the repo's own .mcp.json; --mcp-config adds ONLY our
    // per-project servers (e.g. Grafana). Without it, --strict-mcp-config = no servers.
    const mcp = this.opts.mcpConfigPath ? `--mcp-config ${sq(this.opts.mcpConfigPath)} ` : '';
    // No positional prompt → persistent mode (turns stream in via stdin). --verbose is
    // mandatory with stream-json. --strict-mcp-config ignores the repo's own .mcp.json.
    // BOTH --dangerously-skip-permissions AND --permission-prompt-tool stdio: verified
    // to coexist — normal tools auto-run (bypass, no round-trip) while AskUserQuestion
    // STILL fires a can_use_tool control_request we answer (→ Slack buttons).
    const command =
      `cd ${sq(this.opts.cwd)} && ${CC_TOKEN_ENV} IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 ` +
      `claude --output-format stream-json --input-format stream-json --verbose ` +
      `--dangerously-skip-permissions --permission-prompt-tool stdio --strict-mcp-config ${mcp}${resume}${sys}`;
    const started = await this.sandbox.process.executeSessionCommand(
      this.sessionKey,
      { command, runAsync: true },
      0,
    );
    this.cmdId = started.cmdId!;
    // Stream stdout until the process exits; resolution/rejection both mean "process gone".
    void this.sandbox.process
      .getSessionCommandLogs(this.sessionKey, this.cmdId, (c) => this.onChunk(c), () => {})
      .then(() => this.onExit())
      .catch(() => this.onExit());
  }

  // Push a user turn; resolves when its `result` arrives. signal → clean interrupt.
  // onQuestion is invoked when the agent calls AskUserQuestion (→ Slack buttons).
  async send(
    text: string,
    onStep?: (s: string) => void,
    signal?: AbortSignal,
    onQuestion?: OnQuestion,
  ): Promise<TurnResult> {
    if (this.dead || !this.cmdId)
      return { status: 'error', resultText: 'session not open', isError: true, started: false };
    if (this.pending)
      return { status: 'busy', resultText: 'session busy', isError: true, started: false };
    this.turnStarted = false;

    return await new Promise<TurnResult>((resolve) => {
      const p: PendingTurn = {
        resolve,
        onStep,
        onQuestion,
        settled: false,
        canceled: false,
        // Hard max-runtime: the process state is unknown after this, so mark the session
        // dead (force a fresh --resume next turn) rather than reusing it.
        timer: setTimeout(() => {
          this.dead = true;
          void this.interrupt();
          this.settle({ status: 'timeout', resultText: '', isError: true });
        }, STREAM_MAX_MS),
      };
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

      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
      void this.sandbox.process
        .sendSessionCommandInput(this.sessionKey, this.cmdId!, line)
        .catch((e) =>
          this.settle({
            status: 'error',
            resultText: e instanceof Error ? e.message : String(e),
            isError: true,
          }),
        );
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
    await this.sandbox.process
      .sendSessionCommandInput(this.sessionKey, this.cmdId, JSON.stringify(obj) + '\n')
      .catch(() => {});
  }

  async close(): Promise<void> {
    this.dead = true;
    await this.sandbox.process.deleteSession(this.sessionKey).catch(() => {});
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
      for (const b of ev.message.content) {
        if (b?.type === 'tool_use') this.pending?.onStep?.(stepLabel(b.name, b.input ?? {}));
      }
    } else if (t === 'control_request' && ev.request?.subtype === 'can_use_tool') {
      this.turnStarted = true;
      void this.handleCanUseTool(ev); // AskUserQuestion → Slack; everything else auto-allow
    } else if (t === 'control_cancel_request') {
      // claude withdrew a still-open can_use_tool (e.g. the turn was interrupted while
      // we were waiting on a Slack answer) — abort the matching question so its buttons
      // close instead of resolving into a dead request id.
      this.inflightTools.get(ev.request_id)?.abort();
    } else if (t === 'result') {
      this.turnStarted = true;
      if (ev.session_id) this.claudeSessionId = ev.session_id; // authoritative per-turn id
      const resultText = typeof ev.result === 'string' ? ev.result : '';
      const status: TurnResult['status'] = this.pending?.canceled ? 'canceled' : 'ok';
      this.settle({ status, resultText, isError: !!ev.is_error });
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
          await allow({ ...input, answers });
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
