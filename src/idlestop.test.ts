// The idle stop's pure parts (OpenSpec `sandbox-idle-stop`): the activity record and its lock, the
// rule, the floor, and the sweep over fake drivers and a fake engine view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SandboxActivity,
  candidateList,
  createIdleSweep,
  housekeepingSandboxStep,
  idleStopDue,
  idleStopMinutes,
  idleStopPlan,
  monoNow,
  stopCutWork,
  WAKEUP_GRACE_MS,
  type ActivityView,
  type IdleProject,
  type SandboxUse,
  type StopOutcome,
  type StopRequest,
  type SweepCandidate,
} from './idlestop.js';

const MIN = 60_000;
const tick = () => new Promise((r) => setImmediate(r));

// ── the record ─────────────────────────────────────────────────────────────

test('activity — the floor (the sweep start) bounds every idle clock, touches move it on', () => {
  let now = 1_000;
  const a = new SandboxActivity(() => now);
  assert.deepEqual(a.view('proj-caldora'), { lastActivity: 0, inFlight: 0, parked: false });
  now = 5_000;
  a.start();
  assert.equal(a.view('proj-caldora').lastActivity, 5_000, 'nothing before the start counts as idle');
  now = 9_000;
  a.touch('proj-caldora');
  assert.equal(a.view('proj-caldora').lastActivity, 9_000);
  assert.equal(a.view('proj-bluefin').lastActivity, 5_000, 'per container');
});

test('activity — a tracked call is in flight while it runs and touches at its start and its end, also when it rejects', async () => {
  let now = 100;
  const a = new SandboxActivity(() => now);
  let release!: () => void;
  const op = a.track('proj-x', () => new Promise<void>((r) => (release = r)));
  assert.equal(a.view('proj-x').inFlight, 1);
  assert.equal(a.view('proj-x').lastActivity, 100);
  now = 700;
  release();
  await op;
  assert.deepEqual(a.view('proj-x'), { lastActivity: 700, inFlight: 0, parked: false });
  now = 900;
  await assert.rejects(a.track('proj-x', async () => { throw new Error('exec refused'); }), /exec refused/);
  assert.deepEqual(a.view('proj-x'), { lastActivity: 900, inFlight: 0, parked: false });
});

test('activity — the default clock is monotonic: a wall-clock jump (a host suspend, an NTP step) is not idle time', (t) => {
  const a = new SandboxActivity();
  a.start();
  a.touch('proj-x');
  const last = a.view('proj-x').lastActivity;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * MIN }); // the wall clock jumps two hours
  assert.ok(monoNow() - last < MIN, 'the idle clock did not move with it');
});

test('activity — the parked mark survives touches and only unpark clears it', () => {
  const a = new SandboxActivity(() => 1);
  a.park('proj-x');
  a.touch('proj-x');
  assert.equal(a.view('proj-x').parked, true);
  a.unpark('proj-x');
  assert.equal(a.view('proj-x').parked, false);
  a.unpark('proj-never-seen'); // no record: nothing to clear, no throw
});

