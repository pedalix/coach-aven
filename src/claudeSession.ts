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

export interface TurnResult {
  status: 'ok' | 'canceled' | 'timeout' | 'error';
  resultText: string;
  isError: boolean;
}

const STREAM_MAX_MS = (Number(process.env.STREAM_MAX_MINUTES) || 15) * 60_000;

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  onStep?: (s: string) => void;
  settled: boolean;
  canceled: boolean;
  timer: ReturnType<typeof setTimeout>;
}

// A persistent `claude` process driven over Daytona stdin/stdout in bidirectional
// stream-json mode (the Happy model). Spawn ONCE; push user turns to stdin; read NDJSON
// events from stdout; the `result` event marks turn completion and the process stays
// alive for the next turn. Cancel via a control_request{interrupt} written to stdin —
// NEVER by killing the process (killing corrupts the conversation + zombies the cmd).
export class ClaudeSession {
  private readonly sessionKey = `claude-sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  private cmdId?: string;
  private buf = '';
  private claudeSessionId?: string;
  private pending?: PendingTurn;
  private dead = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly opts: { cwd: string; resumeSessionId?: string; systemPrompt?: string },
  ) {}

  sessionId(): string | undefined {
    return this.claudeSessionId;
  }
  isDead(): boolean {
    return this.dead;
  }

  // Start the persistent process and begin streaming its stdout in the background.
  async open(): Promise<void> {
    await this.sandbox.process.createSession(this.sessionKey);
    const resume = this.opts.resumeSessionId ? `--resume ${this.opts.resumeSessionId} ` : '';
    const sys = this.opts.systemPrompt ? `--append-system-prompt ${sq(this.opts.systemPrompt)} ` : '';
    // No positional prompt → persistent mode (turns stream in via stdin). --verbose is
    // mandatory with stream-json. --strict-mcp-config ignores the repo's own .mcp.json.
    const command =
      `cd ${sq(this.opts.cwd)} && ${CC_TOKEN_ENV} IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 ` +
      `claude --output-format stream-json --input-format stream-json --verbose ` +
      `--dangerously-skip-permissions --strict-mcp-config ${resume}${sys}`;
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
  async send(text: string, onStep?: (s: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    if (this.dead || !this.cmdId) return { status: 'error', resultText: 'session not open', isError: true };
    if (this.pending) return { status: 'error', resultText: 'session busy', isError: true };

    return await new Promise<TurnResult>((resolve) => {
      const p: PendingTurn = {
        resolve,
        onStep,
        settled: false,
        canceled: false,
        timer: setTimeout(() => {
          void this.interrupt(); // try to unstick; don't kill the process
          this.settle({ status: 'timeout', resultText: '', isError: true });
        }, STREAM_MAX_MS),
      };
      this.pending = p;

      const onAbort = () => {
        p.canceled = true;
        void this.interrupt(); // clean cancel: control message, NOT a kill
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
    if (this.dead || !this.cmdId) return;
    const req =
      JSON.stringify({
        request_id: `int-${Date.now()}`,
        type: 'control_request',
        request: { subtype: 'interrupt' },
      }) + '\n';
    await this.sandbox.process.sendSessionCommandInput(this.sessionKey, this.cmdId, req).catch(() => {});
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
      for (const b of ev.message.content) {
        if (b?.type === 'tool_use') this.pending?.onStep?.(stepLabel(b.name, b.input ?? {}));
      }
    } else if (t === 'result') {
      if (ev.session_id) this.claudeSessionId = ev.session_id; // authoritative per-turn id
      const resultText = typeof ev.result === 'string' ? ev.result : '';
      const status: TurnResult['status'] = this.pending?.canceled ? 'canceled' : 'ok';
      this.settle({ status, resultText, isError: !!ev.is_error });
    }
    // control_request (can_use_tool) / control_response (interrupt ack): Phase 2.
  }

  private onExit(): void {
    this.dead = true;
    this.settle({ status: 'error', resultText: 'claude process exited', isError: true });
  }

  private settle(r: TurnResult): void {
    const p = this.pending;
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve(r);
  }
}
