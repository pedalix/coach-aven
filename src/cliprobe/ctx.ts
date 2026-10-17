// A scenario's view of one probe run (OpenSpec `cli-probe`, design D1–D2). It starts the CLI through a
// transport with the bot's own command line (claudeLaunch), records every frame both ways plus the
// process boundaries, answers the CLI's control requests the way the bot does (allow, the bot's MCP
// framing), checks that the CLI that answers is the version the run names, and turns a missed
// precondition into `inconclusive` and a missed prediction into `fails`.
import {
  allowFrame,
  claudeLaunch,
  initializeFrame,
  interruptFrame,
  mcpAnswerFrame,
  userFrame,
  type ClaudeLaunch,
  type ClaudeLaunchOpts,
} from '../claudeSession.js';
import type { HostServerRoute } from '../hosttools.js';
import type { Frame, RecordLine } from './types.js';

/** The model's part of the script did not happen: the run is inconclusive. */
export class PreconditionMissed extends Error {}
/** What the hypothesis predicts did not happen: the run fails. */
export class PredictionMissed extends Error {}
/** The CLI that answered is not the version the run names: the run is an error, not a verdict. */
export class VersionMismatch extends Error {}

export interface ProbeProcess {
  write(line: string): Promise<void>;
  /** Close stdin (the CLI exits once its work is done). */
  end(): void;
  kill(signal?: NodeJS.Signals): void;
}
export interface ProcessHandlers {
  onLine(line: string): void;
  onExit(code: number | null, signal: string | null): void;
}
/** How a run reaches the CLI: a local process, or a session in a throwaway sandbox. */
export interface Transport {
  readonly kind: 'local' | 'sandbox';
  start(launch: ClaudeLaunch, h: ProcessHandlers): Promise<ProbeProcess>;
  dispose(): Promise<void>;
}

export type Pred = (f: Frame) => boolean;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const content = (f: Frame): unknown[] => {
  const c = (f as Any).message?.content;
  return Array.isArray(c) ? c : [];
};
const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/** Predicates over frames, for `precondition` / `expect`. */
export const is = {
  init: (f: Frame) => f.type === 'system' && f.subtype === 'init',
  system: (subtype: string) => (f: Frame) => f.type === 'system' && f.subtype === subtype,
  result: (f: Frame) => f.type === 'result',
  toolUse: (name?: string) => (f: Frame) =>
    f.type === 'assistant' && content(f).some((b: Any) => b?.type === 'tool_use' && (!name || b.name === name)),
  toolResult: (f: Frame) => f.type === 'user' && !(f as Any).isReplay && content(f).some((b: Any) => b?.type === 'tool_result'),
  text: (f: Frame) => f.type === 'assistant' && content(f).some((b: Any) => b?.type === 'text'),
  control: (subtype: string) => (f: Frame) => f.type === 'control_request' && (f as Any).request?.subtype === subtype,
  controlResponse: (requestId: string) => (f: Frame) => f.type === 'control_response' && (f as Any).response?.request_id === requestId,
  replayOf: (needle: string) => (f: Frame) => f.type === 'user' && (f as Any).isReplay === true && text((f as Any).message?.content).includes(needle),
};

export interface CtxOptions {
  transport: Transport;
  /** The bot's command line for this run, minus --resume (restart adds it). */
  launch: Omit<ClaudeLaunchOpts, 'resumeSessionId'>;
  /** The CLI version the run names; every `system/init` must report it. */
  expectedVersion?: string;
  log?: (line: string) => void;
}

export class ProbeCtx {
  /** Every stdout frame, in order, across processes. */
  readonly frames: Frame[] = [];
  readonly recording: RecordLine[] = [];
  readonly results: Frame[] = [];
  readonly replays: Frame[] = [];
  readonly is = is;
  sessionId?: string;
  /** Answer a can_use_tool: return the updatedInput to allow with, or undefined to leave it open. Default: allow as sent (the bot). */
  onCanUseTool?: (frame: Frame) => unknown | Promise<unknown>;
  /** Lines on stdout that were not JSON (the bot skips them too). */
  noise = 0;
  /** Lines on stdout that were the transport's copy of what the probe wrote (see RecordLine `echo`). */
  transportEchoes = 0;
  private readonly written: string[] = [];

  private readonly t0 = Date.now();
  private proc?: ProbeProcess;
  private alive = false;
  private fatal?: Error;
  private seq = 0;
  // Where the next wait starts: just after the frame the previous wait matched, or at the end of the
  // frames when the probe last wrote something. So chained waits never miss a frame that arrived in the
  // same burst as the one before it (the sandbox transport streams in bursts), and a wait after an
  // action never matches a frame from before that action.
  private cursor = 0;
  private hostRoutes: readonly HostServerRoute[] = [];
  private readonly waiters = new Set<() => void>();
  private spentClosed = 0; // cost of processes that exited
  private spentLive = 0; // running total of the live process (total_cost_usd is cumulative per process)

