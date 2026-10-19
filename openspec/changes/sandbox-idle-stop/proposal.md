## Why

Every conversation runs its own persistent `claude` process inside the project's sandbox, and nothing in the bot ever ends one that went quiet: the live-session LRU and the 45-day chat prune only drop the bot's reference "and let the sandbox's own idle lifecycle reap the process" (`src/tasks.ts`, `src/turn.ts`). That lifecycle was Daytona's: a sandbox stopped after `SANDBOX_AUTOSTOP_MINUTES` (30) without activity, every process in it ended, and the next message resumed the conversation with `--resume`. The ssh-docker driver has no such stop ("an idle container on our own box costs nothing", `src/sshdocker.ts`), so each container keeps one `claude` process per conversation touched since it started, plus any Sail stack the agent brought up. Measured: one installation's sandbox host had 7 such processes (~225 MB each) eight hours after its projects moved from Daytona to ssh-docker; the home container had 15 (2.8 GB) after four days. With 6 GiB per container on a 15.6 GB host, a busy project reaches OOM inside its container within one to two weeks. Every installation we run is on ssh-docker now.

## What Changes

- An ssh-docker project container is **stopped after `SANDBOX_AUTOSTOP_MINUTES` without activity** (default 30, the meaning the key had for Daytona; `0` = never). The next turn wakes it, as it already does after a host reboot, and the conversation continues with `--resume`.
- **Activity** is recorded at one place, the ssh-docker driver: every operation on the container (exec, upload, session start/input/teardown, warm-up) and every chunk of session output. The turn engine adds what the driver cannot see: a turn queued, running (also while it waits for an answer to an agent question), a one-off ask, or a turn being recovered after a restart **holds** the container however long it stays silent. Background tasks the CLI reports, messages written into a session and not answered yet, and sandbox calls still running **postpone** the stop, but only until the container has been silent for the turn hard cap (`STREAM_HARD_MAX_MINUTES`, 60).
- A **sweep** in the bot process (started with the pollers; never in the CLI probe or the sources daemon) checks once a minute and stops a due container with `docker stop`, only if its name is `<SANDBOX_NAME_PREFIX><slug>` for one of this installation's ssh-docker projects and its `managedBy`/`project` labels match. The idle clock starts no earlier than the sweep.
- **No race with a wake:** the driver serializes warm-up, peek and stop per container, and the sweep re-checks idleness under that lock; a message that arrives during a stop waits for it and then wakes the container.
- **Sessions after a stop:** the bot treats the project's live session processes as exited (no sandbox call, no thread message), clears their reattach coordinates in `state.json` and keeps each `sessionId`, so the next turn resumes the same conversation.
- **A wake on ssh-docker is what a Daytona start was:** the session directories of the previous run are removed (their processes ended with the container) and, on a docker-in-docker project, dockerd is running again before the turn goes on (Daytona's image entrypoint did that; ssh-docker started dockerd only at chat prep). The session liveness probe also requires the session's own pid file, so a reattach record from before a wake can never pass for a live session, whatever process holds its old pid.
- Docs: `docs/sandbox-drivers.md` (auto-stop and wake rows), both `.env.example` files, the comments that promise an idle reaper, `CLAUDE.md`, a ledger row in `docs/rollout.md`.

## Out of scope

- Ending idle conversations' processes inside a container that never goes idle (one busy project with many threads). Daytona had no such reaping either; container memory limits are the next change.
- Per-container CPU and memory limits.
- Daytona projects: their provider keeps stopping them on its own (`autoStopInterval`); nothing changes there.
- Containers of projects removed from the registry, containers started by hand outside the bot, and an operator's own `docker exec` into a container (not activity: the bot cannot see it).
- Changing the system prompt, the Home tab or any chat surface (see design D11).

## Capabilities

### New Capabilities

- `sandbox-idle-stop`: when the bot stops an idle project sandbox that its provider does not stop on its own, what counts as activity, how a stop coordinates with turns and wakes, what happens to the sessions in it, and which containers it may touch.

### Modified Capabilities

None.

## Impact

- Code: a new pure module `src/idlestop.ts` (+ `src/idlestop.test.ts`): the activity record, the idle decision, the sweep tick. `src/sshdocker.ts`: activity tracking in the handle, per-container serialization, `stopSandbox` with its script, the wake additions to `ensureSandboxScript`, the pid-file liveness probe. `src/driver.ts`: an optional `stopSandbox` on `SandboxDriver`. `src/turn.ts`: a `recovering` set and two engine methods for the sweep. `src/tasks.ts` / `src/claudeSession.ts`: treating a session's process as exited without a sandbox call, the count of unanswered injected messages. `src/state.ts`: clearing a project's session coordinates in one write. `src/pollers.ts`: starting the sweep.
- Config: `SANDBOX_AUTOSTOP_MINUTES` keeps its name, default and meaning, now applied by ssh-docker as well. No new key. An installation that still sets it from its Daytona days gets that value on ssh-docker.
- **Rollout bucket 1 (bug fix), ungated.** The session lifecycle has always assumed an idle stop that ssh-docker never had; for installations that came from Daytona this restores the behaviour they ran with until their migration. `SANDBOX_AUTOSTOP_MINUTES=0` turns it off for an installation. The ledger row names the watch items: host memory, `claude` processes per container, wake latency, no error in a thread after a wake, `sail up` working after a wake.
- The unmerged `retire-daytona-driver` change lists `SANDBOX_AUTOSTOP_MINUTES` among the keys it retires (its D5) and names this fix as its first follow-up (its D9). This change does not depend on it; once this lands, that change keeps the key, which is no longer Daytona-only.
- No new dependency.
