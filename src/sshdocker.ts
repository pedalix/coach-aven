import { spawn } from 'node:child_process';
import type { Config } from './config.js';
import type { ExecOpts, ExecResult, SandboxDriver, SandboxHandle } from './driver.js';
import { dockerdGuardCmd } from './housekeeping.js';
import { sandboxActivity, type StopOutcome, type StopRequest } from './idlestop.js';
import { log } from './log.js';
import { utf8Chunks } from './utf8.js';
import { assertDeletable, resolveSandboxOptions, sandboxManagedBy, type Mount, type SandboxOptions } from './sandboxopts.js';

// SshDockerDriver: sandboxes as Docker containers on a host we own, driven over SSH.
// The one sandbox driver (see driver.ts): one fixed-cost box runs every project as a
// long-lived container (DinD via sysbox or --privileged, so Laravel Sail keeps working),
// and the driver maps the SandboxDriver contract onto plain docker + POSIX primitives:
//   • warm named sandbox  → `docker run -d --name proj-<slug> … sleep`, `docker start`
//     (dockerd inside comes up via the ensureDockerd guard — at chat prep, and at the first
//     warm-up after every boot of the container — so the image needs no entrypoint
//     cooperation).
//   • idle stop           → the bot's own (OpenSpec sandbox-idle-stop, idlestop.ts): Docker
//     has no idle lifecycle, and the session code relies on one (every idle conversation's
//     claude ends with the container). Every handle call and every chunk of session output
//     is recorded as activity here, the one place every caller goes through; warm-up, peek
//     and stop of one container run under one lock.
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

// The in-container exec script: stderr folded into stdout (the handle's exec returns one
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

// Zombie-aware liveness test for a session pid, as a shell condition. `kill -0` alone
// is NOT enough: it succeeds on a zombie, and a session process that dies while its
// docker-exec parent is already gone stays a zombie until PID 1 reaps it — the E2E smoke
// caught streams that never settled and running-checks that never went false because of
// exactly this. --init (below) makes zombies transient, but the reap is asynchronous, so
// the check must still treat state Z as dead.
const aliveCond = (pidExpr: string) =>
  `kill -0 ${pidExpr} 2>/dev/null && ! grep -q '^State:.*Z' "/proc/"${pidExpr}"/status" 2>/dev/null`;

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
    `while [ -n "$pid" ] && ${aliveCond('"$pid"')}; do sleep 2; done`,
    `sleep 1`, // let tail flush the final chunk (the result line) before we kill it
    `kill "$t" 2>/dev/null`,
    `wait "$t" 2>/dev/null || true`,
  ].join('\n');
}

// A session's process is alive and is that session's own — as a shell condition over three shell
// words (quoted literals, or "$var" expansions): the pid, the session's FIFO and its pid file.
// Liveness is the stream watcher's rule; identity is the process's standard input: the recorded pid
// is the `sh -c` the session script started with `< "$d/in"`, so /proc/<pid>/fd/0 resolves to that
// path (measured, busybox readlink; every live session of a canary container matched), and a pid
// that some other process holds now never does. Where the link cannot be read at all — no readlink
// in the image, a runtime that hides another process's descriptors — the session's own pid file
// naming that pid decides instead, the rule before the identity check.
// ONE rule for the probe and the boot step's cleanup (bootScript): a cleanup stricter than the probe
// removes the files of a session the probe calls up, the probe then calls that live process gone,
// and a reattach starts a second claude on its conversation and worktree.
const sessionAliveCond = (pid: string, fifo: string, pidFile: string): string =>
  `${aliveCond(pid)} && { f=$(readlink /proc/${pid}/fd/0 2>/dev/null); [ "$f" = ${fifo} ] || { [ -z "$f" ] && [ "$(cat ${pidFile} 2>/dev/null)" = ${pid} ]; }; }`;

// The sessionCommandRunning probe (sessionAliveCond). A pid alone is not an identity: pids start
// again from 1 at every container start, so a reattach record from before a boot (a host reboot,
// the idle stop, a restart by hand) can name a pid that some unrelated process holds now, and a bare
// `kill -0` would pass it. The fallback where the link cannot be read keeps a live session from
// ever being reported gone only because the runtime would not say; its price, only there, is the
// old rule's: a reattach record from before a boot whose pid a live process holds now reads as up
// while its session directory is on disk — and that directory can outlast the next boot's first
// warm-up: a warm-up that first sees the container running removes nothing, and a new boot's
// cleanup keeps whatever this rule calls up (bootScript).
export function runningProbeScript(key: string, pid: string): string {
  const p = sq(safeToken(pid));
  const d = sessDir(key);
  return `if ${sessionAliveCond(p, sq(`${d}/in`), sq(`${d}/pid`))}; then echo up; else echo down; fi`;
}

