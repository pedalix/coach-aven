## 1. The driver goes

- [ ] 1.1 Delete `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts` (design D13). Verify: `npm run typecheck` names every remaining importer (`src/driver.ts`, `src/cliprobe/sandbox.ts`), and each one is handled below.
- [ ] 1.2 `src/driver.ts`:
  - `createDriver` returns the ssh-docker driver; the `kind` parameter stays (D6);
  - the header says there is one implementation and that the interface is the seam for another;
  - the note on lines 52-54 states the replay-from-start tail as the contract every driver keeps, without crediting Daytona;
  - "auto-stop" on lines 12 and 72 becomes "a stopped sandbox", and "image/snapshot" on line 65 becomes "image";
  - `listStates` (line 74) says that a listing which cannot answer throws, rather than returning an empty map (D8).

  Verify: a new `src/driver.test.ts` shows that `createDriver(cfg)` and `createDriver(cfg, 'ssh-docker')` both return an `SshDockerDriver`.
- [ ] 1.3 `src/config.ts` (D2, D4, D7):
  - `SandboxDriverKind = 'ssh-docker'`;
  - `SANDBOX_DRIVER` unset, empty or `ssh-docker` gives `ssh-docker`;
  - `SANDBOX_DRIVER=daytona` gives `ssh-docker` and records the old Daytona default, naming `SANDBOX_DRIVER`;
  - any other non-empty value is refused at boot, naming `ssh-docker`;
  - `SANDBOX_DRIVER` unset or empty, with a non-empty `DAYTONA_API_URL`, records the old Daytona default, naming `DAYTONA_API_URL`. `loadConfig` refuses nothing for an old default (D4);
  - the `daytona` block, `snapshot.name`, `snapshot.cpu`, `snapshot.memory`, `snapshot.disk` and `sandbox.autoStopMinutes` go;
  - `snapshot.image` stays where it is, still read from `SNAPSHOT_IMAGE` (D7: no rename, so the two configurations cast to `Config` need no edit);
  - the comments on lines 148-165 are updated.

  The refusals (D3, D4) are thrown as a configuration error class. `src/cli.ts` prints it as one line without a stack, exits 1, and does not send it to Sentry, as it does for a `UsageError`. The checks are pure exported helpers beside `retiredEnvWarnings`.

  Verify with `src/config.test.ts`:
  - (a) today's shape (D11, proof 1): `SANDBOX_DRIVER=ssh-docker`, a remote `SSHDOCKER_HOST`, `SSHDOCKER_RUNTIME`, `SANDBOX_MANAGED_BY`, `SANDBOX_NAME_PREFIX`, `SANDBOX_WORK_DIR` and `SNAPSHOT_IMAGE`, with fictional values. It gives the same driver, host, runtime, image, work directory and name prefix as before, and no old default;
  - (b) unset and empty `SANDBOX_DRIVER` both give `ssh-docker`, with no old default;
  - (c) `daytona` records the old default, naming `SANDBOX_DRIVER`;
  - (d) a typo is refused, and the error names `ssh-docker`;
  - (e) a non-empty `DAYTONA_API_URL` with `SANDBOX_DRIVER` unset, or with it empty, records the old default naming `DAYTONA_API_URL`. With `SANDBOX_DRIVER=ssh-docker`, or with an empty `DAYTONA_API_URL`, there is none.

  Also verify by hand: start a refused configuration under `systemd-run --user`, or on a scratch box with the unit template. The last twelve journal lines show the one-line error.
- [ ] 1.4 `retiredEnvWarnings` (D5) adds one line that names whichever retired settings have a non-empty value:
  - every `DAYTONA_*` variable;
  - `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`;
  - `SANDBOX_DRIVER=daytona`, with "set `ssh-docker`" as the advice.

  Verify with `src/config.test.ts`:
  - each key alone gives one line;
  - several keys together give one line naming all of them;
  - `DAYTONA_TARGET` is named;
  - an empty value is not named;
  - none gives no line;
  - the `DISPATCH` case is unchanged.
