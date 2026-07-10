import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import type { ExecOpts, ExecResult, SandboxDriver, SandboxHandle } from './driver.js';
import { log } from './log.js';

// SshDockerDriver: sandboxes as Docker containers on a host we own, driven over SSH.
// The self-hosted answer to Daytona's freeze (see driver.ts): one fixed-cost box runs
// every project as a long-lived container (DinD via sysbox or --privileged, so Laravel
// Sail keeps working), and the driver maps the SandboxDriver contract onto plain docker
// + POSIX primitives:
//   • warm named sandbox  → `docker run -d --name proj-<slug> … sleep`, `docker start`
//     (dockerd inside comes up lazily via project.ts's ensureDockerd guard, so the image
//     needs no entrypoint cooperation). No auto-stop: an idle container on our own box
//     costs nothing, unlike metered Daytona time.
//   • exec / uploadFile   → `docker exec` with the SCRIPT (or file bytes) piped via
//     stdin — nothing user-controlled is ever interpolated into a shell string.
//   • persistent sessions → a FIFO + log file under /tmp/aven-sess/<key>/ inside the
//     container: claude reads the FIFO (a background holder keeps the write end open so
//     it never sees EOF), stdout tees to out.log; snapshot = cat, tail = tail -f, and
//     the whole thing survives bot restarts because it lives in the container.
// Everything remote is busybox-sh compatible (the sandbox image is Alpine).

// Single-quote a string for safe embedding in a shell command (same as claudeSession's).
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Session keys / container names / paths become path or argv segments — allow only the
// charset the bot actually generates, so a corrupted state.json can't smuggle shell in.
export function safeToken(s: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(s) || s.includes('..')) throw new Error(`unsafe token: ${s}`);
  return s;
}

const SESS_BASE = '/tmp/aven-sess';
const sessDir = (key: string): string => `${SESS_BASE}/${safeToken(key)}`;

// ── pure script builders (pinned by sshdocker.test.ts) ─────────────────────

// The in-container exec script: stderr folded into stdout (Daytona's exec returns one
// combined `result`, and callers parse it), optional cwd/env, optional hard timeout.
// The caller's command is embedded via sq — it may be a multi-line script (housekeeping).
export function execScript(command: string, opts: ExecOpts = {}): string {
  const lines = ['exec 2>&1'];
  if (opts.cwd) lines.push(`cd ${sq(opts.cwd)} || exit 1`);
  for (const [k, v] of Object.entries(opts.env ?? {})) lines.push(`export ${safeToken(k)}=${sq(v)}`);
  const t = opts.timeout ?? 0;
  lines.push(t > 0 ? `timeout ${Math.ceil(t)} sh -c ${sq(command)}` : command);
  return lines.join('\n');
}

// Start a detached session command: FIFO for stdin (holder keeps it EOF-free), stdout+
// stderr to out.log, pid recorded and echoed (= the cmdId). `sleep 2147483647` not
// `sleep infinity` — busybox sleep has no `infinity`.
export function startSessionScript(key: string, command: string): string {
  const d = sessDir(key);
  return [
    `d=${sq(d)}`,
    `mkdir -p "$d"`,
    `[ -p "$d/in" ] || mkfifo "$d/in"`,
    // Write-end holder: without it, the first writer's close() would EOF claude's stdin.
    // Opening blocks until the reader opens — backgrounded so the command below (the
    // reader) can start; the two unblock each other.
    `sleep 2147483647 > "$d/in" &`,
    `echo $! > "$d/holder"`,
    `sh -c ${sq(command)} < "$d/in" > "$d/out.log" 2>&1 &`,
    `echo $! > "$d/pid"`,
    `cat "$d/pid"`,
  ].join('\n');
}

// Tail the session log from the start (replay + follow — the contract claudeSession's
// skip-prefix logic expects), and exit when the command's pid dies. busybox tail has no
// --pid, hence the polling watcher.
export function streamSessionScript(key: string): string {
  const d = sessDir(key);
  return [
    `d=${sq(d)}`,
    `tail -c +1 -f "$d/out.log" 2>/dev/null &`,
    `t=$!`,
    `pid=$(cat "$d/pid" 2>/dev/null)`,
    `while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; do sleep 2; done`,
    `sleep 1`, // let tail flush the final chunk (the result line) before we kill it
    `kill "$t" 2>/dev/null`,
    `wait "$t" 2>/dev/null || true`,
  ].join('\n');
}

