// The idle stop (OpenSpec `sandbox-idle-stop`): a project sandbox nobody uses is stopped after
// SANDBOX_AUTOSTOP_MINUTES. The session code relies on that lifecycle — the live-session LRU and
// the chat prune leave a conversation's `claude` process to "the sandbox's own idle lifecycle" —
// and a Docker container has none: without this, every conversation touched since a container
// started kept its process (and the agent's Sail stack kept running) until the container restarted.
//
// The parts, all pure or injected so they are tested without Docker:
//   • SandboxActivity — what the bot did in each container and when (every handle call, every
//     chunk of session output; recorded by the ssh-docker driver, the one choke point every
//     caller goes through), the per-container lock that serializes warm-up, peek and stop, and
//     the parked mark;
//   • idleStopDue — the rule (design D2): holds never stop, a pending wakeup is waited for,
//     lingering work postpones up to the turn hard cap, quiet time against the window;
//   • createIdleSweep and candidateList — the once-a-minute check that asks the driver to stop a
//     due container, re-deciding under that container's lock (design D5/D6), over the stored
//     sandbox names of this installation's projects (D10);
//   • the small decisions around it, each pinned by a test: the configured minutes and the boot
//     lines (idleStopPlan), whether a stop cut work its conversation must hear about
//     (stopCutWork), what the nightly housekeeping does with an asleep sandbox
//     (housekeepingSandboxStep).
// The engine's view (holds, sessions) comes from turn.ts; the stop itself from the driver.
//
// Every duration is measured on the monotonic clock (monoNow), the one the turn watchdog's timers
// run on. A host suspend or a wall-clock step is not idle time: a laptop that slept for an hour
// during a turn would otherwise find, at the first check after it wakes, the turn's hold "stuck"
// and the container "idle", before the watchdog (which did not see that hour either) had any
// reason to end the turn. Only a wakeup's due time is the CLI's wall-clock time; the engine hands
// the rule how far away it is (SandboxUse.wakeupInMs).
import { resolveSandboxOptions, type SandboxOptions } from './sandboxopts.js';

/** The ssh-docker stop never runs sooner than this after the last activity (design D9). */
export const IDLE_STOP_FLOOR_MINUTES = 10;
/** A scheduled wakeup holds the container until this long after it is due (design D2). */
export const WAKEUP_GRACE_MS = 2 * 60_000;
/** A hold older than the turn hard cap plus this margin stops holding: a hang before the watchdog. */
export const STALE_HOLD_MARGIN_MS = 5 * 60_000;
/** How often the sweep checks. */
export const SWEEP_EVERY_MS = 60_000;
/** Minutes before a failed stop of one container is tried again, by consecutive failures. */
const BACKOFF_MINUTES = [1, 2, 4, 8, 15] as const;
/** A failure this old belongs to an outage that ended while the container had work (no stop was tried). */
const OUTAGE_OVER_MS = 2 * BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]! * 60_000;

/** The idle stop's clock: monotonic milliseconds (libuv's, like every timer's), never the wall clock. */
export const monoNow = (): number => performance.now();

// ── the activity record ─────────────────────────────────────────────────────

export interface ActivityView {
  lastActivity: number; // monotonic ms (monoNow), never before the sweep started
  inFlight: number; // calls into the container that have not returned
  parked: boolean; // the sweep has nothing to do here until a warm-up (stopped, missing, foreign)
}

// One per process (`sandboxActivity` below): createDriver builds a new driver object per call,
// so the record cannot live on a driver. Keyed by container name; bounded by the projects (and,
// in the CLI probe's process, its own throwaway names).
export class SandboxActivity {
  private floor = 0;
  private readonly recs = new Map<string, { last: number; inFlight: number; parked: boolean }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = monoNow) {}

  /** The sweep starts: no idle clock counts from before this moment (a restart is not idleness). */
  start(): void {
    this.floor = this.now();
  }

  private rec(name: string): { last: number; inFlight: number; parked: boolean } {
    let r = this.recs.get(name);
    if (!r) {
      r = { last: 0, inFlight: 0, parked: false };
      this.recs.set(name, r);
    }
    return r;
  }

  touch(name: string): void {
    this.rec(name).last = this.now();
  }

  /** A call into the container: in flight while it runs, a touch at its start and its end (also on failure). */
  async track<T>(name: string, op: () => Promise<T>): Promise<T> {
    const r = this.rec(name);
    r.inFlight++;
    r.last = this.now();
    try {
      return await op();
    } finally {
      r.inFlight--;
      r.last = this.now();
    }
  }

  park(name: string): void {
    this.rec(name).parked = true;
  }

  /** Every warm-up attempt, successful or not: any attempt may have started the container. */
  unpark(name: string): void {
    const r = this.recs.get(name);
    if (r) r.parked = false;
  }

  view(name: string): ActivityView {
    const r = this.recs.get(name);
    return { lastActivity: Math.max(this.floor, r?.last ?? 0), inFlight: r?.inFlight ?? 0, parked: r?.parked ?? false };
  }

  /**
   * Run `fn` alone for this container: warm-up, peek and stop of one container never interleave
   * (design D6). A promise chain per name; a rejected `fn` rejects its caller and never the chain.
   */
  exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(name, tail);
    void tail.then(() => {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    });
    return run;
  }
}