- [ ] 1.5 `src/projects.ts` (D3, D4): `loadProjects` is given the old Daytona default from the configuration. Its five callers pass it: both apps, `/aven reload` and the two `orch sources` paths. It refuses:
  - a `driver` other than `ssh-docker`, with an error naming the project, its field and the accepted value. For `daytona`, the error also names the removal and the fix;
  - under an old Daytona default, a project without a `driver` field, with an error naming the project, the setting and the fix.

  The comment on lines 68-71 is updated. In `projects.config.example.json`, acme-shop loses `"driver": "daytona"`.

  Verify with `src/projects.test.ts`:
  - `daytona` is refused, and the error names the project and the fix;
  - `ssh-dokcer` is refused, and the error names `ssh-docker`;
  - an absent field and `ssh-docker` load without a warning;
  - under an old default, a project without a field is refused, and the error names the setting. A registry in which every project names `ssh-docker` loads;
  - "the shipped projects.config.example.json loads" still passes.

  Verify the reload with a new recording, `reload-refuses-daytona`, in `src/chat/slack/commands.record.test.ts`. Its registry file has a project that names `daytona`. The reply carries the error and "The previous config stays active", and the registry in use is unchanged.
- [ ] 1.6 `src/sandboxopts.ts`: delete `isDefaultSandbox`, which only the driver used. The `assertDeletable` comment drops "Daytona's does"; the guard itself stays (D1). Verify: `src/sandboxopts.test.ts` passes without its two `isDefaultSandbox` assertions, and the guard's tests are unchanged.
- [ ] 1.7 `src/netretry.ts`: drop the `DaytonaConnectionError` name check, and rewrite the header: the Teams connector retries through the module, and Slack uses its `stackHead`. In `src/netretry.test.ts`, the Daytona-named errors get generic names. Verify: `src/netretry.test.ts` passes, and the Teams tests are unchanged.
- [ ] 1.8 The CLI probe:
  - `src/cliprobe/sandbox.ts` is ssh-docker only. `SANDBOX_DRIVER` stays required in the probe's environment and accepts only `ssh-docker`; `daytona` is refused with the D3 wording before any sandbox is created.
  - The configuration it builds by hand (lines 128-136, cast to `Config`) loses the `daytona` block, `SNAPSHOT_NAME`, the CPU, memory and disk values and `autoStopMinutes`. It keeps the fields that `SshDockerDriver` reads: `sshDocker`, `snapshot.image` and `sandbox.namePrefix`.
  - The header comment and the `driverFromEnv` comment are updated.
  - `src/cliprobe/report.ts:69`, `src/cliprobe/types.ts:9`, `src/cliprobe/ctx.test.ts:172` and `src/claudeSession.recorded.test.ts:135` describe a transport's copy of stdin without naming Daytona. The `echo` record kind stays (D1).

  Verify:
  - the cliprobe tests, with new cases: `driverFromEnv` refuses `daytona`, refuses a missing `SANDBOX_DRIVER`, and accepts `ssh-docker` with the label `sandbox (ssh-docker)`;
  - `npm run cli-probe -- check`.
- [ ] 1.9 Comments in shared code drop Daytona, or the assumption of its behaviour:
  - `src/claudeSession.ts` (354, 483, 933);
  - `src/tasks.ts` (74, 135, 241, 319);
  - `src/tasks.ts` (114-117) and `src/turn.ts` (575-579): say what really ends a dropped session process. On ssh-docker today, nothing does until its container restarts. If the reaping fix (D9) has landed first, name it instead;
  - `src/state.ts` (35, 212);
  - `src/pollers.ts` (305);
  - `src/sshdocker.ts` (9, 15-16, 42, 215, 433);
  - `src/housekeeping.ts` (21) and `src/project.ts` (42): ssh-docker starts no dockerd from an entrypoint. It runs `sleep`, and dockerd starts lazily;
  - `src/chat/core/commands.ts` (68-69, 140-141);
  - `src/chat/views.ts` (128);
  - `src/chat/slack/blocks.ts` (2);
  - the "no Slack/Daytona deps" headers of `src/format.ts`, `src/pr.ts`, `src/schedule.ts` and `src/steps.ts` (2, 5);
  - `src/sources/serve.ts` (5).

  Verify:
  - `git grep -n -i daytona -- src scripts` lists only the refusal and warning texts of 1.3, 1.4, 1.5 and 1.8, and their tests;
  - the grep finds only the word, so the lines that assume Daytona's behaviour without naming it are checked by reading them in the PR.
