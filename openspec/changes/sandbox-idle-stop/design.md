## Context

See proposal.md for the motivation. Today's code, as far as this change touches it:

- **Containers.** A project's sandbox is `${SANDBOX_NAME_PREFIX}${slug}` (`proj-` by default). `createDriver(cfg, kind)` builds a new driver object on every call (`src/driver.ts`), so anything that must outlive one call lives at module level. ssh-docker's `ensureSandbox` runs one host script (`ensureSandboxScript`) that answers `ready`, `started` (a `docker start`), `created` (`docker run --init … --label managedBy=… --label project=<slug> --entrypoint sh <image> -c 'sleep …'`) or `revived` (stop + start after a failed exec or mount probe). `getSandbox` is a `docker inspect` that never starts anything; `listStates` is one `docker ps -a --filter label=managedBy=<SANDBOX_MANAGED_BY>`. Measured with the driver's own image and entrypoint: `docker stop -t 10` takes 0.4 s (tini forwards SIGTERM, nothing waits for the grace period), `docker start` 0.4 s.
- **Sessions.** A conversation's `claude` runs in a FIFO session under `/tmp/aven-sess/<key>/` (pid, holder, `in`, `out.log`). `/tmp` is part of the container's writable layer: the files survive a stop, the processes do not. When the container stops, the session's log stream (`docker exec … tail -f`) ends, and `ClaudeSession.onExit` marks the session dead; with no turn pending this posts nothing. The next `ensureSession` wakes the container, re-seeds tokens and MCP config, and spawns a new `claude --resume <sessionId>` after checking that the transcript is on disk. A reattach record (`sessionKey`, `cmdId` in `state.json`) is tried once per `ChatSession`, and ssh-docker's liveness probe is `kill -0 <pid>` plus a zombie check, which a recycled pid after a restart passes.
- **What Daytona did that ssh-docker does not.** A Daytona start re-ran the image's docker-in-docker entrypoint, so dockerd came back with every wake (`snapshot/Dockerfile`); its toolbox sessions did not survive a stop, so a reattach after a stop failed cleanly. ssh-docker starts dockerd only through the guard in chat prep (`prepareChat`, a new `ChatSession`) and in housekeeping. `ensureSession`'s reopen path, which a continuing conversation takes after a wake, does not run it.
- **Activity sources**: turns through `engine.liveTurn` (its `queues` cover queued and running turns, a turn waiting for a slot or for a click on an agent question included), one-off asks and dreams (`asking`), restart recovery (`resumeInflightTurns`, `recoverShadow`: today in neither set), messages injected into a running turn or recovered after a restart, CLI background tasks (`system/background_tasks_changed`), housekeeping, the dream's memory journal, `/aven memory [live]`, 🔄 Restart session. `/aven status`, PR/CI reads, the pollers' API calls, the sources poller and daemon never reach a container. `ClaudeSession`'s `running` flag is reset only on the message-ledger path, so it cannot serve as an idle signal. A new thread has no chat record until its first turn leaves the queue, so `slugForKey` cannot place a turn that still waits for a slot (`projectBusy` misses it the same way).
- **Config and wiring.** `SANDBOX_AUTOSTOP_MINUTES` is parsed by `num()` (unset or empty → 30, not a number → the boot fails) and read only by Daytona today. The pollers start in both composition roots (`pollers.startAll()`), after restart recovery and the queue replay were started; tests build pollers but never start them. `store.patchChat` stamps `updatedAt` and rewrites `state.json`; retention drops chats by `updatedAt`.

Constraints: rollout bucket 1, so a stop must never cost a running turn or post anything; code never deletes a project's container; installations may share a Docker host; the host runs deterministic code only; pure logic goes in its own module with tests.

## Goals / Non-Goals

**Goals:**

- One idle rule per project container, decided from one activity record that every call into a container updates by construction, plus the turn engine's own state.
- Stops that cannot race a wake, a turn or another installation.
- A wake on ssh-docker that leaves the container as a Daytona start did: no stale sessions, dockerd running.

**Non-Goals:**

