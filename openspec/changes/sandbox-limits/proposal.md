## Why

The ssh-docker driver creates a project's container with no memory or CPU limit (`docs/sandbox-drivers.md`,
*Not yet done*). Every sandbox of an installation lives on one host, so one runaway build or test run in one
project can take the memory of all of them, and on a host without swap the kernel then kills processes of
other projects.

One installation worked around it by hand: an operator ran `docker update` on the containers that existed that
day. The containers the bot created later had no limit, and nobody noticed for four weeks (found 2026-11-25,
while sizing the host for the nightly pass). A limit that depends on somebody remembering it is not a limit.

Consumer: the operator of any installation whose sandboxes share a host.

## What Changes

- **Two installation settings**, `SANDBOX_LIMIT_MEMORY` and `SANDBOX_LIMIT_CPUS`: the memory and the CPUs one
  project's container may use. Unset — the default — means what happens today: the driver sets no limit and
  does not touch one set by hand.
- **The driver applies them itself**: to a container it creates, and to an existing container whose limit
  differs, in place (`docker update`) the next time it prepares that container. No container is recreated.
- **A value the driver cannot read stops the boot**, like the other sandbox settings.
- The names are new on purpose: `SANDBOX_MEMORY` and `SANDBOX_CPU` belonged to the removed driver and stay
  ignored (`sandbox-drivers`: *Settings only the removed driver read change nothing*).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sandbox-drivers`: a new requirement — an installation can cap what one project's container uses, and the
  driver keeps every container at that cap.

## Impact

- `src/config.ts` (the two settings, validated at boot), `src/sshdocker.ts` (`ensureSandboxScript`: the flags
  at creation, the in-place update), their tests.
- `docs/configuration.md`, `docs/sandbox-drivers.md` (the item leaves *Not yet done*), `docs/runtime-config.md`
  if it lists the sandbox settings.
- Rollout: default-preserving — with both settings unset the script the driver runs is byte-for-byte today's
  (a test pins it). No flag and no ledger row: these are permanent installation settings, set per installation
  in its ops repository.
- Not in this change: a limit per project, a disk limit, a limit on process count.
