## 1. The driver goes

- [ ] 1.1 Delete `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts` (design D13). Verify: `npm run typecheck` names every remaining importer (`src/driver.ts`, `src/cliprobe/sandbox.ts`), and each one is handled below.
- [ ] 1.2 `src/driver.ts`:
  - `createDriver` returns the ssh-docker driver; the `kind` parameter stays (D6);
  - the header says there is one implementation and that the interface is the seam for another;
  - the note on lines 54-56 states the replay-from-start tail as the contract every driver keeps, without crediting Daytona;
  - "image/snapshot" on line 67 becomes "image";
  - `listStates` (line 77) says that a listing which cannot answer throws, rather than returning an empty map (D8);
  - `stopSandbox` stays optional (D1). Its comment (lines 79-83) drops the provider's name: a driver whose provider stops idle sandboxes itself needs none, and is never asked.

  The idle-stop wording on lines 13-14 and 74-75 comes from `sandbox-idle-stop` and stays.

  Verify: a new `src/driver.test.ts` shows that `createDriver(cfg)` and `createDriver(cfg, 'ssh-docker')` both return an `SshDockerDriver`.
- [ ] 1.3 `src/config.ts` (D2, D4, D7):
  - `SandboxDriverKind = 'ssh-docker'`;
  - `SANDBOX_DRIVER` unset, empty or `ssh-docker` gives `ssh-docker`;
  - `SANDBOX_DRIVER=daytona` gives `ssh-docker` and records the old Daytona default, naming `SANDBOX_DRIVER`;
  - any other non-empty value is refused at boot, naming `ssh-docker`;
  - `SANDBOX_DRIVER` unset or empty, with a non-empty `DAYTONA_API_URL`, records the old Daytona default, naming `DAYTONA_API_URL`. `loadConfig` refuses nothing for an old default (D4);
  - the `daytona` block, `snapshot.name`, `snapshot.cpu`, `snapshot.memory` and `snapshot.disk` go;
  - `snapshot.image` stays where it is, still read from `SNAPSHOT_IMAGE` (D7: no rename, so the three configurations with a `snapshot` block that are cast to `Config` need no edit);
  - `sandbox.autoStopMinutes` stays, still read by `autoStopMinutesEnv` from `SANDBOX_AUTOSTOP_MINUTES` (D5, `sandbox-idle-stop`). Its doc comment (lines 361-362) drops Daytona's half;
  - the comments on lines 148-165 are updated.

  The refusals (D3, D4) are thrown as a configuration error class (`ConfigError`, beside `UsageError` in `src/sources/errors.ts`). `src/cli.ts` prints it as one line without a stack, exits 1, and does not send it to Sentry, as it does for a `UsageError`. The `SANDBOX_DRIVER` check is a pure exported helper beside `retiredEnvWarnings` (`sandboxDriverEnv`). The words of the refusals and of the warning live in a new import-free `src/driverkind.ts`, with its own test: the CLI probe shares them, and it may not import `src/config.ts`'s values (`src/cliprobe/imports.test.ts`), which load `.env` on import.

  Verify with `src/config.test.ts`:
  - (a) today's shape (D11, proof 1): `SANDBOX_DRIVER=ssh-docker`, a remote `SSHDOCKER_HOST`, `SSHDOCKER_RUNTIME`, `SANDBOX_MANAGED_BY`, `SANDBOX_NAME_PREFIX`, `SANDBOX_WORK_DIR`, `SNAPSHOT_IMAGE` and `SANDBOX_AUTOSTOP_MINUTES`, with fictional values. It gives the same driver, host, runtime, image, work directory, name prefix and idle-stop minutes as before, and no old default;
  - (b) unset and empty `SANDBOX_DRIVER` both give `ssh-docker`, with no old default;
  - (c) `daytona` records the old default, naming `SANDBOX_DRIVER`;
  - (d) a typo is refused, and the error names `ssh-docker`;
  - (e) a non-empty `DAYTONA_API_URL` with `SANDBOX_DRIVER` unset, or with it empty, records the old default naming `DAYTONA_API_URL`. With `SANDBOX_DRIVER=ssh-docker`, or with an empty `DAYTONA_API_URL`, there is none.

  Also verify by hand that a refusal reaches the journal as one line.
