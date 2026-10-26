# Proposal

> **Status: decided 2026-10-26; the code is in the same pull request.** First proposed on 2026-10-19 as two pull requests (this spec, then the code) with machinery for someone else's Daytona installation: a refused Daytona default inferred from `DAYTONA_API_URL`, warnings for every leftover setting, a one-line configuration error class and a *Breaking* release category. On 2026-10-26 the maintainer cut it to one pull request without any of that (design D3): no installation runs Daytona, and the public repository has no forks. v0.42.0 is the last release with the driver.

## Why

The Daytona driver has no users left. All three installations we operate (home, staging, prod) set `SANDBOX_DRIVER=ssh-docker` and run every project on ssh-docker, and the public repository (1 star, 0 forks) shows nobody else running it. What remains is dead code that every reader of the sandbox path has to skip, plus a dependency the project cannot maintain:
- `@daytonaio/sdk` is pinned to match a self-hosted server whose code was frozen in June 2026, Dependabot is told to ignore it, and upstream has since deprecated the package under that name.
- Its subtree is 159 of the lockfile's 417 packages, and it carries most of what the audits find. On 2026-10-26 `npm audit` reports 31 vulnerable packages (19 high, 12 moderate) from 18 advisories, 26 of those packages and 13 of the advisories through the SDK; Dependabot shows 17 open alerts, 14 of them from the SDK's tree. For most of them the only fix npm offers is a newer SDK, which the pin rules out.
- The code default is still `daytona`, so an installation that sets nothing gets a driver nobody runs, and the docs, the templates and Slack's `/aven status` still present Daytona as current.

## What Changes

- **Removed:**
  - the driver (`src/daytona.ts`), its test, and the operator script `scripts/peek-sandbox.ts`;
  - `@daytonaio/sdk` and its lockfile entries, and Dependabot's ignore entry for it;
  - the settings only the driver read: every `DAYTONA_*` variable, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK`;
  - the Daytona-only pieces of shared code: the SDK's error name in the network retry, and an options check only the driver used;
  - the Daytona blocks of both `.env` templates, and the `daytona` driver of an example project, which now names `ssh-docker`.
- **ssh-docker is the only driver, and the default.** `SANDBOX_DRIVER` and a project's `driver` field stay optional. The templates and docs keep `SANDBOX_DRIVER=ssh-docker` written out, because v0.42.0 still defaults to `daytona`. The driver interface stays as the seam for another driver.
- **One rule for a driver setting.** A `SANDBOX_DRIVER` other than `ssh-docker` stops the bot at boot with one sentence. A project's `driver` other than `ssh-docker` is a projects-configuration error that names the project, at boot and at `/aven reload`, like any other invalid project setting. Nothing else: leftover Daytona settings are not read and draw no warning.
- **Slack's `/aven status` says "Sandboxes" where it said "Daytona", and shows ⚠️ while the sandbox host cannot be listed**, with each project's sandbox "unknown" instead of "not created". Today ssh-docker's listing ignores its own exit code, so an outage reads as ✅ with every project "not created". The Teams card already says "sandboxes".
- **The docs and templates describe one driver**, and `docs/sandbox-drivers.md` keeps a short note on the retired one.

## What does not change

- The ssh-docker driver: container names, the image (`SNAPSHOT_IMAGE` and the config's `snapshot` block keep their names), flags, sessions, housekeeping, the idle stop and restart recovery. Its listing only gains the exit-code check.
- `SANDBOX_AUTOSTOP_MINUTES`: since `sandbox-idle-stop` it sets the bot's idle stop of ssh-docker containers.
- The system prompt goldens, the Home tab and the Teams cards.
- Every recorded chat call, except the two that carry the status flag and the missing-driver-settings error.

## Out of scope

- Help for a Daytona installation beyond the boot error and the retired note: no inferred Daytona default, no warnings about leftover settings, no migration script, no deprecation release, no *Breaking* release category.
- What Daytona offered that ssh-docker lacks: archiving, per-sandbox CPU, memory and disk limits, preview links, a hosted API. CPU and memory limits would be a change of their own, under new names.
- Renaming `SNAPSHOT_IMAGE` or the `snapshot/` directory.
- How `getSandbox` reads an unreachable host: it says "no sandbox" (design D4).
- The audit findings left after the removal, all outside the SDK: `follow-redirects` (Dependabot's pull request #72), `body-parser`, `@azure/msal-node` through the Teams SDK, and `@opentelemetry/core` through the error reporter.
- Anything outside this repository: a decommissioned Daytona server, its sandboxes and its credentials.

## Capabilities

### New Capabilities
- `sandbox-drivers`: which driver runs a project's sandbox, how an installation selects it, what a setting that names another driver does, and what `/aven status` says about the sandboxes. No current spec covers it: `sandbox-image` covers the toolchain inside the image, `cli-probe` only uses a driver, and `sandbox-idle-stop` covers the idle stop the bot runs for a driver without one.

### Modified Capabilities
- `sandbox-idle-stop`: no project can run on Daytona any more. Its rule for a driver whose provider stops idle sandboxes itself stays, without naming Daytona. Its scenario *A Daytona project* keeps its name, because OpenSpec refuses a MODIFIED block that drops a scenario, and now says that such a configuration is refused (design D6).

## Impact

- **Rollout: bucket 1 (bug fix or invisible improvement), no flag.** The removal and the default flip are dead code on every installation we operate: each sets `SANDBOX_DRIVER=ssh-docker`, and `src/config.test.ts` pins today's shape. The status word and the listing check are bug fixes. The rule is inert wherever every setting says `ssh-docker`. `docs/rollout.md` gets a ledger row and a *Retired* entry. Prod runs v0.42.0 and changes only at the next tag; a rollback to v0.42.0 stays safe because every installation's `.env` sets `SANDBOX_DRIVER=ssh-docker`.
- **Code:**
  - deleted: `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts`;
  - changed: `src/config.ts`, `src/driver.ts`, `src/projects.ts`, `src/sshdocker.ts` (the listing), `src/sandboxopts.ts`, `src/netretry.ts`, `src/cliprobe/sandbox.ts`, `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/slack/blocks.ts` and `src/chat/teams/cards.ts`;
  - comments in about twenty other files.
- **Tests and fixtures:** new cases in `src/config.test.ts`, `src/projects.test.ts`, `src/sshdocker.test.ts` and `src/cliprobe/sandbox.test.ts`, and a new `src/driver.test.ts`; `status.json` and `memory-live-no-sandbox.json` re-captured.
- **Dependencies:** the SDK and 159 lockfile packages leave (417 → 258), and so does the Dependabot ignore entry. `@opentelemetry/instrumentation` and `@opentelemetry/api-logs` stay, hoisted at 0.214.0, the version the error reporter (`@sentry/node`) pins, instead of the SDK tree's 0.217.0 (design D5). `npm audit` goes from 31 vulnerable packages (18 advisories) to 5 (5 advisories), measured 2026-10-26.
- **Docs:** listed in tasks.md, group 5.