// `docker ps` lines ("name\tstate") → the state map /aven status renders. Docker's
// `running` maps to Daytona's `started`; everything else (exited/created/paused) reads
// as stopped — the same asleep/awake dichotomy the rest of the bot works with.
export function parseContainerStates(out: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, state] = line.trim().split('\t');
    if (name && state) states.set(name, state === 'running' ? 'started' : 'stopped');
  }
  return states;
}

// ── ssh transport ───────────────────────────────────────────────────────────

interface SshResult {
  code: number;
  stdout: string;
}

// Run one remote command over ssh, with optional stdin. BatchMode: never prompt (a
// missing key must fail fast, not hang the turn). Only stdout is surfaced — remote
// stderr is already folded into stdout by the scripts; local ssh warnings are dropped.
function runSsh(
  host: string,
  remoteCmd: string,
  opts: { stdin?: Buffer | string; timeoutMs?: number; onStdout?: (chunk: string) => void } = {},
): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCmd], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString('utf8');
      if (opts.onStdout) opts.onStdout(s);
      else stdout += s;
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

// ── the driver ──────────────────────────────────────────────────────────────

class SshDockerHandle implements SandboxHandle {
  constructor(
    private readonly host: string,
    readonly name: string,
    readonly started: boolean,
  ) {}

  // All in-container work goes through `docker exec -i <name> sh -s` with the script on
  // stdin — no remote-shell quoting layer for the script itself.
  private inContainer(script: string, opts: Parameters<typeof runSsh>[2] = {}): Promise<SshResult> {
    return runSsh(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -s`, {
      ...opts,
      stdin: script,
    });
  }

  async exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const t = opts.timeout ?? 0;
    const r = await this.inContainer(execScript(command, opts), {
      // Local backstop slightly above the remote `timeout` so the remote one wins
      // (its exit code is meaningful); no remote timeout → no local one either.
      timeoutMs: t > 0 ? (t + 30) * 1000 : undefined,
    });
    if (opts.check && r.code !== 0) {
      throw new Error(`command failed (exit ${r.code}): ${command}\n--- output ---\n${r.stdout}`);
    }
    return { exitCode: r.code, result: r.stdout };
  }

  async uploadFile(data: Buffer, path: string): Promise<void> {
    // Bytes via stdin (tokens must never transit a command line); mkdir -p the parent.
    const inner = `mkdir -p $(dirname ${sq(path)}) && cat > ${sq(path)}`;
    const r = await runSsh(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -c ${sq(inner)}`, {
      stdin: data,
    });
    if (r.code !== 0) throw new Error(`upload to ${path} failed (exit ${r.code})`);
  }

  async createSession(sessionKey: string): Promise<void> {
    await this.inContainer(`mkdir -p ${sq(sessDir(sessionKey))}`);
  }

  async startSessionCommand(sessionKey: string, command: string): Promise<{ cmdId: string }> {
    const r = await this.inContainer(startSessionScript(sessionKey, command));
    const pid = r.stdout.trim();
    if (r.code !== 0 || !/^\d+$/.test(pid)) {
      throw new Error(`session start failed (exit ${r.code}): ${r.stdout.slice(0, 500)}`);
    }
    return { cmdId: pid };
  }

  async sessionCommandRunning(_sessionKey: string, cmdId: string): Promise<boolean> {
    // cmdId is the in-container pid. kill -0 has a pid-recycling caveat after a container
    // restart, but a restart also kills the process the pid pointed at — the reattach then
    // fails at the next step (no new output ever arrives) rather than corrupting anything.
    const r = await this.inContainer(`kill -0 ${sq(safeToken(cmdId))} 2>/dev/null && echo up || echo down`);
    return r.stdout.trim() === 'up';
  }

  async sessionCommandLogs(sessionKey: string, _cmdId: string): Promise<string> {
    const r = await this.inContainer(`cat ${sq(sessDir(sessionKey))}/out.log 2>/dev/null || true`);
    return r.stdout;
  }

  async streamSessionCommandLogs(
    sessionKey: string,
    _cmdId: string,
    onStdout: (chunk: string) => void,
  ): Promise<void> {
    await this.inContainer(streamSessionScript(sessionKey), { onStdout });
  }