test('activity — exclusive: one container at a time, two containers in parallel, a rejection never breaks the chain', async () => {
  const a = new SandboxActivity();
  const log: string[] = [];
  let releaseStop!: () => void;
  const stop = a.exclusive('proj-x', async () => {
    log.push('stop:start');
    await new Promise<void>((r) => (releaseStop = r));
    log.push('stop:end');
  });
  const wake = a.exclusive('proj-x', async () => {
    log.push('wake');
    return 'started';
  });
  const other = a.exclusive('proj-y', async () => {
    log.push('other');
  });
  await other;
  await tick();
  assert.deepEqual(log, ['stop:start', 'other'], 'the wake waits; another container does not');
  releaseStop();
  await stop;
  assert.equal(await wake, 'started');
  assert.deepEqual(log, ['stop:start', 'other', 'stop:end', 'wake']);
  await assert.rejects(a.exclusive('proj-x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await a.exclusive('proj-x', async () => 'after'), 'after');
});

// ── the rule ───────────────────────────────────────────────────────────────

const NOW = 10_000 * MIN;
const idle = (minutes: number, over: Partial<ActivityView> = {}): ActivityView => ({ lastActivity: NOW - minutes * MIN, inFlight: 0, parked: false, ...over });
const due = (minutes: number, use: Partial<SandboxUse> = {}, over: Partial<ActivityView> = {}, autoStop = 30) =>
  idleStopDue({ now: NOW, autoStopMs: autoStop * MIN, hardCapMs: 60 * MIN, activity: idle(minutes, over), use: { held: false, ...use } });

test('rule — thirty quiet minutes stop; twenty-nine do not', () => {
  assert.deepEqual(due(30), { stop: true, idleMs: 30 * MIN });
  assert.deepEqual(due(29), { stop: false, reason: 'recent' });
});

test('rule — turned off, or parked: never', () => {
  assert.deepEqual(due(500, {}, {}, 0), { stop: false, reason: 'off' });
  assert.deepEqual(due(500, {}, {}, -5), { stop: false, reason: 'off' });
  assert.deepEqual(due(500, {}, { parked: true }), { stop: false, reason: 'parked' });
});

test('rule — a held container is never stopped, however long it has been silent', () => {
  assert.deepEqual(due(45, { held: true }), { stop: false, reason: 'held' });
  assert.deepEqual(due(600, { held: true }), { stop: false, reason: 'held' });
});

test('rule — a pending wakeup is waited for until two minutes after it is due', () => {
  assert.deepEqual(due(40, { wakeupInMs: 20 * MIN }), { stop: false, reason: 'wakeup' });
  assert.deepEqual(due(40, { wakeupInMs: -WAKEUP_GRACE_MS + 1 }), { stop: false, reason: 'wakeup' });
  assert.deepEqual(due(40, { wakeupInMs: -3 * MIN }), { stop: true, idleMs: 40 * MIN });
  // A wakeup does not make a recently active container due.
  assert.deepEqual(due(10, { wakeupInMs: -30 * MIN }), { stop: false, reason: 'recent' });
});

test('rule — lingering work postpones the stop up to the turn hard cap, then the stop names it', () => {
  for (const kind of ['background', 'injected', 'self-turn', 'stale-hold'] as const) {
    assert.deepEqual(due(40, { lingering: kind }), { stop: false, reason: 'lingering' });
    assert.deepEqual(due(61, { lingering: kind }), { stop: true, idleMs: 61 * MIN, forced: kind });
  }
  assert.deepEqual(due(40, {}, { inFlight: 1 }), { stop: false, reason: 'lingering' });
  assert.deepEqual(due(61, {}, { inFlight: 1 }), { stop: true, idleMs: 61 * MIN, forced: 'call' });
  // A window longer than the hard cap is the bound itself.
  assert.deepEqual(due(80, { lingering: 'background' }, {}, 90), { stop: false, reason: 'recent' });
  assert.deepEqual(due(90, { lingering: 'background' }, {}, 90), { stop: true, idleMs: 90 * MIN, forced: 'background' });
});

test('idleStopMinutes — off at zero or below, the floor below ten, the value otherwise', () => {
  assert.deepEqual(idleStopMinutes(0), { minutes: 0, raised: false });
  assert.deepEqual(idleStopMinutes(-5), { minutes: 0, raised: false });
  assert.deepEqual(idleStopMinutes(Number.NaN), { minutes: 0, raised: false });
  assert.deepEqual(idleStopMinutes(5), { minutes: 10, raised: true });
  assert.deepEqual(idleStopMinutes(0.5), { minutes: 10, raised: true });
  assert.deepEqual(idleStopMinutes(10), { minutes: 10, raised: false });
  assert.deepEqual(idleStopMinutes(45), { minutes: 45, raised: false });
});

test('idleStopPlan — the minutes and the lines the bot logs when the sweep starts (off, raised to the floor, as set)', () => {
  assert.deepEqual(idleStopPlan(0), { minutes: 0, info: 'idle stop: off (SANDBOX_AUTOSTOP_MINUTES ≤ 0)' });
  assert.deepEqual(idleStopPlan(-5), { minutes: 0, info: 'idle stop: off (SANDBOX_AUTOSTOP_MINUTES ≤ 0)' });
  assert.deepEqual(idleStopPlan(5), {
    minutes: 10,
    info: 'idle stop: sandboxes without an idle stop of their own (ssh-docker) stop after 10 min without activity',
    warn: "SANDBOX_AUTOSTOP_MINUTES=5 is below the idle stop's floor — ssh-docker sandboxes stop after 10 min",
  });
  assert.deepEqual(idleStopPlan(30), { minutes: 30, info: 'idle stop: sandboxes without an idle stop of their own (ssh-docker) stop after 30 min without activity' });
});

test('stopCutWork — a stop is told only where it cut background work or a turn of the CLI\'s own', () => {
  assert.equal(stopCutWork({ background: 0, selfTurn: false }), false, 'an idle conversation: nothing posted');
  assert.equal(stopCutWork({ background: 2, selfTurn: false }), true, 'background tasks still listed');
  assert.equal(stopCutWork({ background: 0, selfTurn: true }), true, 'a turn the CLI started on its own');
  // Only an unanswered injected message: the deliverer sends it again as a turn — no notice. (A
  // process that had already ended reports all zeros: claudeSession.test.ts, idle state.)
  const onlyInjected = { background: 0, injected: 1, selfTurn: false };
  assert.equal(stopCutWork(onlyInjected), false);
});

test('housekeepingSandboxStep — wake an asleep sandbox only where the bot stops it again; never create one', () => {
  const step = (exists: boolean, started: boolean, driverStops: boolean, idleStopOn: boolean) => housekeepingSandboxStep({ exists, started, driverStops, idleStopOn });
  assert.equal(step(true, true, true, true), 'run');
  assert.equal(step(true, true, false, false), 'run', 'an awake sandbox runs on every driver, with the stop on or off');
  assert.equal(step(true, false, true, true), 'wake', 'ssh-docker with the idle stop on: woken, stopped again after the window');
  assert.equal(step(true, false, true, false), 'skip', 'SANDBOX_AUTOSTOP_MINUTES=0: nothing would stop it again');
  assert.equal(step(true, false, false, true), 'skip', 'a provider that stops its own sandboxes: waking the fleet nightly would defeat it');
  assert.equal(step(false, false, true, true), 'skip', 'a missing sandbox is never created');
});

test('candidateList — registry projects the bot stops, with a project record, by the stored name; one warning per project for a prefix mismatch', () => {
  const projects: IdleProject[] = [
    { slug: 'caldora' }, // default driver, default sandbox shape
    { slug: 'bluefin', sandbox: { privileged: false, dind: false } },
    { slug: 'harbor', driver: 'self-stopping' }, // a driver whose provider stops its sandboxes itself
    { slug: 'newbie' }, // never had a turn
    { slug: 'renamed' },
    { slug: 'broken', sandbox: { privileged: false, dind: true } }, // refused at boot; read as the default
  ];
  const stored: Record<string, string> = { caldora: 'proj-caldora', bluefin: 'proj-bluefin', harbor: 'proj-harbor', renamed: 'old-renamed', broken: 'proj-broken' };
  const warns: string[] = [];
  const list = candidateList({
    projects: () => projects,
    defaultKind: 'ssh-docker',
    driverStops: (kind) => kind === 'ssh-docker',
    storedName: (slug) => stored[slug],
    namePrefix: 'proj-',
    warn: (l) => warns.push(l),
  });
  const expected: SweepCandidate[] = [
    { slug: 'caldora', name: 'proj-caldora', kind: 'ssh-docker', dind: true },
    { slug: 'bluefin', name: 'proj-bluefin', kind: 'ssh-docker', dind: false },
    { slug: 'renamed', name: 'old-renamed', kind: 'ssh-docker', dind: true },
    { slug: 'broken', name: 'proj-broken', kind: 'ssh-docker', dind: true },
  ];
  assert.deepEqual(list(), expected);
  assert.deepEqual(list(), expected, 'every tick reads the registry again');
  assert.deepEqual(warns, ["idle stop: project 'renamed' runs in 'old-renamed' (state.json) but SANDBOX_NAME_PREFIX gives 'proj-renamed' — the idle stop follows the stored name"], 'once per bot start');
  projects.push({ slug: 'added' }); // /aven reload
  stored.added = 'proj-added';
  assert.deepEqual(list().at(-1), { slug: 'added', name: 'proj-added', kind: 'ssh-docker', dind: true });
});

// ── the sweep ──────────────────────────────────────────────────────────────

interface Harness {
  now: number;
  activity: SandboxActivity;
  uses: Map<string, SandboxUse>;
  stopped: { slug: string; minutes: number; cut: string[]; parkedAtCall: boolean }[];
  infos: string[];
  warns: string[];
  calls: string[];
  outcomes: Map<string, StopOutcome | Error | ((req: StopRequest) => Promise<StopOutcome>)>;
}

function sweep(cands: SweepCandidate[], o: { kinds?: Record<string, boolean> } = {}) {
  const h: Harness = { now: 0, activity: undefined as never, uses: new Map(), stopped: [], infos: [], warns: [], calls: [], outcomes: new Map() };
  h.activity = new SandboxActivity(() => h.now);
  h.activity.start();
  const s = createIdleSweep({
    candidates: () => cands,
    stopper: (kind) =>
      o.kinds?.[kind] === false
        ? undefined
        : async (req) => {
            h.calls.push(req.name);
            const scripted = h.outcomes.get(req.name);
            if (typeof scripted === 'function') return scripted(req);
            if (scripted instanceof Error) throw scripted;
            // The driver's contract: re-check under the lock; on a stop, the sessions first, then the mark.
            if (!req.recheck()) return { kind: 'skipped' };
            const out = scripted ?? { kind: 'stopped', ms: 420 };
            if (out.kind === 'stopped') req.onStopped();
            if (out.kind !== 'skipped') h.activity.park(req.name);
            return out;
          },
    use: (slug) => h.uses.get(slug) ?? { held: false },
    stopped: (slug, minutes, cut) => h.stopped.push({ slug, minutes, cut: [...cut], parkedAtCall: h.activity.view(`proj-${slug}`).parked }),
    activity: h.activity,
    now: () => h.now,
    autoStopMs: 30 * MIN,
    hardCapMs: 60 * MIN,
    log: { info: (l) => h.infos.push(l), warn: (l) => h.warns.push(l) },
  });
  return { h, s };
}
const cand = (slug: string, over: Partial<SweepCandidate> = {}): SweepCandidate => ({ slug, name: `proj-${slug}`, kind: 'ssh-docker', dind: true, ...over });

test('sweep — nothing due, no stop call; due → stopped, sessions ended before the mark, one info line', async () => {
  const { h, s } = sweep([cand('caldora'), cand('bluefin')]);
  h.now = 29 * MIN;
  await s.tick();
  assert.deepEqual(h.calls, [], 'the steady state makes no host call');
  h.activity.touch('proj-bluefin');
  h.now = 31 * MIN;
  await s.tick();
  assert.deepEqual(h.calls, ['proj-caldora']);
  assert.deepEqual(h.stopped, [{ slug: 'caldora', minutes: 31, cut: [], parkedAtCall: false }], 'onStopped runs before the parked mark');
  assert.deepEqual(h.infos, ["sandbox 'proj-caldora' stopped after 31 min idle (ssh-docker, 0.4s)"]);
  assert.deepEqual(h.warns, []);
  h.now = 90 * MIN;
  await s.tick();
  assert.deepEqual(h.calls, ['proj-caldora', 'proj-bluefin'], 'a parked container is not asked again');
});

test('sweep — work that arrives between the first check and the stop: the re-check under the lock skips it', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.now = 40 * MIN;
  h.outcomes.set('proj-caldora', async (req) => {
    h.uses.set('caldora', { held: true }); // a turn was queued while the stop waited for the lock
    return req.recheck() ? { kind: 'stopped', ms: 1 } : { kind: 'skipped' };
  });
  await s.tick();
  assert.deepEqual(h.stopped, []);
  assert.deepEqual([...h.infos, ...h.warns], []);
});

test('sweep — who hears about a stop is what the re-check read under the lock, not the first look and not the view once the container died', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.uses.set('caldora', { held: false, lingering: 'background', cut: ['thread:1700000000.000009'] }); // the first look
  h.outcomes.set('proj-caldora', async (req) => {
    h.uses.set('caldora', { held: false, lingering: 'background', cut: ['thread:1700000000.000001'] }); // while it waited for the lock
    if (!req.recheck()) return { kind: 'skipped' };
    // docker stop: the in-container log tails die with PID 1 and their end reaches the bot before the
    // stop returns — the processes are ended, and list nothing any more, when its handler runs.
    h.uses.set('caldora', { held: false });
    req.onStopped();
    h.activity.park(req.name);
    return { kind: 'stopped', ms: 300 };
  });
  h.now = 61 * MIN;
  await s.tick();
  assert.deepEqual(h.stopped.map((x) => x.cut), [['thread:1700000000.000001']]);
  assert.deepEqual(h.warns, ["sandbox 'proj-caldora' stopped after 61 min idle (ssh-docker, 0.3s) — background tasks were still listed"]);
});

