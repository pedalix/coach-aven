## Context

See proposal.md for the motivation. Today's code, as far as this change touches it:

- **Containers.** A project's sandbox is the `sandboxName` stored in its project record, `${SANDBOX_NAME_PREFIX}${slug}` (`proj-` by default) at the time the record was created. `createDriver(cfg, kind)` builds a new driver object on every call (`src/driver.ts`), so anything that must outlive one call lives at module level. ssh-docker's `ensureSandbox` runs one host script (`ensureSandboxScript`) that answers `ready`, `started` (a `docker start`), `created` (`docker run --init … --label managedBy=… --label project=<slug> --entrypoint sh <image> -c 'sleep …'`) or `revived` (stop + start after a failed exec or mount probe). `getSandbox` is a `docker inspect` that never starts anything; `listStates` is one `docker ps -a --filter label=managedBy=<SANDBOX_MANAGED_BY>`. The driver sets no CPU or memory limit.
- **What a stop does to the processes inside.** PID 1 is docker's `--init` (tini) and its only child is `sleep`. `docker stop` sends SIGTERM to tini, which passes it to `sleep`; when `sleep` exits, PID 1 exits and the kernel SIGKILLs every other process of the container. That includes the inner dockerd and every container it runs (a Sail stack's database), which were started through `docker exec` and are nobody's children. Measured on a throwaway docker-in-docker container: an inner container that traps SIGTERM got none on a plain `docker stop`, and got it when the inner dockerd was sent SIGTERM first (dockerd stopped it, then exited after 3 s). A Daytona stop was graceful here: its image ran dockerd as the entrypoint, so dockerd received the SIGTERM itself.
- **Sessions.** A conversation's `claude` runs in a FIFO session under `/tmp/aven-sess/<key>/` (pid, holder, `in`, `out.log`). `/tmp` is part of the container's writable layer: the files survive a stop, the processes do not (measured). When the container stops, the session's log stream (`docker exec … tail -f`) ends, and `ClaudeSession.onExit` marks the session dead; with no turn pending this posts nothing. The next `ensureSession` wakes the container, re-seeds tokens and MCP config, and spawns a new `claude --resume <sessionId>` after checking that the transcript is on disk. A reattach record (`sessionKey`, `cmdId` in `state.json`) is tried once per `ChatSession`, and ssh-docker's liveness probe is `kill -0 <pid>` plus a zombie check, which a recycled pid after a restart passes. The recorded pid's standard input is the session's FIFO: `readlink /proc/<pid>/fd/0` answers `/tmp/aven-sess/<key>/in` (measured).
- **What Daytona did that ssh-docker does not.** A Daytona start re-ran the image's docker-in-docker entrypoint, so dockerd came back with every wake (`snapshot/Dockerfile`); its toolbox sessions did not survive a stop, so a reattach after a stop failed cleanly. ssh-docker starts dockerd only through the guard in chat prep (`prepareChat`, a new `ChatSession`) and in housekeeping. `ensureSession`'s reopen path, which a continuing conversation takes after a wake, does not run it.
- **Activity sources**: turns through `engine.liveTurn` (its `queues` cover queued and running turns, a turn waiting for a slot or for a click on an agent question included), one-off asks and dreams (`asking`), restart recovery (`resumeInflightTurns`, `recoverShadow`: today in neither set), messages injected into a running turn or recovered after a restart, CLI background tasks (`system/background_tasks_changed`), turns the CLI starts on its own (a background completion, a `ScheduleWakeup` the agent scheduled), housekeeping, the dream's memory journal, `/aven memory [live]`, 🔄 Restart session. `/aven status`, PR/CI reads, the pollers' API calls, the sources poller and daemon never reach a container. `ClaudeSession`'s `running` flag is reset only on the message-ledger path, so it cannot serve as an idle signal. A new thread has no chat record until its first turn leaves the queue, so `slugForKey` cannot place a turn that still waits for a slot (`projectBusy` misses it the same way).
- **ScheduleWakeup.** The base prompt promises that "a ScheduleWakeup result is posted the same way — as a 🔔 Background update", and agents use it to wait for data. A wakeup is a timer inside the persistent `claude`; while it waits the process prints nothing. The call is visible on the stream: an assistant `tool_use` named `ScheduleWakeup` with `delaySeconds` (or `{ stop: true }`, which cancels), and its tool result, whose `tool_use_result` carries `scheduledFor` (epoch ms), `clampedDelaySeconds` and `wasClamped` (seen in Claude Code transcripts; delays seen up to 3600 s, the tool's documented maximum). When it fires, the CLI runs a turn of its own, as after a background completion. No probe scenario covers it yet.
- **Config and wiring.** `SANDBOX_AUTOSTOP_MINUTES` is parsed by `num()` (unset or empty → 30, a value of only spaces → 0, not a number → the boot fails) and read only by Daytona today. The pollers start in both composition roots (`pollers.startAll()`; the Slack root only when it has a home client), after restart recovery and the queue replay were started; tests build pollers but never start them. `store.patchChat` stamps `updatedAt` and rewrites `state.json`; retention drops chats by `updatedAt`. Housekeeping skips a sandbox that is not started ("waking the fleet nightly defeats auto-stop"), and its prune above the disk threshold removes every stopped container and then every image no container uses that is older than a week.

Constraints: a stop must never cost a running turn; code never deletes a project's container; installations may share a Docker host; the host runs deterministic code only; pure logic goes in its own module with tests.

## Goals / Non-Goals

**Goals:**

- One idle rule per project container, decided from one activity record that every call into a container updates by construction, plus the turn engine's and the sessions' own state.
- Stops that cannot race a wake, a turn or another installation, and that let the inner Docker shut its containers down.
- A wake on ssh-docker that leaves the container as a Daytona start did: no stale sessions, dockerd running, whatever started it.

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

### D2. The idle rule: holds, wakeups, lingering work, quiet time

Evaluated per container by one pure function (`idleStopDue` in `src/idlestop.ts`):

1. `SANDBOX_AUTOSTOP_MINUTES ≤ 0`, or the container is **parked** (D3: the sweep stopped it, found it stopped, missing or foreign, and no warm-up has run since) → no.
2. **Held** → no. Held = a turn of the project is being accepted, queued, running (also while it waits for a click) or being recovered, or a one-off ask or dream runs on it (D4) — unless the hold is older than the turn hard cap plus five minutes (then it counts as lingering, below).
3. Quiet time `q` = now − last activity (D3). `q < autostop` → no.
4. **A pending wakeup** of a live session (D4) → no until two minutes after it is due. The CLI clamps a wakeup to at most an hour, and the due time the bot keeps is capped at the call plus 62 minutes, so this wait is bounded.
5. **Lingering** work — background tasks a live session lists, injected messages it has not answered, a turn the CLI started on its own and has not finished, a hold older than the hard cap, calls into the container still in flight — → no while `q < max(autostop, STREAM_HARD_MAX_MINUTES)`; past that, stop and say which one was still there.
6. Otherwise stop.

Why these classes. Every hold ends on its own: a running turn at its watchdog (soft 15 / hard 60 minutes), a one-off ask at the same deadlines, a recovery likewise, a queued turn when the turns ahead of it end. So holding unconditionally is safe, and it is the only way a 45-minute command that prints nothing survives. A hold that outlives the hard cap is a hang before the watchdog was armed (a seeding call with no timeout), so it stops holding. A wakeup has a known due time and a fixed maximum, so it is waited for exactly: stopping under it would drop the update the prompt promises. Lingering work has no deadline of its own: a dev server started with `run_in_background` never ends, a self-started turn can hang like any turn, and a `cat > in` into a FIFO whose reader is gone blocks forever. The turn hard cap bounds it because it is already the longest the bot lets a turn's work run, and the base prompt asks the agent to background only commands of "tens of minutes".

Alternatives considered:

- *Driver activity only* (Daytona counted API calls): stops a container under a long silent tool call. Rejected.
- *Engine state only*: misses background agents, housekeeping, `/aven memory live` and the dream's journal. Rejected.
- *`ClaudeSession.running`*: never resets on sessions without the message ledger. Rejected.
- *Probing processes in the container* (`ps`, CPU): an exec per container per minute, which is itself activity, and it cannot tell an idle `claude` from one waiting on the network or on a timer. Rejected.
- *Background tasks as holds*: a forgotten background server pins the container forever and the leak returns. *Background tasks ignored*: a 35-minute background test run is killed and its promised background update never comes. Both rejected.
- *Wakeups as lingering work under the hard-cap bound*: a 60-minute wakeup due a minute after the bound would be killed at the edge (the CLI aligns `scheduledFor` to the minute). Rejected for the exact wait.

### D3. Activity is recorded in the ssh-docker driver

`src/idlestop.ts` keeps a module-level record per container name: last activity, calls in flight, the **parked** mark, and the per-container lock of D6. The floor of every last-activity value is the moment the sweep starts.

- Every `SshDockerHandle` call (`exec`, `uploadFile`, `createSession`, `startSessionCommand`, `sessionCommandRunning`, `sessionCommandLogs`, `sendSessionInput`, `deleteSession`) runs through one wrapper: in flight +1 and a touch at the start, a touch and −1 in `finally`.
- `streamSessionCommandLogs` is the exception: it lasts as long as the process, so it is never "in flight"; every chunk it delivers is a touch.
- `ensureSandbox` runs through the wrapper as well, and **every** warm-up attempt clears the parked mark at its start, successful or not: any attempt may have started the container (a `docker start` followed by a failed probe leaves it running). `getSandbox`, `listStates` and `deleteSandbox` are host-level and record nothing.

Why the driver: every caller reaches a container only through a handle, so turns, housekeeping, the dream journal, `/aven memory`, Restart session and any future caller are recorded without knowing about it. Why only ssh-docker: Daytona's provider measures its own activity. The record is driver-agnostic, so another driver without an idle lifecycle can reuse it. The transport (`runSsh`) is injectable for tests; production passes nothing.

Alternatives considered: wrapping every driver in `createDriver` (an extra layer for Daytona, which needs none and is about to be retired); recording at call sites (the next caller forgets it); recording in `runSsh` (a host-level script does not say which container it is about).

### D4. The engine's view of a project

`src/turn.ts` gains:

- **holds**: one per turn the engine accepted, keyed by an id and carrying the key, the slug and a clock. `liveTurn` registers its hold synchronously on entry, before the chat acknowledgements it awaits (a message still being acknowledged is already a hold), and releases it when the turn settles or when acceptance fails; the clock restarts when the turn leaves its key's queue. `runAsk` holds for its whole run (clock restarted once its slot is granted). `resumeInflightTurns` and `recoverShadow` register a hold per recovered conversation before `sessionFor` and release it in `finally`. So a new thread's first turn counts while it still waits for a slot.
- the slug in every **live-session entry** (`{ chat, slug }`, set by `sessionFor`), so a live session is placed without its chat record, which retention may have pruned.
- `sandboxUse(slug)` → `{ held, lingering?, wakeupDueAt? }`: `held` when a hold of the slug is younger than the hard cap plus five minutes; `lingering` names the first of `background` (tasks the CLI lists), `injected` (a message written into the session and not answered), `self-turn` (a turn the CLI started with no turn of ours pending, not finished), `stale-hold` (only holds older than that); `wakeupDueAt` is the latest pending wakeup of the slug's live sessions.
- `sandboxStopped(slug, idleMinutes)` (D7).

`ClaudeSession` tracks what only it can see, from the stream it already parses:

- **Wakeups**: a `ScheduleWakeup` `tool_use` sets the due time to now plus `delaySeconds` clamped to [60, 3600]; its result's `tool_use_result.scheduledFor` replaces it with the CLI's own time (capped at the call plus 62 minutes); `{ stop: true }` clears it; the process's exit clears it. The same handler runs over a reattach snapshot.
- **Self-started turns**: the CLI is in a turn from `system/init`, an assistant message or a permission request until its `result`; a turn with no pending send or adopt is self-started.

The sweep pulls this view when it decides, instead of the engine pushing leases into the record: a release that never happens cannot pin a container, and the engine stays the only owner of turn state. `projectBusy` keeps its meaning (dreams, housekeeping and the CLI upgrade gate are unchanged).

A probe scenario (`schedule-wakeup`, exploratory, `src/cliprobe/scenarios/delivery.ts`) records what a wakeup looks like in a headless session: the result's fields, whether `background_tasks_changed` lists it, and whether it fires. Running it needs a subscription token the operator hands to the probe (`docs/cli-probe.md`), so it is recorded by the operator (task 7.2). The rule does not depend on its answer: a wakeup listed as a background task is lingering anyway, and one that never fires headless is waited for until its due time and no longer.

### D5. The sweep

`src/idlestop.ts` exports the sweep (`createIdleSweep`) with its dependencies injected (candidates, a stop function per driver kind, the engine view, the record, clock, log), so it is tested with fakes; `src/pollers.ts` starts it from `startAll()` every 60 s, and not at all when `SANDBOX_AUTOSTOP_MINUTES ≤ 0`. So it runs exactly where the routine scheduler runs: in the Slack composition root (with a home client) and the Teams one, never in tests, the CLI probe or the sources daemon, which never start pollers.

Candidates (D10): every project of `reg.current` whose driver has `stopSandbox` and that has a project record, by the record's `sandboxName`.

One tick, never two at once (a tick still running when the next minute comes is not overlapped):

1. For each candidate not waiting out a failure backoff, evaluate D2. Nothing due → no host call. That is the steady state once idle containers are parked.
2. For each due candidate, `driver.stopSandbox({ name, slug, dind, recheck, onStopped })`: inside the per-container lock, evaluate D2 again on fresh inputs and run the stop only if still due; on `stopped`, still inside the lock, `onStopped` (`engine.sandboxStopped`) and then the parked mark (D7).
3. The outcome: `stopped` → one log line; `not-running` or `missing` → parked, no log; `foreign` → parked, one warning per name per boot; `skipped` (work arrived) → nothing.

The stop is one host script (90 s timeout) that answers by name: it reads `.State.Running` and the `managedBy`/`project` labels in one `docker inspect` and prints `missing` (after checking that the daemon answers), `foreign managedBy=<x> project=<y>`, `not-running`, or stops the container and prints `stopped`. On a docker-in-docker project it first sends SIGTERM to the inner dockerd (`/var/run/docker.pid`) and waits up to 30 s for it to exit, so dockerd stops its containers with their own grace; then `docker stop -t 10`. With `--init` the outer stop itself takes well under a second.

Failures: a stop that throws (the host does not answer, the script fails) puts that container on a backoff of 1, 2, 4, 8, then 15 minutes, logs one warning when the outage starts and one info line when a stop of it works again; nothing is parked and its sessions are untouched. An exception from the tick itself (a bug) goes to `pollFail('idle-stop')`.

Log lines:

- info: `sandbox '<name>' stopped after <m> min idle (ssh-docker, <s>s)`;
- warning: the same line followed by ` — background tasks were still listed`, ` — an injected message was still unanswered`, ` — a turn the CLI started on its own was still running`, ` — a turn held it past the hard cap` or ` — a sandbox call was still running`;
- warning: `idle stop of '<name>' failed: <reason> — retrying in <n> min`, then info `idle stop of '<name>' works again`;
- warning, once per name per boot: `idle stop: '<name>' carries managedBy=<x>, project=<y> — not this installation's container, left running`;
- warning, once per project per boot: `idle stop: project '<slug>' runs in '<stored>' (state.json) but SANDBOX_NAME_PREFIX gives '<computed>' — the idle stop follows the stored name`;
- at the sweep's start: info `idle stop: sandboxes without an idle stop of their own (ssh-docker) stop after <m> min without activity` (or `idle stop: off (SANDBOX_AUTOSTOP_MINUTES ≤ 0)`), and a warning when the floor of D9 raised the value.

Alternatives considered: a `listStates()` per kind to learn "running?" first (it filters by the `managedBy` label, so a container with another label would never reach the label check, and a container started by a failed warm-up would stay marked stopped); a timer per container reset on every touch (still has to poll the engine, which has no "turn ended" event); a `docker inspect` per project per tick (nine ssh calls a minute on a nine-project host to learn nothing); running the sweep in the sources daemon or on the host (neither sees turns).

### D6. Stop, wake and peek are serialized per container

The ssh-docker driver runs `ensureSandbox`, `getSandbox` and `stopSandbox` for one container under the record's per-container lock (a promise chain per name that a rejection never breaks).

- A turn or `/aven memory live` that needs the container during a stop waits for it — at most the stop's timeout, typically under a second, up to ~45 s on a docker-in-docker project whose inner dockerd shuts a Sail stack down — then starts it.
- A peek (housekeeping, `/aven memory`, Restart session) during a stop reports the state after the stop.
- Two warm-ups of one container run one after the other. That matters for D8's cleanup: a turn (under `tasks.ts`'s per-project lock) and `/aven memory live` (the only waker outside it) can no longer both start the container, and one cannot remove a session the other has just created.
- The re-check under the lock closes "found idle, then work started": anything accepted, queued, started or read before it is seen, and anything later waits for the stop to finish.
- The sessions are ended and the coordinates forgotten (D7) inside the same exclusive section, before the parked mark and before the lock is released: a warm-up queued behind the stop starts the container only after that.

