# Proposal

> **Status: proposed 2026-10-19, for review.** Decision taken: the Daytona sandbox driver leaves the product, and ssh-docker becomes the only driver. Each decision in design.md comes with its alternative and stays open until the review settles it. Then the change goes out as a spec-only PR, and the code follows in its own PR.

## Why

The Daytona driver has no users left. Every installation we know of runs its projects on ssh-docker. The last one moved its projects on 2026-10-19 and deleted its self-hosted Daytona the same day. What remains is dead code that every reader of the sandbox path has to skip, plus a dependency the project cannot maintain:
- `@daytonaio/sdk` is pinned to match a self-hosted server whose code was frozen in 06/2026, and Dependabot is told to ignore it. Upstream has since deprecated the package under that name.
- Its subtree makes up 159 of the lockfile's 417 entries: the AWS S3 client, gRPC, the OpenTelemetry exporters and more. `npm audit` reports 30 advisories in the lockfile (19 high). 29 of them come through the SDK and leave with it. For several of them, the only fix npm offers is a newer SDK, which the pin rules out.
- The code default is still `daytona`, so an installation that sets nothing gets a driver nobody runs. The docs, the templates and Slack's `/aven status` still present Daytona as current.

## What Changes

- **Removed. BREAKING for an installation that still runs Daytona:**
  - the driver (`src/daytona.ts`), its test, and the operator script `scripts/peek-sandbox.ts`;
  - `@daytonaio/sdk` and its 159 lockfile entries, and Dependabot's ignore entry for it;
  - the settings only Daytona read: `DAYTONA_API_URL`, `DAYTONA_API_KEY`, `DAYTONA_ORGANIZATION_ID`, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`;
  - the Daytona-only pieces of shared code: the SDK's error name in the network retry, and an options check only the driver used;
  - the Daytona blocks of the `.env` templates, and the example project that names Daytona.
- **ssh-docker is the only driver, and the default.** `SANDBOX_DRIVER` and a project's `driver` field stay optional and accept only `ssh-docker`. The driver interface stays as the seam for a future driver.
- **A configuration that still selects Daytona is refused. The bot never moves a project for it:**
  - `SANDBOX_DRIVER=daytona`, or a project with `"driver": "daytona"`, stops the bot at boot. The error names the setting and the fix. At `/aven reload` the previous configuration stays active.
  - Any other unknown value is refused the same way. Today a typo in a project's `driver` silently selects Daytona.
  - `DAYTONA_API_URL` set without `SANDBOX_DRIVER` stops the bot at boot. Under that configuration, projects without a `driver` field ran on Daytona, and starting would move them to new sandboxes.
- **Leftover Daytona-only settings log one warning at boot** and change nothing.
- **Slack's `/aven status` says "Sandboxes" where it said "Daytona".** The flag reports whether the sandbox listing answered, and that listing is ssh-docker's everywhere. The Teams card already says "sandboxes".
- **The docs and templates describe one driver:**
  - `docs/sandbox-drivers.md`: the driver, the seam, moving a project, and what Daytona offered;
  - `README.md`, `CLAUDE.md`, `docs/local-dev.md`, the `.env` templates;
  - the passing mentions in other docs.

## What does not change

- The ssh-docker driver: container names, the image (`SNAPSHOT_IMAGE` keeps its name), flags, sessions, housekeeping and restart recovery.
- The system prompt: the goldens stay byte-identical.
- The Home tab and the Teams cards.
- Every recorded chat call, except the two that carry the status word and the missing-driver-settings error.
- The driver interface and its contract: a warm named sandbox, exec and upload, persistent sessions that replay from the start, and the name-only delete guard.

## Out of scope

- What Daytona gave that ssh-docker lacks: idle stop, archiving, per-sandbox CPU, memory and disk limits, preview links, and a hosted API with no host to run. Design D9 names each one; each would be its own change.
- Any new sandbox driver.
- Renaming `SNAPSHOT_IMAGE` or the `snapshot/` directory (design D7).
- The one advisory left after the removal (OpenTelemetry, through the error reporter, fixable within range): a separate dependency update.
- Each operator's own clean-up, such as leftover keys in an `.env` or what is left on a decommissioned server. That belongs to the operator's own plan.

## Capabilities

### New Capabilities
- `sandbox-drivers`: which driver runs a project's sandbox, how an installation selects it, and what the bot does with a setting for a driver it no longer has. Such a setting is either refused with the fix or warned about and ignored. No current spec covers sandbox drivers: `sandbox-image` covers the toolchain inside the image, and `cli-probe` only uses a driver.

### Modified Capabilities
None.

## Impact

- **Rollout: bucket 1.** This removes dead code, with the risk of a bug fix. It is default-preserving for every configuration that already selects ssh-docker:
  - Every installation we know of sets `SANDBOX_DRIVER=ssh-docker`, gives every project `"driver": "ssh-docker"` and has no `DAYTONA_*` key. For them only the status word changes, plus one boot warning where a leftover key remains.
  - Tests prove today's shape. Such a configuration loads without a warning and gives every project the ssh-docker driver. The prompt goldens and every other recorded chat call stay byte-identical.
  - There is no flag. The refusals fire only on a configuration that cannot work once the driver is gone.
  - **BREAKING** for an installation that still runs Daytona. It refuses to start and is told to stay on the last release that has the driver (design D12).
  - `docs/rollout.md` gets one ledger row and a *Retired* entry.
  - It ships in the first tag cut after the code PR has run on the canary. Prod runs an older tag and is untouched until then.
- **Code:**
  - deleted: `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts`;
  - changed: `src/config.ts`, `src/driver.ts`, `src/projects.ts`, `src/sandboxopts.ts`, `src/netretry.ts`, `src/cliprobe/sandbox.ts`, `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/slack/blocks.ts` and `src/chat/teams/cards.ts`;
  - comments in about fifteen other files.
- **Tests and fixtures:** new cases in `src/config.test.ts` and `src/projects.test.ts`, and a new `src/driver.test.ts`. Two recorded Slack fixtures are re-captured on purpose.
- **Dependencies and CI:** the SDK and 159 lockfile entries leave, and so does the Dependabot ignore entry. `npm audit` goes from 30 advisories to 1.
- **Config:** the eight Daytona-only keys are retired and only warn. `SANDBOX_DRIVER=daytona`, a project's `"driver": "daytona"`, and `DAYTONA_API_URL` without `SANDBOX_DRIVER` are refused.
- **Docs:** listed in tasks.md, groups 4 and 5.
