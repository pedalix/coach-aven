# Design

## Context

- **Resolving a project.** `resolveSandboxOptions(input)` in `src/sandboxopts.ts` returns `DEFAULT_SANDBOX_OPTIONS = { privileged: true, dind: true }` for a project without a `sandbox` block, and `?? true` for each missing field. `loadProjects` calls it at boot and at `/aven reload`.
- **Running a container.** The driver turns `privileged` into `config.sshDocker.runtime`: `--runtime sysbox-runc`, or `--privileged`, the default when `SSHDOCKER_RUNTIME` is unset (`src/config.ts`, `src/sshdocker.ts`).
- **Where the installations stand on 2026-10-30:**
  - prod: 11 projects without a block, sysbox on a separate sandbox host;
  - staging: 2 projects, both `privileged: false`, local mode;
  - home: 1 project, `privileged: false`, local mode;
  - the quickstart: explicit `privileged: false`.

## Decisions

### D1. One installation default, read where the default is used today
`SANDBOX_DEFAULT` (`dind` | `plain`; anything else stops the boot) becomes a parameter of `resolveSandboxOptions(input, installationDefault)`:
- **`dind`:** today's `{ privileged: true, dind: true }`.
- **`plain`:** `{ privileged: false, dind: false }`.

A project's own block still wins field by field, as now. Unset means `dind` in this change. The config records `sandboxDefaultSet: false`, so the boot can tell "chose dind" from "did not choose".

*Why an installation setting, not a per-project rule?* The image is installation-wide: a `plain` default with the laravel image works, but a `dind` default with the plain image breaks at the dockerd guard. The default belongs beside `SNAPSHOT_IMAGE`.

### D2. Warnings now, errors and a new default later
Three pure functions in `src/sandboxopts.ts` take the resolved projects and the settings and return warning lines; the composition root logs them once at boot:
1. **The implicit default:** `SANDBOX_DEFAULT` is unset and some project has no `sandbox` block. The warning names the slugs.
2. **The implicit runtime:** some project resolves to `dind`, and `SSHDOCKER_RUNTIME` is unset.
3. **The unconfirmed local privileged sandbox:** `SSHDOCKER_HOST=local`, some project resolves to privileged, and `SANDBOX_LOCAL_PRIVILEGED` is not `1`.

Stage 2 changes the unset default to `plain` and makes the same functions' results boot errors. The text is already written, so stage 2 is a small, reviewable flip.

*Why not errors now?* Prod would fail its next boot. Bucket 3 means today's installations keep running until their operator sets the values.

### D3. The docs carry the recipe, not the code
`docs/security.md` → *Accepted risks* gains:
- a trust note: who can make the agent run what, and why privileged plus local is the worst combination;
- an egress allow-list recipe for the sandbox host. Sandboxes join a user-defined Docker network; `DOCKER-USER` iptables rules (or an HTTP proxy such as Squid with an allow-list) admit GitHub, `api.anthropic.com`, the image registries and the MCP hosts the project declares, and drop the rest. The recipe is marked untested until an installation runs it.

## Risks / Trade-offs

- **Warning fatigue on prod until it sets the values.** One line per boot; the ledger row tracks it.
- **`SANDBOX_DEFAULT=plain` with the laravel image.** Valid: the image runs without dockerd, unprivileged. The dockerd guard is skipped because `dind` is false.
