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
- **One resolved shape, read everywhere.** Today `loadProjects` validates the options and throws the result away, and five places re-read the raw `sandbox` block (the `docker run` flags, the dockerd guard at chat preparation and in housekeeping, the idle stop's inner dockerd, the prompt's Sail paragraph). The resolved options become part of the loaded project, and every site reads only them, so the installation default reaches all of them.
- **The runtime of a privileged project is a choice too.** When some project resolves to privileged and `SSHDOCKER_RUNTIME` is unset, the boot warns and names `sysbox-runc` (preferred) and `privileged`.
- **A privileged sandbox on the bot's own machine needs a confirmation.** With `SSHDOCKER_HOST=local` and a project that resolves to privileged, the boot warns unless `SANDBOX_LOCAL_PRIVILEGED=1` says the operator knows the container is root-equivalent beside the bot's secrets.
- **Templates and docs say it first:**
  - `.env.example` and `quickstart/.env.example` (`plain`) write `SANDBOX_DEFAULT` explicitly;
  - the root `projects.config.example.json` gives its block-less projects a `sandbox` block;
  - `docs/security.md` gets a trust note and an honest egress section: what a host can do today (a proxy plus a default-deny rule; DNS and IPv6 caveats; not under Docker Desktop), and that putting sandboxes on their own Docker network is a follow-up;
  - `docs/sandbox-drivers.md` and `docs/configuration.md` describe the settings.
- **A later change makes the choice required.** Once every installation we operate sets these values, a minor release turns the three warnings into boot errors that name the setting. An unset `SANDBOX_DEFAULT` with a block-less project then stops the boot instead of picking a default silently. A silent `plain` default would take Sail's php and composer away from a laravel-image installation. That step is its own change and ledger row.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `sandbox-drivers`: how a project's privilege is decided — the installation default, the runtime of docker-in-docker, and the local-mode confirmation — and what the boot says about each.

## Impact

- **Rollout:**
  - **Stage 1, this change, bucket 2:** new settings; today's default unchanged; three log lines. Every resolved option, every `docker run`, every housekeeping and idle-stop script and every golden prompt stays byte for byte what it is today, pinned by tests over today's configurations.
  - **Stage 2, a later change, bucket 3:** it is breaking. Unset becomes a boot error, with its own ledger row; containers whose creation flags differ from their resolved options are listed and recreated.
  - Ledger row "sandbox privilege opt-in".
  - Before stage 2:
    - prod sets `SANDBOX_DEFAULT=dind` (its 11 projects rely on the default; `SSHDOCKER_RUNTIME=sysbox-runc` is already set);
    - staging and home set `SANDBOX_DEFAULT=plain` (every project there already says `privileged: false`).
- **Code:**
  - `src/sandboxopts.ts`: the default comes from a parameter, and pure functions produce the warnings;
  - `src/config.ts`: `SANDBOX_DEFAULT` and `SANDBOX_LOCAL_PRIVILEGED`, and whether `SSHDOCKER_RUNTIME` was set;
  - `src/projects.ts`: `loadProjects` resolves the options with the default and keeps them on the project; `/aven reload` and `src/sources/cli.ts` load through it;
  - `src/sshdocker.ts`, `src/tasks.ts`, `src/pollers.ts`, `src/idlestop.ts`, `src/prompt.ts`: read the resolved options;
  - `src/cliprobe/sandbox.ts`: its own `Config` gains the new fields;
  - `src/chat/root.ts` and the reload path: the warnings.
- **Out of scope:**
  - egress filtering in code, including a `--network` option for sandboxes (a follow-up);
  - the stage-2 step itself;
  - showing a project's privilege in `/aven status`;
  - per-project runtimes;
  - a seccomp or AppArmor profile.