- [ ] 1.10 Test stubs:
  - `autoStopMinutes` leaves the seven config stubs: `src/chat/slack/{commands,events,pollers,turn}.record.test.ts`, `src/chat/slack/twin.test.ts`, `src/chat/teams/commands.test.ts` and `src/chat/teams/pollers.record.test.ts`;
  - `src/chat/slack/commands.record.test.ts` drops its `DAYTONA_*` env juggling (217-218, 292-293);
  - in `src/chat/teams/config.test.ts`, `BASE` drops `SNAPSHOT_NAME`, and `KEYS` gains `SANDBOX_DRIVER` and `DAYTONA_API_URL`. Tests skip `.env`, so a developer shell that exports either one must not change the result.

  Verify: `npm test`.

## 2. Chat surfaces

- [ ] 2.1 `StatusReport.daytonaOk` becomes `sandboxesOk` in `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/teams/cards.ts` and `src/chat/teams/cards.test.ts`. Slack's health line says `Sandboxes` (`src/chat/slack/blocks.ts:721`, D8). Verify: re-capture `src/fixtures/chat/commands/status.json` with `UPDATE_SNAPSHOTS=1`. Its diff is `_Daytona ⚠️` → `_Sandboxes ⚠️`, and `src/fixtures/chat/teams/cards.json` is unchanged.
- [ ] 2.2 `src/sshdocker.ts`, `listStates` (D8): the listing throws when its command exits non-zero, and the error carries the tail of its stderr. A pure helper turns the exit code, stdout and stderr into the state map or an error. `getSandbox` is unchanged (D8, out of scope). Verify in `src/sshdocker.test.ts`:
  - exit 0 parses exactly as before;
  - exit 255 (ssh) and exit 1 (the Docker daemon) throw, with the stderr tail;
  - the existing cases are unchanged.
- [ ] 2.3 Re-capture `src/fixtures/chat/commands/memory-live-no-sandbox.json`. The twin has no driver settings, so the error now names `SSHDOCKER_HOST`. Verify: `git diff --stat src/fixtures` lists exactly the two re-captured files of 2.1 and 2.3, and the new `reload-refuses-daytona.json` of 1.5.
- [ ] 2.4 Home tab (CLAUDE.md: a Slack UI change updates the Home tab): no change. Its `/aven status` line ("a live view of sandboxes…") names no provider and stays right. Verify: `src/fixtures/chat/interactions/home.json`, `home-client.json` and the Teams home card in `src/fixtures/chat/teams/cards.json` are unchanged.
- [ ] 2.5 Prompt goldens: no change. The base prompt names no driver. Verify: `git diff --stat src/fixtures/prompt` is empty.

## 3. Dependencies, CI and release notes

- [ ] 3.1 `npm uninstall @daytonaio/sdk` (D10). Verify:
  - a JSON diff of the lockfile's `packages` shows no entry left under `node_modules/@daytonaio/` or `node_modules/@daytona/`, none added, and no version changed;
  - `npm ci` prints no deprecation warning for the SDK;
  - `npm audit --package-lock-only` lists no advisory whose path goes through a removed package;
  - the PR body quotes the counts measured then. They will differ from the proposal's.