// The boot step of every warm-up (design D8 of sandbox-idle-stop), run inside the container with
// AVEN_BOOT = the container's .State.StartedAt and AVEN_OUTCOME = this warm-up's outcome. The
// marker /tmp/aven-sess/.boot remembers the boot the bot last cleaned up after:
//   • same boot → nothing (a warm container: almost every turn);
//   • no marker and `ready` → write it only: a container this code never saw boot — one running
//     since before this step existed, whose live sessions must not be touched;
//   • otherwise (a fresh start, a recycle, a marker from an earlier boot — a container started by
//     a warm-up whose probe then failed, by a host reboot or by hand) → a new boot: remove every
//     session directory whose process the probe above would not call up (sessionAliveCond, the
//     same rule: its pid is alive and reads this directory's FIFO as its stdin, or, where that
//     link cannot be read, is the pid its pid file names — so a session opened in this boot before
//     a failed boot step could write the marker survives, with or without a readable link), write
//     the marker, and on a dind project bring dockerd back (the container's `sleep` entrypoint
//     never starts it, and a continuing conversation never passes chat prep's guard, so its
//     `sail up -d` would fail after every wake).
// On a dind project the guard also runs, in any boot, when an idle stop left its mark: it stopped
// the inner dockerd, and then the container did not stop (`docker stop` failed, or the bot died
// in between) — same boot, no dockerd, and nothing else would bring it back for a continuing
// conversation.
// Prints `aven:fresh-boot` and the guard's `hk:dockerd=` marker (the caller sends both to stderr).
// An empty boot time (the inspect failed) removes nothing.
export function bootScript(dind: boolean): string {
  return [
    `d=${SESS_BASE}`,
    `seen=$(cat "$d/.boot" 2>/dev/null)`,
    `new=`,
    `if [ -n "$AVEN_BOOT" ] && [ "$seen" != "$AVEN_BOOT" ]; then`,
    `  if [ -n "$seen" ] || [ "$AVEN_OUTCOME" != ready ]; then new=1; fi`,
    `  mkdir -p "$d" && printf '%s' "$AVEN_BOOT" > "$d/.boot"`,
    `fi`,
    `if [ -n "$new" ]; then`,
    `  for s in "$d"/*/; do`,
    `    s=\${s%/}`,
    `    p=$(cat "$s/pid" 2>/dev/null)`,
    `    [ -n "$p" ] && ${sessionAliveCond('"$p"', '"$s/in"', '"$s/pid"')} && continue`,
    `    [ -d "$s" ] && rm -rf "$s"`,
    `  done`,
    `  echo aven:fresh-boot`,
    `fi`,
    ...(dind ? [`if [ -n "$new" ] || [ -e "$d/${DOCKERD_STOPPED_MARK}" ]; then`, `  rm -f "$d/${DOCKERD_STOPPED_MARK}"`, `  ${dockerdGuardCmd()}`, `fi`] : []),
  ].join('\n');
}
// Left by an idle stop that stopped the inner dockerd (stopSandboxScript), for the boot step above.
const DOCKERD_STOPPED_MARK = '.dockerd-stopped';

