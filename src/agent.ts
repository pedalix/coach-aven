import type { Sandbox } from '@daytonaio/sdk';
import { CC_TOKEN_ENV } from './project.js';
import { log } from './log.js';

// Single-quote a string for safe embedding in a bash command.
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface HeadlessResult {
  exitCode: number;
  sessionId: string; // the in-box exec session (not the claude conversation id)
}

// Run Claude Code headless in a worktree and stream its output to onLog.
// Uses an async session command so we can stream logs live; the box is isolated,
// so --dangerously-skip-permissions is appropriate.
export async function runHeadless(
  sandbox: Sandbox,
  opts: {
    cwd: string;
    prompt: string;
    composeProject: string;
    onLog?: (stream: 'out' | 'err', chunk: string) => void;
  },
): Promise<HeadlessResult> {
  const sessionId = `claude-${opts.composeProject}-${Date.now()}`;
  await sandbox.process.createSession(sessionId);

  // COMPOSE_PROJECT_NAME isolates this task's Sail stack from sibling worktrees.
  // IS_SANDBOX=1 lifts CC's root guard for --dangerously-skip-permissions (set inline
  // too, so it works even on a sandbox created before that env was baked in).
  const claude =
    `cd ${sq(opts.cwd)} && ${CC_TOKEN_ENV} IS_SANDBOX=1 COMPOSE_PROJECT_NAME=${sq(opts.composeProject)} ` +
    `claude -p ${sq(opts.prompt)} --dangerously-skip-permissions --strict-mcp-config ` +
    `--output-format stream-json --verbose`;

  const started = await sandbox.process.executeSessionCommand(
    sessionId,
    { command: claude, runAsync: true },
    0,
  );
  const cmdId = started.cmdId!;

  const onLog = opts.onLog ?? ((_s, c) => log.raw(c));
  await sandbox.process.getSessionCommandLogs(
    sessionId,
    cmdId,
    (c) => onLog('out', c),
    (c) => onLog('err', c),
  );

  const info = await sandbox.process.getSessionCommand(sessionId, cmdId);
  await sandbox.process.deleteSession(sessionId).catch(() => {});
  return { exitCode: info.exitCode ?? -1, sessionId };
}

export interface StreamResult {
  exitCode: number;
  sessionId?: string; // the Claude conversation id (for --resume)
  resultText: string;
  isError: boolean;
  status: 'ok' | 'canceled' | 'timeout';
}