- [ ] 3.2 `.github/dependabot.yml`: drop the `ignore` block and its comment. The header keeps "security updates only, no version-update PRs". Verify: `git diff` shows only that block and the header line. After the merge, the repository's Dependabot page lists the configuration without an error.
- [ ] 3.3 `.github/release.yml` (D12): a "⚠️ Breaking" category, listed first and matched by the label `breaking`. Verify: the file parses as YAML, and the categories after it are unchanged. Task 8.2 checks the generated notes at the tag.
- [ ] 3.4 The CI workflows need no change, because no step depends on the SDK. Verify: the PR's CI `verify` and `hub` jobs are green.

## 4. Templates

- [ ] 4.1 `.env.example`:
  - the Daytona block goes, whatever its lines hold by then; so do `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES`;
  - `SANDBOX_DRIVER=ssh-docker` stays written out (D6: earlier releases default to `daytona`). It heads the ssh-docker block, with `SSHDOCKER_HOST` (`local`, or a host) and `SSHDOCKER_RUNTIME`;
  - the snapshot comment loses "snapshot name";
  - the "dev vs prod on a SHARED Daytona" note becomes "dev and prod on one Docker host" (`SANDBOX_NAME_PREFIX`, `SANDBOX_MANAGED_BY`).

  Verify: `src/cliprobe/gate.test.ts` passes (its CLI pin line is untouched), and gitleaks and the public guard are clean.
- [ ] 4.2 `infra/deploy/ops.example/.env.example`: the same removals. Add the ssh-docker block that the template lacks today, with `SANDBOX_DRIVER=ssh-docker` written out. Verify: gitleaks and the public guard are clean.

## 5. Docs

- [ ] 5.1 Rewrite `docs/sandbox-drivers.md` along D6. It keeps its file name. Sections:
  - ssh-docker. Its *Auto-stop* row says that nothing stops an idle container and each conversation's process lives until the container restarts (D9). It no longer says that an idle container costs nothing;
  - *Selecting the driver*. Both settings are optional, and the doc writes `SANDBOX_DRIVER=ssh-docker` because earlier releases default to `daytona`;
  - *Moving a project to ssh-docker*: a new sandbox, and what does not carry over;
  - *Inspecting a sandbox*: the `docker exec` line from D13;
  - *Adding a driver*: the contract;
  - *Retired: Daytona*: what it offered (D9).

  The dated verification history stays. Verify: reviewed in the PR, and the links from `README.md`, `CLAUDE.md` and `docs/README.md` still resolve.
- [ ] 5.2 `docs/local-dev.md`. The isolation section explains that sandboxes collide only when dev and prod share a Docker host (`SSHDOCKER_HOST`), and covers `SANDBOX_NAME_PREFIX` and `SANDBOX_MANAGED_BY`. Then:
  - no Daytona credentials among the prerequisites or in the variables table;
  - no snapshot step on first use;
  - dev containers are removed with `docker rm`.

  Verify: reviewed in the PR.
- [ ] 5.3 Entry points:
  - `README.md`: the diagram line (30) and the quickstart (44-51);
  - `CLAUDE.md`: line 3, line 36, and the driver paragraph (80-85), which describes one driver, the seam and no provider SDK;
  - `SECURITY.md:8`;
  - `docs/README.md:27`;
  - the `package.json` description.

  Verify: reviewed in the PR, and the public guard is clean.
- [ ] 5.4 Passing mentions:
  - `docs/how-we-work.md:150` and `docs/why.md:186`;
  - `docs/sources.md:389` and `docs/observability.md:4`;
  - `docs/runtime-config.md` (291, 352-353);
  - `docs/cli-probe.md` (49-51);
  - `docs/stream-json-contract.md`: line 42, and the "Daytona transport mapping" from line 99, which becomes the driver contract and the ssh-docker mapping;
  - `docs/memory.md` (152-155, 181, 219) and `docs/housekeeping.md:70`;
  - `docs/multitenancy.md`: the current parts (99, 293, 335), plus one dated note above the 2026-07 option analysis, which otherwise stays.

  Verify: reviewed in the PR.