Handle calls are not under the lock: that would serialize a project's whole traffic. They are tracked (D3), so a call in flight at the re-check postpones the stop. A call made on a handle fetched before the stop fails like any call into a stopped container, and its caller reports it as it reports any sandbox error.

`tasks.ts`'s fast path in `ensureSession` checks again after its warm-up whether the session died meanwhile and, if so, reopens it at once, instead of handing a dead session to `send` (which would fail it and retry).

Boot: the sweep starts after restart recovery and the queue replay were started, both of them holds, and its start is the floor of every idle clock. So nothing is stopped under a recovered turn, and a container that sat idle for hours before a restart still gets the full `SANDBOX_AUTOSTOP_MINUTES`.

Alternatives considered: the sweep takes `tasks.ts`'s per-project prep lock (covers turns only, not `/aven memory live`, housekeeping or Restart session, and ties the sweep to the chat layer); the engine re-check alone without a lock (a wake from `/aven memory live` could interleave the stop).

### D7. Sessions on stop: ended in memory, coordinates forgotten, `sessionId` kept

Inside the per-container lock, after `docker stop` succeeded, `engine.sandboxStopped(slug, idleMinutes)`, in this order:

1. Every live `ChatSession` of the project ends its `claude` the way a closed log stream does, without any call into the sandbox: dead, injected messages `lost` (the deliverer sends them again as turns), background list and wakeup cleared, a pending turn settled as an error (D2 guarantees there is none). The `ChatSession` stays in the live map, so the next turn only re-seeds and reopens with `--resume`, the path every Daytona wake took, instead of a full chat prep.
2. A session that still listed background work or was in a turn of its own when it ended posts one line through its idle-notify target (where its 🔔 Background updates go): `⏹ The sandbox was stopped after <m> min without activity — the background work still running in this conversation ended with it. Ask me to run it again if you still need the result.` A shadow conversation (agent messaging) gets none: its idle-notify target is its task's completion rule, which would take the line for the answer; its task is nudged and ended by that rule as for any idle shadow conversation.
3. The store clears `sessionKey` and `cmdId` on every chat of the slug that has them and no `inflight` marker, in one write (a failure is logged, the stop stands). `sessionId`, `ledger` and `updatedAt` stay as they are.

