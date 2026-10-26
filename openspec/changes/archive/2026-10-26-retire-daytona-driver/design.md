## Context

See proposal.md (Why). The code as it stands on `main` (62876bb, which has `sandbox-idle-stop`, merged as 2c309ff and shipped in v0.42.0, and both halves of `multi-driver-installation`, #76 and #78):
- **The selection.** `src/driver.ts` defines the `SandboxDriver` interface and `createDriver(cfg, kind)`. `kind` is the project's `driver` field, or else `SANDBOX_DRIVER`, whose code default is `daytona`. Only the exact string `ssh-docker` selects ssh-docker: `daytona`, nothing at all, or a typo in a project's `driver` field selects Daytona. `loadConfig` checks `SANDBOX_DRIVER` against the two names and throws on anything else; the project field is not checked when the configuration loads.
- **The settings.** `loadConfig` builds a Daytona block when `DAYTONA_API_URL` is set, requires `SNAPSHOT_NAME` unless the default driver is ssh-docker, and reads `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK` for the Daytona snapshot only. `SNAPSHOT_IMAGE` is the image of every ssh-docker container. `SANDBOX_AUTOSTOP_MINUTES` sets the bot's idle stop of ssh-docker containers (`sandbox-idle-stop`).
- **The listing.** ssh-docker's `listStates` does not check the exit code of its `docker ps`, so an unreachable host or a stopped Docker daemon reads as an empty listing: `/aven status` shows `Daytona ✅` and every project "not created".
- **The installations.** Home, staging and prod set `SANDBOX_DRIVER=ssh-docker` and no `DAYTONA_*` key, and all twelve of their projects run on ssh-docker. The repository went public on 2026-10-16 and has 1 star and 0 forks.
- **This change's first version** (proposed 2026-10-19, decided 2026-10-20) removed the same code and added machinery for an unknown Daytona installation: a refusal of a project without a `driver` field under a Daytona default inferred from `SANDBOX_DRIVER=daytona` or `DAYTONA_API_URL`, at boot, at `/aven reload` and in `orch sources`; a boot warning naming every leftover setting; a configuration error class that `orch` printed as one line, without a stack, kept from the error reporter; a *Breaking* release category and label. The maintainer cut all of it on 2026-10-26, for one rule (D3).

## Goals / Non-Goals

**Goals:**
- No Daytona code, dependency or setting is left; the rule's message and history stay.
- A configuration that already says ssh-docker sees no change except one word in Slack's `/aven status`, and the tests prove it. The other visible change is a ⚠️, with each project's sandbox "unknown", while the sandbox host cannot be listed.
- No project is moved to a new sandbox on a guess: a setting that names another driver stops the load.
- The seam for another driver stays, and it is documented.

**Non-Goals:**
- Help for a Daytona installation beyond the boot error and the retired note (D3).
- New ssh-docker capabilities, such as CPU and memory limits.
- Requiring `SSHDOCKER_HOST` at boot: a missing host keeps failing at the first sandbox use.

## Decisions

### D1. The driver goes at once; v0.42.0 is the last release with it
The driver, its SDK, its script and its settings leave in one pull request, with no deprecation release. An installation that still runs Daytona stays on v0.42.0 until its projects run on ssh-docker; the boot error and the retired note in `docs/sandbox-drivers.md` name that release.

**Alternative.** A deprecation release: warn when Daytona is selected, remove the driver one release later.

**Why not.** No installation we operate runs Daytona, and nobody else is known to. The SDK is pinned to a frozen server and deprecated upstream, and a release that keeps it keeps 13 of the 18 `npm audit` advisories (26 of the 31 vulnerable packages, 2026-10-26). The boot error is the deprecation notice.

### D2. ssh-docker is the only driver and the default; what stays
When neither `SANDBOX_DRIVER` nor the project's `driver` is set, the project runs on ssh-docker; an empty `SANDBOX_DRIVER` counts as unset, as it does today, and a JSON `null` field as absent. These stay:
- **`SandboxDriver` and `createDriver(cfg, kind)`**, with `kind` unread: the bot and its tests program against the interface, and a second driver brings the switch back. `stopSandbox` stays optional: a driver whose provider stops idle sandboxes itself needs none.
- **`SANDBOX_DRIVER` and the project `driver` field, both optional.** The templates, the docs and the `manage-project` skill still write `SANDBOX_DRIVER=ssh-docker` and `"driver": "ssh-docker"`: v0.42.0 and every earlier release default to `daytona`, so the written line keeps a rollback safe.
- **`SANDBOX_AUTOSTOP_MINUTES` and `Config.sandbox.autoStopMinutes`**: the idle stop of ssh-docker containers reads them.
- **`SNAPSHOT_IMAGE`, `snapshot/` and `Config.snapshot.image`**, under their Daytona-era names: every installation sets the variable, and a rename changes no behaviour. The block loses `name`, `cpu`, `memory` and `disk`.
- **`src/netretry.ts`** (the Teams connector retries through it, Slack renders errors with its `stackHead`), the name-only delete guard (`assertDeletable`), the CLI probe's `echo` record kind, and the contract that a session's tail replays its log from the start: none of them is Daytona's alone.

**Alternative.** Require `SANDBOX_DRIVER=ssh-docker` and refuse to start without it, which guarantees the line a rollback needs.

**Why not.** A mandatory setting with one legal value is ceremony for every new installation; the templates already write the line.

### D3. One rule for a driver setting
The maintainer's decision of 2026-10-26:
- **`SANDBOX_DRIVER`**: unset, empty or `ssh-docker` gives ssh-docker. Any other value stops the boot with one sentence, `SANDBOX_DRIVER=<value>: the Daytona driver was removed after v0.42.0; ssh-docker is the only sandbox driver`, thrown by `loadConfig` as `main` throws for this check today: an error at boot, logged with its stack, exit 1. The check is a pure helper, `sandboxDriverEnv`, beside the other environment helpers in `src/config.ts`.
- **A project's `driver`**: absent or `null` gives the installation's driver; `ssh-docker` gives ssh-docker. Any other value — `daytona`, a typo, an empty string, a number — fails `loadProjects` with `<file>: project "<slug>" driver "<value>": ` and the same words, through its existing validation, as an invalid `gitFlow` does: at boot the bot does not start, `/aven reload` replies with the error and keeps the previous configuration, and the `orch sources` commands fail. Until now a typo there selected Daytona without a word.
- **Nothing else.** `DAYTONA_*`, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK` are not read, and no warning names them.
- The CLI probe's sandbox transport keeps requiring `SANDBOX_DRIVER` in its own environment, and now accepts only `ssh-docker`.

**Alternatives (this change's first version).**
- (a) Refuse a project without a `driver` field under a Daytona default inferred from `SANDBOX_DRIVER=daytona`, or from `DAYTONA_API_URL` without `SANDBOX_DRIVER`, at boot, at `/aven reload`, in `orch sources` and in the sources daemon.
- (b) Warn once at boot about every leftover setting, after the projects configuration loads.
- (c) A configuration error class that `orch` prints as one line, without a stack, and keeps from the error reporter.

**Why not.** Each guards an installation that does not exist, and each brought its own code, tests and recordings. The case (a) caught — an installation that ran Daytona only through `DAYTONA_API_URL`, never naming it — now starts on ssh-docker and fails its first turn with an error naming `SSHDOCKER_HOST`, or, with a host set, gets new, empty containers. No installation has that shape: each sets `SANDBOX_DRIVER=ssh-docker`. The explicit form, `SANDBOX_DRIVER=daytona`, is refused. The stack under a boot error is what every other configuration error at boot prints today.

### D4. `/aven status` while the sandbox listing fails
- Slack's health line reads `_Sandboxes ✅ · GitHub ✅ · Slack ✅_`; `StatusReport.daytonaOk` becomes `sandboxesOk`. The Teams card already says `sandboxes`. The flag reports whether the sandbox listing answered, and on every installation that listing is ssh-docker's, so "Daytona" is wrong wherever it shows: correcting it is a bug fix.
- ssh-docker's listing fails when its command exits non-zero — ssh's 255 when the host cannot be reached, docker's 1 when its daemon is down — and the error carries the tail of its stderr. The verdict is a pure helper (`listingStates`), pinned in `src/sshdocker.test.ts`. The CLI probe's leftover sweep reads the same listing, so it now fails early with the real cause.
- While the listing fails, each project's sandbox reads "unknown" (Slack `⚠️ unknown`, the Teams card `unknown`), never "not created", and the bot's journal gets the listing's error. Since the idle stop, "stopped" is a sandbox's normal state: an outage that read "not created" would report every sleeping sandbox as missing.
- `src/fixtures/chat/commands/status.json` is re-captured: its twin's listing fails, so it pins the new word and the "unknown" lines. `getSandbox` still reads an unreachable host as "no sandbox" (out of scope): `/aven memory live` then says there is no sandbox yet, and housekeeping skips the project.

### D5. The lockfile: the SDK out, OpenTelemetry hoisted at 0.214.0
- Removing `@daytonaio/sdk` takes the lockfile from 417 packages to 258: 159 entries are removed and none are added. Two versions change: `@opentelemetry/instrumentation` and `@opentelemetry/api-logs`, which `main` resolves at 0.217.0 through the SDK's tree, are hoisted at 0.214.0, the version `@sentry/node` pins.
- **`npm uninstall` is not enough.** It leaves those two nested under `@sentry/node`, where `@sentry/node-core` cannot find them: it imports `@opentelemetry/instrumentation` as an optional peer, which npm does not install. A clean `npm ci` then cannot load the error reporter, and the tests, the CLI probe's check and `orch` itself fail. Dropping the two nested entries and running `npm install --package-lock-only` hoists them, with `package.json` unchanged. A worktree inside a checkout hides the fault, because Node falls back to the checkout's own `node_modules`, so the check runs in a clean clone.
- The lockfile is byte-identical to #67's as reviewed (bd21964); `package.json` and the lockfile are unchanged on `main` since 2c309ff, so nothing had to be resolved again.
- The hoisted packages load at run time only where an error-reporter DSN is set. Home has none and staging has one, so staging confirms that the error reporter still sends events before the tag (task 7.2).
- `.github/dependabot.yml` loses its `ignore` block and keeps "security updates only, no version-update PRs"; with no exception left, security updates cover the whole tree. CI keeps its steps: nothing in it depends on the SDK.

### D6. The idle-stop spec delta
The main spec `sandbox-idle-stop` (created when that change was archived, 2026-10-26) names Daytona as a current driver in *An idle project container is stopped*: the clause "A project on a driver whose provider stops idle sandboxes itself (Daytona) SHALL NOT be stopped by the bot", the comparison "as it did on Daytona", and the scenario *A Daytona project*. Once a configuration that names Daytona is refused (D3), that scenario cannot happen.

So this change carries a MODIFIED delta for that requirement, copied from the main spec with three differences:
- the clause loses "(Daytona)": it is the seam's case (D2), and `src/idlestop.test.ts` covers a driver kind without `stopSandbox` under a neutral name;
- the comparison goes;
- the scenario *A Daytona project* keeps its name, because OpenSpec (1.14) refuses a MODIFIED block that drops a scenario, and now says that such a configuration is refused when it loads; a scenario for a driver whose provider stops its own sandboxes is added.

The spec's Purpose ("the way Daytona's idle stop did") and the title *A wake restores what a Daytona start restored* are history, and stay.

### D7. Docs, templates and the ledger
- `docs/sandbox-drivers.md` keeps its file name, so every link still works: ssh-docker; *Selecting the driver* (the rule, and why the templates still write `SANDBOX_DRIVER=ssh-docker`); *Looking inside a container*; *Adding a driver* (the contract); and a short *Retired: Daytona* note.
- `README.md`, `CLAUDE.md`, `SECURITY.md`, `docs/local-dev.md`, both `.env` templates, the `manage-project` skill, the image comments and the passing mentions in other docs describe one driver. The dated notes (`docs/stream-json-contract.md`, `docs/memory.md`, the 2026-07 option analysis in `docs/multitenancy.md`) stay as history.
- Bucket 1, no flag (proposal, Impact). `docs/rollout.md` gets a ledger row and a *Retired* entry for the Daytona settings. The release notes need no category of their own.

## Risks / Trade-offs

- **[Someone still runs Daytona]** → The boot error says the driver was removed after v0.42.0; the retired note says to stay on that release until the projects run on ssh-docker. Nothing on their side is deleted.
- **[An installation that ran Daytona only through `DAYTONA_API_URL`]** → It would start on ssh-docker: its first turn fails naming `SSHDOCKER_HOST`, or, with a host set, its projects get new, empty containers. No installation has that shape (D3).
- **[A rollback to v0.42.0]** → v0.42.0 defaults to `daytona`. It stays safe while `SANDBOX_DRIVER=ssh-docker` is set, as every installation's `.env` and both templates have it (task 8.1).
- **[The error reporter after the hoist]** → Only installations with a DSN load it, and the home canary has none: staging checks it before the tag (D5).
- **[Users read a new word in `/aven status`, or a ⚠️ during an outage]** → "Sandboxes" reports the same check that "Daytona" did. The ⚠️ is the truth that ✅ hid, and "unknown" the truth that "not created" hid.
- **[A re-captured fixture hides a slip]** → Two fixtures are re-captured, and their diff is one line each. Every other recording stays byte-identical.

## Migration Plan

1. One pull request: spec, code, docs and the ledger, merged once CI is green.
2. Home, the canary, in one step: stop the bot and the sources daemon, pull, `npm ci`, start both. Its boot logs no new warning and the same idle-stop minutes as before, and `/aven status` shows `Sandboxes ✅` (task 7.1).
3. Staging: deploy `main`, and confirm that the error reporter still sends events (task 7.2).
4. Before the tag, each installation keeps `SANDBOX_DRIVER=ssh-docker`, and every project's `driver` is absent or `ssh-docker` (task 8.1).
5. The change is archived after the merge (task 7.3).

**Rollback:** revert the pull request, then `npm ci` (the earlier code imports the SDK). Nothing on disk or in `state.json` changes shape, and the sandboxes are untouched. Rolling back to v0.42.0 is safe while `SANDBOX_DRIVER=ssh-docker` stays set (D2).

## Open Questions

None.
