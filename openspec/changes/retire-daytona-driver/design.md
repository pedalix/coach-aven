## Context

See proposal.md (Why). This is the code as it stands, against origin/main at 2fab1da:
- **The selection.** `src/driver.ts` defines the `SandboxDriver` interface and `createDriver(cfg, kind)`. `kind` is the project's `driver` field, or else `SANDBOX_DRIVER`, whose code default is `daytona`. Only the exact string `ssh-docker` selects ssh-docker. Anything else that reaches `createDriver` selects Daytona: `daytona`, nothing at all, or a typo in a project's `driver` field. `loadConfig` checks `SANDBOX_DRIVER` against the two names, but the project field is not checked when the configuration loads.
- **The settings.** `loadConfig` (`src/config.ts`):
  - builds the Daytona block when `DAYTONA_API_URL` is set, and then requires the key and the organization;
  - requires `SNAPSHOT_NAME` unless the default driver is ssh-docker;
  - always requires `SNAPSHOT_IMAGE`, which is the image of every ssh-docker container.

  `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK` feed only the Daytona snapshot's resources, and `SANDBOX_AUTOSTOP_MINUTES` only Daytona's idle stop. A driver with missing settings throws at the project's first sandbox use, not at boot.
- **Who reads them.**
  - `loadConfig` also runs for `orch sources …`.
  - The warnings for retired settings (`retiredEnvWarnings`, from `retire-agent-dispatch` D4) run only in `orch slack` and `orch teams`.
  - A failed `/aven reload` replies with the error, and the previous configuration stays active.
- **The installations.** Every installation we know of selects ssh-docker explicitly, both installation-wide and per project, and has no `DAYTONA_*` key. One of them still sets `SANDBOX_AUTOSTOP_MINUTES`, which ssh-docker already ignores.

**Inventory.** 239 lines in 71 files say "daytona". Another 87 lines carry Daytona-only concepts without saying it.

| Kind | Where | What happens |
|---|---|---|
| Delete | `src/daytona.ts` (231 lines), `src/daytona.test.ts`, `scripts/peek-sandbox.ts` | gone |
| Delete | `@daytonaio/sdk` in `package.json` and `package-lock.json`; the Dependabot ignore entry | gone |
| Delete | in `.env.example` and `infra/deploy/ops.example/.env.example`: the Daytona block, `SNAPSHOT_NAME`, `SANDBOX_CPU`/`_MEMORY`/`_DISK`/`_AUTOSTOP_MINUTES` | gone |
| Delete | acme-shop's `"driver": "daytona"` in `projects.config.example.json` | gone |
| Delete | `isDefaultSandbox` (`src/sandboxopts.ts`), the `DaytonaConnectionError` check (`src/netretry.ts:39`), the snapshot hint (`snapshot/build-and-push.sh:97`) | gone |
| Delete | in tests: the `DAYTONA_*` env juggling in `src/chat/slack/commands.record.test.ts`, `autoStopMinutes` in seven config stubs, `SNAPSHOT_NAME` in `src/chat/teams/config.test.ts` | gone |
| Simplify | `src/config.ts`, `src/driver.ts`, `src/projects.ts`, `src/cliprobe/sandbox.ts` | one driver |
| Simplify | `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/teams/cards.ts` (`daytonaOk` becomes `sandboxesOk`); `src/netretry.test.ts` | neutral names |
| Simplify | comments in about fifteen files: `claudeSession.ts`, `tasks.ts`, `state.ts`, `pollers.ts`, `sshdocker.ts`, the "no Slack/Daytona deps" headers and others | neutral wording |
| Visible text | Slack's `/aven status` health flag (`src/chat/slack/blocks.ts:721`); the missing-driver-settings error a user can meet in `/aven memory live` | `status.json` and `memory-live-no-sandbox.json` re-captured |
| Docs | `docs/sandbox-drivers.md` (rewrite), `docs/local-dev.md`, `README.md`, `CLAUDE.md`, `SECURITY.md` | one driver |
| Docs | `docs/{README,how-we-work,why,sources,observability,runtime-config,cli-probe,stream-json-contract,memory,housekeeping,multitenancy}.md` | one driver |
| Docs | `infra/deploy/{README.md,deploy.sh,coach-aven.service.tmpl}`, `snapshot/{Dockerfile,plain/Dockerfile,build-and-push.sh}`, the `manage-project` skill, the package description | one driver |
| History | `openspec/changes/archive/*` (14 lines); the ledger rows in `docs/rollout.md` | unchanged |
| History | the dated notes in `docs/stream-json-contract.md:11` and `docs/memory.md:114`; the 2026-07 option analysis in `docs/multitenancy.md` | unchanged |
| In-flight | `agent-messaging` (D12/D13, task 0.2), one sentence of `agent-skills`' design | no edit (D14) |

