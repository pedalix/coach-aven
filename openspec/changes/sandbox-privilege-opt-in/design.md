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

### D1. One installation default, resolved once, read everywhere
`SANDBOX_DEFAULT` (`dind` | `plain`; anything else stops the boot) becomes a parameter of `resolveSandboxOptions(input, installationDefault)`:
- **`dind`:** today's `{ privileged: true, dind: true }`.
- **`plain`:** `{ privileged: false, dind: false }`.

A project's block still wins field by field. A block that sets `dind: true` without `privileged` implies `privileged: true`, so `{ "dind": true }` stays valid under a `plain` default. Unset means `dind` in this change, and the config records `sandboxDefaultSet: false`.

`loadProjects` keeps the result on the loaded project (`resolvedSandbox`). Every reader switches to it:
- the `docker run` flags (`src/sshdocker.ts`);
- the dockerd guard at chat preparation and the prompt's Sail paragraph (`src/tasks.ts`, `src/prompt.ts`);
- housekeeping's guard (`src/pollers.ts`);
- the idle stop's inner dockerd (`src/idlestop.ts`).

Before this, the default could not reach them: each re-read the raw block.

*Why an installation setting, not a per-project rule?* The image is installation-wide. `plain` with the laravel image starts a container, but php, composer and artisan are Sail shims that need dockerd (`snapshot/shims/sail-shim.sh`), so they fail. And `dind` with the plain image fails at the dockerd guard. The default belongs beside `SNAPSHOT_IMAGE`, and the docs say which pairs work.

### D2. Warnings now, a required choice later
Three pure functions in `src/sandboxopts.ts` take the resolved projects and the settings and return warning lines. The composition root logs them at boot; `/aven reload` logs them for projects it adds.
1. **The implicit default:** `SANDBOX_DEFAULT` is unset and some project has no block. The warning names the slugs.
2. **The implicit runtime:** some project resolves to privileged, and `SSHDOCKER_RUNTIME` is unset. The runtime flag follows `privileged`, not `dind`.
3. **The unconfirmed local privileged sandbox:** `SSHDOCKER_HOST=local`, some project resolves to privileged, and `SANDBOX_LOCAL_PRIVILEGED` is not `1`.

Stage 2 turns the same three results into boot errors. It does **not** introduce a silent `plain` default: an operator who never chose gets a sentence naming the setting, not a toolchain that disappeared.

Stage 2 also lists the containers whose creation flags differ from their resolved options, because a container keeps its flags until it is recreated. Their operator recreates them (`docker rm`; the next turn creates it again).

*Why not errors now?* Prod would fail its next boot.

### D3. Egress: say what a host can do today, honestly
`docs/security.md` → *Accepted risks* gains a trust note on who can make the agent run what, and why privileged plus local is the worst combination. It also gains an egress section that does not oversell:
- **Where sandboxes sit:** today they use the default bridge network (no `--network` in `docker run`).
- **What a host can do:**
  - a forward proxy with an allow-list (GitHub, `api.anthropic.com`, the image and package registries, the MCP hosts a project declares);
  - a default-deny rule for the bridge's direct egress in the `DOCKER-USER` chain;
  - `HTTPS_PROXY` set for the sandboxes. That needs an env passthrough the code does not have yet.
- **Caveats:**
  - DNS stays open, which leaves a way out;
  - IPv6 needs its own rules;
  - IP allow-lists do not work for CDN-fronted hosts;
  - none of it applies under Docker Desktop.
- **Follow-up:** a `--network` and proxy option for sandboxes is its own change.

The section is marked untested until an installation runs it.

## Risks / Trade-offs

- **Warning fatigue on prod until it sets the values.** One line per boot; the ledger row tracks it.
- **Refactoring five readers to the resolved shape.** The byte-for-byte tests (task 1.3) are the guard: the golden prompts, the housekeeping and idle-stop scripts, and the `docker run` argv.