export const sandboxActivity = new SandboxActivity();

// ── the rule ────────────────────────────────────────────────────────────────

/** Work that postpones a stop only up to the turn hard cap of container silence (design D2). */
export type LingerKind = 'background' | 'injected' | 'self-turn' | 'stale-hold' | 'call';

/** What the turn engine and the live sessions say about one project (turn.ts sandboxUse). */
export interface SandboxUse {
  held: boolean;
  lingering?: Exclude<LingerKind, 'call'>;
  // How far away the latest pending ScheduleWakeup of the project's live sessions is, in ms
  // (negative once it is due): its due time is the CLI's, on the wall clock.
  wakeupInMs?: number;
  // The conversations (live-session keys) whose process a stop now would cut short (stopCutWork).
  // Not an input of the rule: the sweep keeps the value its re-check read under the container's
  // lock, right before the stop, and hands it to the engine once the container stopped (design D7)
  // — by then the stopped container's log streams have usually ended those processes already, and
  // with them what they listed.
  cut?: string[];
}

export interface IdleInputs {
  now: number; // monotonic, like activity.lastActivity
  autoStopMs: number;
  hardCapMs: number;
  activity: ActivityView;
  use: SandboxUse;
}

export type IdleDecision =
  | { stop: false; reason: 'off' | 'parked' | 'held' | 'recent' | 'wakeup' | 'lingering' }
  | { stop: true; idleMs: number; forced?: LingerKind };

export function idleStopDue(i: IdleInputs): IdleDecision {
  if (i.autoStopMs <= 0) return { stop: false, reason: 'off' };
  if (i.activity.parked) return { stop: false, reason: 'parked' };
  if (i.use.held) return { stop: false, reason: 'held' };
  const idleMs = i.now - i.activity.lastActivity;
  if (idleMs < i.autoStopMs) return { stop: false, reason: 'recent' };
  // Known due time, bounded by the CLI's one-hour clamp: waited for exactly, not cut at the bound.
  if (i.use.wakeupInMs !== undefined && i.use.wakeupInMs > -WAKEUP_GRACE_MS) return { stop: false, reason: 'wakeup' };
  const lingering: LingerKind | undefined = i.use.lingering ?? (i.activity.inFlight > 0 ? 'call' : undefined);
  if (lingering) {
    if (idleMs < Math.max(i.autoStopMs, i.hardCapMs)) return { stop: false, reason: 'lingering' };
    return { stop: true, idleMs, forced: lingering };
  }
  return { stop: true, idleMs };
}

/** SANDBOX_AUTOSTOP_MINUTES as the ssh-docker stop applies it: ≤ 0 → off (0), below the floor → the floor. */
export function idleStopMinutes(configured: number): { minutes: number; raised: boolean } {
  if (!(configured > 0)) return { minutes: 0, raised: false };
  if (configured < IDLE_STOP_FLOOR_MINUTES) return { minutes: IDLE_STOP_FLOOR_MINUTES, raised: true };
  return { minutes: configured, raised: false };
}

/**
 * The idle stop as the bot process runs it (pollers.ts): the minutes (0 = off: no sweep, and no
 * housekeeping wake either) and the lines it logs when it starts — the canary's proof of the setting.
 */
export function idleStopPlan(configured: number): { minutes: number; info: string; warn?: string } {
  const { minutes, raised } = idleStopMinutes(configured);
  if (minutes <= 0) return { minutes: 0, info: 'idle stop: off (SANDBOX_AUTOSTOP_MINUTES ≤ 0)' };
  return {
    minutes,
    info: `idle stop: sandboxes without an idle stop of their own (ssh-docker) stop after ${minutes} min without activity`,
    ...(raised ? { warn: `SANDBOX_AUTOSTOP_MINUTES=${configured} is below the idle stop's floor — ssh-docker sandboxes stop after ${minutes} min` } : {}),
  };
}