Unaffected:
- the prompt goldens: the base prompt varies by `gitFlow` and `sandbox.dind`, never by driver;
- the Home tab;
- the text of the Teams cards;
- the CLI recordings: transport `local` only.

## Goals / Non-Goals

**Goals:**
- No Daytona code, dependency or setting is left. No doc or template presents Daytona as current. History stays history.
- A configuration that already selects ssh-docker sees no change except one word in Slack's `/aven status`, and the tests prove it.
- No project moves to a new sandbox because of this change unless its operator edits the configuration.
- The seam for another driver stays, and it is documented.

**Non-Goals:**
- New ssh-docker capabilities (D9).
- Requiring `SSHDOCKER_HOST` at boot. A missing host keeps failing at the first sandbox use, as it does today.

## Decisions

### D1. What goes, what stays
Everything in the inventory's Delete rows goes. These stay:
- **`SandboxDriver` and `createDriver`.** The bot and its tests program against the interface (D6).
- **The name-only delete guard (`assertDeletable`).** The `cli-probe` spec requires it, whatever a driver's listing holds.
- **`src/netretry.ts`.** The Teams connector retries through it, and Slack renders errors with its `stackHead`.
- **The probe's `echo` record kind, and the rule that only the CLI's own `isReplay` echo confirms delivery.** No transport copies stdin today. The rule holds for any transport, and keeping it costs nothing.
- **The `started` and `stopped` state words** that ssh-docker maps containers to. `/aven status` renders them.
- **The tail that replays a session's log from the start.** ssh-docker does it too, so `ClaudeSession`'s skip-prefix logic stays. Only the comment that credits Daytona with it changes.
- **`SNAPSHOT_IMAGE` and `snapshot/`** (D7).

### D2. The default driver is ssh-docker
**Recommendation.** When neither `SANDBOX_DRIVER` nor the project's `driver` is set, the project runs on ssh-docker.
**Alternative.** Require `SANDBOX_DRIVER=ssh-docker`, and refuse to start without it.
**Why.** There is nothing left to choose, and a mandatory setting with one legal value is ceremony for every new installation. The one risky case is an installation that ran Daytona by default. D4 catches it; a mandatory setting is not needed for that.

### D3. A setting that names Daytona is refused, at boot and at reload
**Recommendation.**
- `SANDBOX_DRIVER=daytona` stops the bot at boot.
- A project's `"driver": "daytona"` stops it at boot, and fails `/aven reload` with the previous configuration kept.
- The error names the setting: the variable, or the project and its field. It says the driver was removed and names the fix: move the project to ssh-docker and change or drop the setting, or keep running the last release that has the driver.
- Any other value is refused the same way, naming the one accepted value. Today a typo in a project's `driver` silently selects Daytona, so this also fixes a latent bug.

**Alternatives.**
- (a) Warn, and run the project on ssh-docker.
- (b) Load the configuration, and fail at the project's first turn, as a missing driver setting does today.

**Why.**
- (a) would move a project to a new, empty sandbox without anyone choosing it. The repos are cloned again. What lived only in the old sandbox stays behind: worktrees and uncommitted work, memory not yet journaled, Sail databases, and the Claude session files that `--resume` needs. The house rule is to fail loudly on a setting that would change behaviour, as the `gitFlow` check does.
- (b) keeps the other projects up. But the failure then reaches users in a channel, maybe days later, instead of reaching the operator at deploy. The deploy's health check shows the error within a minute.
- A reload never takes the bot down, because it keeps the previous configuration.
- Every command that loads the projects configuration refuses it, the sources commands included, as for any invalid project field today.

### D4. Daytona by default is stopped, not moved
**Recommendation.** `loadConfig` refuses when `SANDBOX_DRIVER` is unset and `DAYTONA_API_URL` is set. Under that configuration, every project without a `driver` field ran on Daytona.
**Alternative.** Only warn (D5), and let the new default apply.
**Why.**
- With D2 alone, such an installation would start anyway:
  - where `SSHDOCKER_HOST` is set (a fleet that mixed drivers), its default projects would move to new containers at their next turn;
  - where it is not set, every turn would fail with an error about `SSHDOCKER_HOST` that never mentions Daytona.
- Together, D3 and D4 catch every way a project ran on Daytona:
  - an explicit project field (D3);
  - an explicit installation default (D3);
  - the implicit default (D4). The default could only reach a working Daytona when `DAYTONA_API_URL` was set.