// Map a Claude tool call to a short human-readable progress line for the UI.
function truncate(s: unknown, n = 50): string {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function shortPath(p: unknown): string {
  const s = typeof p === 'string' ? p : '';
  return s.length > 56 ? '…' + s.slice(-55) : s;
}
function stepLabel(name: string, input: Record<string, unknown> = {}): string {
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

// Run Claude Code headless with stream-json, surfacing a human-readable step for each
// tool call via onStep while capturing the final result + conversation id. This is
// the streaming variant behind the chat UI's live progress.
export async function streamClaude(
  sandbox: Sandbox,
  opts: {
    cwd: string;
    prompt: string;
    resumeSessionId?: string;
    onStep?: (step: string) => void;
    signal?: AbortSignal; // abort → cancel the run (kills the command)
  },
): Promise<StreamResult> {
  const sessionKey = `claude-chat-${Date.now()}`;
  await sandbox.process.createSession(sessionKey);
  const resume = opts.resumeSessionId ? `--resume ${opts.resumeSessionId} ` : '';
  // --strict-mcp-config ignores the cloned repo's .mcp.json (e.g. a `browsermcp`
  // server that can't start in the sandbox and hangs the run). Per-project MCP, when
  // added, will be passed explicitly via --mcp-config.
  const command =
    `cd ${sq(opts.cwd)} && ${CC_TOKEN_ENV} IS_SANDBOX=1 ` +
    `claude -p ${sq(opts.prompt)} ${resume}--dangerously-skip-permissions --strict-mcp-config ` +
    `--output-format stream-json --verbose`;

  const started = await sandbox.process.executeSessionCommand(
    sessionKey,
    { command, runAsync: true },
    0,
  );
  const cmdId = started.cmdId!;

  let buf = '';
  let sessionId: string | undefined;
  let resultText = '';
  let isError = false;
  let ended: 'ok' | 'canceled' | 'timeout' = 'ok';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw stream-json event
  const handle = (ev: any) => {
    if (ev?.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) sessionId = ev.session_id;
    } else if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === 'tool_use') opts.onStep?.(stepLabel(block.name, block.input ?? {}));
      }
    } else if (ev?.type === 'result') {
      if (ev.session_id) sessionId = ev.session_id;
      if (typeof ev.result === 'string') resultText = ev.result;
      isError = !!ev.is_error;
    }
  };
  // stdout arrives in arbitrary chunks; buffer and split on newlines (NDJSON).
  const onChunk = (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* partial / non-json line */
      }
    }
  };

  // Cancel (external signal) or a max-runtime timeout both end the run by deleting the
  // session — which makes getSessionCommandLogs reject. This is also the safety net for
  // a Daytona command that exits but is left with no exitCode (zombie → would hang).
  const maxMs = (Number(process.env.STREAM_MAX_MINUTES) || 15) * 60_000;
  const kill = () => void sandbox.process.deleteSession(sessionKey).catch(() => {});
  const timer = setTimeout(() => {
    if (ended === 'ok') ended = 'timeout';
    kill();
  }, maxMs);
  const onAbort = () => {
    if (ended === 'ok') ended = 'canceled';
    kill();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await sandbox.process.getSessionCommandLogs(sessionKey, cmdId, onChunk, () => {});
    if (buf.trim()) {
      try {
        handle(JSON.parse(buf.trim()));
      } catch {
        /* ignore trailing partial */
      }
    }
  } catch (e) {
    if (ended === 'ok') {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      throw e; // genuine streaming/transport error (not our kill)
    }
    // canceled / timeout: we deleted the session, so the logs stream rejected — expected.
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  if (ended !== 'ok') {
    return { exitCode: -1, sessionId, resultText, isError: true, status: ended };
  }

  const info = await sandbox.process.getSessionCommand(sessionKey, cmdId).catch(() => undefined);
  await sandbox.process.deleteSession(sessionKey).catch(() => {});
  return { exitCode: info?.exitCode ?? -1, sessionId, resultText, isError, status: 'ok' };
}

// Mid-session interaction: an interactive `claude` PTY you can feed follow-up
// messages into. Returns a handle exposing send()/onData/close(). The orchestrator
// (or a future web UI) drives the conversation turn-by-turn.
export interface InteractiveSession {
  send: (message: string) => Promise<void>;
  close: () => Promise<void>;
}

export async function startInteractive(
  sandbox: Sandbox,
  opts: {
    cwd: string;
    composeProject: string;
    sessionId: string;
    onData: (text: string) => void;
  },
): Promise<InteractiveSession> {
  const pty = await sandbox.process.createPty({
    id: opts.sessionId,
    cwd: opts.cwd,
    envs: { COMPOSE_PROJECT_NAME: opts.composeProject, TERM: 'xterm-256color', IS_SANDBOX: '1' },
    cols: 120,
    rows: 30,
    onData: (data) => opts.onData(new TextDecoder().decode(data)),
  });
  await pty.waitForConnection();
  await pty.sendInput(`${CC_TOKEN_ENV} claude --dangerously-skip-permissions --strict-mcp-config\n`);

  return {
    send: async (message: string) => {
      // submit the user turn (newline = Enter)
      await pty.sendInput(message.replace(/\n+$/g, '') + '\n');
    },
    close: async () => {
      await pty.sendInput(new Uint8Array([3])); // Ctrl-C to bail out of any prompt
      await pty.disconnect();
    },
  };
}