- [ ] 1.4 `retiredEnvWarnings` (D5) adds one line that names whichever retired settings have a non-empty value:
  - every `DAYTONA_*` variable;
  - `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK`;
  - `SANDBOX_DRIVER=daytona`, with "set `ssh-docker`" as the advice.

  `SANDBOX_AUTOSTOP_MINUTES` is not retired: it sets ssh-docker's idle stop (D5, `sandbox-idle-stop`).

  `orch slack` and `orch teams` log the line once the projects configuration has loaded (`loadBootRegistry` in `src/projects.ts`, both apps), so a boot refused for a Daytona leftover prints the refusal alone.

  Verify with `src/config.test.ts`:
  - each key alone gives one line;
  - several keys together give one line naming all of them;
  - `DAYTONA_TARGET` is named;
  - an empty value is not named;
  - none gives no line;
  - `SANDBOX_AUTOSTOP_MINUTES` alone gives no line, and beside retired keys it is not named;
  - the `DISPATCH` case is unchanged;
  - `DAYTONA_*` keys without `DAYTONA_API_URL` record no old default (review fix).

  And with `src/projects.test.ts`: `loadBootRegistry` logs the warnings only once the configuration has loaded.
- [ ] 1.5 `src/projects.ts` (D3, D4): `loadProjects` is given the old Daytona default from the configuration. Its five callers pass it: both apps (through `loadBootRegistry`), `/aven reload` and the two `orch sources` paths. The parameter is required, so the typecheck names a caller that forgets it (review fix). It refuses:
  - a `driver` other than `ssh-docker`, with an error naming the project, its field and the accepted value. For `daytona`, the error also names the removal and the fix;
  - under an old Daytona default, a project without a `driver` field, with an error naming the project, the setting and the fix.

  A JSON `null` is an absent field, as the old selection (`driver ?? SANDBOX_DRIVER`) read it: it loads, and under an old default it is refused like an absent field (review fix). The comment on lines 68-71 is updated. In `projects.config.example.json`, acme-shop's `"driver": "daytona"` becomes `"ssh-docker"` (D6: the templates write the field; review fix, it first lost the field).

  Verify with `src/projects.test.ts`:
  - `daytona` is refused, and the error names the project and the fix;
  - `ssh-dokcer` is refused, and the error names `ssh-docker`;
  - an absent field and `ssh-docker` load without a warning;
  - under an old default, a project without a field is refused, and the error names the setting. A registry in which every project names `ssh-docker` loads;
  - a `null` field loads without an old default, and is named under one;
  - "the shipped projects.config.example.json loads" still passes.

  Verify the reload with two new recordings in `src/chat/slack/commands.record.test.ts`. In `reload-refuses-daytona`, the registry file has a project that names `daytona` (D3). In `reload-refuses-daytona-default` (review fix), the twin carries a `DAYTONA_API_URL` default, and the registry file adds a project without a `driver` field (D4). Each reply carries the error and "The previous config stays active", and the registry in use is unchanged.
- [ ] 1.6 `src/sandboxopts.ts`: delete `isDefaultSandbox`, which only the driver used. The `assertDeletable` comment drops "Daytona's does"; the guard itself stays (D1). Verify: `src/sandboxopts.test.ts` passes without its two `isDefaultSandbox` assertions, and the guard's tests are unchanged.
- [ ] 1.7 `src/netretry.ts`: drop the `DaytonaConnectionError` name check, and rewrite the header: the Teams connector retries through the module, and Slack uses its `stackHead`. In `src/netretry.test.ts`, the Daytona-named errors get generic names. Verify: `src/netretry.test.ts` passes, and the Teams tests are unchanged.
- [ ] 1.8 The CLI probe:
  - `src/cliprobe/sandbox.ts` is ssh-docker only. `SANDBOX_DRIVER` stays required in the probe's environment and accepts only `ssh-docker`; `daytona` is refused with the D3 wording before any sandbox is created.
  - The configuration it builds by hand (lines 128-136, cast to `Config`) loses the `daytona` block, `SNAPSHOT_NAME`, and the CPU, memory and disk values. It keeps the fields that `SshDockerDriver` reads: `sshDocker`, `snapshot.image` and `sandbox.namePrefix`. It also keeps `sandbox.autoStopMinutes`, which stays in `Config`; the probe starts no idle sweep, so the value changes nothing there.
  - The header comment and the `driverFromEnv` comment are updated.
  - `src/cliprobe/report.ts:69`, `src/cliprobe/types.ts:9`, `src/cliprobe/ctx.test.ts:172` and `src/claudeSession.recorded.test.ts:135` describe a transport's copy of stdin without naming Daytona. The `echo` record kind stays (D1).

  Verify:
  - the cliprobe tests, with new cases: `driverFromEnv` refuses `daytona`, refuses a missing `SANDBOX_DRIVER`, and accepts `ssh-docker` with the label `sandbox (ssh-docker)`;
  - `npm run cli-probe -- check`.