- Precise stop times: the check runs once a minute.
- Seeing activity the bot does not cause (an operator's shell in the container, a container started by hand).
- Stopping sandboxes on Daytona, or changing anything for Daytona projects.

## Decisions

### D1. Stop the whole container, as Daytona did

The maintainer's call, and what the session code was written for: one stop ends every idle `claude`, the inner dockerd and any Sail stack, and the next turn resumes. `docker stop` keeps the container, its disk and its labels; the bot still never removes a project's container.

Alternatives considered:

- *Per-conversation reaping* (the `reap-idle-sessions` idea in `retire-daytona-driver` D9): kill one conversation's process after N idle hours. Frees `claude` memory only, leaves Sail stacks and dockerd running, and needs a clock per conversation. Rejected for this fix; it stays possible later for containers that never go idle.
- *Memory limits only*: turns slow growth into OOM kills inside a project. Rejected.
- *A cron `docker stop` on the sandbox host*: cannot see turns, so it would kill silent ones. Rejected.

### D2. The idle rule: holds, lingering work, quiet time

Evaluated per container by one pure function (`idleStopDue` in `src/idlestop.ts`):

1. `SANDBOX_AUTOSTOP_MINUTES ≤ 0`, or the container is already marked stopped → no.
2. **Held** → no. Held = a turn of the project is queued, running (also while it waits for a click) or being recovered, or a one-off ask or dream runs on it (D4).
3. Quiet time `q` = now − last activity (D3). `q < autostop` → no.
4. **Lingering** work — background tasks a live session lists, injected messages it has not answered, calls into the container still in flight — → no while `q < max(autostop, STREAM_HARD_MAX_MINUTES)`; past that, stop and say which one was still there.
5. Otherwise stop.

Why two classes. Every hold ends on its own: a running turn at its watchdog (soft 15 / hard 60 minutes), a one-off ask at 15, a recovery at the same deadlines, a queued turn when the turns ahead of it end. So holding unconditionally is safe, and it is the only way a 45-minute command that prints nothing survives. Lingering work has none: a dev server started with `run_in_background` never ends, and a `cat > in` into a FIFO whose reader is gone blocks forever. The turn hard cap bounds it because it is already the longest the bot lets a turn's work run, and the base prompt asks the agent to background only commands of "tens of minutes".

Alternatives considered:

- *Driver activity only* (Daytona counted API calls): stops a container under a long silent tool call. Rejected.
- *Engine state only*: misses background agents, housekeeping, `/aven memory live` and the dream's journal. Rejected.
- *`ClaudeSession.running`*: never resets on sessions without the message ledger. Rejected.
- *Probing processes in the container* (`ps`, CPU): an exec per container per minute, which is itself activity, and it cannot tell an idle `claude` from one waiting on the network. Rejected.
- *Background tasks as holds*: a forgotten background server pins the container forever and the leak returns. *Background tasks ignored*: a 35-minute background test run is killed and its promised background update never comes. Both rejected.

### D3. Activity is recorded in the ssh-docker driver

`src/idlestop.ts` keeps a module-level record per container name: last activity, calls in flight, a `stopped` mark, and the per-container lock of D6. The floor of every last-activity value is the moment the sweep starts.

- Every `SshDockerHandle` call (`exec`, `uploadFile`, `createSession`, `startSessionCommand`, `sessionCommandRunning`, `sessionCommandLogs`, `sendSessionInput`, `deleteSession`) runs through one wrapper: in flight +1 and a touch at the start, a touch and −1 in `finally`.
- `streamSessionCommandLogs` is the exception: it lasts as long as the process, so it is never "in flight"; every chunk it delivers is a touch.
- `ensureSandbox` runs through the wrapper as well, and a successful warm-up clears the `stopped` mark: nothing else the bot does can start a stopped container. `getSandbox`, `listStates` and `deleteSandbox` are host-level and record nothing.

Why the driver: every caller reaches a container only through a handle, so turns, housekeeping, the dream journal, `/aven memory`, Restart session and any future caller are recorded without knowing about it. Why only ssh-docker: Daytona's provider measures its own activity. The record is driver-agnostic, so another driver without an idle lifecycle can reuse it.

Alternatives considered: wrapping every driver in `createDriver` (an extra layer for Daytona, which needs none and is about to be retired); recording at call sites (the next caller forgets it); recording in `runSsh` (a host-level script does not say which container it is about).

### D4. The engine's view of a project

`src/turn.ts` gains:

- a `recovering` set: keys whose in-flight turn (`resumeInflightTurns`) or shadow turn (`recoverShadow`) is being recovered, added before `sessionFor`, removed in `finally`;
- the project of every key it holds a turn for, recorded when the turn is accepted (`liveTurn`, `runAsk` and recovery all know it) and dropped when the key's last turn settles, so a new thread's first turn counts while it still waits for a slot;
- `sandboxUse(slug)` → `{ held, lingering }`: `held` when any key of the slug is in `queues`, `asking` or `recovering`; `lingering` names the first of "background tasks" or "an unanswered message" found on a live session of the slug (`ChatSession` exposes the CLI's background tasks already and gains the count of injected messages still waiting);
- `sandboxStopped(slug)` (D7).

The sweep pulls this view when it decides, instead of the engine pushing leases into the record: a release that never happens cannot pin a container, and the engine stays the only owner of turn state. `projectBusy` keeps its meaning (dreams, housekeeping and the CLI upgrade gate are unchanged).

### D5. The sweep

`src/idlestop.ts` exports the tick with its dependencies injected (projects, engine view, drivers, clock, log), so it is tested with fakes; `src/pollers.ts` starts it from `startAll()` every 60 s, and not at all when `SANDBOX_AUTOSTOP_MINUTES ≤ 0`. So it runs exactly where the routine scheduler runs: in the Slack and Teams composition roots, never in tests, the CLI probe or the sources daemon, which never start pollers.

One tick:

1. For each project of `reg.current` whose driver has `stopSandbox` (drivers cached per kind; one that cannot be built is skipped with one warning), evaluate D2.
2. Nothing due → done, no host call. That is the steady state once idle containers are stopped and marked.
3. One `listStates()` per driver kind that has candidates. A candidate that is not `started` gets the `stopped` mark and is not asked about again until a warm-up clears it (only a warm-up can start it; one started by hand is out of scope).
4. For each running candidate, `driver.stopSandbox(name, slug, recheck)`: inside the per-container lock, evaluate D2 again synchronously and run the stop only if still due; then, still inside the lock, `engine.sandboxStopped(slug)` and the `stopped` mark.

The stop is one host script (60 s timeout): read the `managedBy` and `project` labels and `.State.Running`, answer `missing`, `not-running`, `foreign <labels>`, or run `docker stop -t 10` and answer `stopped`. Ten seconds is the grace the recycle path already uses; with `--init` the stop takes well under a second.

Log lines:

- info: `sandbox '<name>' stopped after <m> min idle (ssh-docker)`;
- warning: the same line followed by ` — background tasks were still listed`, ` — an injected message was still unanswered` or ` — a sandbox call was still running`;
- warning: `idle stop of '<name>' failed: <reason>` — nothing is marked, sessions are untouched, the next tick tries again;
- warning, once per name per boot: `idle stop: '<name>' carries managedBy=<x>, project=<y> — not this installation's container, left running`.

Alternatives considered: a timer per container reset on every touch (still has to poll the engine, which has no "turn ended" event); a `docker inspect` per project per tick (nine ssh calls a minute on a nine-project host to learn nothing); running the sweep in the sources daemon or on the host (neither sees turns).

### D6. Stop, wake and peek are serialized per container

The ssh-docker driver runs `ensureSandbox`, `getSandbox` and `stopSandbox` for one container under the record's per-container lock (a promise chain per name).

- A turn or `/aven memory live` that needs the container during a stop waits at most the stop's timeout, then starts it.
- A peek (housekeeping, `/aven memory`, Restart session) during a stop reports the container stopped: housekeeping records `sandbox asleep — skipped`.
- Two warm-ups of one container run one after the other. That matters for D8's cleanup: a turn (under `tasks.ts`'s per-project lock) and `/aven memory live` (the only waker outside it) can no longer both start the container, and one cannot remove a session the other has just created.
- The re-check under the lock closes "found idle, then work started": anything queued, started or read before it is seen, and anything later waits for the stop to finish.

Handle calls are not under the lock: that would serialize a project's whole traffic. They are tracked (D3), so a call in flight at the re-check postpones the stop. A call made on a handle fetched before the stop fails like any call into a stopped container, and its caller reports it as it reports any sandbox error.

Boot: the sweep starts after restart recovery and the queue replay were started, both of them holds, and its start is the floor of every idle clock. So nothing is stopped under a recovered turn, and a container that sat idle for hours before a restart still gets the full `SANDBOX_AUTOSTOP_MINUTES`.

Alternatives considered: the sweep takes `tasks.ts`'s per-project prep lock (covers turns only, not `/aven memory live`, housekeeping or Restart session, and ties the sweep to the chat layer); the engine re-check alone without a lock (a wake from `/aven memory live` could interleave the stop).

### D7. Sessions on stop: ended in memory, coordinates forgotten, `sessionId` kept

Inside the per-container lock, after `docker stop` succeeded, `engine.sandboxStopped(slug)`:

- Every live `ChatSession` of the project ends its `claude` the way a closed log stream does, without any call into the sandbox: dead, injected messages `lost`, background list cleared, a pending turn settled as an error (D2 guarantees there is none). The `ChatSession` stays in the live map, so the next turn only re-seeds and reopens with `--resume`, the path every Daytona wake took, instead of a full chat prep.
- The store clears `sessionKey` and `cmdId` on every chat of the slug that has them and no `inflight` marker, in one write. `sessionId`, `ledger` and `updatedAt` stay as they are.

Why end the sessions explicitly when the stream's exit would mark them dead anyway: between `docker stop` returning and that exit being observed, a turn waiting on the lock could be handed a session that is not dead yet and write into a FIFO without a reader, which blocks with no timeout. Why forget the coordinates: a bot restart after a stop would otherwise try to reattach by pid. Why not `patchChat` per chat: it stamps `updatedAt`, so every stop would restart the 45-day retention, and it rewrites `state.json` once per chat.

Alternatives considered: `ChatSession.close()` (one failing exec per session into a stopped container); removing the keys from the live map (a turn already holding the object still gets the stale session); `retireSession` per key (an exec and a save each).

### D8. A wake on ssh-docker is what a Daytona start was

`ensureSandboxScript`, only for the outcomes `started` and `revived`, after the probes:

1. `rm -rf /tmp/aven-sess` inside the container, best effort. Every session directory there belongs to a process that ended with the container.
2. On a docker-in-docker project, the dockerd guard (`dockerdGuardCmd`, the one chat prep and housekeeping run), best effort, with its marker on stderr and in the wake log line. It never fails the warm-up: a project whose dockerd will not start can still run turns that do not need Sail, and chat prep's guard reports it to Sentry when a chat opens.

`ready` and `created` are unchanged.

`runningProbeScript(key, pid)`: a session is up only if `/tmp/aven-sess/<key>/pid` holds that pid and the pid is alive and not a zombie. After a wake by the bot the directory is gone, so a reattach record from before it (a bot that died between `docker stop` and D7's write, a host reboot that stopped the container) is reported gone at once. Today's bare `kill -0` would accept whatever process now holds the old pid; pids start again from 1 with every container start, so with daily wakes that stops being rare.

Why: without (2), a continuing conversation's `sail up -d` fails after every wake, because `ensureSession` does not run chat prep's guard. Without (1) and the probe, a stale reattach record can attach to an unrelated process and write into a FIFO nobody reads, which blocks until the turn's hard cap. Cost: one exec, plus the few seconds dockerd needs to answer (the guard waits up to 20 s), only on a wake.

Alternatives considered: the guard on every `ensureSession` (one more exec per turn, and a wake by `/aven memory live` would still leave dockerd down); `docker exec -d dockerd` in the background (the agent's first `sail` call can race it, and stale pid files after a hard kill need the guard's cleanup); restoring the image's entrypoint (changes creation for every project, and existing containers keep theirs).

### D9. Configuration: the Daytona key, the Daytona meaning

`SANDBOX_AUTOSTOP_MINUTES` (`cfg.sandbox.autoStopMinutes`): unset or empty → 30, `0` or negative → the sweep never starts (Daytona's `autoStopInterval: 0` meant "never" too), not a number → the boot fails as today. The lingering bound reads the turn hard cap the sessions use (`STREAM_HARD_MAX_MINUTES`, exported from `claudeSession.ts`), not a new key. No flag: this is bucket 1, and the existing key is each installation's off switch.

Alternatives considered: a new `SSHDOCKER_IDLE_STOP_MINUTES` (two keys for one meaning, and the Daytona retirement would keep only the new one); a per-project override (no need yet, see Open Questions).

### D10. Only this installation's containers

Candidates come from the installation's own registry: `reg.current.projects` on a driver with `stopSandbox` → `${namePrefix}${slug}`. They never come from a listing; the listing only answers "running?" for those names. The stop script proves the labels (`managedBy` = this installation's value, `project` = slug) on the host in the same call that stops. On a shared host, two installations differ by name prefix. The `managedBy` value alone would not separate them: two of ours share it. `cli-probe-*` containers and a developer's containers on a local Docker host never match a candidate.

Alternatives considered: selecting by the label listing (stops another installation's containers on a shared host); names without the label check (stops a hand-made container that happens to carry one of our names).

### D11. What people and the agent see

People: the first message after a quiet half hour waits a few more seconds under "🛠 Preparing…". `/aven status` shows `💤 stopped` for idle projects, `/aven memory` answers "asleep" more often (`memory live` wakes the container), and housekeeping records "sandbox asleep — skipped" for idle projects. All of this is how the bot behaved on Daytona. Nothing is posted on a stop or a wake.

The agent: the same conversation, resumed. The container's files (checkouts, worktrees, `vendor/`, the inner Docker's volumes) are intact and dockerd is running. Sail's containers are stopped: Sail says "Sail is not running", and the toolchain paragraph's `sail up -d` step applies as written. Anything it left running in the background is gone.

So there is no system prompt change (the goldens stay byte-identical) and no Home tab change: no command, button or interaction is new or different, and the Home tab never described Daytona's stop either.

### D12. Rollout

Bucket 1, ungated. The session lifecycle has assumed this stop since it was written, and installations that came from Daytona get back the behaviour they ran with before their migration. `SANDBOX_AUTOSTOP_MINUTES=0` is the per-installation off switch. Ledger row (top of `docs/rollout.md`):

| Change | PR | Gate | Canary since | Prod since | Default since | What to watch / notes |
|---|---|---|---|---|---|---|
| ssh-docker containers stop after `SANDBOX_AUTOSTOP_MINUTES` (default 30) without activity, as Daytona sandboxes did; the next turn wakes the container and resumes the conversation with `--resume`; a wake removes the old session directories and brings dockerd back (OpenSpec `sandbox-idle-stop`) | #TBD | bucket 1 — bug fix; `SANDBOX_AUTOSTOP_MINUTES=0` turns it off per installation | – | – | n/a | Host memory and `claude` processes per container (no more than the conversations active in the last half hour); one `stopped after … idle` line per idle container; the first turn after a stop (wake latency, no error or note in the thread, `sail up -d` works); warnings: a stop forced past lingering work (a forgotten background task, a hung call) or a foreign label. An installation that still sets `SANDBOX_AUTOSTOP_MINUTES` from its Daytona days now gets that value on ssh-docker: check it before deploying. |

## Risks / Trade-offs

- [A silent background run longer than the turn hard cap is cut off] → The base prompt asks for background runs of "tens of minutes", and the cap is 60 minutes of quiet. The stop's warning says background work was still listed, and `STREAM_HARD_MAX_MINUTES` raises the bound.
- [The first message after a stop is slower] → Measured 0.4 s for the container start; seeding, the session start and dockerd add seconds, once per quiet half hour, as every Daytona wake did. The ledger watches it.
- [Sail stacks are down after a wake] → As on Daytona. The agent runs `sail up -d` (Sail and the shim say so), and the stack's volumes are kept.
- [A peek on a handle fetched just before a stop fails] → Only the first call of housekeeping or `/aven memory` in the same instant. It is reported like any sandbox error, nothing is changed, and the next run sees the container asleep.
- [An operator inside a container sees it stopped under them] → `docker exec` from the host is not activity. The docs say so: set `SANDBOX_AUTOSTOP_MINUTES=0` for a long maintenance session, or start the container again.
- [A container that never goes idle keeps accumulating processes] → Out of scope, as on Daytona. Per-container memory limits are the next change.
- [The bot dies between `docker stop` and forgetting the coordinates] → After the restart a reattach finds no session directory (D8 removes it at the wake) and the pid-file probe answers "gone", so the conversation resumes.
- [A container restarted by hand while the bot runs keeps its session directories] → The bot sees it running (`ready`), so nothing is removed and an old reattach record could still meet a reused pid. That is today's behaviour, unchanged; the bot's next stop and wake clears it. Identifying a session by pid and start time would close it, but it is not needed for the idle stop.
- [Housekeeping's prune removes the stopped Sail containers] → Only above the disk threshold, never volumes. It was like this on Daytona, and `sail up -d` recreates them.
- [A label mismatch blocks every stop of one installation] → One warning per container per boot. It is the same mismatch that already empties `/aven status`, and the fix is to pin `SANDBOX_MANAGED_BY`, as the ledger's neutral-defaults row says.
- [`retire-daytona-driver` retires `SANDBOX_AUTOSTOP_MINUTES`] → Coordination, not a dependency. Whichever change merges second keeps the key out of the retired list.

## Migration Plan

1. Merge to `main`. Restart the home bot (the canary), and update and restart the staging installation, which follows `main`. Prod gets it with the next tag. Its projects already run on ssh-docker and keep accumulating processes until then, which the ledger row watches.
2. After a start nothing is stopped for `SANDBOX_AUTOSTOP_MINUTES`. Then each idle container stops within a minute, with one log line each.
3. Rollback: `SANDBOX_AUTOSTOP_MINUTES=0` in the installation's `.env` (through its ops repo, then export and restart) stops the sweep. A container it already stopped wakes on its next turn. A revert works the same way. There is no data to migrate either way: forgotten coordinates only mean a resume instead of a reattach.

## Open Questions

- Should a project be able to override the minutes, for example one whose Sail stack is slow to start? This would be additive later. Nothing in the rule depends on it being global.
- Housekeeping's commands count as activity, so they keep an awake container up for another half hour at night. That is harmless at 04:30; revisit it if a night-time cost ever matters.