/**
 * Whether a stop cut short work its conversation must hear about (design D7): background tasks the
 * CLI still listed, or a turn it was running on its own — work whose 🔔 Background update would
 * otherwise never come. An unanswered injected message is not: the deliverer sends it again as a
 * turn. A process that had already ended reports nothing (ClaudeSession.idleState), so it is asked
 * BEFORE the stop, while the processes still run (the engine's sandboxUse in the stop's re-check:
 * SandboxUse.cut) — asked after it, the stopped container's log streams have usually ended them.
 */
export const stopCutWork = (s: { background: number; selfTurn: boolean }): boolean => s.background > 0 || s.selfTurn;

/**
 * What the nightly housekeeping pass does with a project's sandbox (design D13): runs in an awake
 * one; wakes an asleep one only where the bot owns the idle stop AND it is on, so the stop puts it
 * back to sleep — on a driver whose provider stops its own sandboxes, or with
 * SANDBOX_AUTOSTOP_MINUTES=0, an asleep sandbox is skipped; a missing one is never created.
 */
export function housekeepingSandboxStep(s: { exists: boolean; started: boolean; driverStops: boolean; idleStopOn: boolean }): 'run' | 'wake' | 'skip' {
  if (!s.exists) return 'skip';
  if (s.started) return 'run';
  return s.driverStops && s.idleStopOn ? 'wake' : 'skip';
}

// ── the sweep ───────────────────────────────────────────────────────────────

/** One project container the sweep may stop: the stored sandbox name of a project in the registry. */
export interface SweepCandidate {
  slug: string;
  name: string;
  kind: string; // the driver kind, for the stopper and the log line
  dind: boolean; // the stop asks the inner dockerd to shut its containers down first
}

/** A registry project as the candidate list reads it (projects.ts ProjectConfig). */
export interface IdleProject {
  slug: string;
  driver?: string;
  sandbox?: SandboxOptions;
}

export interface CandidateDeps {
  projects(): readonly IdleProject[]; // the registry as it is now (/aven reload changes it)
  defaultKind: string; // SANDBOX_DRIVER, for a project without its own `driver`
  driverStops(kind: string): boolean; // that kind's driver has stopSandbox (none if its provider stops idle ones)
  storedName(slug: string): string | undefined; // the project record's sandboxName; none → never had a turn
  namePrefix: string;
  warn(line: string): void;
}

/**
 * The sweep's candidates (design D10): every registry project on a driver the bot stops, that has a
 * project record — by the record's STORED sandbox name, the one its turns use (a prefix changed since
 * the record was made would otherwise point the stop at another container); one warning per project
 * per bot start when it differs from the prefix's. Never a listing: the stop proves the labels by name.
 */
export function candidateList(d: CandidateDeps): () => SweepCandidate[] {
  const warned = new Set<string>();
  return () => {
    const out: SweepCandidate[] = [];
    for (const p of d.projects()) {
      const kind = p.driver ?? d.defaultKind;
      if (!d.driverStops(kind)) continue;
      const name = d.storedName(p.slug);
      if (!name) continue;
      const computed = `${d.namePrefix}${p.slug}`;
      if (name !== computed && !warned.has(p.slug)) {
        warned.add(p.slug);
        d.warn(`idle stop: project '${p.slug}' runs in '${name}' (state.json) but SANDBOX_NAME_PREFIX gives '${computed}' — the idle stop follows the stored name`);
      }
      out.push({ slug: p.slug, name, kind, dind: dindOf(p.sandbox) });
    }
    return out;
  };
}

// The project's dind answer; a block that does not validate (loadProjects refuses it at boot, so only
// a hand-edited registry gets here) reads as docker-in-docker.
function dindOf(sandbox: SandboxOptions | undefined): boolean {
  try {
    return resolveSandboxOptions(sandbox).dind;
  } catch {
    return true; // stopping an inner dockerd that is not there costs nothing; leaving one running does
  }
}

/** What the sweep hands a driver's stopSandbox (driver.ts). */
export interface StopRequest {
  name: string;
  slug: string;
  dind: boolean;
  // Evaluated inside the container's lock, right before the stop: false → nothing is done.
  recheck: () => boolean;
  // Runs inside the lock once the container stopped, before the parked mark (design D7).
  onStopped: () => void;
}

export type StopOutcome =
  | { kind: 'skipped' } // the re-check found work: the host was not asked
  | { kind: 'stopped'; ms: number }
  | { kind: 'not-running' }
  | { kind: 'missing' }
  | { kind: 'foreign'; labels: string }; // our name, someone else's labels: left running

export type Stopper = (req: StopRequest) => Promise<StopOutcome>;