Then the driver sets the parked mark and releases the lock.

Why end the sessions explicitly when the stream's exit would mark them dead anyway: between `docker stop` returning and that exit being observed, a turn waiting on the lock could be handed a session that is not dead yet. Why forget the coordinates: a bot restart after a stop would otherwise try to reattach by pid. Why not `patchChat` per chat: it stamps `updatedAt`, so every stop would restart the 45-day retention, and it rewrites `state.json` once per chat.

Alternatives considered: `ChatSession.close()` (one failing exec per session into a stopped container); removing the keys from the live map (a turn already holding the object still gets the stale session); `retireSession` per key (an exec and a save each); posting nothing when background work dies (the prompt promises an update that would then never come).

### D8. A wake on ssh-docker is what a Daytona start was

`ensureSandboxScript`, after the exec and mount probes, compares the container's boot (`docker inspect -f '{{.State.StartedAt}}'`) with the marker `/tmp/aven-sess/.boot` inside it, in one `docker exec`:

- Same boot → nothing (a warm container, the case of almost every turn).
- No marker and the outcome `ready` → write the marker only: a container this code has not seen boot, typically one running since before this change shipped, whose live sessions must not be touched.
- Otherwise (any other outcome, or a marker from an earlier boot) → `rm -rf /tmp/aven-sess` (every session there belongs to a process that ended with that boot), write the marker, and on a docker-in-docker project run the dockerd guard (`dockerdGuardCmd`, the one chat prep and housekeeping run) and print its marker. All of it best effort, on stderr; the outcome stays the last stdout line, and `ensureSandbox` puts `fresh boot` and the guard's result in its log line (a failed dockerd is a warning, not a failed warm-up: chat prep's guard reports it to Sentry when a chat opens).

