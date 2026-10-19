# Proposal

> **Status: proposed 2026-10-19, revised after two reviews the same day.** Decision taken: the Daytona sandbox driver leaves the product, and ssh-docker becomes the only driver. Each decision in design.md comes with its alternative and stays open until the review settles it. Then the change goes out as a spec-only PR, and the code follows in its own PR.

## Why

The Daytona driver has no users left. Every installation we know of runs its projects on ssh-docker, and no self-hosted Daytona we know of is left. What remains is dead code that every reader of the sandbox path has to skip, plus a dependency the project cannot maintain:
- `@daytonaio/sdk` is pinned to match a self-hosted server whose code was frozen in 06/2026, and Dependabot is told to ignore it. Upstream has since deprecated the package under that name.
- Its subtree makes up 159 of the lockfile's 417 packages (measured 2026-10-19): the AWS S3 client, gRPC, the OpenTelemetry exporters and more. `npm audit` reports 30 advisories in the lockfile (19 high). 29 of them come through the SDK and leave with it. For several of them, the only fix npm offers is a newer SDK, which the pin rules out.
- The code default is still `daytona`, so an installation that sets nothing gets a driver nobody runs. The docs, the templates and Slack's `/aven status` still present Daytona as current.

## What Changes

- **Removed. BREAKING for an installation that still runs Daytona:**
  - the driver (`src/daytona.ts`), its test, and the operator script `scripts/peek-sandbox.ts`;
  - `@daytonaio/sdk` and its lockfile entries, and Dependabot's ignore entry for it;
  - the settings only Daytona read: every `DAYTONA_*` variable, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`;
  - the Daytona-only pieces of shared code: the SDK's error name in the network retry, and an options check only the driver used;
  - the Daytona blocks of the `.env` templates, and the example project that names Daytona.
- **ssh-docker is the only driver, and the default.** `SANDBOX_DRIVER` and a project's `driver` field stay optional, and `ssh-docker` is the only driver they select. The docs and templates still write `SANDBOX_DRIVER=ssh-docker`, because every earlier release defaults to `daytona`. The driver interface stays as the seam for a future driver.
- **No project moves to a new sandbox unless its operator edits the configuration.** Every command that loads the projects configuration refuses one that would move a project:
  - a project whose `driver` is `daytona`, or any other value but `ssh-docker`. Today a typo there silently selects Daytona;
  - a project without a `driver` field while the installation's default was Daytona: `SANDBOX_DRIVER=daytona`, or `DAYTONA_API_URL` set without `SANDBOX_DRIVER`.

  At boot the bot does not start, and a one-line error names the project, the setting and the fix. At `/aven reload` the previous configuration stays active.
- **Leftover Daytona settings that move nothing log one warning at boot** and change nothing. That includes a stale Daytona default when every project names its driver.
- **Slack's `/aven status` says "Sandboxes" where it said "Daytona", and shows ⚠️ when the sandbox host cannot be reached.** Today ssh-docker's listing ignores its own exit code, so an outage reads as ✅ with every project "not created". The Teams card already says "sandboxes".
- **The release notes get a "Breaking" heading**, and this PR is the first under it.
- **The docs and templates describe one driver:**
  - `docs/sandbox-drivers.md`: the driver, the seam, moving a project, and what Daytona offered;
  - `README.md`, `CLAUDE.md`, `docs/local-dev.md`, the `.env` templates;
  - the passing mentions in other docs and comments.

  They also stop saying that an idle container costs nothing. Daytona's idle stop also ended every idle conversation's `claude` process, and nothing does that on ssh-docker (design D9).

## What does not change

- The ssh-docker driver: container names, the image (`SNAPSHOT_IMAGE` and the config's `snapshot` block keep their names), flags, sessions, housekeeping and restart recovery. Its listing only gains the exit-code check.
- The system prompt: the goldens stay byte-identical.
- The Home tab and the Teams cards.
- Every recorded chat call, except the two that carry the status word and the missing-driver-settings error, plus one new recording of the reload refusal.
- The driver interface and its contract: a warm named sandbox, exec and upload, persistent sessions that replay from the start, and the name-only delete guard.

## Out of scope

- What Daytona gave that ssh-docker lacks: idle stop, archiving, per-sandbox CPU, memory and disk limits, preview links, and a hosted API with no host to run. Design D9 names each one, and each would be its own change. The most urgent one ends idle conversations' processes. It does not depend on this change and does not wait for it.
- Any new sandbox driver.
- Renaming `SNAPSHOT_IMAGE` or the `snapshot/` directory (design D7).
- How `getSandbox` reads an unreachable host: it says "no sandbox" (design D8).
- The one advisory left after the removal (OpenTelemetry, through the error reporter, fixable within range): a separate dependency update.
- Clean-up outside the repositories an installation deploys from, such as a decommissioned Daytona server, its sandboxes and its credentials. The leftover keys an installation's first boot names are task 7.1.

## Capabilities

### New Capabilities
- `sandbox-drivers`: which driver runs a project's sandbox, how an installation selects it, and what the bot does with a setting for a driver it no longer has. A setting that would move a project is refused with the fix. One that moves nothing gets a warning and is ignored. No current spec covers sandbox drivers: `sandbox-image` covers the toolchain inside the image, and `cli-probe` only uses a driver.

### Modified Capabilities
None.

## Impact

- **Rollout: bucket 1 (bug fix or invisible improvement).** The PR body names each part (design D11):
  - **The removal and the default flip:** dead code on every installation we know of, so the risk is that of a bug fix. Every installation sets `SANDBOX_DRIVER=ssh-docker`, so the code default goes unused, and the config test pins today's shape.
  - **The status word and the listing check:** bug fixes.
  - **The refusals:** inert on every installation we know of, because no project there would move.
  - **The warnings:** one line at boot where a retired key remains.
  - There is no flag. **BREAKING** for an installation that still runs Daytona: it refuses to start and is told to stay on the last release that has the driver (design D12).
  - `docs/rollout.md` gets one ledger row and a *Retired* entry.
  - It ships in the first tag cut after the code PR has run on the canary. Prod runs an older tag and is untouched until then.
- **Code:**
  - deleted: `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts`;
  - changed: `src/config.ts`, `src/driver.ts`, `src/projects.ts`, `src/sshdocker.ts` (the listing), `src/sandboxopts.ts`, `src/netretry.ts`, `src/cli.ts` (one-line configuration errors), `src/cliprobe/sandbox.ts`, `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/slack/blocks.ts` and `src/chat/teams/cards.ts`;
  - comments in about twenty other files.
- **Tests and fixtures:**
  - new cases in `src/config.test.ts`, `src/projects.test.ts`, `src/sshdocker.test.ts` and the cliprobe tests, and a new `src/driver.test.ts`;
  - two Slack recordings re-captured on purpose, and one new.
- **Dependencies and CI:**
  - the SDK and its 159 lockfile entries leave, and so does the Dependabot ignore entry; `npm audit` goes from 30 advisories to 1;
  - `.github/release.yml` gains the *Breaking* category.
- **Config:**
  - the Daytona-only keys are retired and only warn;
  - a configuration that would move a project off Daytona is refused.
- **Docs:** listed in tasks.md, groups 4 and 5.