test('sweep — a stop forced past lingering work warns with its cause', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.uses.set('caldora', { held: false, lingering: 'background' });
  h.now = 45 * MIN;
  await s.tick();
  assert.deepEqual(h.calls, [], 'postponed while under the hard cap');
  h.now = 61 * MIN;
  await s.tick();
  assert.deepEqual(h.warns, ["sandbox 'proj-caldora' stopped after 61 min idle (ssh-docker, 0.4s) — background tasks were still listed"]);
});

test('sweep — a container with another label: left running, one warning per boot, then parked', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.outcomes.set('proj-caldora', { kind: 'foreign', labels: 'managedBy=someone-else, project=caldora' });
  h.now = 31 * MIN;
  await s.tick();
  await s.tick();
  assert.deepEqual(h.warns, ["idle stop: 'proj-caldora' carries managedBy=someone-else, project=caldora — not this installation's container, left running"]);
  assert.deepEqual(h.stopped, [], 'no session of the project is touched');
  assert.equal(h.activity.view('proj-caldora').parked, true);
  h.activity.unpark('proj-caldora'); // a warm-up of it
  h.now = 70 * MIN;
  await s.tick();
  assert.equal(h.warns.length, 1, 'still one warning');
});

test('sweep — not running or missing: parked quietly', async () => {
  const { h, s } = sweep([cand('caldora'), cand('bluefin')]);
  h.outcomes.set('proj-caldora', { kind: 'not-running' });
  h.outcomes.set('proj-bluefin', { kind: 'missing' });
  h.now = 31 * MIN;
  await s.tick();
  assert.deepEqual([...h.infos, ...h.warns, ...h.stopped.map((x) => x.slug)], []);
  assert.equal(h.activity.view('proj-caldora').parked && h.activity.view('proj-bluefin').parked, true);
});

