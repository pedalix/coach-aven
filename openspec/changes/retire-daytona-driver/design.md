## Context

See proposal.md (Why). This is the code as it stands against origin/main at 2fab1da, with the idle-stop fix applied (`sandbox-idle-stop`, PR #65), which goes to `main` before this change. Line numbers here and in tasks.md are that code's:
- **The selection.** `src/driver.ts` defines the `SandboxDriver` interface and `createDriver(cfg, kind)`. `kind` is the project's `driver` field, or else `SANDBOX_DRIVER`, whose code default is `daytona`. Only the exact string `ssh-docker` selects ssh-docker. Anything else that reaches `createDriver` selects Daytona: `daytona`, nothing at all, or a typo in a project's `driver` field. `loadConfig` checks `SANDBOX_DRIVER` against the two names, but the project field is not checked when the configuration loads.
- **The settings.** `loadConfig` (`src/config.ts`):
  - builds the Daytona block when `DAYTONA_API_URL` is non-empty, and then requires the key and the organization. Without that block, the Daytona driver throws at first use, so a project could reach a working Daytona only when `DAYTONA_API_URL` was set;
  - requires `SNAPSHOT_NAME` unless the default driver is ssh-docker;
  - always requires `SNAPSHOT_IMAGE`, which is the image of every ssh-docker container.

  `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK` feed only the Daytona snapshot's resources. `SANDBOX_AUTOSTOP_MINUTES` feeds Daytona's idle stop and, since `sandbox-idle-stop`, the bot's idle stop of ssh-docker containers (`autoStopMinutesEnv`). The SDK also read more `DAYTONA_*` variables straight from the environment, such as `DAYTONA_TARGET`. A driver with missing settings throws at the project's first sandbox use, not at boot.
- **Who reads them.**
  - `loadConfig` also runs for `orch sources …` and for the mirror script. `loadProjects` runs at boot, at `/aven reload` and in the `orch sources` commands.
  - The warnings for retired settings (`retiredEnvWarnings`, from `retire-agent-dispatch` D4) run only in `orch slack` and `orch teams`.
  - A failed `/aven reload` replies with the error, and the previous configuration stays active.
  - An error at boot is logged with its stack. The deploy's health check prints the last twelve journal lines.
- **What ends a session process.** Each conversation's `claude` runs as a persistent process inside the project's sandbox. The live-session LRU and the 45-day chat prune only drop the bot's reference to it. They leave the process to the sandbox's idle stop (`src/tasks.ts`, `src/turn.ts`). On Daytona that is the provider's own stop. On ssh-docker it is the bot's since `sandbox-idle-stop`: a sweep stops a project container after `SANDBOX_AUTOSTOP_MINUTES` without activity, and the next turn wakes it and resumes the conversation with `--resume` (D9).
- **The idle stop's seam.** `SandboxDriver.stopSandbox` is optional. ssh-docker implements it. Daytona does not, because its provider stops idle sandboxes itself. The sweep (`candidateList`) and housekeeping (`housekeepingSandboxStep`) treat a driver without it as one whose provider stops its sandboxes (D1).
- **The listing.** ssh-docker's `listStates` does not check the exit code of its `docker ps`. An unreachable host or a stopped Docker daemon therefore reads as an empty listing, not as a failure (D8).
- **The installations.** Every installation we know of selects ssh-docker explicitly, both installation-wide and per project, and has no `DAYTONA_*` key. An installation may still carry one of the other retired keys, which ssh-docker already ignores.

**Inventory.** At 2fab1da, 239 lines in 71 files said "daytona". Another 87 lines carried Daytona-only concepts without saying it. Thirteen of those carry `SANDBOX_AUTOSTOP_MINUTES` or `autoStopMinutes`, which the fix made ssh-docker's too, so they are no longer Daytona-only (D5). Eight more comments assumed Daytona's behaviour without naming it. The fix rewrote four of them, which now name Daytona, so four are left (task 1.9). With the fix applied, 308 lines in 82 files say "daytona". The fix added 44 of them in its own OpenSpec change (D14), and 25 in code, docs, templates and the ledger (tasks 1.2, 1.3, 1.9, 4.1, 4.2, 5.1, 5.4).

| Kind | Where | What happens |
|---|---|---|
| Delete | `src/daytona.ts` (233 lines), `src/daytona.test.ts`, `scripts/peek-sandbox.ts` | gone |
| Delete | `@daytonaio/sdk` in `package.json` and `package-lock.json`; the Dependabot ignore entry | gone |
| Delete | in `.env.example` and `infra/deploy/ops.example/.env.example`: the Daytona block, `SNAPSHOT_NAME`, `SANDBOX_CPU`/`_MEMORY`/`_DISK` | gone |
| Delete | acme-shop's `"driver": "daytona"` in `projects.config.example.json` | gone |
| Delete | `isDefaultSandbox` (`src/sandboxopts.ts`), the `DaytonaConnectionError` check (`src/netretry.ts:39`), the snapshot hint (`snapshot/build-and-push.sh:97`) | gone |
| Delete | in tests: the `DAYTONA_*` env juggling in `src/chat/slack/commands.record.test.ts`, `SNAPSHOT_NAME` in `src/chat/teams/config.test.ts` | gone |
| Keep | `SANDBOX_AUTOSTOP_MINUTES` and `Config.sandbox.autoStopMinutes`, with their template lines and the test stubs that set it; the optional `SandboxDriver.stopSandbox` (all from `sandbox-idle-stop`) | unchanged; their comments lose Daytona (D1, D5) |
| Simplify | `src/config.ts`, `src/driver.ts`, `src/projects.ts`, `src/cliprobe/sandbox.ts` | one driver |
| Simplify | `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/teams/cards.ts` (`daytonaOk` becomes `sandboxesOk`); `src/netretry.test.ts`; `src/idlestop.test.ts` (a driver without a stop) | neutral names |
| Fix | `src/sshdocker.ts`: the listing fails on a non-zero exit (D8); `src/cli.ts`: a configuration refusal prints as one line (D3) | bug fixes |
| Simplify | comments in about twenty files: `claudeSession.ts`, `tasks.ts`, `turn.ts`, `state.ts`, `pollers.ts`, `sshdocker.ts`, `housekeeping.ts`, `project.ts`, `idlestop.ts`, the "no Slack/Daytona deps" headers and others | true wording |
| Visible text | Slack's `/aven status` health flag (`src/chat/slack/blocks.ts:721`); the missing-driver-settings error a user can meet in `/aven memory live` | `status.json` and `memory-live-no-sandbox.json` re-captured |
| Docs | `docs/sandbox-drivers.md` (rewrite), `docs/local-dev.md`, `README.md`, `CLAUDE.md`, `SECURITY.md` | one driver |
| Docs | `docs/{README,how-we-work,why,sources,observability,runtime-config,cli-probe,stream-json-contract,memory,housekeeping,multitenancy}.md` | one driver |
| Docs | `infra/deploy/{README.md,deploy.sh,coach-aven.service.tmpl}`, `snapshot/{Dockerfile,plain/Dockerfile,build-and-push.sh}`, the `manage-project` skill, the package description | one driver |
| Release | `.github/release.yml`: a *Breaking* category (D12) | new heading |
| History | `openspec/changes/archive/*` (14 lines); the ledger rows in `docs/rollout.md` | unchanged |
| History | the dated notes in `docs/stream-json-contract.md:11` and `docs/memory.md:114`; the 2026-07 option analysis in `docs/multitenancy.md` | unchanged |
| In-flight | `agent-messaging` (D12/D13, task 0.2), one sentence of `agent-skills`' design, the change files of `sandbox-idle-stop` | no edit (D14) |
| Spec | `sandbox-idle-stop`: the clause and the scenario that name Daytona as a current driver | a delta of this change (D14) |

Unaffected:
- the prompt goldens: the base prompt varies by `gitFlow` and `sandbox.dind`, never by driver;
- the Home tab;
- the text of the Teams cards;
- the CLI recordings: transport `local` only.

## Goals / Non-Goals

**Goals:**
- No Daytona code, dependency or setting is left. `SANDBOX_AUTOSTOP_MINUTES` stays, because it is ssh-docker's setting now (D5). No doc or template presents Daytona as current. History stays history.
- A configuration that already selects ssh-docker sees no change except one word in Slack's `/aven status`, and the tests prove it. The other visible change is a ⚠️ when the sandbox host cannot be reached.
- No project moves to a new sandbox unless its operator edits the configuration. A configuration in which every project names its driver is never refused for a Daytona leftover.
- The seam for another driver stays, and it is documented.

**Non-Goals:**
- New ssh-docker capabilities (D9). The urgent one, the idle stop, came first as its own fix (`sandbox-idle-stop`).
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
- **`SNAPSHOT_IMAGE`, `snapshot/` and the config's `snapshot` block** (D7).
- **`SANDBOX_AUTOSTOP_MINUTES` and `Config.sandbox.autoStopMinutes`.** Since `sandbox-idle-stop`, the bot's idle stop of ssh-docker containers reads them (D5).
- **The optional `stopSandbox` on `SandboxDriver`, and how the idle stop and housekeeping treat a driver without it.** It is the seam's case of a provider that stops idle sandboxes itself, as Daytona's did (D6). A required method would make every future driver implement a stop its provider may already do.

### D2. The default driver is ssh-docker
**Recommendation.** When neither `SANDBOX_DRIVER` nor the project's `driver` is set, the project runs on ssh-docker. An empty `SANDBOX_DRIVER` counts as unset, as it does today. The docs and templates still write `SANDBOX_DRIVER=ssh-docker` (D6).

**Alternative.** Require `SANDBOX_DRIVER=ssh-docker`, and refuse to start without it. Its strongest point is rollback: every earlier release defaults to `daytona`, and a mandatory setting guarantees the line is there when an installation goes back to one.

**Why.**
- There is nothing left to choose, and a mandatory setting with one legal value is ceremony for every new installation.
- The one risky case is an installation that ran Daytona by default. D4 catches it; a mandatory setting is not needed for that.
- The templates and docs keep the line, which covers rollback for every installation built from them.

### D3. A project that names a removed or unknown driver is refused, at boot and at reload
**Recommendation.**
- Every command that loads the projects configuration refuses a project whose `"driver"` is `"daytona"`:
  - at boot, the bot does not start;
  - `/aven reload` fails, and the previous configuration stays active;
  - the `orch sources` commands refuse it in the same words.
- Any other value but `ssh-docker` is refused the same way, naming the one accepted value. Today a typo in a project's `driver` silently selects Daytona, so this also fixes a latent bug.
- A non-empty `SANDBOX_DRIVER` that is neither `ssh-docker` nor `daytona` stops the bot at boot, as today. D4 covers `SANDBOX_DRIVER=daytona`.
- The error names the setting: the variable, or the project and its field. For `daytona`, it says the driver was removed and names the fix: move the project to ssh-docker and change or drop the setting, or keep running the last release that has the driver.
- The refusals are thrown as a configuration error, which `orch` prints as one line, without a stack, and with exit code 1. The reasons:
  - With a stack, the message line can fall outside the last twelve journal lines that the deploy's health check prints.
  - A refusal in the environment comes before Sentry starts, so the journal is the only place it shows.
  - Like a usage error, it is not sent to Sentry: it is a configuration error, not an incident, and the unit would repeat it every three seconds.

**Alternatives.**
- (a) Warn, and run the project on ssh-docker.
- (b) Load the configuration, and fail at the project's first turn, as a missing driver setting does today.

**Why.**
- (a) would move a project to a new, empty sandbox without anyone choosing it. The repos are cloned again. What lived only in the old sandbox stays behind: worktrees and uncommitted work, memory not yet journaled, Sail databases, and the Claude session files that `--resume` needs. The house rule is to fail loudly on a setting that would change behaviour, as the `gitFlow` check does.
- (b) keeps the other projects up. But the failure then reaches users in a channel, maybe days later, instead of reaching the operator at deploy. The deploy's health check shows the error within a minute.
- A reload never takes the bot down, because it keeps the previous configuration.

### D4. A Daytona default is refused only where a project would move
**Recommendation.**
- The installation's old default was Daytona in two cases:
  - `SANDBOX_DRIVER=daytona`;
  - `SANDBOX_DRIVER` unset or empty, with `DAYTONA_API_URL` non-empty.
- `loadConfig` records that old default and the setting that made it. It refuses nothing for it.
- `loadProjects` is given the old default and refuses each project without a `driver` field. The error names the project, the setting and the fix: give the project `"driver": "ssh-docker"`, or set `SANDBOX_DRIVER=ssh-docker`, once it runs on ssh-docker; or stay on the last release that has the driver. The check runs wherever D3's does: at boot, at `/aven reload`, and in the `orch sources` commands.
- When every project names its driver, the old default moves nothing. The bot starts, and D5's warning names the setting.
- A reload that adds a project without a `driver` field under such a default is refused, and the error names that project.

**Alternatives.**
- (a) Refuse the settings themselves in `loadConfig`, whatever the projects say: `SANDBOX_DRIVER=daytona`, or `DAYTONA_API_URL` without `SANDBOX_DRIVER`. This is simpler to state, but it refuses installations where nothing would move:
  - the end state of the per-project migration that `docs/sandbox-drivers.md` documents: every project names ssh-docker, and `SANDBOX_DRIVER=daytona` stays;
  - an installation built from the ops template, which ships a `DAYTONA_API_URL` line and no `SANDBOX_DRIVER` line;
  - commands that never touch a sandbox, such as the mirror script, which reads only the environment.
- (b) Only warn (D5), and let the new default apply.

**Why.**
- With D2 alone, such an installation would start anyway:
  - where `SSHDOCKER_HOST` is set (a fleet that mixed drivers), its default projects would move to new containers at their next turn;
  - where it is not set, every turn would fail with an error about `SSHDOCKER_HOST` that never mentions Daytona.
- Together, D3 and D4 catch every way a project ran on Daytona: an explicit project field (D3), and the installation default, explicit or implicit (D4).
- They refuse one more shape: `SANDBOX_DRIVER=daytona` with a project without a `driver` field, even where `DAYTONA_API_URL` was never set. That project could not have run on Daytona, but the operator wrote Daytona down, so the bot asks rather than guesses.
- A configuration in which every project names its driver is never refused for a Daytona leftover, so the safety costs no false positive there.
- Emptiness follows today's code. An empty `SANDBOX_DRIVER` counts as unset, because the code default is applied with `||`. An empty `DAYTONA_API_URL` never configured Daytona, because `loadConfig` tests it for truthiness. A guard written with `=== undefined` would let `SANDBOX_DRIVER=` through, so the tests pin both empty cases.

### D5. Leftover Daytona-only settings warn once at boot
**Recommendation.**
- Nothing reads these settings any more:
  - every variable whose name starts with `DAYTONA_`. The bot read three of them, and the SDK read more straight from the environment, such as `DAYTONA_TARGET`;
  - `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK`;
  - `SANDBOX_DRIVER=daytona`.
- `retiredEnvWarnings` adds one line that names the ones present with a non-empty value, for example `config: SNAPSHOT_NAME is retired with the Daytona sandbox driver and changes nothing — remove it`. For `SANDBOX_DRIVER=daytona`, the line asks the operator to set `ssh-docker`.
- `orch slack` and `orch teams` log the line.
- D4 is the one exception: under a Daytona default, a project without a `driver` field is refused, not warned about.
- `SANDBOX_AUTOSTOP_MINUTES` is not on the list. Daytona read it, and since `sandbox-idle-stop` the bot's idle stop of ssh-docker containers reads it too, with the same default (30) and meaning (`0` = never). An installation keeps its value, and the line never names it.

**Alternatives.** Ignore them silently, or refuse to start.

**Why.**
- They change nothing: ssh-docker already ignores the four keys of the second bullet.
- Refusing would stop a healthy installation that kept a retired key.
- Silence would leave dead keys in `.env` files forever.
- One warning reaches the operator, as `retire-agent-dispatch` D4 did for `DISPATCH`.
- The names stay retired. No later change gives `SANDBOX_CPU`, `SANDBOX_MEMORY` or `SANDBOX_DISK` a new meaning (D9). Otherwise an operator who ignored the warning would get a hard limit without noticing.
- `SANDBOX_AUTOSTOP_MINUTES` is the other case: it kept its meaning on ssh-docker. Retiring it would tell operators to delete a line that still sets their idle stop, and `0`, the idle stop's off switch, would go with it.

### D6. The seam stays; the docs present one driver
**Recommendation.** Keep:
- the `SandboxDriver` interface and `createDriver(cfg, kind)`;
- `SANDBOX_DRIVER` and the project `driver` field, both optional, with `ssh-docker` the only driver they select (`SandboxDriverKind = 'ssh-docker'`). D3, D4 and D5 say what any other value does.

The templates, the docs and the `manage-project` skill still write `SANDBOX_DRIVER=ssh-docker`, and a project's `"driver": "ssh-docker"`. Every earlier release defaults to `daytona`. An installation that drops the line and later rolls back, or runs an older tag, would send every project without a `driver` field down the Daytona path, where each turn fails.

`docs/sandbox-drivers.md` keeps its file name, so every link to it still works. It becomes:
- **ssh-docker:** host prerequisites, local mode, project options, how it maps, the idle stop, and the dated verification history. What `sandbox-idle-stop` wrote stays: the *Auto-stop*, *Wake* and *Persistent claude* rows, *Idle stop* and the *Not yet done* list. Only their comparisons to Daytona go (D9);
- **Selecting the driver:** both settings are optional and select one driver, and the docs keep writing it (above); what a removed or unknown value does (D3, D4, D5);
- **Moving a project to ssh-docker:** it gets a new sandbox; what does not carry over (D3);
- **Looking inside a container:** the section `sandbox-idle-stop` added (`docker start` first, then `docker exec`), without its sentence about `peek-sandbox` (D13);
- **Adding a driver:** the contract in `src/driver.ts`:
  - a warm named sandbox;
  - an idle lifecycle the session code can rely on: either the provider stops idle sandboxes itself, or the driver implements `stopSandbox` and the bot's sweep stops them (`sandbox-idle-stop`);
  - exec and upload;
  - persistent sessions whose tail replays from the start;
  - a listing that fails rather than reads as empty when it cannot answer (D8);
  - the name-only delete guard;

  one file per driver, and no provider SDK outside it;
- **Retired: Daytona:** removed by this change, the last release that has it, and what it offered (D9).

**Alternative.** Retire both settings: `ssh-docker` is still accepted, but with a warning. `createDriver(cfg)` loses its `kind`, and the `driver` plumbing leaves `tasks.ts`, `turn.ts`, `pollers.ts`, `idlestop.ts` and `commands.ts`. A future driver would bring its own selection back.

**Why.**
- Every installation we know of sets both settings explicitly. Retiring them would turn valid configurations into warnings for no gain.
- An explicit `SANDBOX_DRIVER=ssh-docker` is what keeps a rollback safe. That is the strongest reason not to retire it.
- Selection is the first thing a second driver needs, and the plumbing is a few lines.
- The interface itself is not in question. It keeps the bot provider-ignorant, and it is what the tests fake.

### D7. `SNAPSHOT_IMAGE`, `snapshot/` and the config's `snapshot` block keep their names
**Recommendation.** The variable and the directory keep their Daytona-era names. In the code, `Config.snapshot` loses `name`, `cpu`, `memory` and `disk`, and keeps `image` under the same name. There is no internal rename. Three hand-built configurations with a `snapshot` block are cast to `Config`: the CLI probe's (`src/cliprobe/sandbox.ts`) and two in `src/sshdocker.test.ts`, one of them added by `sandbox-idle-stop`. The typecheck cannot see a renamed field there. A missed edit would break only the probe's live sandbox run, which no CI step exercises.

**Alternative.** Rename the variable to `SANDBOX_IMAGE`, with `SNAPSHOT_IMAGE` as a deprecated alias; rename `snapshot/` to `images/`; and move the field to `Config.sandbox.image`.

**Why.** Every installation sets `SNAPSHOT_IMAGE`, and the build script, the docs and the operators all use `snapshot/`. A rename changes no behaviour, and it costs every operator an edit. If it is ever wanted, it is its own change.

### D8. `/aven status` says "Sandboxes", and a failed listing shows ⚠️
**Recommendation.**
- Slack's health line reads `_Sandboxes ✅ · GitHub ✅ · Slack ✅_`, and `StatusReport.daytonaOk` becomes `sandboxesOk`. The Teams card already says `sandboxes`.
- ssh-docker's listing fails when its command exits non-zero, and the error carries the tail of its stderr. The two common cases are ssh's exit 255, when the host cannot be reached, and docker's exit 1, when its daemon is down. Today the exit code is ignored, so an outage reads as `Sandboxes ✅`, with every project "not created".
- The check is a pure helper, pinned in `src/sshdocker.test.ts`: it turns the exit code, stdout and stderr into the state map, or into an error.
- The CLI probe's leftover sweep reads the same listing, so it now fails early with the real cause.
- Knowingly unchanged: when the listing fails, the per-project lines still read "not created", with the ⚠️ beside them.
- Out of scope: `getSandbox` still reads an unreachable host as "no sandbox". `/aven memory live` then says there is no sandbox yet, and housekeeping skips the project as asleep. Both are harmless.

**Alternative.** Keep the word byte-identical in this change, and fix the label and the listing in a separate PR.

**Why.**
- The flag reports whether the sandbox listing answered. On every installation we know of, that listing is ssh-docker's, so "Daytona" is wrong today wherever it shows. Correcting the label is a bug fix.
- The new requirement says a failed listing shows ⚠️. That holds only once the listing reports its failures. Today the ⚠️ appears only when the driver cannot even be built, as without `SSHDOCKER_HOST`.
- `/aven status` is a viewer verb, so users see the new word.
- The Home tab's line ("a live view of sandboxes…") was already right and does not change.
- The re-captured `status.json` pins the new word, and the helper's test pins the failure.

### D9. What Daytona gave: the idle stop is done, the rest is out of scope and named
| Daytona | ssh-docker today | Its own change? |
|---|---|---|
| Idle stop (`SANDBOX_AUTOSTOP_MINUTES`, 30 minutes by default). An idle sandbox stopped, and every process in it ended: each idle conversation's `claude` process, and any Sail stack. The bot relies on this. The live-session LRU and the 45-day chat prune drop a conversation's reference, and leave its process to the sandbox's idle stop (`src/tasks.ts`, `src/turn.ts`). The next message resumed the conversation with `--resume`, and the start brought dockerd back. | The same, since `sandbox-idle-stop` (PR #65). The bot stops a project container after `SANDBOX_AUTOSTOP_MINUTES` without activity (30 by default, `0` = never, a lower value raised to 10), and that ends every process in it. On a docker-in-docker project, the inner dockerd stops its Sail stack first. The next turn wakes the container and resumes the conversation with `--resume`. The first warm-up after each start removes the dead sessions' files and brings dockerd back. Left out, as on Daytona: the idle processes of a container that never goes idle. | **Done, as its own fix, before this change.** It keeps the key and its meaning, so this change does not retire it (D5). It stops the whole container, as Daytona did. This design's first idea was per-conversation reaping (working name `reap-idle-sessions`): ending one conversation's process after N idle hours. It was not taken (`sandbox-idle-stop` D1), and it stays possible for a container that never goes idle. |
| Archiving: long-stopped sandboxes moved off the runner, restored on start | A stopped container keeps its disk. | No. Disk on a host you own is cheap, and housekeeping's prune and worktree reap bound the growth. While the idle stop is on, housekeeping wakes an asleep container for its nightly pass (`sandbox-idle-stop` D13). |
| Per-sandbox CPU, memory and disk (`SANDBOX_CPU`, `_MEMORY`, `_DISK`) | No limits: one runaway build can starve the host. An operator can create a container with limits by hand. The driver keeps an existing container's flags, but recreates it without the limits. | Yes, for CPU and memory, as a small change of its own: `sandbox-idle-stop` names memory limits as the next step. A per-project `sandbox.resources` becomes `docker run --cpus/--memory`, at creation only, like the other options. It never reuses the retired names (D5). The idle stop bounds memory only in a container that goes idle. One that never does still keeps a process per conversation touched since its last start, and a memory limit turns that growth into OOM kills inside it. Not for disk: Docker has no portable per-container quota. Watch the host's disk instead. |
| Preview links to a port inside the sandbox | None | No. The product never used them. |
| A hosted API and dashboard, with no host to run | A Docker host the operator runs, which may be the bot's own | Only as a new driver behind the seam, once an installation needs one. |
| Many runners behind one API | One host per installation (`SSHDOCKER_HOST`) | Only when one host is not enough; then a host per project. |

### D10. Dependencies, CI and Dependabot
**What the pin did.** It held `@daytonaio/sdk` at the version that matched the self-hosted server, because a newer SDK may call API that the frozen server lacks. Dependabot was told to ignore the package, security updates included. So an advisory whose only fix is a newer SDK could not be fixed. Upstream has meanwhile deprecated the package under that name.

**After.** These numbers were measured on 2026-10-19 on a copy. The code PR measures them again and quotes them in its body.
- `npm uninstall @daytonaio/sdk` takes the lockfile from 417 packages to 258. 159 are removed, none are added, and no version changes.
- `npm audit` goes from 30 advisories (19 high, 11 moderate) to 1 moderate. The one left is OpenTelemetry core, through the error reporter. It is fixable within range, in a separate update.
- `.github/dependabot.yml` loses its `ignore` block and keeps "security updates only, no version-update PRs". With no exception left, security updates cover the whole tree.
- CI keeps its steps. Nothing in it depends on the SDK, and `npm ci` stops printing the SDK's deprecation warning.

**Alternative.** Delete `.github/dependabot.yml`. Without the ignore entry, the file changes nothing that the repository settings don't already do.

**Why keep it.** It states the policy where readers look for it, and an ignore entry can come back later without deciding the policy again.

### D11. Bucket, proof, ledger, release order
**Bucket.** Bucket 1, bug fix or invisible improvement. The PR body names each part, as `retire-agent-dispatch` did:
- **The removal and the default flip:** dead code on every installation we know of, so the risk is that of a bug fix. Every installation sets `SANDBOX_DRIVER=ssh-docker`, so the code default goes unused. Proof 1 pins it.
- **The status word and the listing check:** bug fixes. They change one visible word, and show a ⚠️ when the host cannot be reached.
- **The refusals (D3, D4):** inert on every installation we know of, because no project there would move. Only the tests exercise them.
- **The warnings (D5):** one line at boot where a retired key remains.

There is no flag.

**Alternative.** Bucket 3: keep the driver for one release behind a flag that is off by default, and remove it after the canary.

**Why not.** A flag over code that no installation runs has nothing to canary. A Daytona installation gets the same chance to stay on the previous release from the refusals and the release note (D12).

**Proof of today's shape:**
1. `src/config.test.ts` loads an environment with the sandbox keys an installation sets today, with fictional values: `SANDBOX_DRIVER=ssh-docker`, a remote `SSHDOCKER_HOST`, `SSHDOCKER_RUNTIME`, `SANDBOX_MANAGED_BY`, `SANDBOX_NAME_PREFIX`, `SANDBOX_WORK_DIR`, `SNAPSHOT_IMAGE` and `SANDBOX_AUTOSTOP_MINUTES`. It gets the same driver, host, runtime, image, work directory, name prefix and idle-stop minutes as before, and no old Daytona default. `retiredEnvWarnings` returns nothing for it.
2. `src/projects.test.ts`: a registry in which every project names ssh-docker loads without a warning or a refusal. It also loads under a stale Daytona default.
3. A new `src/driver.test.ts`: `createDriver` returns the ssh-docker driver, with and without a `kind`.
4. `src/sshdocker.test.ts`: the existing cases are unchanged, so the scripts the driver runs are byte-identical. One case is added, for the listing's exit check.
5. The prompt goldens are unchanged.
6. Every recorded chat call is unchanged, except three:
   - `status.json` changes by one word;
   - `memory-live-no-sandbox.json` changes because the twin has no driver settings;
   - `reload-refuses-daytona.json` is new.

**Ledger.**
- One row. It names the bucket parts above. What to watch:
  - The home bot's first boot on `main` logs no `config:` warning, its idle-stop line at boot (`idle stop: … stop after <m> min without activity`) names the same minutes as before, and `/aven status` shows `Sandboxes ✅`.
  - An installation that kept a retired key logs one warning at its first boot, naming the keys to delete. That is the only live exercise of D5.
  - Only the tests cover the refusals.

  The sandbox host's memory and the `claude` processes per container are the idle-stop fix's watch items, in its own row.
- A *Retired* entry for the Daytona settings, as for `DISPATCH`.

**Release order.**
1. The spec PR, then the code PR.
2. After the merge to `main`, the canary (the home bot) runs it for two days or more.
3. It ships in the first tag cut after that, on the normal schedule.

Prod runs an older tag and is untouched until then. Nothing in this change needs an earlier tag. Before that tag, every operator checks their installation (task 8.1).

### D12. Public users and the release note
The repository has been public since 2026-10-16, so someone may run the Daytona driver: it was the code default, and the value `.env.example` shipped with. Nobody can be asked, so the release says it:
- **The PR title is the release-notes line:** "Remove the Daytona sandbox driver — ssh-docker is the only driver (Daytona installations: stay on the previous release)".
- **The heading.** `.github/release.yml` gains a "⚠️ Breaking" category, listed first and matched by the label `breaking`. The PR carries that label alone, so the generated notes lead with the removal. Under `fix`, the label `retire-agent-dispatch` used, they would file it among the fixes.
- **When the tag is cut,** one upgrade note goes at the top of the release notes:

  "**Daytona sandbox driver removed.** An installation that runs Daytona stays on vX.Y.Z, the last release with it, until its projects run on ssh-docker (`docs/sandbox-drivers.md` → *Moving a project*). This release refuses to start when a project would move. That is a project whose `driver` is `daytona` or another unknown value. It is also a project without a `driver` field while `SANDBOX_DRIVER=daytona` is set, or while `DAYTONA_API_URL` is set and `SANDBOX_DRIVER` is not. Leftover Daytona settings only warn. `SANDBOX_AUTOSTOP_MINUTES` is not one of them: ssh-docker's idle stop reads it. Keep `SANDBOX_DRIVER=ssh-docker` set: earlier releases default to `daytona`."
- **The boot refusals (D3, D4) give the same advice,** so an operator who skips the notes still reads it.

**Alternatives.**
- A deprecation release first: warn when Daytona is selected, and remove it one release later.
- For the heading: label the PR `fix`, as `retire-agent-dispatch` was, and rely on the upgrade note added by hand at the tag.

**Why not a deprecation release.**
- No installation we operate runs Daytona.
- The repository has been public for three days.
- The server version the SDK is pinned to is frozen.
- A release that keeps the driver keeps the 29 advisories.
- The refusal message is the deprecation notice.

**Why the heading.** A note added by hand can be forgotten, and then a Daytona installation reads the removal among the fixes. The heading costs one block of YAML, and it serves every later breaking PR.

### D13. `scripts/peek-sandbox.ts` goes
**Recommendation.** Delete it. `docs/sandbox-drivers.md` already gives the ssh-docker equivalent, in the section `sandbox-idle-stop` added (*Looking inside a container*). An idle container is usually stopped, so the section says to start it first, with `docker start <prefix><slug>` or `/aven memory live`. Then comes `ssh <SSHDOCKER_HOST> docker exec <prefix><slug> sh -c '<cmd>'`, or plain `docker exec` in local mode. This change drops the section's sentence about the script. The `manage-project` skill's peek line becomes the same two steps.

**Alternative.** Rewrite it over `SandboxDriver` (`getSandbox`, then `exec`), reading an overlay's `.env`.

**Why.** On ssh-docker the operator already has a shell on the host. Two documented lines replace a script that would need the bot's settings just to build a driver. An operator's `docker exec` is not activity for the idle stop, and the section says so.

### D14. In-flight changes
- **`agent-messaging`.** D12, D13 and task 0.2 record measurements taken through the Daytona session, whose output carried a copy of stdin. They stay as records. The rule they produced holds for any transport, and it stays right on ssh-docker, whose FIFO adds no copy: only the CLI's own `isReplay` echo confirms delivery. Its spec names no transport. No edit.
- **`agent-skills`.** Its design says both drivers run the same command line, which was true when it was written. No edit. `docs/runtime-config.md`, the current doc that repeats it, is updated here.
- **`sandbox-idle-stop`** (PR #65, on `main` before this change). Its proposal, design and tasks compare the idle stop with Daytona's and name this change. They stay as records. Its spec names Daytona in two ways:
  - as history: the Purpose ("the way Daytona's idle stop did") and the title *A wake restores what a Daytona start restored*. Both stay true, and they stay;
  - as a current driver, in *An idle project container is stopped*: the clause "A project on a driver whose provider stops idle sandboxes itself (Daytona) SHALL NOT be stopped by the bot", the comparison "as it did on Daytona", and the scenario *A Daytona project*. Once this change refuses `daytona` (D3), that scenario cannot happen.

  So this change carries a MODIFIED delta for that one requirement (`specs/sandbox-idle-stop/spec.md`). The clause stays without the provider's name, because it is the seam's case (D1, D6). The comparison goes. The scenario becomes one for a driver whose provider stops its own sandboxes, which `src/idlestop.test.ts` covers under a neutral name (task 1.9). The rest of the requirement is copied unchanged. The delta modifies the main spec, so `sandbox-idle-stop` is archived before this change, and the copy is checked against it then (task 7.3).
- **Every other open change.** None assumes a sandbox driver. The "both drivers" in `teams-chat-driver` are chat drivers.
- **The main specs.** None names Daytona today. `sandbox-idle-stop`'s will once it is archived (above). The `cli-probe` spec says that "a driver's listing can include every sandbox of an account"; that stays true of drivers in general, so it needs no delta.

## Risks / Trade-offs

- **[An unknown installation still runs Daytona]** → It refuses to start, with the fix in the error (D3, D4), and the release note says to stay on the previous release. Nothing is deleted on its side: its Daytona sandboxes stay where they are.
- **[A project moved by hand loses what lived only in its sandbox]** → *Moving a project* lists what does not carry over:
  - worktrees and uncommitted work;
  - memory not yet journaled;
  - Sail data;
  - the Claude session files `--resume` needs, so old threads start fresh.

  The bot never moves a project by itself.
- **[The clean-up catches the idle stop's key]** → `SANDBOX_AUTOSTOP_MINUTES` was on this design's first list of retired keys, and D5 now leaves it out. Its config field, template lines and test stubs stay (tasks 1.3, 1.8, 1.10, 4.1, 4.2). The tests pin that it gets no warning and keeps its value (tasks 1.3, 1.4). The canary's boot line shows the idle stop's minutes (D11), and task 7.1 tells operators to keep the line.
- **[A stale Daytona default]** → D4 refuses only where a project would move. Otherwise D5's warning names the setting. A reload that adds a project without a `driver` field under it is refused, and the error names the project.
- **[The sources daemon shares the `.env` and the projects configuration]** → It refuses the same configurations as the bot (D3, D4). The operator sees both at deploy and fixes one file.
- **[A rollback, or an older tag]** → Every earlier release defaults to `daytona`. Keep `SANDBOX_DRIVER=ssh-docker` set; the templates and docs write it (D6).
- **[A boot refusal goes unseen]** → It is one line with no stack, so the deploy's health check prints it among its last lines (D3).
- **[Users read a new word in `/aven status`, or a ⚠️ during an outage]** → "Sandboxes" reports the same check that "Daytona" did. The ⚠️ is the truth that ✅ hid.
- **[A hosted sandbox service is needed later]** → The seam and *Adding a driver* stay. The old driver would not be the starting point anyway: its SDK is deprecated and pinned to a frozen server.
- **[A re-captured fixture hides a slip]** → Two fixtures are re-captured and one is new, and their diff is reviewed word by word. Every other recording stays byte-identical.

## Migration Plan

1. The spec PR (this change), after the review. It has no runtime effect.
2. The code PR, from a worktree with `/opsx:apply`, merged once CI is green. The home bot, and any installation that follows `main`, picks it up at its next restart. Watch four things:
   - no `config:` warning on the home bot;
   - its idle-stop line at boot, with the same minutes as before;
   - `Sandboxes ✅` in its `/aven status`;
   - one warning on an installation that kept a retired key, until its operator deletes the key (task 7.1).
3. The archive creates `openspec/specs/sandbox-drivers/` and modifies `openspec/specs/sandbox-idle-stop/`, which is archived first (task 7.3).
4. Before the tag, each operator checks their installation (task 8.1). Then the tag, with the upgrade note (task 8.2).

**Rollback:** revert the code PR. Nothing on disk or in `state.json` changes shape, and the sandboxes are untouched. The rollback is safe only while `SANDBOX_DRIVER=ssh-docker` stays set, because every earlier release defaults to `daytona` (D2, D6).

## Open Questions

- **The refusal rule (D4).** Should the refusal look at its effect (recommended), or refuse the Daytona settings themselves (alternative a)? The effect-based rule has no false positives, but it needs the projects to decide. The setting-based rule is one check in `loadConfig`.
- **The listing check (D8).** Should it ship in this change (recommended), or in a separate PR, with the spec scenario claiming only the label?
- **The *Breaking* heading (D12).** Should `.github/release.yml` gain it (recommended), or should the release rely on the upgrade note added by hand at the tag?
- **The default driver (D2).** Should ssh-docker be the default (recommended), or should `SANDBOX_DRIVER=ssh-docker` become mandatory, which makes rollback safe by construction?
- **The per-project CPU and memory limits (D9).** The idle stop they were to follow is in, and `sandbox-idle-stop` names memory limits as its next step. Should that change open now (recommended, since it does not depend on this one), or after this one?
- **The last release with Daytona (D12).** Which release the note names is decided when the tag is cut.

Resolved since the reviews:
- **Ending idle conversations' processes (D9).** `sandbox-idle-stop` does it, as its own fix that goes to `main` before this change, so the tag that carries this change already has it. It keeps `SANDBOX_AUTOSTOP_MINUTES` (D5).
