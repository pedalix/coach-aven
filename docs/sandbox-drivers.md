# Sandbox drivers

The bot reaches sandboxes only through the provider-agnostic `SandboxDriver` interface
(`src/driver.ts`): warm named sandboxes, exec, file upload, and persistent process
sessions (stdin + log snapshot + live tail — where `claude` lives and what
restart-recovery reattaches to). It has one implementation, **ssh-docker**: long-lived
Docker containers on a host the installation runs. Everything outside the driver files is
provider-ignorant, so the interface stays as the seam for another driver (*Adding a driver*).

## `ssh-docker`

Sandboxes as long-lived Docker containers on a host the installation runs, driven over SSH
(`src/sshdocker.ts`), or on the bot's own host (*Local mode*). Fixed cost, no vendor in the
loop, and a DinD-capable image, so Laravel Sail works inside.

**Host prerequisites**

1. Docker installed; the SSH user in the `docker` group.
2. Key-based SSH from the bot's host, non-interactive (`BatchMode`); an `~/.ssh/config`
   alias is the place for port/key/user options — `SSHDOCKER_HOST` can be that alias.
3. DinD runtime, one of:
   - **sysbox** (`SSHDOCKER_RUNTIME=sysbox-runc`) — preferred: containers get a working
     inner dockerd without host-root equivalence. Install: https://github.com/nestybox/sysbox
   - **privileged** (`SSHDOCKER_RUNTIME=privileged`, default) — works everywhere, but a
     privileged container is root on the host; acceptable only because the box is
     dedicated to these sandboxes.

   Both exist only because the fleet image (`snapshot/Dockerfile`, the `laravel`
   variant) runs dockerd for Sail. A project that never starts containers of its own can
   use the `plain` image variant instead (`snapshot/plain/Dockerfile`: no dockerd,
   multi-arch amd64 + arm64) and then needs neither sysbox nor `--privileged`, which is
   what makes a self-hosted instance on an Apple-silicon Mac viable. Pair it with the
   project's `sandbox` block (validated at boot by `src/sandboxopts.ts`):

   ```json
   {
     "slug": "ops-plain",
     "repos": ["you/ops-ledger"],
     "driver": "ssh-docker",
     "sandbox": {
       "privileged": false,
       "dind": false,
       "mounts": ["/srv/ops/notes:/data/notes"]
     },
     "sources": { "slack": { "workspaces": ["T0…"] } }
   }
   ```

   - `privileged: false` → plain `docker run`, no `--privileged`, no `--runtime` (requires
     `dind: false`; docker-in-docker needs one of the two runtimes).
   - `dind: false` → no dockerd guard at chat prep or in housekeeping, no docker prune, no
     exec-probe/recycle dance (that one exists for sysbox's registry), and the base system
     prompt drops its Sail/Docker-in-Docker toolchain paragraph (`src/prompt.ts`) — there are
     no shims to explain.
   - `mounts` → `-v host:container:mode`; mode defaults to `ro`. Paths must be absolute,
     `[A-Za-z0-9._/-]`, no `..`. Read-only is the point: the agent reads the archive, it
     never edits it.
   - The bot adds no mounts of its own: the sources tools and the messaging tools reach the agent
     over the session control channel (`docs/runtime-config.md` → *Host tools*). The store replica
     is never mounted (`docs/sources.md` → "Replica").

   The image itself stays deployment-wide (`SNAPSHOT_IMAGE`), so a plain project lives on
   an instance whose fleet image is the plain variant (how the variants are built and the
   CLI pinned: `snapshot/README.md`). Options shape CREATION only: an
   existing `proj-<slug>` keeps the flags it was born with — `docker rm` it on the sandbox
   host and the next turn recreates it with the new ones.

**Local mode.** `SSHDOCKER_HOST=local` (the literal word) skips ssh entirely: the driver
runs the very same scripts through `sh -c` against this machine's Docker daemon. It is
for a single-box self-hosted instance — a laptop/WSL, a Mac mini — where the bot and
the sandboxes share the host and running sshd just to reach localhost would be theatre.
Everything else (`docker run … sleep`, exec via stdin, FIFO sessions) is unchanged. Trust
note: in local mode the bot process and the sandboxes share a kernel, so pair it with
projects that run `sandbox.privileged: false` (plain image, no DinD) rather than the
`--privileged` hammer.

**How it maps** (onto the driver contract, *Adding a driver*)

| Concern | ssh-docker behavior |
|---|---|
| Warm sandbox | `docker run -d --init --name proj-<slug> …` with `sleep` under docker's init and **no restart policy**; dockerd starts via the `ensureDockerd` guard — at chat prep, and at the first warm-up after every start of the container |
| Auto-stop | **The bot's own** (there is no provider to do it): stopped after `SANDBOX_AUTOSTOP_MINUTES` (default 30, floor 10, `0` = never) without activity — see *Idle stop* below |
| Wake | `docker start` (retried once) on the first turn after a stop — the idle stop's, or a host/daemon reboot's. Deliberately NOT `--restart unless-stopped`: a daemon-started container races the host filesystem export (Docker Desktop/WSL) and its bind mounts come up empty. Every warm-up also probes each bind mount (non-empty host dir ⇒ non-empty target) and stop+starts a container whose mount attached to nothing. The first warm-up after each start of the container — whoever started it — removes the session directories whose process did not survive the start (a directory stays only while its pid is alive and reads its FIFO, or, where the runtime does not let the bot read that link, is the pid its pid file names: the running check's own rule) and, on a docker-in-docker project, brings dockerd back before the turn goes on (a boot marker, `/tmp/aven-sess/.boot`, tells a new start from a warm container; the first warm-up of a container already running when this shipped only writes it) |
| exec / upload | `docker exec` with the script (or file bytes) piped via stdin — no shell-quoting of payloads |
| Persistent claude | FIFO + `out.log` under `/tmp/aven-sess/<key>/` in the container; snapshot = `cat`, tail = `tail -f` from the first byte; survives bot restarts. A session counts as running only while its recorded pid is alive and its stdin is that session's FIFO, so a pid reused after a restart never passes (where the runtime does not let the bot read that link at all, the session's own pid file decides, as before). The processes end with an idle stop; the conversation resumes with `--resume` on its next turn |
| `/aven status` | `docker ps -a` filtered by the `managedBy` label, states mapped to started/stopped (`💤 stopped` for an idle project). A listing that exits non-zero — ssh's 255 when the host cannot be reached, docker's 1 when its daemon is down — shows `Sandboxes ⚠️`, never `✅`, and each project's sandbox `⚠️ unknown`, never "not created"; the bot's journal gets the listing's error |

**Idle stop** (OpenSpec `sandbox-idle-stop`, `src/idlestop.ts`)

Every conversation keeps its own `claude` process in the project's container, and the bot never
ends one that went quiet: it relies on the sandbox stopping when nobody uses it. Docker has no idle
lifecycle, so on ssh-docker the bot does that stop itself. Once a minute (from the pollers, so only
in a running bot), it stops a project container that has been idle for `SANDBOX_AUTOSTOP_MINUTES`;
the next turn wakes it and continues the same conversation.

- **Activity** is every call the bot makes into the container (exec, upload, session start, input
  and teardown, warm-up) and every chunk of session output — recorded in the driver, which every
  caller passes. `/aven status`, `docker ps`, a peek that finds it asleep and an operator's own
  `docker exec` are not activity. The idle clock never starts before the bot did.
- **Never stopped** while a turn of the project is being accepted, queued, running (also waiting
  for an answer to an agent question) or recovered after a restart, or a one-off ask or dream runs
  on it — however long the turn is silent. A wakeup the agent scheduled (`ScheduleWakeup`) is waited
  for until two minutes after it is due.
- **Postponed, up to the turn hard cap** (`STREAM_HARD_MAX_MINUTES`, 60, of container silence):
  background tasks the CLI lists, messages written into a session and not answered, a turn the CLI
  started on its own, a call that has not returned, a turn hold older than the hard cap. Past that
  the stop goes ahead with a warning naming the cause, and a conversation whose background work it
  ended gets one 🔔 Background update saying so.
- **After a bot restart** the bot sees this only for the conversations it has reattached since: a
  turn that was running is recovered at once, every other conversation at its next turn. Until
  then, the background tasks, self-started turns and pending wakeups of a conversation are
  invisible: they neither hold nor postpone the stop, so its process is stopped
  `SANDBOX_AUTOSTOP_MINUTES` after the bot started, with no notice in its thread. Their results were
  never posted after a restart anyway (nothing listens until that conversation's next turn).
- **The stop**: by name, and only if the container's `managedBy`/`project` labels are this
  installation's (checked in the same host call). On a docker-in-docker project the inner dockerd
  gets SIGTERM first and up to 30 s to stop its containers (a Sail stack) with their own grace — a
  plain `docker stop` would end them with SIGKILL. Then `docker stop -t 10`; should that fail (or the
  bot die in between), the container runs on without dockerd, and the next warm-up brings it back (a
  mark the inner stop leaves, `/tmp/aven-sess/.dockerd-stopped`). Warm-up, peek and stop of one
  container never overlap: a message that arrives during a stop waits for it (seconds; up to ~45 s
  while an inner Sail stack shuts down), then wakes the container.
- **The sessions**: the project's live sessions are ended in memory, their reattach coordinates in
  `state.json` forgotten (one write; `sessionId` and the last-used time are kept), and the next turn
  of each conversation resumes it with `--resume`. A conversation whose background work or
  self-started turn the stop cut short gets the one 🔔 Background update above; no other
  conversation gets anything.
- **Log lines**: `sandbox '<name>' stopped after <m> min idle (ssh-docker, <s>s)` (a warning with the
  cause when lingering work was cut), `idle stop of '<name>' failed: …` (one per outage, retried with
  a backoff from 1 to 15 minutes), `idle stop: '<name>' carries managedBy=…` (a container with one of
  our names and another label: left running, one warning per start of the bot), `sandbox '<name>':
  no answer to a state check …` (a peek — housekeeping, `/aven memory` — runs under the container's
  lock, so it gives up after 30 s; it then reads as no sandbox). On a wake:
  `sandbox '<name>' started (ssh-docker) — new boot: session files reset, dockerd restarted`. At the
  bot's start: `idle stop: sandboxes without an idle stop of their own (ssh-docker) stop after <m> min
  without activity`, or `idle stop: off (SANDBOX_AUTOSTOP_MINUTES ≤ 0)`.
- **Housekeeping**, where enabled and while the idle stop is on, wakes an asleep container for its
  nightly pass (`docs/housekeeping.md`); the idle stop puts it back to sleep.
- **Off switch**: `SANDBOX_AUTOSTOP_MINUTES=0` turns off the stops and housekeeping's wake (values
  between 0 and 10 are raised to 10, with a warning). It does not turn off what every warm-up and
  reattach now does on ssh-docker, stop or no stop: the boot step (old sessions' directories
  removed, dockerd back on docker-in-docker), the identity check of a session's process, the
  `docker start` retry, the per-container lock, the prune's compose filter. Their rollback is a
  revert.
- **One bot per container**: candidates are the stored sandbox names of this installation's
  projects, and the labels cannot tell two installations apart when they share a `managedBy` value.
  Installations that share a Docker host must use distinct `SANDBOX_NAME_PREFIX` values.

**Verification status**

E2E-verified 2026-07-10 against a real host (20-check smoke: container lifecycle, exec
semantics incl. cwd/env/timeout/exit codes, byte-exact upload, and the full FIFO session
contract — replay-then-tail reattach, no EOF between turns, clean teardown). The smoke
caught the zombie pitfall now baked into the driver: containers run with `--init`
(without it, PID 1 is our `sleep` and never reaps orphans — dead session processes
linger as zombies, which pass `kill -0` and wedge streams), and liveness checks treat
state `Z` as dead. Containers created by a pre-`--init` build must be recreated
(`docker rm -f proj-<slug>`; the next turn recreates it — repo state is re-cloned).

**Host upgrades orphan running containers (sysbox)**

sysbox keeps its own registry of the containers it manages, and it lives in the
`sysbox-mgr`/`sysbox-fs` daemons. Restarting them — which any unattended host upgrade
touching kernel/glibc does — drops the entries for containers that are *already*
running. Those containers stay `Up` in `docker ps` but every `docker exec` then fails
with `OCI runtime exec failed: … unsafe procfs detected`, and `sysbox-fs` logs
`seccompNotifMsg generated by unknown container: <id>`. This wedged the coach-aven
sandbox for twelve days in August 2026 (sysbox restarted Jul 29, container running since
Jul 13): every turn died at the first token upload.

`ensureSandbox` now probes `docker exec … true` before handing back a handle and, if the
probe fails twice, recycles the container (`stop` + `start`, which re-registers it with
sysbox) and logs a WARN. Recycling is safe because an exec-less sandbox is already
useless; the repo checkout on the container's disk survives it. Only a container that
still refuses exec after the recycle is a hard failure — and the driver now includes
docker's own stderr in that error instead of a bare exit code.

**Not yet done**

- Per-container CPU and memory limits: the driver sets none, so the processes of a project
  share the host's memory with every other project.
- Ending idle conversations' processes inside a container that never goes idle (a busy project
  with many threads keeps one `claude` per conversation touched since its last start).

## Selecting the driver

- `SANDBOX_DRIVER` in `.env` (installation-wide) and a project's `"driver"` field in
  `projects.config.json` are both optional, and `ssh-docker` is the only value either one
  takes. With both unset — an empty `SANDBOX_DRIVER` counts as unset, a JSON `null` field as
  absent — a project runs on ssh-docker.
- **Write it anyway:** `SANDBOX_DRIVER=ssh-docker`, as both `.env` templates do (the
  `manage-project` skill writes a project's `"driver": "ssh-docker"`). v0.42.0 and every earlier
  release default to `daytona`: an installation that drops the line and later rolls back sends
  every project without a `driver` field down a path where each turn fails.
- **Any other value is a configuration error, never followed.** A `SANDBOX_DRIVER` other than
  `ssh-docker` stops the bot at boot (`SANDBOX_DRIVER=<value>: the Daytona driver was removed
  after v0.42.0; ssh-docker is the only sandbox driver`). A project's `driver` other than
  `ssh-docker` fails the projects configuration with the same words, naming the project, like any
  other invalid project setting: the bot does not start, `/aven reload` keeps the previous
  configuration, and the `orch sources` commands refuse it. Before the removal a misspelt `driver`
  selected Daytona without a word.

Missing driver settings are not checked at boot: without `SSHDOCKER_HOST`, a project's first
sandbox use fails with an error naming it, so one misconfigured setting cannot keep the bot
down.

## Looking inside a container

A project's container is a plain container on the sandbox host:
`ssh <SSHDOCKER_HOST> docker exec -it <prefix><slug> sh` (in local mode just
`docker exec -it <prefix><slug> sh`); `docker ps -a --filter label=managedBy=<SANDBOX_MANAGED_BY>`
lists the installation's containers, and `docker exec <prefix><slug> ps` shows its `claude`
processes. An idle container is usually stopped: `docker start <prefix><slug>` first (or
`/aven memory live`, which wakes it). Your own `docker exec` is not activity for the idle stop, so a
container can be stopped under a long session of yours: set `SANDBOX_AUTOSTOP_MINUTES=0` for long
maintenance, or just start it again. A container started by hand stays up until the bot's next
warm-up of it; from then on the idle stop applies again.

## Adding a driver

Another provider is one new driver file beside `src/sshdocker.ts` that implements
`SandboxDriver` (`src/driver.ts`). Its SDK, if it has one, is imported in that file and nowhere
else, and the rest of the bot does not change. The contract every driver keeps:

- **A warm named sandbox per project**, created from the installation's image on first use, woken
  when stopped, with a disk that survives a stop (`ensureSandbox`); `getSandbox` peeks without
  creating or waking it.
- **An idle lifecycle the session code can rely on.** Every conversation keeps its own `claude`
  process in the sandbox, and the bot ends none that went quiet, so an idle sandbox must stop and
  end every process in it. Either the provider stops idle sandboxes itself — then the driver has no
  `stopSandbox`, and the bot's sweep and housekeeping never stop or wake its sandboxes — or the
  driver implements `stopSandbox`, records activity and serializes warm-up, peek and stop of one
  sandbox as ssh-docker does (`sandboxActivity`, `src/idlestop.ts`), and the bot's sweep stops
  them.
- **exec and upload**: exec with cwd, env, a timeout and the exit code; an upload whose bytes never
  sit on a command line (a token must not show up in an exec log).
- **Persistent sessions** with stdin, a log snapshot and a live tail, alive across bot restarts.
  Every (re)subscribe of the tail replays the whole log from the start, then follows;
  `ClaudeSession` skips the prefix it already has.
- **A listing that fails when it cannot answer** (`listStates` throws): an empty map would read as
  "every sandbox not created" behind `Sandboxes ✅`.
- **The name-only delete guard**: `deleteSandbox` refuses every name but a throwaway
  `cli-probe-<run>` (`assertDeletable` in `src/sandboxopts.ts`), whatever the provider's listing
  holds. Code never deletes a project's sandbox.

Selecting it: `SandboxDriverKind` (`src/config.ts`) gains its name, `createDriver(cfg, kind)`
switches again on `kind` — a project's `driver`, else `SANDBOX_DRIVER` — which it ignores today,
and the checks that refuse every value but `ssh-docker` accept the new one (`sandboxDriverEnv` in
`src/config.ts`, `loadProjects`, the CLI probe's `driverFromEnv`). Its settings are read by
`loadConfig` and checked at its first use, not at boot. Its tests fake the provider, as
`src/sshdocker.test.ts` fakes the Docker host.

## Retired: Daytona

The first driver ran each project in a sandbox on a self-hosted [Daytona](https://www.daytona.io)
server, through `@daytonaio/sdk`. Daytona's open-source code was frozen in June 2026, the SDK was
pinned to match the server and later deprecated upstream, and by October 2026 every installation we
know of ran its projects on ssh-docker. OpenSpec `retire-daytona-driver` removed the driver, the SDK
and the settings only they read; v0.42.0 is the last release that has the driver.

- A configuration that still names it is refused (*Selecting the driver*).
- The other settings it read — every `DAYTONA_*` variable, `SNAPSHOT_NAME`, `SANDBOX_CPU`,
  `SANDBOX_MEMORY` and `SANDBOX_DISK` — are not read any more: delete them. `SANDBOX_AUTOSTOP_MINUTES`
  is not one of them: it sets the idle stop.
- A project moved off a Daytona sandbox gets a new, empty container: its worktrees, uncommitted
  work, memory not yet journaled, Sail data and the Claude session files `--resume` needs stay
  behind, and nothing in the bot deletes the old sandbox.
- What Daytona offered beyond ssh-docker — archiving long-stopped sandboxes, per-sandbox CPU,
  memory and disk limits, preview links, a hosted API — has no counterpart. CPU and memory limits
  would be a change of their own, under new names (*Not yet done*).
