# Proposal

## Why

A project without a `sandbox` block runs as **privileged docker-in-docker**:
- `resolveSandboxOptions` defaults to `privileged: true, dind: true`;
- the runtime defaults to `--privileged` unless `SSHDOCKER_RUNTIME=sysbox-runc`.

That default made sense for the first installations, Laravel agencies running Sail inside the sandbox. For anyone else it is the riskiest choice, and it is made silently:
- A privileged container is root-equivalent on its Docker host. Claude Code runs there with its permission prompts off, beside the project's dependencies, and reads text from people and documents.
- With `SSHDOCKER_HOST=local`, that Docker host is the machine that holds the bot's own secrets and its Docker socket.
- A Node or Python team needs three opt-outs to avoid it. The README and `.env.example` offered local mode without saying so; the community plan's audit counted this as a major finding.

`docs/security.md` lists it as an accepted risk. This change makes it a choice.

## What Changes

- **`SANDBOX_DEFAULT`, the installation's default for a project without a `sandbox` block:**
  - `dind` means privileged docker-in-docker, today's behaviour;
  - `plain` means an unprivileged container without Docker.

  In this change an unset value still means `dind`. The boot logs one warning that names the projects relying on it and the two ways out: set `SANDBOX_DEFAULT`, or give the project a `sandbox` block.
- **The runtime of a docker-in-docker project is a choice too.** When some project resolves to `dind` and `SSHDOCKER_RUNTIME` is unset, the boot warns and names `sysbox-runc` (preferred) and `privileged`.
- **A privileged sandbox on the bot's own machine needs a confirmation.** With `SSHDOCKER_HOST=local` and a project that resolves to privileged, the boot warns unless `SANDBOX_LOCAL_PRIVILEGED=1` says the operator knows the container is root-equivalent beside the bot's secrets.
- **Templates and docs say it first:**
  - `.env.example` and the ops template write `SANDBOX_DEFAULT` explicitly;
  - `projects.config.example.json` shows the `sandbox` block;
  - `docs/security.md` gets a trust note and an egress allow-list recipe (GitHub, Anthropic, the image registries, the MCP hosts a project declares);
  - `docs/sandbox-drivers.md` and `docs/configuration.md` describe the settings.
- **A later change flips it.** Once every installation we operate sets these values, a minor release makes `plain` the default and turns the three warnings into boot errors that name the setting. That flip is a separate ledger stage, not part of this change.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `sandbox-drivers`: how a project's privilege is decided — the installation default, the runtime of docker-in-docker, and the local-mode confirmation — and what the boot says about each.

## Impact

- **Rollout: bucket 3, in two stages.**
  - **Stage 1, this change:** warnings only; every resolved option and every `docker run` stays byte for byte what it is today, pinned by tests over today's configurations.
  - **Stage 2, a later change:** the defaults flip.
  - Ledger row "sandbox privilege opt-in".
  - Before stage 2:
    - prod sets `SANDBOX_DEFAULT=dind` (its 11 projects rely on the default; `SSHDOCKER_RUNTIME=sysbox-runc` is already set);
    - staging and home set `SANDBOX_DEFAULT=plain` (every project there already says `privileged: false`).
- **Code:**
  - `src/sandboxopts.ts`: the default comes from a parameter, and pure functions produce the warnings;
  - `src/config.ts`: `SANDBOX_DEFAULT` and `SANDBOX_LOCAL_PRIVILEGED`, and whether `SSHDOCKER_RUNTIME` was set;
  - `src/projects.ts`: `loadProjects` passes the default;
  - `src/chat/root.ts`: the boot warnings.
- **Out of scope:**
  - egress filtering in code (the recipe is docs);
  - the flip itself;
  - per-project runtimes;
  - a seccomp or AppArmor profile.