  async sendSessionInput(sessionKey: string, _cmdId: string, data: string): Promise<void> {
    // Data via stdin into the FIFO. Writers open/write/close freely — the holder keeps
    // the write end open so the reader never EOFs between turns.
    const inner = `cat > ${sq(sessDir(sessionKey))}/in`;
    const r = await runSsh(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -c ${sq(inner)}`, {
      stdin: data,
    });
    if (r.code !== 0) throw new Error(`session input failed (exit ${r.code})`);
  }

  async deleteSession(sessionKey: string): Promise<void> {
    const d = sessDir(sessionKey);
    await this.inContainer(
      [
        `for f in pid holder; do kill "$(cat ${sq(d)}/$f 2>/dev/null)" 2>/dev/null; done`,
        `rm -rf ${sq(d)}`,
      ].join('\n'),
    );
  }
}

export class SshDockerDriver implements SandboxDriver {
  private readonly host: string;
  private readonly runtimeFlag: string;

  constructor(private readonly cfg: Config) {
    if (!cfg.sshDocker) {
      throw new Error('SSHDOCKER_HOST is not set — required for the ssh-docker sandbox driver');
    }
    this.host = cfg.sshDocker.host;
    // DinD needs either sysbox (preferred: unprivileged-but-docker-capable) or the
    // --privileged hammer. Configured host-wide via SSHDOCKER_RUNTIME.
    this.runtimeFlag = cfg.sshDocker.runtime === 'sysbox-runc' ? '--runtime sysbox-runc' : '--privileged';
  }

  private onHost(script: string, opts: Parameters<typeof runSsh>[2] = {}): Promise<SshResult> {
    return runSsh(this.host, 'sh -s', { ...opts, stdin: script });
  }

  async ensureImage(): Promise<void> {
    const image = this.cfg.snapshot.image;
    const r = await this.onHost(
      `docker image inspect ${sq(image)} >/dev/null 2>&1 && echo present || docker pull ${sq(image)}`,
      { timeoutMs: 15 * 60_000 }, // first pull of the dind image is large
    );
    if (r.code !== 0) throw new Error(`image pull failed: ${image}\n${r.stdout.slice(0, 500)}`);
    if (r.stdout.trim() !== 'present') log.info(`pulled sandbox image ${image}`);
  }

  async ensureSandbox(name: string, projectSlug: string): Promise<SandboxHandle> {
    const n = sq(safeToken(name));
    // The container's own process is just sleep — claude/dockerd/etc. start on demand
    // (project.ts's ensureDockerd guard revives dockerd at every chat prep). --restart
    // unless-stopped: a host reboot brings the fleet back warm.
    const script = [
      `state=$(docker inspect -f '{{.State.Running}}' ${n} 2>/dev/null)`,
      `if [ "$state" = "true" ]; then echo ready`,
      `elif [ "$state" = "false" ]; then docker start ${n} >/dev/null && echo started`,
      `else`,
      `  docker run -d --name ${n} ${this.runtimeFlag} --restart unless-stopped \\`,
      `    -e IS_SANDBOX=1 --label managedBy=bluefin-thin-orchestrator --label project=${sq(safeToken(projectSlug))} \\`,
      `    --entrypoint sh ${sq(this.cfg.snapshot.image)} -c 'sleep 2147483647' >/dev/null && echo created`,
      `fi`,
    ].join('\n');
    const r = await this.onHost(script, { timeoutMs: 120_000 });
    const outcome = r.stdout.trim();
    if (r.code !== 0 || !['ready', 'started', 'created'].includes(outcome)) {
      throw new Error(`ensureSandbox ${name} failed (exit ${r.code}): ${r.stdout.slice(0, 500)}`);
    }
    if (outcome !== 'ready') log.info(`sandbox '${name}' ${outcome} (ssh-docker)`);
    return new SshDockerHandle(this.host, name, true);
  }

  async getSandbox(name: string): Promise<SandboxHandle | undefined> {
    const r = await this.onHost(
      `docker inspect -f '{{.State.Running}}' ${sq(safeToken(name))} 2>/dev/null || echo missing`,
    );
    const state = r.stdout.trim();
    if (state !== 'true' && state !== 'false') return undefined;
    return new SshDockerHandle(this.host, name, state === 'true');
  }

  async listStates(): Promise<Map<string, string>> {
    const r = await this.onHost(
      `docker ps -a --filter label=managedBy=bluefin-thin-orchestrator --format '{{.Names}}\t{{.State}}'`,
    );
    return parseContainerStates(r.stdout);
  }
}