// Warm the named container and hand back what happened: ready | started | created |
// revived. The container's own process is just sleep — claude/dockerd/etc. start on
// demand (the boot step above revives dockerd at the first warm-up after every start of the
// container, project.ts's ensureDockerd guard at every chat prep). A failed `docker start` is
// tried once more after two seconds: with the idle stop every quiet half hour ends in a stop, so
// starts that used to be rare are routine, and a failed one is an error in someone's thread.
//
// NO docker restart policy, on purpose. Containers used to carry `--restart
// unless-stopped` so a host reboot brought the fleet back warm — but that lets the
// DAEMON start the container at the worst moment: the first seconds after it boots.
// On Docker Desktop/WSL the host filesystem is not yet exported to the engine VM at
// that point, so every bind mount comes up as an EMPTY directory and stays that way
// (the sources replica vanished from proj-owen-ops for 8h on 2026-10-13: the container
// was auto-restarted at 08:31Z, the host side was fine all along). With no policy the
// container just stays stopped until the next turn, when THIS script's `docker start`
// branch wakes it — a lazy start at a moment the filesystem is guaranteed to be there,
// for the price of a few seconds on the first turn after a reboot. Existing containers
// are migrated in place (`docker update --restart=no`) — the flag is per container.
//
// The trailing health probe is not paranoia: a container can be `running` and still
// refuse EVERY `docker exec`. sysbox keeps its own registry of the containers it
// manages, and restarting its daemons (any host upgrade touching kernel/libc does)
// drops the entries for containers already running — from then on every exec dies with
// "OCI runtime exec failed: … unsafe procfs detected" while `docker ps` still says Up.
// That wedged the coach-aven sandbox for 12 days in 2026-08 (sysbox restarted Jul 29,
// container up since Jul 13) and every turn failed at the first upload. stop+start
// re-registers the container with sysbox and costs nothing here — an exec-less sandbox
// is useless anyway, so recycling can only improve on it. Probed twice before recycling
// so a momentarily busy daemon doesn't kill a live session.
//
// The mount probe guards the same failure from the other side: for every bind mount
// whose host directory has content, the container must see content at the target. An
// empty target over a non-empty source is a bind mount that attached to nothing
// (see above) and can only be fixed by stop+start — `docker start` re-resolves the
// mount. Verified before every turn because it is one `ls -A` per mount; a target that
// is still empty after the recycle FAILS the ensure (exit 1, the reason on stderr).
// It used to be a stderr note only ("degraded, not useless") — but a run against a
// missing sources replica is worse than no run: on 2026-10-13 two scheduled runs
// settled "ok" with every data call failing, and nothing machine-readable said so.
// A failed ensure surfaces as a failed turn, which the routine delivery guard
// (routineguard.ts) labels and retries. Prod projects mount nothing, so this branch
// never runs there.
//
// `runtimeFlag` is '' for an unprivileged project (plain `docker run`); `mounts` become
// `-v src:dst:mode` (paths pre-validated by sandboxopts.ts, quoted again here); `dind`
// false skips the exec-probe/recycle block — that dance exists for sysbox's registry,
// which an ordinary container never touches.
export function ensureSandboxScript(
  name: string,
  projectSlug: string,
  image: string,
  runtimeFlag: string,
  mounts: Mount[] = [],
  dind = true,
): string {
  const n = sq(safeToken(name));
  const volumeArgs = mounts.map((m) => `-v ${sq(`${safeToken(m.source)}:${safeToken(m.target)}:${m.mode}`)}`).join(' ');
  const runFlags = [runtimeFlag, volumeArgs].filter(Boolean).join(' ');
  const probe = dind
    ? [
        `if ! docker exec ${n} true >/dev/null 2>&1; then`,
        `  sleep 2`,
        `  if ! err=$(docker exec ${n} true 2>&1); then`,
        `    echo "exec probe failed, recycling ${name}: $err" >&2`,
        `    docker stop -t 10 ${n} >/dev/null 2>&1`,
        `    docker start ${n} >/dev/null 2>&1`,
        `    if ! err=$(docker exec ${n} true 2>&1); then`,
        `      echo "still no exec after recycle: $err" >&2`,
        `      exit 1`,
        `    fi`,
        `    outcome=revived`,
        `  fi`,
        `fi`,
      ]
    : [];
  const mountProbe = mounts.flatMap((m) => {
    const src = sq(safeToken(m.source));
    const tgt = sq(safeToken(m.target));
    const inside = `docker exec ${n} ls -A ${tgt} 2>/dev/null`;
    return [
      `if [ -n "$(ls -A ${src} 2>/dev/null)" ] && [ -z "$(${inside})" ]; then`,
      `  echo "mount ${m.target} is empty while ${m.source} is not — recycling ${name} (bind mount attached before the host fs was up)" >&2`,
      `  docker stop -t 10 ${n} >/dev/null 2>&1`,
      `  docker start ${n} >/dev/null 2>&1`,
      `  if [ -z "$(${inside})" ]; then echo "mount ${m.target} still empty after recycle" >&2; exit 1; fi`,
      `  outcome=revived`,
      `fi`,
    ];
  });
  return [
    `state=$(docker inspect -f '{{.State.Running}}' ${n} 2>/dev/null)`,
    `if [ "$state" = "true" ]; then outcome=ready`,
    `elif [ "$state" = "false" ]; then docker start ${n} >/dev/null || { sleep 2; docker start ${n} >/dev/null; } || exit 1; outcome=started`,
    `else`,
    // --init: docker's tini as PID 1. Without it PID 1 is our `sleep`, which never reaps
    // orphans — every finished session process would linger as a zombie forever (and
    // zombies pass kill -0, wedging streams and running-checks; found by the E2E smoke).
    // Existing containers created without --init must be recreated.
    `  docker run -d --init --name ${n}${runFlags ? ` ${runFlags}` : ''} \\`,
    `    -e IS_SANDBOX=1 --label managedBy=${sq(sandboxManagedBy())} --label project=${sq(safeToken(projectSlug))} \\`,
    `    --entrypoint sh ${sq(image)} -c 'sleep 2147483647' >/dev/null || exit 1`,
    `  outcome=created`,
    `fi`,
    // Migration for containers created with the old `--restart unless-stopped`: the
    // policy lives on the container, so strip it in place (idempotent, no-op on new ones).
    `docker update --restart=no ${n} >/dev/null 2>&1 || true`,
    ...probe,
    ...mountProbe,
    // After the probes: the container answers exec, and a recycle above already changed its boot.
    // Best effort, all of it on stderr — the outcome stays the last stdout line.
    `boot=$(docker inspect -f '{{.State.StartedAt}}' ${n} 2>/dev/null)`,
    `docker exec -e AVEN_BOOT="$boot" -e AVEN_OUTCOME="$outcome" ${n} sh -c ${sq(bootScript(dind))} >&2 || true`,
    `echo "$outcome"`,
  ].join('\n');
}