- [ ] 5.5 Tooling comments:
  - `infra/deploy/README.md:12`, `infra/deploy/deploy.sh:4` and `infra/deploy/coach-aven.service.tmpl:10`;
  - `snapshot/Dockerfile`: lines 3-6, and line 38, where the driver overrides the entrypoint with `sleep` and dockerd starts lazily;
  - `snapshot/plain/Dockerfile`: lines 15-16, and line 45, where "the drivers" becomes "the driver";
  - `snapshot/build-and-push.sh`: the comment on lines 5-7, and the Daytona hint on line 97, which is deleted.

  Verify:
  - `src/chat/teams/deploy.test.ts` passes, since it renders from the template;
  - `bash -n infra/deploy/deploy.sh && bash -n snapshot/build-and-push.sh`, run as two separate checks: a second file given to one `bash -n` is not parsed.
- [ ] 5.6 `.claude/skills/manage-project/SKILL.md`:
  - the `driver` row says to set `"ssh-docker"`. Omitting the field works only on releases after the removal;
  - the `peek-sandbox` line becomes the `docker exec` line (D13).

  Verify: reviewed in the PR.
- [ ] 5.7 History stays history. Verify: `git grep -n -i daytona -- . ':!openspec/changes/archive' ':!openspec/changes/retire-daytona-driver'` lists only:
  - the refusal and warning texts and their tests;
  - the *Retired: Daytona* section of `docs/sandbox-drivers.md`;
  - the ledger in `docs/rollout.md`;
  - the dated notes (`docs/stream-json-contract.md:11`, `docs/memory.md:114`, the option analysis in `docs/multitenancy.md`);
  - the in-flight records named in D14.

## 6. Rollout and the PR

- [ ] 6.1 `docs/rollout.md` (D11):
  - one ledger row, naming the bucket parts (the removal and the default flip; the status word and the listing check; the refusals; the warnings) and the breaking note. What to watch:
    - the home bot's first boot: no `config:` warning, and `Sandboxes ✅`;
    - one warning on an installation that kept a retired key;
    - the refusals, which only the tests cover;
    - until the reaping fix (D9) ships, the sandbox host's free memory and the `claude` processes per container;
  - a *Retired* entry for the Daytona settings.

  Verify: `grep -n 'retire-daytona-driver' docs/rollout.md` shows both the ledger row and the *Retired* entry, and the public guard is clean.
- [ ] 6.2 The PR:
  - the D12 title;
  - the label `breaking` alone (D12; create it if the repository lacks it);
  - a body that names the bucket parts, the ledger row, the breaking note, and the counts measured in 3.1.

  Verify: CI `verify` is green: typecheck, tests, the cli-probe check, the public guard on the tree and on the PR text, and gitleaks.

## 7. After the merge

- [ ] 7.1 For each installation whose first boot on the new code logs a `config:` warning: delete the settings it names from that installation's `.env` in its ops repository. Keep `SANDBOX_DRIVER=ssh-docker`. Then export and restart. Verify: the next boot logs no `config:` warning.
- [ ] 7.2 In-flight changes (D14): none is edited. `agent-messaging` D12, D13 and task 0.2, and one sentence of `agent-skills`' design, stay as records. Verify: the code PR's `git diff --stat openspec/changes` lists only this change's own files.
- [ ] 7.3 Archive the change after the merge, which creates `openspec/specs/sandbox-drivers/`. Section 8 runs on the tag's schedule, and the archive does not wait for it. Verify: `openspec validate --specs --strict`.

## 8. At the tag (the archive does not wait for it)

- [ ] 8.1 Before the tag, for each installation:
  - `SANDBOX_DRIVER=ssh-docker` is set (D6: a rollback stays safe);
  - every project's `driver` is absent or `ssh-docker`. Check per element: `jq -r '.projects[] | "\(.slug) \(.driver)"' projects.config.json`, never one fallback over the whole array.

  Verify: `npm run ops -- <slug> import` shows that the box equals the overlay that was checked.
- [ ] 8.2 When the tag is cut, the D12 upgrade note goes at the top of the release notes, naming the last release with Daytona. Verify with `gh release view <tag>`: the note is at the top, and the generated notes list the PR under *Breaking*.
