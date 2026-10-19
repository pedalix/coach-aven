// The idle stop (OpenSpec `sandbox-idle-stop`): a project sandbox nobody uses is stopped, as
// Daytona's provider stopped its sandboxes after SANDBOX_AUTOSTOP_MINUTES. The session code was
// written for that lifecycle — the live-session LRU and the chat prune leave a conversation's
// `claude` process to "the sandbox's own idle lifecycle" — and ssh-docker had none, so every
// conversation touched since a container started kept its process (and the agent's Sail stack
// kept running) until the container restarted.
//
// Three parts, all pure or injected so they are tested without Docker:
//   • SandboxActivity — what the bot did in each container and when (every handle call, every
//     chunk of session output; recorded by the ssh-docker driver, the one choke point every
//     caller goes through), the per-container lock that serializes warm-up, peek and stop, and
//     the parked mark;
//   • idleStopDue — the rule (design D2): holds never stop, a pending wakeup is waited for,
//     lingering work postpones up to the turn hard cap, quiet time against the window;
//   • createIdleSweep — the once-a-minute check that asks the driver to stop a due container,
//     re-deciding under that container's lock (design D5/D6).
// The engine's view (holds, sessions) comes from turn.ts; the stop itself from the driver.

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

// ── the activity record ─────────────────────────────────────────────────────

export interface ActivityView {
  lastActivity: number; // epoch ms, never before the sweep started
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

  constructor(private readonly now: () => number = Date.now) {}

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
  wakeupDueAt?: number; // the latest pending ScheduleWakeup of the project's live sessions, epoch ms
}

export interface IdleInputs {
  now: number;
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
  if (i.use.wakeupDueAt !== undefined && i.now < i.use.wakeupDueAt + WAKEUP_GRACE_MS) return { stop: false, reason: 'wakeup' };
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

// ── the sweep ───────────────────────────────────────────────────────────────

/** One project container the sweep may stop: the stored sandbox name of a project in the registry. */
export interface SweepCandidate {
  slug: string;
  name: string;
  kind: string; // the driver kind, for the stopper and the log line
  dind: boolean; // the stop asks the inner dockerd to shut its containers down first
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
  | { kind: 'skipped' } // the re-check found work
  | { kind: 'stopped'; ms: number }
  | { kind: 'not-running' }
  | { kind: 'missing' }
  | { kind: 'foreign'; labels: string }; // our name, someone else's labels: left running

export type Stopper = (req: StopRequest) => Promise<StopOutcome>;

export interface SweepDeps {
  candidates(): SweepCandidate[];
  stopper(kind: string): Stopper | undefined; // undefined: that provider stops its sandboxes itself
  use(slug: string): SandboxUse;
  stopped(slug: string, idleMinutes: number): void; // the engine ends the project's sessions
  activity: Pick<SandboxActivity, 'view'>;
  now(): number;
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
  const failures = new Map<string, { count: number; retryAt: number }>();
  const decide = (c: SweepCandidate): IdleDecision =>
    idleStopDue({ now: deps.now(), autoStopMs: deps.autoStopMs, hardCapMs: deps.hardCapMs, activity: deps.activity.view(c.name), use: deps.use(c.slug) });

  async function one(c: SweepCandidate): Promise<void> {
    const failed = failures.get(c.name);
    if (failed && deps.now() < failed.retryAt) return;
    if (!decide(c).stop) return;
    const stop = deps.stopper(c.kind);
    if (!stop) return;
    let decision: IdleDecision | undefined;
    const minutes = (): number => (decision?.stop ? Math.floor(decision.idleMs / 60_000) : 0);
    let out: StopOutcome;
    try {
      out = await stop({
        name: c.name,
        slug: c.slug,
        dind: c.dind,
        recheck: () => {
          decision = decide(c);
          return decision.stop;
        },
        onStopped: () => deps.stopped(c.slug, minutes()),
      });
    } catch (e) {
      // A host-level failure: back off per container, one warning per outage (not one a minute).
      const count = (failed?.count ?? 0) + 1;
      const wait = BACKOFF_MINUTES[Math.min(count, BACKOFF_MINUTES.length) - 1]!;
      failures.set(c.name, { count, retryAt: deps.now() + wait * 60_000 });
      if (count === 1) deps.log.warn(`idle stop of '${c.name}' failed: ${errMsg(e)} — retrying in ${wait} min`);
      return;
    }
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
