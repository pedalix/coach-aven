# Sandbox drivers

The bot talks to sandboxes through the provider-agnostic `SandboxDriver` interface
(`src/driver.ts`): warm named sandboxes, exec, file upload, and persistent process
sessions (stdin + log snapshot + live tail — where `claude` lives and what
restart-recovery reattaches to). Two implementations exist; which one hosts a project is
config, not code.

## Choosing a driver

- **Deployment default:** `SANDBOX_DRIVER` env (`daytona` | `ssh-docker`, default `daytona`).
- **Per project:** `"driver": "ssh-docker"` in its `projects.config.json` entry — the
  fleet can span providers, so migration happens project by project. `/aven status`
  merges sandbox states across every provider in use.

Only the selected provider(s) need their env config; a driver whose config is missing
throws at first use with the vars to set.

## `daytona` (default)

The original backend: our self-hosted Daytona at `<daytona-host>`. Note Daytona's
open-source codebase was frozen in June 2026 — the instance keeps working, but pin the
instance and `@daytonaio/sdk` versions and don't expect upstream fixes. Config:
`DAYTONA_API_URL`, `DAYTONA_API_KEY`, `DAYTONA_ORGANIZATION_ID`, plus the snapshot vars
(image, cpu/memory/disk, auto-stop).

## `ssh-docker`

Sandboxes as long-lived Docker containers on a host we own, driven over SSH
(`src/sshdocker.ts`). Fixed cost, zero vendor risk, and the same DinD-capable image —
Laravel Sail keeps working.

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
   what makes a self-hosted instance on an Apple-silicon Mac viable. Today the runtime
   flag is still host-wide and `ensureDockerd` still runs for every project, so pairing
   a project with the plain image needs the per-project `sandbox` options that are
   tracked as a follow-up (unprivileged run, `dind: false`, read-only mounts).

**How it maps** (vs Daytona)

| Concern | ssh-docker behavior |
|---|---|
| Warm sandbox | `docker run -d --name proj-<slug> … --restart unless-stopped` with `sleep` as PID 1; dockerd starts lazily via the existing `ensureDockerd` guard |
| Auto-stop | None — an idle container on our own box costs nothing (`SANDBOX_AUTOSTOP_MINUTES` is ignored) |
| Wake | `docker start`; a host reboot restarts the fleet via `--restart unless-stopped` |
| exec / upload | `docker exec` with the script (or file bytes) piped via stdin — no shell-quoting of payloads |
| Persistent claude | FIFO + `out.log` under `/tmp/aven-sess/<key>/` in the container; snapshot = `cat`, tail = `tail -f`; survives bot restarts like Daytona session commands |
| `/aven status` | `docker ps` states mapped to started/stopped |

**Enabling for one project**

```json
{ "slug": "bluefin-infra", "repos": ["BluefinOrg/bluefin-infra"], "driver": "ssh-docker" }
```

Then `deploy.sh export` the runtime config and restart the bot (config is read at boot).
The first turn pulls the snapshot image on the host (can take minutes) and creates the
container; subsequent turns reuse it warm.

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

- A docker-less container variant (skip DinD runtime for projects that never run Sail) —
  today every container gets the same runtime flag.
- Sandbox-side housekeeping additions (session dir cleanup) — tracked with the general
  Daytona-side cleanup backlog.