// Stop a project container the idle sweep found idle (OpenSpec sandbox-idle-stop, design D5) and
// say what happened, by name — never from a listing: `docker ps --filter label=managedBy=…` would
// hide a container that carries one of our names under someone else's label from the check below.
//   missing      — no such container (after making sure the daemon answers at all);
//   foreign …    — our name, not our labels (another installation's, or a hand-made one): left alone;
//   not-running  — already stopped;
//   stopped      — it was ours and running, and now it is not.
// On a docker-in-docker project the INNER dockerd is asked to stop first, and waited for up to
// 30 s: PID 1 is docker's --init, whose only child is `sleep`, so a plain `docker stop` ends with
// the kernel SIGKILLing every other process of the container — dockerd and every container it
// runs (a Sail stack's database) included. dockerd on SIGTERM stops its containers with their own
// grace first (measured: an inner container that traps SIGTERM gets it this way, and nothing
// without). An image that ran dockerd as its entrypoint would get that grace from a plain
// `docker stop`; ours runs `sleep`.
// Before the signal it leaves a mark in the container: should the outer stop then fail (or the bot
// die before it), the next warm-up's boot step finds a running container of the same boot with no
// dockerd, and the mark tells it to bring dockerd back (bootScript).
export function stopSandboxScript(name: string, slug: string, managedBy: string, dind: boolean): string {
  const n = sq(safeToken(name));
  const innerDockerdStop = [
    `p=$(cat /var/run/docker.pid 2>/dev/null)`,
    `[ -n "$p" ] || exit 0`,
    `mkdir -p ${SESS_BASE} && : > ${SESS_BASE}/${DOCKERD_STOPPED_MARK}`,
    `kill -TERM "$p" 2>/dev/null || exit 0`,
    `i=0`,
    `while ${aliveCond('"$p"')} && [ $i -lt ${INNER_DOCKERD_STOP_S} ]; do sleep 1; i=$((i+1)); done`,
  ].join('; '); // one line of the host script
  return [
    `info=$(docker inspect -f '{{.State.Running}}|{{index .Config.Labels "managedBy"}}|{{index .Config.Labels "project"}}' ${n} 2>/dev/null) || { docker version >/dev/null 2>&1 || exit 1; echo missing; exit 0; }`,
    `running=\${info%%|*}; rest=\${info#*|}; mb=\${rest%%|*}; pj=\${rest#*|}`,
    `if [ "$mb" != ${sq(managedBy)} ] || [ "$pj" != ${sq(safeToken(slug))} ]; then echo "foreign managedBy=$mb, project=$pj"; exit 0; fi`,
    `[ "$running" = true ] || { echo not-running; exit 0; }`,
    ...(dind ? [`docker exec ${n} sh -c ${sq(innerDockerdStop)} >/dev/null 2>&1 || true`] : []),
    `docker stop -t 10 ${n} >/dev/null || exit 1`,
    `echo stopped`,
  ].join('\n');
}
// The inner dockerd's own shutdown grace for its containers is 15 s; twice that is the most a
// stop waits for it before the outer stop goes ahead anyway.
const INNER_DOCKERD_STOP_S = 30;
// Inspect + the inner dockerd's wait + `docker stop -t 10`, with room to spare.
const STOP_TIMEOUT_MS = 90_000;
// A peek is one `docker inspect` (well under a second, ssh included); what it waits for longest is
// the per-container lock, which this does not count.
const PEEK_TIMEOUT_MS = 30_000;