  constructor(private readonly opts: CtxOptions) {}

  private now(): number {
    return Date.now() - this.t0;
  }
  private log(s: string): void {
    this.opts.log?.(`${(this.now() / 1000).toFixed(1).padStart(6)} ${s}`);
  }
  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  get running(): boolean {
    return this.alive;
  }
  /** Milliseconds since the run started (the recording's clock). */
  elapsed(): number {
    return this.now();
  }
  /** When a stdout frame arrived, on the recording's clock. */
  timeOf(frame: Frame | undefined): number | undefined {
    if (!frame) return undefined;
    for (const l of this.recording) if ('frame' in l && l.frame === frame) return l.t;
    return undefined;
  }
  /** API-equivalent cost of the run so far (sum over its processes). */
  costUsd(): number {
    return this.spentClosed + this.spentLive;
  }

  /** Start a CLI process with the bot's command line (plus --resume). */
  async start(o: { resume?: string } = {}): Promise<void> {
    if (this.alive) throw new Error('a CLI process is already running');
    const launch = claudeLaunch({ ...this.opts.launch, resumeSessionId: o.resume });
    this.recording.push({ t: this.now(), proc: 'start', argv: ['claude', ...launch.args] });
    this.alive = true;
    this.log(`START${o.resume ? ' --resume' : ''}`);
    this.proc = await this.opts.transport.start(launch, {
      onLine: (l) => this.onLine(l),
      onExit: (code, signal) => {
        if (!this.alive) return;
        this.alive = false;
        this.spentClosed += this.spentLive;
        this.spentLive = 0;
        this.recording.push({ t: this.now(), proc: 'exit', code, signal });
        this.log(`EXIT ${code ?? signal}`);
        this.wake();
      },
    });
  }

  private onLine(line: string): void {
    // The transport's copy of a line the probe wrote: recorded as such, never taken for the CLI's.
    const mine = this.written.indexOf(line.trim());
    if (mine >= 0) {
      this.written.splice(mine, 1);
      this.transportEchoes++;
      try {
        this.recording.push({ t: this.now(), dir: 'echo', frame: JSON.parse(line) as Frame });
      } catch {
        /* not JSON: nothing to record */
      }
      return;
    }
    let f: unknown;
    try {
      f = JSON.parse(line);
    } catch {
      if (line.trim()) this.noise++;
      return;
    }
    if (!f || typeof f !== 'object' || Array.isArray(f)) return;
    const frame = f as Frame;
    this.recording.push({ t: this.now(), dir: 'out', frame });
    this.frames.push(frame);
    const a = frame as Any;
    if (typeof a.session_id === 'string') this.sessionId = a.session_id;
    if (frame.type === 'result') {
      this.results.push(frame);
      if (typeof a.total_cost_usd === 'number') this.spentLive = Math.max(this.spentLive, a.total_cost_usd);
    }
    if (frame.type === 'user' && a.isReplay === true) this.replays.push(frame);
    if (is.init(frame) && this.opts.expectedVersion && a.claude_code_version !== this.opts.expectedVersion) {
      this.fatal = new VersionMismatch(
        `the CLI reports ${String(a.claude_code_version)} in system/init, the run names ${this.opts.expectedVersion}`,
      );
      this.proc?.kill('SIGKILL');
    }
    if (frame.type === 'control_request') void this.onControl(frame);
    this.log(`${String(frame.type)}${frame.subtype ? `/${String(frame.subtype)}` : ''}`);
    this.wake();
  }

  // The bot's answers: can_use_tool → allow (a scenario may answer or hold it), mcp_message → the
  // bot's own framing over the scenario's host servers. Every other request is left alone, as the bot does.
  private async onControl(f: Frame): Promise<void> {
    const a = f as Any;
    const sub = a.request?.subtype;
    if (sub === 'can_use_tool') {
      const input = a.request?.input ?? {};
      const updated = this.onCanUseTool ? await this.onCanUseTool(f) : input;
      if (updated !== undefined) await this.write(allowFrame(a.request_id, updated));
    } else if (sub === 'mcp_message') {
      await this.write(await mcpAnswerFrame(f, this.hostRoutes));
    }
  }

  /** Write one frame to the CLI's stdin (recorded as `in`). */
  async write(frame: Frame): Promise<void> {
    if (!this.proc || !this.alive) throw new Error('no CLI process to write to');
    this.cursor = this.frames.length;
    this.recording.push({ t: this.now(), dir: 'in', frame });
    const text = JSON.stringify(frame);
    this.written.push(text);
    if (this.written.length > 200) this.written.shift();
    await this.proc.write(text + '\n');
  }