test('sweep — the host does not answer: one warning, backoff 1, 2, 4 … 15 min, sessions untouched, info when it works again', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.outcomes.set('proj-caldora', new Error('ssh: connect to host sandboxes.example port 22: Connection refused\nmore'));
  h.now = 31 * MIN;
  await s.tick();
  assert.deepEqual(h.warns, ["idle stop of 'proj-caldora' failed: ssh: connect to host sandboxes.example port 22: Connection refused — retrying in 1 min"]);
  const at: number[] = [];
  for (let m = 32; m <= 80; m++) {
    h.now = m * MIN;
    const before = h.calls.length;
    await s.tick();
    if (h.calls.length > before) at.push(m);
  }
  assert.deepEqual(at, [32, 34, 38, 46, 61, 76], 'retries after 1, 2, 4, 8, 15, 15 minutes');
  assert.equal(h.warns.length, 1, 'one warning per outage');
  assert.deepEqual(h.stopped, []);
  h.outcomes.delete('proj-caldora');
  h.now = 91 * MIN;
  await s.tick();
  assert.deepEqual(h.infos, ["idle stop of 'proj-caldora' works again", "sandbox 'proj-caldora' stopped after 91 min idle (ssh-docker, 0.4s)"]);
});

test('sweep — a re-check that finds work after a failure is no proof the host is back: no "works again", the outage goes on without a new warning', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.outcomes.set('proj-caldora', new Error('ssh: connect to host sandboxes.example port 22: Connection refused'));
  h.now = 31 * MIN;
  await s.tick();
  assert.equal(h.warns.length, 1);
  h.outcomes.set('proj-caldora', async () => ({ kind: 'skipped' })); // a turn arrived while the stop waited for the lock
  h.now = 32 * MIN;
  await s.tick();
  assert.deepEqual(h.infos, [], 'the host was not asked');
  h.outcomes.set('proj-caldora', new Error('ssh: connect to host sandboxes.example port 22: Connection refused'));
  h.now = 33 * MIN;
  await s.tick();
  assert.equal(h.warns.length, 1, 'the same outage: no second warning');
  assert.equal(h.calls.length, 3);
  h.now = 34 * MIN;
  await s.tick();
  assert.equal(h.calls.length, 3, 'and its backoff kept growing (2 min after the second failure)');
});

