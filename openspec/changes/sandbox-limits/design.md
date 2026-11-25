## Context

`ensureSandboxScript` (`src/sshdocker.ts`) is the one place a project container is created or started: one
shell script over SSH (or locally) that inspects the container, starts or creates it, and reports an outcome.
It passes a runtime flag and volumes to `docker run` and nothing about resources. The Daytona driver had
`SANDBOX_CPU` / `SANDBOX_MEMORY`; they were retired with it and a leftover is ignored by requirement.

Measured on one installation's sandbox host (8 CPUs, 15.6 GB, no swap; 9 days of 10-minute samples,
2026-11-25): peak 3.0 GB used and 13 % CPU; an awake idle sandbox holds 0.2–0.35 GB. Its hand-set limit is
6 GB and 4 CPUs per container — two containers at the limit fit, a third does not.

## Goals / Non-Goals

**Goals:** every container of an installation carries the limit the installation chose, with nothing to
remember; an existing container gets it without losing its state; an installation that sets nothing sees no
change.

**Non-Goals:** a limit per project; a disk or pid limit; deciding the values for an installation; admission
control (refusing to start a container when the host is full).

## Decisions

### D1. Two installation settings with new names

`SANDBOX_LIMIT_MEMORY` (a docker size: digits and an optional `b`/`k`/`m`/`g`) and `SANDBOX_LIMIT_CPUS` (a
positive number, fractions allowed). Read and validated in `src/config.ts` beside `SANDBOX_DIND_RUNTIME`; a bad
value throws at boot.

- Why not reuse `SANDBOX_MEMORY` / `SANDBOX_CPU`: a leftover line in some installation's `.env` would start
  to apply on the day of the deploy. The existing requirement says such a leftover changes nothing.
- Why not per project (`sandbox.memory` in the projects config): no project needs its own value today, and
  the installation's operator owns the host. It can be added on top later without changing these settings.

### D2. Memory means memory, no extra swap

The driver passes `--memory X --memory-swap X`: the container gets no swap beyond its memory. Docker's default
(`--memory-swap` unset) allows as much swap again, which on a host with swap hides the limit and on a host
without it means nothing.

### D3. Converge in the ensure script, compare first

After the script has a started container (outcome `ready`, `started` or `created`), and only when a setting is
set, it reads `HostConfig.Memory` and `HostConfig.NanoCpus` and runs `docker update` when they differ from the
wanted bytes / nano-CPUs. The comparison is in the script, so the usual path costs one `docker inspect` in a
round trip that already happens, and an unchanged container is never written to.

- Why not only at creation: containers are never recreated here (their state is in the writable layer), so a
  creation-only limit would never reach the containers that exist — the very ones found without a limit.
- Why not a one-off migration command: it is the hand step that was forgotten.
- Why not a sweep at boot over every container: it would touch stopped containers of projects nobody uses,
  and the prepare path reaches each container before any work runs in it anyway.

The wanted values are computed in TypeScript (bytes, nano-CPUs) and embedded as numbers, so the script
compares integers and the parsing is unit-tested.

### D4. A failed update does not fail the turn

`docker update` refuses a memory limit below what a running container already uses. The script prints a marker
line (`limits=failed <docker's first line>`) and exits as before; the driver logs a warning with the project.
The next prepare tries again — after the idle stop the container is stopped and the update always applies.

### D5. Unset leaves everything alone

With a setting unset the script has no line for it: the driver neither sets nor clears that limit. Clearing
would undo an operator's hand-set limit on the first deploy of this change.

## Risks / Trade-offs

- [A project that needs more than the limit starts failing] → the limit is the operator's choice per
  installation; on the installation that already runs with hand-set limits nothing changes for the containers
  that had them. Inside the container the kernel kills the largest process, which can be the agent's own
  `claude` — the turn then ends with the existing "process ended" recovery.
- [`docker update` on a RUNNING sysbox container is untested] → on a stopped one it was done by hand and held
  (the cgroup showed the limit after the start). A task probes the running case before the first installation
  sets a value; if it does not hold, D4's path applies and the limit lands after the next idle stop.
- [Limits sum to more than the host] → by design: limits cap one project, they do not reserve. Sizing the
  host stays the operator's job (`docs/sandbox-drivers.md` gets the arithmetic).

## Migration Plan

1. Merge and ship: no installation sets the settings, nothing changes.
2. Per installation, in its ops repository: add the two lines, restart the bot. Each container converges at
   its next prepare. Rollback: remove the lines and restart — the limits already applied stay until changed by
   hand (`docker update`), which is harmless.

## Open Questions

None.
