## Why

Every conversation runs its own persistent `claude` process inside the project's sandbox, and nothing in the bot ever ends one that went quiet: the live-session LRU and the 45-day chat prune only drop the bot's reference "and let the sandbox's own idle lifecycle reap the process" (`src/tasks.ts`, `src/turn.ts`). That lifecycle was Daytona's: a sandbox stopped after `SANDBOX_AUTOSTOP_MINUTES` (30) without activity, every process in it ended, and the next message resumed the conversation with `--resume`. The ssh-docker driver has no such stop ("an idle container on our own box costs nothing", `src/sshdocker.ts`), so each container keeps one `claude` process per conversation touched since it started, plus any Sail stack the agent brought up. Measured: one installation's sandbox host had 7 such processes (~225 MB each) eight hours after its projects moved from Daytona to ssh-docker; the home container had 15 (2.8 GB) after four days. The driver sets no memory limit, so the growth lands on the whole host (15.6 GB on that installation): within one to two weeks a busy project exhausts it, or, where an operator gave a container a limit by hand, hits OOM inside its container. Every installation we run is on ssh-docker now.

## What Changes

- An ssh-docker project container is **stopped after `SANDBOX_AUTOSTOP_MINUTES` without activity** (default 30, the meaning the key had for Daytona; `0` = never; values between 0 and 10 are raised to 10 for this stop). The next turn wakes it, as it already does after a host reboot, and the conversation continues with `--resume`.
- **Activity** is recorded at one place, the ssh-docker driver: every operation on the container (exec, upload, session start/input/teardown, warm-up) and every chunk of session output. The turn engine adds what the driver cannot see: a turn being accepted, queued, running (also while it waits for an answer to an agent question), a one-off ask, or a turn being recovered after a restart **holds** the container however long it stays silent. A wakeup the agent scheduled (`ScheduleWakeup`) is **waited for** until two minutes after it is due (at most about an hour). Background tasks the CLI reports, messages written into a session and not answered yet, a turn the CLI started on its own, a hold that outlived the turn hard cap, and sandbox calls still running **postpone** the stop, but only until the container has been silent for the turn hard cap (`STREAM_HARD_MAX_MINUTES`, 60).
- A **sweep** in the bot process (started with the pollers; never in the CLI probe or the sources daemon) checks once a minute and stops a due container only if it is the stored sandbox of one of this installation's ssh-docker projects and its `managedBy`/`project` labels match — checked by name in the same host call that stops it. On a docker-in-docker project the **inner dockerd is sent SIGTERM first**, so it stops the Sail stack gracefully; a plain `docker stop` SIGKILLs everything but PID 1's child. The idle clock starts no earlier than the sweep. A failing host is retried with backoff and one warning per outage.
- **No race with a wake:** the driver serializes warm-up, peek and stop per container, and the sweep re-checks idleness under that lock; a message that arrives during a stop waits for it and then wakes the container.
- **Sessions after a stop:** inside the same lock, the bot treats the project's live session processes as exited (no sandbox call), clears their reattach coordinates in `state.json` and keeps each `sessionId`, so the next turn resumes the same conversation. A conversation whose background work the stop ended gets one 🔔 Background update saying so; nothing else is posted.
- **A wake on ssh-docker is what a Daytona start was**, whatever started the container: at the first warm-up after each boot of the container, the session directories of the previous boot are removed and, on a docker-in-docker project, dockerd is running again before the turn goes on. The session liveness probe requires the process's standard input to be the session's own FIFO, so a reattach record from before a boot can never pass for a live session, whatever process holds its old pid. A failed `docker start` is retried once.
- **Housekeeping** wakes an asleep ssh-docker container for its nightly pass (it never slept before, so the janitor keeps running), and its prune spares compose-managed containers, so a stopped Sail stack keeps its containers and images.
- An exploratory CLI-probe scenario records what a `ScheduleWakeup` looks like in a headless session.
- Docs: `docs/sandbox-drivers.md` (the auto-stop and wake rows, inspecting a container with `docker exec`), `docs/runtime-config.md`, `docs/housekeeping.md`, both `.env.example` files, the comments that promise an idle reaper, the Home tab's *Background agents* bullet, `CLAUDE.md`, a ledger row in `docs/rollout.md`.

## Out of scope

- Ending idle conversations' processes inside a container that never goes idle (one busy project with many threads). Daytona had no such reaping either; container memory limits are the next change.
- Per-container CPU and memory limits.
- Daytona projects: their provider keeps stopping them on its own (`autoStopInterval`); nothing changes there.
- Containers of projects removed from the registry, containers started by hand outside the bot, and an operator's own `docker exec` into a container (not activity: the bot cannot see it).
- Changing the system prompt (see design D11).

## Capabilities

### New Capabilities

- `sandbox-idle-stop`: when the bot stops an idle project sandbox that its provider does not stop on its own, what counts as activity, how a stop coordinates with turns and wakes, what happens to the sessions in it, what a wake restores, and which containers it may touch.

### Modified Capabilities

None.

## Impact

- Code: a new pure module `src/idlestop.ts` (+ `src/idlestop.test.ts`): the activity record, the idle decision, the sweep. `src/sshdocker.ts`: activity tracking in the handle, per-container serialization, `stopSandbox` with its script, the boot marker and the `docker start` retry in `ensureSandboxScript`, the FIFO identity probe, an injectable transport. `src/driver.ts`: an optional `stopSandbox` on `SandboxDriver`. `src/turn.ts`: holds, the slug in the live entries, `sandboxUse`/`sandboxStopped`. `src/tasks.ts` / `src/claudeSession.ts`: a session's idle state (background tasks, unanswered injected messages, a self-started turn, a pending wakeup), ending a session's process without a sandbox call. `src/state.ts`: clearing a project's session coordinates in one write. `src/config.ts`: the trimmed parse of the key. `src/pollers.ts`: starting the sweep, the housekeeping wake. `src/housekeeping.ts`: the prune filter. `src/chat/slack/blocks.ts`: one sentence in the Home tab. `src/cliprobe/scenarios/delivery.ts`: the probe scenario.
- Config: `SANDBOX_AUTOSTOP_MINUTES` keeps its name, default and meaning, now applied by ssh-docker as well, with a floor of 10 for that stop; surrounding spaces are trimmed (a value of only spaces is unset). No new key. An installation that still sets it from its Daytona days gets that value on ssh-docker, so each installation's value is decided before it gets the change.
- **Rollout: bucket 1 by maintainer decision — a deliberate, visible change shipped ungated as a regression fix.** The session lifecycle has always assumed an idle stop that ssh-docker never had; for installations that came from Daytona this restores the behaviour they ran with until their migration. The visible effects are listed in the ledger row and the PR. `SANDBOX_AUTOSTOP_MINUTES=0` turns it off for an installation. The ledger row names the watch items: host memory and disk, `claude` processes per container, wake latency, no error in a thread after a wake, `sail up` working after a wake, failed warm-ups.
- The unmerged `retire-daytona-driver` change lists `SANDBOX_AUTOSTOP_MINUTES` among the keys it retires (its D5) and names this fix as its first follow-up (its D9). This change does not depend on it; once this lands, that change keeps the key, which is no longer Daytona-only.
- No new dependency.