export interface SweepDeps {
  candidates(): SweepCandidate[];
  stopper(kind: string): Stopper | undefined; // undefined: that provider stops its sandboxes itself
  use(slug: string): SandboxUse;
  // The engine ends the project's sessions; `cut` (SandboxUse.cut as the re-check read it) hear why.
  stopped(slug: string, idleMinutes: number, cut: readonly string[]): void;
  activity: Pick<SandboxActivity, 'view'>;
  now(): number; // monotonic (monoNow), the activity record's clock
  autoStopMs: number;
  hardCapMs: number;
  log: { info(line: string): void; warn(line: string): void };
}

const FORCED: Record<LingerKind, string> = {
  background: 'background tasks were still listed',
  injected: 'an injected message was still unanswered',
  'self-turn': 'a turn the CLI started on its own was still running',
  'stale-hold': 'a turn held it past the hard cap',
  call: 'a sandbox call was still running',
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);

export function createIdleSweep(deps: SweepDeps): { tick(): Promise<void> } {
  let running = false;
  const foreignWarned = new Set<string>();
  const failures = new Map<string, { count: number; at: number; retryAt: number }>();
  // One read of the engine's view per decision: the rule's inputs and who a stop now would cut short.
  const read = (c: SweepCandidate): { decision: IdleDecision; cut: readonly string[] } => {
    const use = deps.use(c.slug);
    const decision = idleStopDue({ now: deps.now(), autoStopMs: deps.autoStopMs, hardCapMs: deps.hardCapMs, activity: deps.activity.view(c.name), use });
    return { decision, cut: use.cut ?? [] };
  };

  async function one(c: SweepCandidate): Promise<void> {
    let failed = failures.get(c.name);
    // Only a stop the host answered ends an outage. A container that had work while the host came
    // back was never asked, so its record outlives the outage: past twice the longest backoff it is
    // dropped, and the next failure is a new outage with its own warning.
    if (failed && deps.now() - failed.at > OUTAGE_OVER_MS) {
      failures.delete(c.name);
      failed = undefined;
    }
    if (failed && deps.now() < failed.retryAt) return;
    if (!read(c).decision.stop) return;
    const stop = deps.stopper(c.kind);
    if (!stop) return;
    let decision: IdleDecision | undefined;
    // Who hears about the stop is fixed by the re-check, under the container's lock, while the
    // processes still run. Not after: with --init the in-container log tails die with PID 1, so the
    // stopped container's streams usually end before `docker stop` returns, and an ended process
    // lists nothing any more (SandboxUse.cut, design D7).
    let cut: readonly string[] = [];
    const minutes = (): number => (decision?.stop ? Math.floor(decision.idleMs / 60_000) : 0);
    let out: StopOutcome;
    try {
      out = await stop({
        name: c.name,
        slug: c.slug,
        dind: c.dind,
        recheck: () => {
          ({ decision, cut } = read(c));
          return decision.stop;
        },
        onStopped: () => deps.stopped(c.slug, minutes(), cut),
      });
    } catch (e) {
      // A host-level failure: back off per container, one warning per outage (not one a minute).
      const count = (failed?.count ?? 0) + 1;
      const wait = BACKOFF_MINUTES[Math.min(count, BACKOFF_MINUTES.length) - 1]!;
      const at = deps.now();
      failures.set(c.name, { count, at, retryAt: at + wait * 60_000 });
      if (count === 1) deps.log.warn(`idle stop of '${c.name}' failed: ${errMsg(e)} — retrying in ${wait} min`);
      return;
    }
    // Work arrived under the lock: no host call was made, so it proves nothing about an outage.
    if (out.kind === 'skipped') return;
    if (failed) {
      failures.delete(c.name);
      deps.log.info(`idle stop of '${c.name}' works again`);
    }
    if (out.kind === 'stopped') {
      const line = `sandbox '${c.name}' stopped after ${minutes()} min idle (${c.kind}, ${(out.ms / 1000).toFixed(1)}s)`;
      const forced = decision?.stop ? decision.forced : undefined;
      if (forced) deps.log.warn(`${line} — ${FORCED[forced]}`);
      else deps.log.info(line);
    } else if (out.kind === 'foreign' && !foreignWarned.has(c.name)) {
      foreignWarned.add(c.name);
      deps.log.warn(`idle stop: '${c.name}' carries ${out.labels} — not this installation's container, left running`);
    }
  }

  return {
    // Never two at once: a stop can wait behind a warm-up of its container, and the next minute's
    // tick must not start a second stop of it meanwhile. Containers are stopped one at a time.
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        for (const c of deps.candidates()) await one(c);
      } finally {
        running = false;
      }
    },
  };
}