  /** A user message exactly as the bot writes it; the optional fields are the protocol's own. */
  async send(content: string, o: { priority?: 'now' | 'next' | 'later'; uuid?: string; origin?: Record<string, unknown> } = {}): Promise<Frame> {
    const frame: Frame = { ...userFrame(content) };
    if (o.priority) frame.priority = o.priority;
    if (o.uuid) frame.uuid = o.uuid;
    if (o.origin) frame.origin = o.origin;
    this.log(`>>> user${o.priority ? ` (${o.priority})` : ''}`);
    await this.write(frame);
    return frame;
  }

  /** A control request with a run-local id (never a wall-clock id: recordings carry no time). */
  async control(request: Record<string, unknown>): Promise<string> {
    const requestId = `probe-${++this.seq}`;
    await this.write({ type: 'control_request', request_id: requestId, request });
    return requestId;
  }

  /** The bot's interrupt frame. */
  async interrupt(): Promise<string> {
    const requestId = `probe-int-${++this.seq}`;
    this.log('>>> interrupt');
    await this.write(interruptFrame(requestId));
    return requestId;
  }

  /** Register host MCP servers as the bot does right after spawn; their mcp_message calls are then answered. */
  async initialize(routes: readonly HostServerRoute[]): Promise<string> {
    this.hostRoutes = routes;
    const requestId = `probe-init-${++this.seq}`;
    await this.write(initializeFrame(routes, requestId));
    return requestId;
  }

  /** Answer a control request the CLI sent (success). */
  respond(f: Frame, response: unknown): Promise<void> {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: (f as Any).request_id, response } });
  }

  // Wait for a frame matching `pred` — from the cursor (after the previous match or the last write), or
  // over every frame so far with `past`.
  private wait(pred: Pred, ms: number, past: boolean, miss: (why: string) => Error): Promise<Frame> {
    let i = past ? 0 : this.cursor;
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      const check = (): void => {
        if (this.fatal) {
          done();
          return reject(this.fatal);
        }
        for (; i < this.frames.length; i++) {
          const f = this.frames[i]!;
          if (pred(f)) {
            done();
            this.cursor = Math.max(this.cursor, i + 1);
            return resolve(f);
          }
        }
        if (!this.alive) {
          done();
          reject(miss('the CLI process exited first'));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(miss(`not within ${ms} ms`));
      }, ms);
      this.waiters.add(check);
      check();
    });
  }

  /** The model's part of the script (e.g. it calls Bash). Missed → the run is inconclusive. */
  precondition(pred: Pred, ms: number, what: string, o: { past?: boolean } = {}): Promise<Frame> {
    return this.wait(pred, ms, o.past ?? false, (why) => new PreconditionMissed(`${what} — ${why}`));
  }
  /** What the hypothesis predicts. Missed → the run fails. */
  expect(pred: Pred, ms: number, what: string, o: { past?: boolean } = {}): Promise<Frame> {
    return this.wait(pred, ms, o.past ?? false, (why) => new PredictionMissed(`${what} — ${why}`));
  }
  /** A precondition that is a condition, not an event. */
  require(cond: unknown, what: string): void {
    if (!cond) throw new PreconditionMissed(what);
  }
  /** A prediction that is a condition, not an event. */
  check(cond: unknown, what: string): void {
    if (!cond) throw new PredictionMissed(what);
  }

  /** Resolve once the current process has exited (a prediction: missed → fails). */
  expectExit(ms: number, what = 'the CLI process exits'): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      const check = (): void => {
        if (!this.alive) {
          done();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new PredictionMissed(`${what} — not within ${ms} ms`));
      }, ms);
      this.waiters.add(check);
      check();
    });
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.log(`>>> kill ${signal}`);
    this.proc?.kill(signal);
  }

  /** Kill the running process (if any), then start a new one, e.g. with --resume. */
  async restart(o: { resume?: string } = {}): Promise<void> {
    if (this.alive) {
      this.kill('SIGKILL');
      await this.expectExit(10_000, 'the killed process exits').catch(() => {});
    }
    await this.start(o);
  }

  /** End of the run: close stdin, give the CLI a moment, then terminate it. */
  async close(): Promise<void> {
    if (!this.alive) return;
    this.proc?.end();
    await this.expectExit(3_000).catch(() => {});
    if (this.alive) this.proc?.kill('SIGTERM');
    await this.expectExit(3_000).catch(() => {});
    if (this.alive) this.proc?.kill('SIGKILL');
    await this.expectExit(3_000).catch(() => {});
  }

  /** Raised by the version check; the runner aborts the whole probe on it. */
  get fatalError(): Error | undefined {
    return this.fatal;
  }
}