// `docker ps` lines ("name\tstate") → the state map /aven status renders. Docker's
// `running` maps to `started`; everything else (exited/created/paused) reads as
// `stopped` — the same asleep/awake dichotomy the rest of the bot works with.
export function parseContainerStates(out: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, state] = line.trim().split('\t');
    if (name && state) states.set(name, state === 'running' ? 'started' : 'stopped');
  }
  return states;
}

// ── ssh transport ───────────────────────────────────────────────────────────

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshRunOpts {
  stdin?: Buffer | string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
}
// The transport, injectable for tests (a fake host); production always uses runSsh below.
export type SshRun = (host: string, remoteCmd: string, opts?: SshRunOpts) => Promise<SshResult>;

// Run one remote command over ssh, with optional stdin. BatchMode: never prompt (a
// missing key must fail fast, not hang the turn). stdout carries the payload (the
// scripts fold the in-container stderr into it); stderr is kept SEPARATE but not
// discarded: docker's own failures — "container is not running", "OCI runtime exec
// failed: …" — never reach the script's stdout, and dropping them turned a wedged
// sandbox into a bare `exit 126` with no clue what broke (prod, 2026-08-10).
// The literal host `local` means "this machine": the same command runs through `sh -c`
// instead of `ssh`, for a single-box self-hosted instance (laptop/WSL, a Mac mini) where
// the bot and the sandboxes share the Docker daemon and nobody wants to run sshd to
// talk to localhost. This is the ONLY place that knows; every script builder above stays
// byte-identical, and the remote command (`docker exec … sh -s`, `sh -s`) is exactly what
// ssh would have handed the remote shell. Note the trust change: bot and sandboxes then
// share a kernel, so pair local mode with `sandbox.privileged: false` projects.
export const LOCAL_HOST = 'local';

export function transportArgv(host: string, remoteCmd: string): { cmd: string; args: string[] } {
  if (host === LOCAL_HOST) return { cmd: 'sh', args: ['-c', remoteCmd] };
  return { cmd: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCmd] };
}

// A timeout must end the whole call. Over ssh, killing ssh does: the remote side goes with the
// connection. In local mode the remote command runs right here under `sh -c`, and the docker CLIs
// it started hold the output pipes open after their shell is killed — the call would outlive its
// timeout by as long as they run, and a hung stop would hold its container's lock (idlestop.ts)
// with it. So a local call with a timeout runs in a process group of its own, and the timeout
// kills the group. Calls without a timeout (the session log tail) are spawned exactly as before.
// The price, local mode only: such a call is out of a terminal's reach (Node's `detached` gives it
// a session of its own). Ctrl-C in the terminal that runs the bot (SIGINT to its foreground process
// group) or closing that terminal ends the bot but not a timed call it had in flight (a warm-up, a
// stop, an exec with a timeout): that call runs on until it ends by itself, since its timeout ended
// with the bot. Under systemd nothing changes: stopping the unit signals every process in its
// cgroup (KillMode=control-group, the default), whatever its group or session.
export function runSsh(host: string, remoteCmd: string, opts: SshRunOpts = {}): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    const t = transportArgv(host, remoteCmd);
    const group = host === LOCAL_HOST && !!opts.timeoutMs && opts.timeoutMs > 0;
    const child = spawn(t.cmd, t.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(group ? { detached: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (group && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            /* the group is gone already — fall through to the child itself */
          }
        }
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }
    // Decoded incrementally (src/utf8.ts): a per-chunk toString splits multibyte chars.
    const out = utf8Chunks();
    const emit = (s: string) => {
      if (!s) return;
      if (opts.onStdout) opts.onStdout(s);
      else stdout += s;
    };
    child.stdout.on('data', (c: Buffer) => emit(out.push(c)));
    // Bounded: a long tail (streamSessionCommandLogs) can sit here for a whole turn, and
    // stderr is only ever read for error messages.
    const err = utf8Chunks();
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 8192) stderr += err.push(c);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // Flush a trailing partial character (a truncated stream ends mid-sequence).
      emit(out.flush());
      stderr += err.flush();
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

// Append docker's/ssh's own complaint to a thrown error — the difference between
// "upload failed (exit 126)" and knowing the container refuses to exec.
function errTail(r: SshResult): string {
  const s = r.stderr.trim();
  return s ? `\n--- stderr ---\n${s.slice(-1000)}` : '';
}