- [ ] 1.9 Comments in shared code drop Daytona, or the assumption of its behaviour:
  - `src/claudeSession.ts` (374, 510, 984);
  - `src/tasks.ts` (74, 145, 265, 343-344);
  - `src/tasks.ts` (116-117) and `src/turn.ts` (621-622): the idle stop that ends a dropped session's process is the bot's (`idlestop.ts`). The Daytona half of each comment goes;
  - `src/state.ts` (35, 212);
  - `src/pollers.ts` (311) and `src/housekeeping.ts` (6-7): housekeeping's treatment of an asleep sandbox names no provider. The case of a driver whose provider stops its own sandboxes stays (D1);
  - `src/sshdocker.ts` (11, 20-21, 49, 148, 309, 343, 634);
  - `src/housekeeping.ts` (22) and `src/project.ts` (42): ssh-docker starts no dockerd from an entrypoint. It runs `sleep`, and dockerd starts through the guard: at chat prep and, on a docker-in-docker project, at the first warm-up after each start of the container (`sandbox-idle-stop`);
  - `src/idlestop.ts` (2, 215, 244) and `src/idlestop.test.ts` (184, 192, 414): the header says why the idle stop exists without naming the provider. The cases of a driver without `stopSandbox` stay, under a neutral kind name (D1, D14);
  - `src/chat/core/commands.ts` (68-69, 140-141);
  - `src/chat/views.ts` (128);
  - `src/chat/slack/blocks.ts` (2);
  - the "no Slack/Daytona deps" headers of `src/format.ts`, `src/pr.ts`, `src/schedule.ts` and `src/steps.ts` (2, 5);
  - `src/sources/serve.ts` (5).

  Verify:
  - `git grep -n -i daytona -- src scripts` lists only the refusal and warning texts of 1.3, 1.4, 1.5 and 1.8, and their tests. It also lists the old default's plumbing (`daytonaDefault` where the five callers of 1.5 load the configuration), the two keys the Teams config test isolates (1.10), and comments that cite this change by name (`retire-daytona-driver` D3, D4, D5, D8, D12), as comments cite other changes;
  - the grep finds only the word, so the lines that assume Daytona's behaviour without naming it are checked by reading them in the PR.
- [ ] 1.10 Test stubs:
  - the config stubs that set `autoStopMinutes` keep it, because the field stays (D5);
  - `src/chat/slack/commands.record.test.ts` drops its `DAYTONA_*` env juggling (217-218, 292-293);
  - in `src/chat/teams/config.test.ts`, `BASE` drops `SNAPSHOT_NAME`, and `KEYS` gains `SANDBOX_DRIVER` and `DAYTONA_API_URL`. Tests skip `.env`, so a developer shell that exports either one must not change the result.

  Verify: `npm test`.

## 2. Chat surfaces