So the cleanup follows the container's boot, not one warm-up's outcome: a `docker start` whose probe then failed, a container restarted by hand or by a host reboot, all get it at their next warm-up. It costs one `docker exec` per warm-up: a whole warm warm-up (inspect, update, the boot step) took 0.41 s on Docker Desktop.

`runningProbeScript(key, pid)`: a session is up only if the pid is alive, not a zombie, and its standard input is that session's FIFO (`readlink /proc/<pid>/fd/0` = `/tmp/aven-sess/<key>/in`). A recycled pid never has it, so a reattach record from before a boot (the bot died between `docker stop` and D7's write, a host reboot, a restart by hand) is reported gone at once, whatever process now holds its old pid.

`docker start` in the `started` branch is retried once after two seconds before the warm-up fails: every quiet half hour now ends in a stop, so starts that were rare become routine, and a failed one surfaces as an error in the person's thread.

Why: without the guard, a continuing conversation's `sail up -d` fails after every wake, because `ensureSession` does not run chat prep's guard. Without the cleanup and the probe, a stale reattach record can attach to an unrelated process and write into a FIFO nobody reads, which blocks until the turn's hard cap.

Alternatives considered: the cleanup and guard on the outcomes `started`/`revived` only (misses a container whose `docker start` succeeded but whose probe failed: the next warm-up sees it `ready`); the guard on every `ensureSession` (one more exec per turn, and a wake by `/aven memory live` would still leave dockerd down); `docker exec -d dockerd` in the background (the agent's first `sail` call can race it, and stale pid files after a hard kill need the guard's cleanup); restoring the image's entrypoint (changes creation for every project, and existing containers keep theirs); a pid-file comparison as the probe (the stale directory still holds the old pid file, which a reused pid matches).