test('sweep — an outage that ended while the container had work: the next failure, much later, warns again', async () => {
  const { h, s } = sweep([cand('caldora')]);
  h.outcomes.set('proj-caldora', new Error('ssh: connect to host sandboxes.example port 22: Connection refused'));
  h.now = 31 * MIN;
  await s.tick();
  assert.equal(h.warns.length, 1);
  h.uses.set('caldora', { held: true }); // busy for hours: no stop is tried, so nothing clears the record
  for (let m = 32; m <= 300; m += 10) {
    h.now = m * MIN;
    await s.tick();
  }
  assert.equal(h.calls.length, 1);
  h.uses.delete('caldora');
  h.now = 400 * MIN; // idle again; the host is down again, a new outage
  await s.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.warns.length, 2, 'a new outage gets its own warning');
  assert.match(h.warns[1]!, /retrying in 1 min$/, 'and starts the backoff over');
});

test('sweep — a driver kind without a stopper (its provider stops sandboxes itself) is never asked', async () => {
  const { h, s } = sweep([cand('caldora', { kind: 'self-stopping' })], { kinds: { 'self-stopping': false } });
  h.now = 600 * MIN;
  await s.tick();
  assert.deepEqual(h.calls, []);
});

test('sweep — a tick never overlaps the previous one', async () => {
  const { h, s } = sweep([cand('caldora')]);
  let release!: () => void;
  h.outcomes.set('proj-caldora', (req) => new Promise((r) => (release = () => r(req.recheck() ? { kind: 'stopped', ms: 1 } : { kind: 'skipped' }))));
  h.now = 31 * MIN;
  const first = s.tick();
  await tick();
  await s.tick(); // the next minute, while the stop still runs
  assert.deepEqual(h.calls, ['proj-caldora'], 'no second stop of the same container');
  release();
  await first;
});