- The cost is a false positive. An installation whose projects all name ssh-docker, but which kept the URL and set no `SANDBOX_DRIVER`, refuses to start. The fix is one line, and the error names it.
- `loadConfig` also runs for `orch sources …`, so those commands refuse the same environment. The operator fixes one `.env` for both.

### D5. Leftover Daytona-only settings warn once at boot
**Recommendation.** Nothing reads these eight settings any more: `DAYTONA_API_URL`, `DAYTONA_API_KEY`, `DAYTONA_ORGANIZATION_ID`, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`. `retiredEnvWarnings` adds one line that names the ones present, for example `config: SANDBOX_AUTOSTOP_MINUTES is retired with the Daytona sandbox driver and changes nothing — remove it`. `orch slack` and `orch teams` log it. D4 is the one exception.
**Alternatives.** Ignore them silently, or refuse to start.
**Why.**
- They change nothing: ssh-docker already ignores the last five.
- Refusing would stop a healthy installation. One installation we know of still sets `SANDBOX_AUTOSTOP_MINUTES`.
- Silence would leave dead keys in `.env` files forever.
- One warning reaches the operator, as `retire-agent-dispatch` D4 did for `DISPATCH`.

### D6. The seam stays; the docs present one driver
**Recommendation.** Keep:
- the `SandboxDriver` interface and `createDriver(cfg, kind)`;
- `SANDBOX_DRIVER` and the project `driver` field, both optional, both accepting only `ssh-docker` (`SandboxDriverKind = 'ssh-docker'`).

`docs/sandbox-drivers.md` keeps its file name, so every link to it still works. It becomes:
- **ssh-docker:** host prerequisites, local mode, project options, how it maps, and the dated verification history;
- **Selecting the driver:** both settings are optional and take one value; what a removed or unknown value does;
- **Moving a project to ssh-docker:** it gets a new sandbox; what does not carry over (D3);
- **Inspecting a sandbox:** the `docker exec` line (D13);
- **Adding a driver:** the contract in `src/driver.ts`:
  - a warm named sandbox;
  - exec and upload;
  - persistent sessions whose tail replays from the start;
  - a listing;
  - the name-only delete guard;

  one file per driver, and no provider SDK outside it;
- **Retired: Daytona:** removed by this change, the last release that has it, and what it offered (D9).

**Alternative.** Retire both settings: accept only `ssh-docker`, with a warning. `createDriver(cfg)` loses its `kind`, and the `driver` plumbing leaves `tasks.ts`, `turn.ts`, `pollers.ts` and `commands.ts`. A future driver would bring its own selection back.
**Why.**
- Every installation we know of sets both settings explicitly. Retiring them would turn valid configurations into warnings for no gain.
- Selection is the first thing a second driver needs, and the plumbing is a few lines.
- The interface itself is not in question. It keeps the bot provider-ignorant, and it is what the tests fake.

### D7. `SNAPSHOT_IMAGE` and `snapshot/` keep their names
**Recommendation.** The variable and the directory keep their Daytona-era names. In the code, the `snapshot` block of `Config` loses `name`, `cpu`, `memory` and `disk`, and becomes `sandbox.image`.
**Alternative.** Rename them to `SANDBOX_IMAGE`, with `SNAPSHOT_IMAGE` as a deprecated alias, and `snapshot/` to `images/`.
**Why.** Every installation sets `SNAPSHOT_IMAGE`, and the build script, the docs and the operators all use `snapshot/`. A rename changes no behaviour and costs every operator an edit. If it is ever wanted, it is its own change.

### D8. `/aven status` says "Sandboxes"
**Recommendation.** Slack's health line reads `_Sandboxes ✅ · GitHub ✅ · Slack ✅_`, and `StatusReport.daytonaOk` becomes `sandboxesOk`. The Teams card already says `sandboxes`.
**Alternative.** Keep the word byte-identical in this change, and rename it in a separate PR.
**Why.**
- The flag reports whether the sandbox listing answered. On every installation we know of, that listing is ssh-docker's, so "Daytona" is wrong today wherever it shows. Correcting the label is a bug fix.
- `/aven status` is a viewer verb, so users see the new word.
- The Home tab's line ("a live view of sandboxes…") was already right and does not change.
- The re-captured `status.json` pins the new word.

### D9. What Daytona gave that ssh-docker lacks: out of scope, named
| Daytona | ssh-docker today | Its own change? |
|---|---|---|
| Idle stop (`SANDBOX_AUTOSTOP_MINUTES`, 30 minutes by default): an idle sandbox stopped, and any Sail stack inside it with it | A container runs until its host stops it. The driver already wakes a stopped container at the next turn. | Only when a sandbox host's memory becomes the limit. Even then it is a housekeeping rule (stop a container idle for N hours), not a driver feature. |
| Archiving: long-stopped sandboxes moved off the runner, restored on start | A stopped container keeps its disk. | No. Disk on a host you own is cheap, and housekeeping's prune and worktree reap bound the growth. |
| Per-sandbox CPU, memory and disk (`SANDBOX_CPU`, `_MEMORY`, `_DISK`) | No limits: one runaway build can starve the host. An operator can create a container with limits by hand. The driver keeps an existing container's flags, but recreates it without the limits. | Yes, for CPU and memory, as a small change: `sandbox.resources` per project becomes `docker run --cpus/--memory`, at creation only, like the other options. Not for disk: Docker has no portable per-container quota. Watch the host's disk instead. |
| Preview links to a port inside the sandbox | None | No. The product never used them. |
| A hosted API and dashboard, with no host to run | A Docker host the operator runs, which may be the bot's own | Only as a new driver behind the seam, once an installation needs one. |
| Many runners behind one API | One host per installation (`SSHDOCKER_HOST`) | Only when one host is not enough; then a host per project. |

### D10. Dependencies, CI and Dependabot
**What the pin did.** It held `@daytonaio/sdk` at the version that matched the self-hosted server, because a newer SDK may call API that the frozen server lacks. Dependabot was told to ignore the package, security updates included. So an advisory whose only fix is a newer SDK could not be fixed. Upstream has meanwhile deprecated the package under that name.

**After.**
- `npm uninstall @daytonaio/sdk` takes the lockfile from 417 entries to 258. 159 are removed, none are added, and no version changes; this was checked on a copy.
- `npm audit` goes from 30 advisories (19 high, 11 moderate) to 1 moderate. The one left is OpenTelemetry core, through the error reporter, fixable within range, and a separate update.
- `.github/dependabot.yml` loses its `ignore` block and keeps "security updates only, no version-update PRs". With no exception left, security updates cover the whole tree.
- CI keeps its steps. Nothing in it depends on the SDK, and `npm ci` stops printing the SDK's deprecation warning.

**Alternative.** Delete `.github/dependabot.yml`. Without the ignore entry, the file changes nothing that the repository settings don't already do.
**Why keep it.** It states the policy where readers look for it, and an ignore entry can come back later without deciding the policy again.

### D11. Bucket, proof, ledger, release order
**Bucket.** Bucket 1: removal of dead code, with the risk of a bug fix. It is default-preserving for every configuration that selects ssh-docker. There is no flag: the refusals (D3, D4) fire only where the configuration cannot work once the driver is gone.

**Alternative.** Bucket 3: keep the driver for one release behind a flag that is off by default, and remove it after the canary.
**Why not.** A flag over code that no installation runs has nothing to canary. A Daytona installation gets the same chance to stay on the previous release from the refusals and the release note (D12).

**Proof of today's prod shape:**
1. `src/config.test.ts`: an environment with `SANDBOX_DRIVER=ssh-docker`, `SSHDOCKER_HOST`, `SNAPSHOT_IMAGE` and no Daytona key loads with the same driver, host, runtime, image, work directory and name prefix as before. `retiredEnvWarnings` returns nothing for it.
2. `src/projects.test.ts`: a registry in which every project names ssh-docker loads without a warning.
3. A new `src/driver.test.ts`: `createDriver` returns the ssh-docker driver, with and without a `kind`.
4. `src/sshdocker.test.ts` is unchanged: the scripts the driver runs are byte-identical.
5. The prompt goldens are unchanged.
6. Every recorded chat call is unchanged, except two. `status.json` changes by one word. `memory-live-no-sandbox.json` changes because the twin has no driver settings.

**Ledger.**
- One row. It gives the bucket and what to watch: each installation's first boot on the tag logs no `config:` warning, or names the keys to delete; `/aven status` shows `Sandboxes`.
- A *Retired* entry for `SANDBOX_DRIVER=daytona` and the eight settings.

**Release order.**
1. The spec PR, then the code PR.
2. After the merge to `main`, the canary (the home bot, ssh-docker in local mode) runs it for two days or more.
3. It ships in the first tag cut after that, on the normal schedule.

Prod runs an older tag and is untouched until then. Nothing in this change needs an earlier tag. Before that tag, every operator checks their installation (task 7.1).

### D12. Public users and the release note
The repository has been public since 2026-10-16, so someone may run the Daytona driver: it was the code default and the first option in the quickstart. Nobody can be asked, so the release says it:
- **The PR title is the release-notes line:** "Remove the Daytona sandbox driver — ssh-docker is the only driver (Daytona installations: stay on the previous release)".
- **When the tag is cut,** one upgrade note goes at the top of the release notes: "**Daytona sandbox driver removed.** An installation that runs Daytona stays on vX.Y.Z, the last release with it, until its projects run on ssh-docker (`docs/sandbox-drivers.md` → *Moving a project*). This release refuses to start with `SANDBOX_DRIVER=daytona`, with a project's `"driver": "daytona"`, or with `DAYTONA_API_URL` and no `SANDBOX_DRIVER`. Leftover Daytona settings only warn."
- **The boot refusals (D3, D4) give the same advice,** so an operator who skips the notes still reads it.

**Alternative.** A deprecation release first: warn when Daytona is selected, and remove it one release later.
**Why not.**
- No installation we operate runs it.
- The repository has been public for three days.
- The server version the SDK is pinned to is frozen.
- A release that keeps the driver keeps the 29 advisories.
- The refusal message is the deprecation notice.

### D13. `scripts/peek-sandbox.ts` goes
**Recommendation.** Delete it. `docs/sandbox-drivers.md` and the `manage-project` skill give the ssh-docker equivalent: `ssh <SSHDOCKER_HOST> docker exec proj-<slug> sh -c '<cmd>'`, or plain `docker exec` in local mode.
**Alternative.** Rewrite it over `SandboxDriver` (`getSandbox`, then `exec`), reading an overlay's `.env`.
**Why.** On ssh-docker the operator already has a shell on the host. One documented line replaces a script that would need the bot's settings just to build a driver.

### D14. In-flight changes
- **`agent-messaging`.** D12, D13 and task 0.2 record measurements taken through the Daytona session, whose output carried a copy of stdin. They stay as records. The rule they produced holds for any transport, and it stays right on ssh-docker, whose FIFO adds no copy: only the CLI's own `isReplay` echo confirms delivery. Its spec names no transport. No edit.
- **`agent-skills`.** Its design says both drivers run the same command line, which was true when it was written. No edit. `docs/runtime-config.md`, the current doc that repeats it, is updated here.
- **Every other open change.** None assumes a sandbox driver. The "both drivers" in `teams-chat-driver` are chat drivers.
- **The main specs.** None names Daytona. The `cli-probe` spec says that "a driver's listing can include every sandbox of an account"; that stays true of drivers in general, so it needs no delta.

## Risks / Trade-offs

- **[An unknown installation still runs Daytona]** → It refuses to start, with the fix in the error (D3, D4), and the release note says to stay on the previous release. Nothing is deleted on its side: its Daytona sandboxes stay where they are.
- **[A project moved by hand loses what lived only in its sandbox]** → *Moving a project* lists what does not carry over:
  - worktrees and uncommitted work;
  - memory not yet journaled;
  - Sail data;
  - the Claude session files `--resume` needs, so old threads start fresh.

  The bot never moves a project by itself.
- **[D4 refuses an installation that is already clean]** → This happens when an installation's projects all name ssh-docker but it kept `DAYTONA_API_URL` without `SANDBOX_DRIVER`. The error names the one-line fix.
- **[The sources daemon shares the `.env`]** → It refuses the same environments as the bot (D4). The operator sees both at deploy and fixes one file.
- **[Users read a new word in `/aven status`]** → "Sandboxes" reports the same check that "Daytona" did.
- **[A hosted sandbox service is needed later]** → The seam and *Adding a driver* stay. The old driver would not be the starting point anyway: its SDK is deprecated and pinned to a frozen server.
- **[A re-captured fixture hides a slip]** → Only two fixtures change, and their diff is reviewed word by word. Every other recording stays byte-identical.

## Migration Plan

1. The spec PR (this change), after the review. It has no runtime effect.
2. The code PR, from a worktree with `/opsx:apply`, merged once CI is green. The home bot and the canary installations that follow `main` pick it up at their next restart. Watch two things:
   - no `config:` warning on the home bot;
   - the warning naming `SANDBOX_AUTOSTOP_MINUTES` on the installation that still sets it, until its operator deletes the key.
3. Each operator checks their installation before the tag (task 7.1). Then the tag, and the release note (D12).
4. The archive creates `openspec/specs/sandbox-drivers/`.

**Rollback:** revert the code PR. Nothing on disk or in `state.json` changes shape, and the sandboxes are untouched.

## Open Questions

- Which release the note names as "the last release with Daytona" is decided when the tag is cut (D12).
- Whether the CPU and memory limits change (D9) is opened now, or when a sandbox host first runs short.