### D9. Configuration: the Daytona key, the Daytona meaning, a floor

`SANDBOX_AUTOSTOP_MINUTES` (`cfg.sandbox.autoStopMinutes`) is parsed with surrounding spaces trimmed: unset, empty or only spaces → 30; `0` or negative → the sweep never starts (Daytona's `autoStopInterval: 0` meant "never" too); not a number → the boot fails naming the key, as today. The ssh-docker stop has a floor: a value between 0 and 10 is raised to 10 for the sweep, with a warning at its start (Daytona keeps the configured value). A Daytona-era value of a few minutes would otherwise stop and wake a container between almost every pair of messages, and each stop takes the Sail stack down. The lingering bound reads the turn hard cap the sessions use (`STREAM_HARD_MAX_MINUTES`, exported from `claudeSession.ts` as `STREAM_HARD_MAX_MS`), not a new key. No flag: the existing key is each installation's off switch (D12).

Alternatives considered: a new `SSHDOCKER_IDLE_STOP_MINUTES` (two keys for one meaning, and the Daytona retirement would keep only the new one); a per-project override (no need yet, see Open Questions); no floor (see above).

### D10. Only this installation's containers

Candidates come from the installation's own registry and state: each project of `reg.current` on a driver with `stopSandbox` that has a project record → the record's `sandboxName`, the name its turns use. A project with no record has never had a container. When the stored name differs from `${namePrefix}${slug}` (the prefix changed after the record was made), the sweep follows the stored name and warns once (housekeeping and `/aven memory` use the computed name, as today). Candidates never come from a listing. The stop script proves the labels (`managedBy` = this installation's value, `project` = slug) on the host in the same call that stops, by name, so a container with one of our names and another label is found and left running with a warning. On a shared host, two installations differ by name prefix; the `managedBy` value alone would not separate them, because two installations can share it. So installations that share a Docker host must use distinct `SANDBOX_NAME_PREFIX` values (docs and `.env.example` say so): the idle stop and the wake cleanup assume one bot per container. `cli-probe-*` containers and a developer's containers on a local Docker host never match a candidate.

Alternatives considered: selecting by the label listing (stops another installation's containers on a shared host, and hides a container with another label from the check); names without the label check (stops a hand-made container that happens to carry one of our names); the computed name (misses an installation whose prefix changed after its records were made).

### D11. What people and the agent see

People: the first message after a quiet half hour waits a few more seconds under "🛠 Preparing…". `/aven status` shows `💤 stopped` for idle projects and `/aven memory` answers "asleep" more often (`memory live` wakes the container). A background run that keeps the whole sandbox silent for an hour is ended by the stop, and the thread gets one 🔔 Background update saying so (D7). Nothing else is posted on a stop or a wake.

The Home tab's *Background agents* bullet gets one sentence for that limit (re-snapshotted on purpose: `src/fixtures/chat/interactions/home*.json`, `src/fixtures/chat/teams/cards.json`). No command, button or other interaction changes.

The agent: the same conversation, resumed. The container's files (checkouts, worktrees, `vendor/`, the inner Docker's volumes) are intact and dockerd is running. Sail's containers were stopped by the inner dockerd: Sail says "Sail is not running", and the toolchain paragraph's `sail up -d` step applies as written. Anything it left running in the background is gone. So there is no system prompt change (the goldens stay byte-identical).

### D12. Rollout

A deliberate, visible change, shipped ungated as a regression fix by the maintainer's decision: the session lifecycle has assumed an idle stop since it was written, and installations that came from Daytona get back the behaviour they ran with before their migration. It is not "numbers move, behaviour does not": Sail stacks are down after every quiet half hour, the first turn after a stop is slower, a background run silent for an hour is cut (with a notice), `/aven memory` answers "asleep" more often, and housekeeping wakes idle containers at night. `SANDBOX_AUTOSTOP_MINUTES=0` is the per-installation off switch, and each installation's value is decided on purpose before it gets the change (tasks 9.2, 9.3). Ledger row (top of `docs/rollout.md`):

| Change | PR | Gate | Canary since | Prod since | Default since | What to watch / notes |
|---|---|---|---|---|---|---|
| ssh-docker containers stop after `SANDBOX_AUTOSTOP_MINUTES` (default 30, floor 10) without activity, as Daytona sandboxes did; the inner dockerd shuts its containers down first; the next turn wakes the container and resumes the conversation with `--resume`; a wake clears the old session files and brings dockerd back; housekeeping wakes an idle container for its nightly pass and its prune spares compose-managed containers (OpenSpec `sandbox-idle-stop`) | #TBD | bucket 1 by maintainer decision — a visible change shipped as a regression fix; `SANDBOX_AUTOSTOP_MINUTES=0` turns it off per installation | – | – | n/a | Each installation's value decided before it gets the change: home default 30; staging sets the key explicitly — read and set it on purpose before the merge; prod's decision recorded here before the tag. Before the prod tag, one measured cycle on the staging host (a docker-in-docker project with Sail up: stop, wake, first turn, wall time of each step, the guard's result). Watch: host memory and disk; `claude` processes per container (no more than the conversations active since the last wake); one `stopped after … idle` line per idle container; the first turn after a stop (wake latency, no error or note in the thread, `sail up -d` works); daily counts of `ensureSandbox … failed` and `recycled` warnings; warnings: a stop forced past lingering work, a foreign label, a failed stop. |

### D13. Housekeeping where the bot owns the idle stop

On a driver with `stopSandbox` (ssh-docker), `fireHousekeeping` wakes an asleep container (`ensureSandbox`) instead of skipping it, and its digest starts with `woke · `; the sweep stops it again once the window has passed. On ssh-docker containers never slept, so this keeps the nightly janitor running as it does today — the prune above the disk threshold (which matters more here: every container shares the host's disk), CLI convergence for idle projects, the worktree reap. A missing container is still skipped (housekeeping creates nothing). Daytona projects keep the skip.

The prune spares compose-managed containers on every driver: `docker container prune -f --filter label!=com.docker.compose.project`. A stopped Sail stack is now the normal state of an idle project; without the filter the prune would remove its containers and then, through `image prune -a`, their images once older than a week, and the next `sail up -d` would rebuild. The images stay because a stopped container still uses them. Volumes were never pruned.

Alternatives considered: waking only when the last pass is older than N days (needs a new routine field for a janitor that is cheap anyway); keeping the skip (the janitor would silently stop running on every idle ssh-docker project).

## Design review: what was applied

| Finding | Handling |
|---|---|
| 1 (high) ScheduleWakeup timers and self-started turns invisible | Applied: wakeups waited for exactly (D2 rule 4, D4), self-started turns lingering (D2, D4), one line when a stop ends background work or a self-started turn (D7), spec scenarios. The probe scenario is written (D4) but recorded by the operator, who holds the token (task 7.2). |
| 2 label-filtered listing | Applied: no listing; the stop script answers by name (D5); the mark is cleared at the start of every warm-up attempt (D3); test for a foreign label. |
| 3 a stop SIGKILLs the inner Docker | Applied: SIGTERM to the inner dockerd first, up to 30 s, 90 s script timeout, duration in the log line (D5, D6); measured. |
| 4 housekeeping skipped, prune removes Sail stacks | Applied: D13. |
| 5 bucket framing, per-installation values, whitespace | Applied: D12 wording and tasks 9.2–9.3, the floor and the trim (D9), spec scenarios. |
| 6 wake cost measured off-platform | Applied: a measured staging cycle before the prod tag (task 9.3), the `docker start` retry (D8), the failure counts in the watch items, the memory-limit sentence in the proposal. |
| 7 cleanup tied to one warm-up's outcome | Applied: the boot marker and the FIFO identity probe (D8). |
| 8 cleanup inside the lock | Applied: `onStopped` runs in the exclusive section, in the order of D7. |
| 9 engine view gaps | Applied: holds from `liveTurn`'s entry, the slug in the live entry, stale holds (D4). |
| 10 scope guard relies on configuration | Applied: stored names, the mismatch warning, distinct prefixes documented (D10). |
| 11 failure handling | Applied: non-reentrant tick, backoff, one warning per outage (D5). |

## Risks / Trade-offs

- [A silent background run longer than the bound is cut off] → The base prompt asks for background runs of "tens of minutes", the bound is an hour of a silent container, the stop's warning names it, the thread gets one line, and `STREAM_HARD_MAX_MINUTES` raises the bound.
- [The first message after a stop is slower] → Measured on Docker Desktop (no sysbox) with throwaway containers: a plain container stops in 0.3–0.5 s and wakes in 0.95 s (start + boot step); a docker-in-docker one with an inner container running stops in 2.7 s (the inner dockerd's shutdown) and its warm-up after the stop took 3.3 s more (start, exec probe, dockerd guard). sysbox, a real Sail stack and the session's own start add more; task 9.3 measures one cycle on the staging host before the prod tag.
- [Sail stacks are down after a wake] → As on Daytona. The agent runs `sail up -d` (Sail and the shim say so), and the stack's volumes, containers and images are kept (D13).
- [A peek on a handle fetched just before a stop fails] → Only the first call of housekeeping or `/aven memory` in the same instant. It is reported like any sandbox error, nothing is changed, and the next run sees the container asleep.
- [An operator inside a container sees it stopped under them] → `docker exec` from the host is not activity. The docs say so: set `SANDBOX_AUTOSTOP_MINUTES=0` for a long maintenance session, or start the container again.
- [A container that never goes idle keeps accumulating processes] → Out of scope, as on Daytona. Per-container memory limits are the next change.
- [More than 100 live sessions] → A session the live-session LRU evicted is invisible to the engine view; its output still counts as activity, but its silent background work does not hold. Today's cap and behaviour, unchanged.
- [A wakeup or background completion pending across a bot restart] → Its result was already never posted (no live session listens until the next turn of that conversation); the stop now also ends the process. Unchanged for the user.
- [One more `docker exec` per warm-up for the boot marker] → A warm warm-up took 0.41 s in all on Docker Desktop; a turn already does several execs and uploads.
- [A wakeup loop] → An agent that keeps re-scheduling wakeups keeps its container up, as any recurring activity would; each cycle is a metered background turn (`/aven usage`).
- [The bot dies between `docker stop` and forgetting the coordinates] → After the restart a reattach finds no session directory (D8 removes it at the next boot) and the identity probe answers "gone", so the conversation resumes.
- [A label mismatch blocks every stop of one installation] → One warning per container per boot. It is the same mismatch that already empties `/aven status`, and the fix is to pin `SANDBOX_MANAGED_BY`, as the ledger's neutral-defaults row says.
- [Housekeeping wakes idle containers at night] → One start per project per night, the dockerd guard and the janitor; stopped again after the window. Only where the routine is enabled.
- [`retire-daytona-driver` retires `SANDBOX_AUTOSTOP_MINUTES`] → Coordination, not a dependency. Whichever change merges second keeps the key out of the retired list.

## Migration Plan

1. Before the merge: read the staging installation's `SANDBOX_AUTOSTOP_MINUTES` and set it on purpose (30, or 0 to opt out) in its ops repo (task 9.2). Merge to `main`. Restart the home bot (the canary), and update and restart the staging installation, which follows `main`. Prod gets it with the next tag, after its decision is recorded (task 9.3). Its projects already run on ssh-docker and keep accumulating processes until then, which the ledger row watches.
2. The first warm-up of each running container writes its boot marker and removes nothing. After a start nothing is stopped for `SANDBOX_AUTOSTOP_MINUTES`. Then each idle container stops within a minute, with one log line each.
3. Rollback: `SANDBOX_AUTOSTOP_MINUTES=0` in the installation's `.env` (through its ops repo, then export and restart) stops the sweep. A container it already stopped wakes on its next turn. A revert works the same way; a leftover `.boot` marker is harmless. There is no data to migrate either way: forgotten coordinates only mean a resume instead of a reattach.

## Open Questions

- Should a project be able to override the minutes, for example one whose Sail stack is slow to start? This would be additive later. Nothing in the rule depends on it being global.
- Does a wakeup fire in a headless stream-json session at all? Task 7.2 answers it. If it does not, the prompt's sentence about wakeups promises something the CLI never delivers, which is a prompt question for its own change.