// The listing's verdict (OpenSpec retire-daytona-driver D4): the state map, or an error carrying
// ssh's/docker's own words. A non-zero exit is a listing that could not answer — ssh's 255 when the
// host is unreachable, docker's 1 when its daemon is down — and it used to parse as an EMPTY map:
// /aven status then showed ✅ with every project "not created" through an outage. Throwing turns
// that into the ⚠️ flag, and the CLI probe's leftover sweep fails early with the real cause.
export function listingStates(r: SshResult): Map<string, string> {
  if (r.code !== 0) throw new Error(`sandbox listing failed (exit ${r.code})${errTail(r)}`);
  return parseContainerStates(r.stdout);
}

// ── the driver ──────────────────────────────────────────────────────────────

class SshDockerHandle implements SandboxHandle {
  constructor(
    private readonly host: string,
    readonly name: string,
    readonly started: boolean,
    private readonly run: SshRun = runSsh,
  ) {}

  // Every call into the container is activity for the idle stop (idlestop.ts): in flight while it
  // runs, a touch at its start and end. Done here, where every caller passes — turns, housekeeping,
  // the dream journal, /aven memory, Restart session — so no caller can forget it.
  private tracked<T>(op: () => Promise<T>): Promise<T> {
    return sandboxActivity.track(this.name, op);
  }

  // All in-container work goes through `docker exec -i <name> sh -s` with the script on
  // stdin — no remote-shell quoting layer for the script itself.
  private inContainer(script: string, opts: SshRunOpts = {}): Promise<SshResult> {
    return this.run(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -s`, {
      ...opts,
      stdin: script,
    });
  }

  exec(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
    return this.tracked(async () => {
      const t = opts.timeout ?? 0;
      const r = await this.inContainer(execScript(command, opts), {
        // Local backstop slightly above the remote `timeout` so the remote one wins
        // (its exit code is meaningful); no remote timeout → no local one either.
        timeoutMs: t > 0 ? (t + 30) * 1000 : undefined,
      });
      if (opts.check && r.code !== 0) {
        throw new Error(
          `command failed (exit ${r.code}): ${command}\n--- output ---\n${r.stdout}${errTail(r)}`,
        );
      }
      return { exitCode: r.code, result: r.stdout };
    });
  }

  uploadFile(data: Buffer, path: string): Promise<void> {
    return this.tracked(async () => {
      // Bytes via stdin (tokens must never transit a command line); mkdir -p the parent.
      const inner = `mkdir -p $(dirname ${sq(path)}) && cat > ${sq(path)}`;
      const r = await this.run(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -c ${sq(inner)}`, {
        stdin: data,
      });
      if (r.code !== 0) throw new Error(`upload to ${path} failed (exit ${r.code})${errTail(r)}`);
    });
  }

  createSession(sessionKey: string): Promise<void> {
    return this.tracked(async () => {
      await this.inContainer(`mkdir -p ${sq(sessDir(sessionKey))}`);
    });
  }

  startSessionCommand(sessionKey: string, command: string): Promise<{ cmdId: string }> {
    return this.tracked(async () => {
      const r = await this.inContainer(startSessionScript(sessionKey, command));
      const pid = r.stdout.trim();
      if (r.code !== 0 || !/^\d+$/.test(pid)) {
        throw new Error(`session start failed (exit ${r.code}): ${r.stdout.slice(0, 500)}${errTail(r)}`);
      }
      return { cmdId: pid };
    });
  }

  sessionCommandRunning(sessionKey: string, cmdId: string): Promise<boolean> {
    // cmdId is the in-container pid; the probe also checks that the pid's stdin is this
    // session's FIFO, so a pid recycled after a container restart reads as gone (where the
    // runtime lets the bot read that link; see the script for where it does not).
    return this.tracked(async () => {
      const r = await this.inContainer(runningProbeScript(sessionKey, cmdId));
      return r.stdout.trim() === 'up';
    });
  }

  sessionCommandLogs(sessionKey: string, _cmdId: string): Promise<string> {
    return this.tracked(async () => {
      const r = await this.inContainer(`cat ${sq(sessDir(sessionKey))}/out.log 2>/dev/null || true`);
      return r.stdout;
    });
  }

  // Not tracked as in flight: the tail lasts as long as the process, which would pin the container
  // forever. Its output is what counts — every chunk is activity, like any call.
  async streamSessionCommandLogs(
    sessionKey: string,
    _cmdId: string,
    onStdout: (chunk: string) => void,
  ): Promise<void> {
    sandboxActivity.touch(this.name);
    await this.inContainer(streamSessionScript(sessionKey), {
      onStdout: (chunk) => {
        sandboxActivity.touch(this.name);
        onStdout(chunk);
      },
    });
  }

  sendSessionInput(sessionKey: string, _cmdId: string, data: string): Promise<void> {
    return this.tracked(async () => {
      // Data via stdin into the FIFO. Writers open/write/close freely — the holder keeps
      // the write end open so the reader never EOFs between turns.
      const inner = `cat > ${sq(sessDir(sessionKey))}/in`;
      const r = await this.run(this.host, `docker exec -i ${sq(safeToken(this.name))} sh -c ${sq(inner)}`, {
        stdin: data,
      });
      if (r.code !== 0) throw new Error(`session input failed (exit ${r.code})${errTail(r)}`);
    });
  }

  deleteSession(sessionKey: string): Promise<void> {
    return this.tracked(async () => {
      const d = sessDir(sessionKey);
      await this.inContainer(
        [
          `for f in pid holder; do kill "$(cat ${sq(d)}/$f 2>/dev/null)" 2>/dev/null; done`,
          `rm -rf ${sq(d)}`,
        ].join('\n'),
      );
    });
  }
}