- [ ] 2.1 `StatusReport.daytonaOk` becomes `sandboxesOk` in `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/teams/cards.ts` and `src/chat/teams/cards.test.ts`. Slack's health line says `Sandboxes` (`src/chat/slack/blocks.ts:721`, D8). Verify: re-capture `src/fixtures/chat/commands/status.json` with `UPDATE_SNAPSHOTS=1`. Its diff is `_Daytona ⚠️` → `_Sandboxes ⚠️`, and, since 2.2's review fix, `🌑 not created` → `⚠️ unknown` on its three project lines (the twin's listing fails). `src/fixtures/chat/teams/cards.json` is unchanged.
- [ ] 2.2 `src/sshdocker.ts`, `listStates` (D8): the listing throws when its command exits non-zero, and the error carries the tail of its stderr. A pure helper turns the exit code, stdout and stderr into the state map or an error. `getSandbox` is unchanged (D8, out of scope). When the listing fails, `/aven status` reads each project's sandbox as `unknown`, not `not created`, and logs the listing's error (an unreachable host shows neither a green tick nor "not created" for every project; the word `unknown` awaits the maintainer, design *Open Questions*). Verify in `src/sshdocker.test.ts`:
  - exit 0 parses exactly as before;
  - exit 255 (ssh) and exit 1 (the Docker daemon) throw, with the stderr tail;
  - the existing cases are unchanged.

  And with `status.json` (2.1): the project lines read `⚠️ unknown`.
- [ ] 2.3 Re-capture `src/fixtures/chat/commands/memory-live-no-sandbox.json`. The twin has no driver settings, so the error now names `SSHDOCKER_HOST`. Verify: `git diff --stat src/fixtures` lists exactly the two re-captured files of 2.1 and 2.3, and the two new recordings of 1.5 (`reload-refuses-daytona.json`, `reload-refuses-daytona-default.json`).
- [ ] 2.4 Home tab (CLAUDE.md: a Slack UI change updates the Home tab): no change. Its `/aven status` line ("a live view of sandboxes…") names no provider and stays right. So does the sentence `sandbox-idle-stop` added to *Background agents* ("A sandbox nobody is using may be put to sleep after a while…"). Verify: `src/fixtures/chat/interactions/home.json`, `home-client.json` and the Teams home card in `src/fixtures/chat/teams/cards.json` are unchanged.
- [ ] 2.5 Prompt goldens: no change. The base prompt names no driver. Verify: `git diff --stat src/fixtures/prompt` is empty.

## 3. Dependencies, CI and release notes

- [ ] 3.1 `npm uninstall @daytonaio/sdk` (D10). Then drop the two entries it leaves nested under `@sentry/node` (`node_modules/@sentry/node/node_modules/@opentelemetry/instrumentation` and `…/api-logs`) and run `npm install --package-lock-only`, which hoists them; `package.json` loses only the SDK. Verify:
  - a JSON diff of the lockfile's `packages` shows no entry left under `node_modules/@daytonaio/` or `node_modules/@daytona/`, none added, and two versions changed: `@opentelemetry/instrumentation` and `@opentelemetry/api-logs`, 0.217.0 → 0.214.0;
  - in a clean clone, with no `node_modules` in any parent directory: `npm ci` prints no deprecation warning for the SDK, and `npm test`, `npm run cli-probe -- check` and `node --import tsx src/cli.ts --help` pass (final check, 2026-10-20: a worktree inside the main checkout loaded the missing package from the checkout's `node_modules`, and hid a lockfile that a clean install cannot run);
  - `npm audit --package-lock-only` lists no advisory whose path goes through a removed package;
  - the PR body quotes the counts measured then. They will differ from the proposal's.
- [ ] 3.2 `.github/dependabot.yml`: drop the `ignore` block and its comment. The header keeps "security updates only, no version-update PRs". Verify: `git diff` shows only that block and the header line. The check after the merge, on the repository's Dependabot page, is task 7.6.
- [ ] 3.3 `.github/release.yml` (D12): a "⚠️ Breaking" category, listed first and matched by the label `breaking`. The contributor docs that list the labels name it too: `CLAUDE.md`, `CONTRIBUTING.md` and `docs/how-we-work.md` (review fix). Verify: the file parses as YAML, and the categories after it are unchanged. Task 8.2 checks the generated notes at the tag.
- [ ] 3.4 The CI workflows need no change, because no step depends on the SDK. Verify: the PR's CI `verify` and `hub` jobs are green.

## 4. Templates

- [ ] 4.1 `.env.example`:
  - the Daytona block goes, whatever its lines hold by then; so do `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY` and `SANDBOX_DISK`, with their comment;
  - `SANDBOX_DRIVER=ssh-docker` stays written out (D6: earlier releases default to `daytona`). It heads the ssh-docker block, with `SSHDOCKER_HOST` (`local`, or a host) and `SSHDOCKER_RUNTIME`;
  - `SANDBOX_AUTOSTOP_MINUTES=30` stays (D5) and moves into that block. Its comment from `sandbox-idle-stop` loses the clause "Daytona stops its sandboxes itself", and keeps the floor of 10, `0` = never, and distinct `SANDBOX_NAME_PREFIX` values on a shared Docker host;
  - the snapshot comment loses "snapshot name";
  - the "dev vs prod on a SHARED Daytona" note becomes "dev and prod on one Docker host" (`SANDBOX_NAME_PREFIX`, `SANDBOX_MANAGED_BY`). A distinct `SANDBOX_NAME_PREFIX` is required there, because the idle stop and the wake's cleanup assume one bot per container. `SANDBOX_MANAGED_BY` alone does not keep two installations apart (`sandbox-idle-stop` D10).

  Verify: `src/cliprobe/gate.test.ts` passes (its CLI pin line is untouched), and gitleaks and the public guard are clean.
- [ ] 4.2 `infra/deploy/ops.example/.env.example`: the same removals. Add the ssh-docker block that the template lacks today, with `SANDBOX_DRIVER=ssh-docker` written out, and move `SANDBOX_AUTOSTOP_MINUTES=30` into it. Its comment from `sandbox-idle-stop` loses the Daytona clause and keeps "decide it on purpose". Verify: gitleaks and the public guard are clean.

## 5. Docs

- [ ] 5.1 Rewrite `docs/sandbox-drivers.md` along D6. It keeps its file name. Sections:
  - ssh-docker. What `sandbox-idle-stop` wrote stays: the *Auto-stop*, *Wake* and *Persistent claude* rows, *Idle stop* and the *Not yet done* list. Only their comparisons to Daytona go ("as Daytona's did", "as a Daytona start did", "like Daytona session commands");
  - *Selecting the driver*. Both settings are optional, and the doc writes `SANDBOX_DRIVER=ssh-docker` because earlier releases default to `daytona`;
  - *Moving a project to ssh-docker*: a new sandbox, and what does not carry over;
  - *Looking inside a container*, from `sandbox-idle-stop`: its sentence about `peek-sandbox` goes (D13);
  - *Adding a driver*: the contract, idle lifecycle included (D6);
  - *Retired: Daytona*: what it offered (D9). The Daytona section's note that Daytona applies `SANDBOX_AUTOSTOP_MINUTES` itself moves here.

  The dated verification history stays. Verify: reviewed in the PR, and the links from `README.md`, `CLAUDE.md` and `docs/README.md` still resolve.
- [ ] 5.2 `docs/local-dev.md`. The isolation section explains that sandboxes collide only when dev and prod share a Docker host (`SSHDOCKER_HOST`), and that they then need distinct `SANDBOX_NAME_PREFIX` values (`sandbox-idle-stop` D10). It covers `SANDBOX_MANAGED_BY` too. Then:
  - no Daytona credentials among the prerequisites or in the variables table;
  - no snapshot step on first use;
  - dev containers are removed with `docker rm`.

  Verify: reviewed in the PR.
- [ ] 5.3 Entry points:
  - `README.md`: the diagram line (30) and the quickstart (44-51);
  - `CLAUDE.md`: line 3, line 36, and the driver paragraph (81-88), which describes one driver, the seam and no provider SDK. Its `src/idlestop.ts` pointer from `sandbox-idle-stop` stays;
  - `SECURITY.md:8`;
  - `docs/README.md:27`;
  - the `package.json` description.

  Verify: reviewed in the PR, and the public guard is clean.
- [ ] 5.4 Passing mentions:
  - `docs/how-we-work.md:150` and `docs/why.md:186`;
  - `docs/sources.md:389` and `docs/observability.md:4`;
  - `docs/runtime-config.md` (291, 352-353), and in *Sandbox idle stop*, from `sandbox-idle-stop`, the Daytona clauses (376-377, 391-392);
  - `docs/cli-probe.md` (50-52);
  - `docs/stream-json-contract.md`: line 42, and the "Daytona transport mapping" from line 99, which becomes the driver contract and the ssh-docker mapping;
  - `docs/memory.md` (152-155, 219);
  - `docs/housekeeping.md` (75-81): the *An asleep sandbox* bullet from `sandbox-idle-stop` loses its Daytona half;
  - `docs/multitenancy.md`: the current parts (99, 293, 335), plus one dated note above the 2026-07 option analysis, which otherwise stays.

  `docs/memory.md:181` and `docs/housekeeping.md:73` ("let the sandbox auto-stop again afterward") need no edit: the bot's idle stop makes them true on ssh-docker. Verify: reviewed in the PR.
- [ ] 5.5 Tooling comments:
  - `infra/deploy/README.md:12`, `infra/deploy/deploy.sh:4` and `infra/deploy/coach-aven.service.tmpl:10`;
  - `snapshot/Dockerfile`: lines 3-6, and line 38, where the driver overrides the entrypoint with `sleep` and dockerd starts through the guard (at chat prep, and at the first warm-up after each start of the container);
  - `snapshot/plain/Dockerfile`: lines 15-16, and line 45, where "the drivers" becomes "the driver";
  - `snapshot/build-and-push.sh`: the comment on lines 5-7, and the Daytona hint on line 97, which is deleted.

  Verify:
  - `src/chat/teams/deploy.test.ts` passes, since it renders from the template;
  - `bash -n infra/deploy/deploy.sh && bash -n snapshot/build-and-push.sh`, run as two separate checks: a second file given to one `bash -n` is not parsed.
- [ ] 5.6 `.claude/skills/manage-project/SKILL.md`:
  - the `driver` row says to set `"ssh-docker"`. An omitted field is `SANDBOX_DRIVER`, which an older release, after a rollback, reads as the removed driver unless `.env` sets `SANDBOX_DRIVER=ssh-docker`. The minimal new entry in Step 3 writes the field too (D6);
  - the `peek-sandbox` line becomes the two steps of D13: start the container, which is usually asleep (`sandbox-idle-stop`), then `docker exec`;
  - (review fix) the `driver` row also says that a current release refuses an omitted field under an old Daytona default, and the Step 3 validator, which reads no `.env`, says it cannot see that case.

  Verify: reviewed in the PR.
- [ ] 5.7 History stays history. Verify: `git grep -n -i daytona -- . ':!openspec/changes/archive' ':!openspec/changes/retire-daytona-driver'` lists only:
  - the refusal and warning texts and their tests. Also, as in 1.9: the old default's plumbing (`daytonaDefault` where the five callers of 1.5 load the configuration), the two keys the Teams config test isolates, and comments that cite this change by name, in `src/` and in `.github/release.yml`;
  - in `docs/sandbox-drivers.md`: the *Retired: Daytona* section, and the two sections that send a Daytona setting there: *Selecting the driver* (why `SANDBOX_DRIVER=ssh-docker` stays written out) and *Moving a project to ssh-docker* (what is refused, the image the Daytona snapshots were built from, the settings to delete);
  - the lines that say what a leftover Daytona setting does, added by the review fixes: `CLAUDE.md`'s driver paragraph, the `manage-project` skill's `driver` row and its validator note, and the `--transport sandbox` paragraph of `docs/cli-probe.md`;
  - the ledger in `docs/rollout.md`;
  - the dated notes: `docs/stream-json-contract.md:11`, and in `docs/multitenancy.md` the 2026-07 option analysis with the dated note above it (5.4). `docs/memory.md:114` names the deleted `scripts/peek-sandbox.ts`, not Daytona, so the grep does not list it; it stays as a dated record, marked "since removed";
  - the in-flight records named in D14, `sandbox-idle-stop`'s change files among them while it is not archived;
  - once it is archived, `openspec/specs/sandbox-idle-stop/spec.md`: its Purpose and the title *A wake restores what a Daytona start restored* stay as history. The clause and the scenario that this change's delta replaces leave at this change's archive (D14, task 7.3).

## 6. Rollout and the PR

- [ ] 6.1 `docs/rollout.md` (D11):
  - one ledger row, naming the bucket parts (the removal and the default flip; the status word and the listing check; the refusals; the warnings) and the breaking note. What to watch:
    - the home bot's first boot: no `config:` warning, the idle-stop line at boot with the same minutes as before, and `Sandboxes ✅`;
    - one warning on an installation that kept a retired key;
    - the refusals, which only the tests cover;
  - a *Retired* entry for the Daytona settings. `SANDBOX_AUTOSTOP_MINUTES` is not in it (D5).

  Verify: `grep -n 'retire-daytona-driver' docs/rollout.md` shows both the ledger row and the *Retired* entry, besides the `sandbox-idle-stop` row, which names this change. The public guard is clean.
- [ ] 6.2 The PR:
  - the D12 title;
  - the label `breaking` alone (D12). The repository has no such label yet (checked 2026-10-20): create it before labelling the PR, for example `gh label create breaking --description "An installation must act before it upgrades"`;
  - a body that names the bucket parts, the ledger row, the breaking note, and the counts measured in 3.1;
  - once the numbers exist: the PR column of the ledger row and of the *Retired* entry in `docs/rollout.md` (both `#TBD`, 6.1), and the spec PR's number in this PR's body.

  Verify: CI `verify` is green: typecheck, tests, the cli-probe check, the public guard on the tree and on the PR text, and gitleaks.

## 7. After the merge

- [ ] 7.1 For each installation whose first boot on the new code logs a `config:` warning: delete the settings it names from that installation's `.env` in its ops repository. Keep `SANDBOX_DRIVER=ssh-docker`, and keep `SANDBOX_AUTOSTOP_MINUTES`, which the warning never names: it sets the idle stop. Then export and restart. Optionally delete, on the installation's host, the three files the deploy's upload leaves behind (`src/daytona.ts`, `src/daytona.test.ts`, `scripts/peek-sandbox.ts`): the upload adds and overwrites files but never deletes one, and nothing imports these. Verify: the next boot logs no `config:` warning, and its idle-stop line names the same minutes as before.
- [ ] 7.2 In-flight changes (D14): none is edited. `agent-messaging` D12, D13 and task 0.2, one sentence of `agent-skills`' design, and the change files of `sandbox-idle-stop` stay as records. Verify: the code PR's `git diff --stat openspec/changes` lists only this change's own files.
- [ ] 7.3 Archive the change after the merge. The archive creates `openspec/specs/sandbox-drivers/`, and applies this change's delta to `openspec/specs/sandbox-idle-stop/` (D14). So `sandbox-idle-stop` is archived first. Before this archive, compare the delta's copy of *An idle project container is stopped* with the archived requirement: only the provider's name, "as it did on Daytona" and the Daytona scenario may differ. If that change was amended before its archive, copy the requirement again. Section 8 runs on the tag's schedule, and the archive does not wait for it. Verify: `openspec validate --specs --strict`, and `git diff openspec/specs/sandbox-idle-stop` shows only those lines.
- [ ] 7.4 Before the canary's first restart on the merged code (this comes before 7.1): task 8.1's two checks on its configuration. The bot and the sources daemon share that configuration, so an old Daytona default would refuse both. Verify: every project's `driver` is absent or `ssh-docker`, and its `.env` sets `SANDBOX_DRIVER=ssh-docker`, before the restart.
- [ ] 7.5 The bot's own journal check of a refused boot (moved from 1.3, which checked the sources daemon's unit): start `orch slack` or `orch teams` on a refused configuration under `systemd-run --user`, as a scratch unit with dummy tokens, or on staging with the unit template. Verify: the last twelve journal lines show the one-line refusal, without a stack and without a retired-setting warning.
- [ ] 7.6 After the merge, the repository's Dependabot page lists the configuration without an error (moved from 3.2).

## 8. At the tag (the archive does not wait for it)

- [ ] 8.1 Before the tag, for each installation:
  - `SANDBOX_DRIVER=ssh-docker` is set (D6: a rollback stays safe);
  - every project's `driver` is absent or `ssh-docker`. Check per element: `jq -r '.projects[] | "\(.slug) \(.driver)"' projects.config.json`, never one fallback over the whole array. Its `null` covers an absent field and an explicit JSON `null` alike, and both load as absent.

  Verify: `npm run ops -- <slug> import` shows that the box equals the overlay that was checked.
- [ ] 8.2 When the tag is cut, the D12 upgrade note goes at the top of the release notes, naming the last release with Daytona. Verify with `gh release view <tag>`: the note is at the top, and the generated notes list the PR under *Breaking*.