export class SshDockerDriver implements SandboxDriver {
  private readonly host: string;
  private readonly runtimeFlag: string;

  constructor(
    private readonly cfg: Config,
    private readonly run: SshRun = runSsh,
  ) {
    if (!cfg.sshDocker) {
      throw new Error('SSHDOCKER_HOST is not set — required for the ssh-docker sandbox driver');
    }
    this.host = cfg.sshDocker.host;
    // DinD needs either sysbox (preferred: unprivileged-but-docker-capable) or the
    // --privileged hammer. Configured host-wide via SSHDOCKER_RUNTIME.
    this.runtimeFlag = cfg.sshDocker.runtime === 'sysbox-runc' ? '--runtime sysbox-runc' : '--privileged';
  }

  private onHost(script: string, opts: SshRunOpts = {}): Promise<SshResult> {
    return this.run(this.host, 'sh -s', { ...opts, stdin: script });
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

  // Under the container's lock (a stop of it finishes first — idlestop.ts), tracked as activity,
  // and the parked mark is cleared at the START of every attempt: any attempt may have started the
  // container (a `docker start` whose probe then failed leaves it running), and only a warm-up can.
  ensureSandbox(name: string, projectSlug: string, opts?: SandboxOptions): Promise<SandboxHandle> {
    return sandboxActivity.exclusive(name, () => {
      sandboxActivity.unpark(name);
      return sandboxActivity.track(name, () => this.warm(name, projectSlug, opts));
    });
  }

  private async warm(name: string, projectSlug: string, opts?: SandboxOptions): Promise<SandboxHandle> {
    // Project options shape creation only: an existing container keeps the flags it was created with.
    const o = resolveSandboxOptions(opts);
    const script = ensureSandboxScript(
      name,
      projectSlug,
      this.cfg.snapshot.image,
      o.privileged ? this.runtimeFlag : '',
      o.mounts,
      o.dind,
    );
    // Room for the create/pull path plus a stop(-t 10)+start recycle.
    const r = await this.onHost(script, { timeoutMs: 180_000 });
    const outcome = lastLine(r.stdout);
    if (r.code !== 0 || !['ready', 'started', 'created', 'revived'].includes(outcome)) {
      throw new Error(
        `ensureSandbox ${name} failed (exit ${r.code}): ${r.stdout.slice(0, 500)}${errTail(r)}`,
      );
    }
    // The boot step's markers (bootScript): the old boot's sessions were cleared, and dockerd's
    // state after the guard (a new boot, or an idle stop's mark). A dockerd that would not start is
    // worth a warning, not a failed warm-up: turns that need no Sail still work, and chat prep's
    // guard reports it to Sentry.
    const fresh = /^aven:fresh-boot$/m.test(r.stderr);
    const dockerd = r.stderr.match(/^hk:dockerd=(\w+)$/m)?.[1];
    const notes = [...(fresh ? ['new boot: session files reset'] : []), ...(dockerd ? [`dockerd ${dockerd}`] : [])];
    const boot = notes.length ? ` — ${notes.join(', ')}` : '';
    // A revive means the host wedged the container under us (exec refused, or a bind
    // mount that attached to nothing) — worth a WARN (it reaches Sentry), not a silent heal.
    if (outcome === 'revived') {
      log.warn(`sandbox '${name}' was up but unhealthy — recycled it (ssh-docker)${boot}:${errTail(r)}`);
    } else if (dockerd === 'failed') {
      log.warn(`sandbox '${name}' ${outcome} (ssh-docker)${boot}`);
    } else if (outcome !== 'ready' || boot) {
      log.info(`sandbox '${name}' ${outcome} (ssh-docker)${boot}`);
    }
    return new SshDockerHandle(this.host, name, true, this.run);
  }

  // A peek: never starts anything, records nothing — but waits for a stop of the container that
  // is under way, and reports the state after it. It runs under the container's lock, so it has a
  // timeout of its own: on a Docker daemon that stopped answering, a peek without one (nightly
  // housekeeping, /aven memory, the dream journal) would hold the lock for good, and every warm-up of
  // the container would wait behind it — the project's turns sitting at "Preparing…" with no error
  // instead of failing at the warm-up's own timeout. No answer reads as no sandbox, as an unreachable
  // host always did, and is logged.
  getSandbox(name: string): Promise<SandboxHandle | undefined> {
    return sandboxActivity.exclusive(name, async () => {
      const r = await this.onHost(
        `docker inspect -f '{{.State.Running}}' ${sq(safeToken(name))} 2>/dev/null || echo missing`,
        { timeoutMs: PEEK_TIMEOUT_MS },
      );
      const state = r.stdout.trim();
      if (state === 'true' || state === 'false') return new SshDockerHandle(this.host, name, state === 'true', this.run);
      if (state !== 'missing') log.warn(`sandbox '${name}': no answer to a state check (exit ${r.code}) — read as no sandbox${errTail(r)}`);
      return undefined;
    });
  }

  async listStates(): Promise<Map<string, string>> {
    const r = await this.onHost(
      `docker ps -a --filter label=managedBy=${sq(sandboxManagedBy())} --format '{{.Names}}\t{{.State}}'`,
    );
    return listingStates(r);
  }

  // The idle sweep's stop (idlestop.ts; design D5–D7 of sandbox-idle-stop). Under the container's
  // lock: re-decide first (work that arrived since the sweep looked skips the stop without a host
  // call), then the script; on `stopped`, the engine ends the project's sessions and forgets their
  // coordinates BEFORE the parked mark and before the lock opens — a warm-up queued behind the stop
  // starts the container only after that. A container the script says is not ours, not running or
  // missing is parked too: nothing to do until a warm-up.
  stopSandbox(req: StopRequest): Promise<StopOutcome> {
    return sandboxActivity.exclusive(req.name, async (): Promise<StopOutcome> => {
      if (!req.recheck()) return { kind: 'skipped' };
      const t0 = Date.now();
      const r = await this.onHost(stopSandboxScript(req.name, req.slug, sandboxManagedBy(), req.dind), { timeoutMs: STOP_TIMEOUT_MS });
      const out = lastLine(r.stdout);
      if (out === 'stopped') {
        try {
          req.onStopped();
        } catch (e) {
          log.warn(`idle stop of '${req.name}': ending its sessions failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        sandboxActivity.park(req.name);
        return { kind: 'stopped', ms: Date.now() - t0 };
      }
      if (out === 'not-running' || out === 'missing') {
        sandboxActivity.park(req.name);
        return { kind: out };
      }
      if (out.startsWith('foreign ')) {
        sandboxActivity.park(req.name);
        return { kind: 'foreign', labels: out.slice('foreign '.length) };
      }
      throw new Error(`stopSandbox ${req.name} failed (exit ${r.code}): ${r.stdout.slice(0, 300)}${errTail(r)}`);
    });
  }

  async deleteSandbox(name: string): Promise<void> {
    assertDeletable(name, this.cfg.sandbox.namePrefix);
    const r = await this.onHost(deleteSandboxScript(name), { timeoutMs: 60_000 });
    if (r.stdout.trim() !== 'gone') {
      throw new Error(`deleteSandbox ${name} failed (exit ${r.code}): ${r.stdout.slice(0, 300)}${errTail(r)}`);
    }
  }
}

// The scripts' verdict is their last stdout line (anything a step printed before it is not).
const lastLine = (out: string): string => out.trim().split('\n').at(-1)?.trim() ?? '';

// Remove a container and prove it is gone: `docker rm -f` of a missing container fails on some
// Docker versions and succeeds on others, so the verdict is the inspect afterwards, not rm's exit.
export function deleteSandboxScript(name: string): string {
  const n = sq(safeToken(name));
  return `docker rm -f ${n} >/dev/null 2>&1; if docker inspect ${n} >/dev/null 2>&1; then echo still-there; else echo gone; fi`;
}
