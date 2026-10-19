## 1. The driver goes

- [ ] 1.1 Delete `src/daytona.ts`, `src/daytona.test.ts` and `scripts/peek-sandbox.ts` (design D13). Verify: `npm run typecheck` names every remaining importer (`src/driver.ts`, `src/cliprobe/sandbox.ts`), and each one is handled below.
- [ ] 1.2 `src/driver.ts`:
  - `createDriver` returns the ssh-docker driver; the `kind` parameter stays (D6);
  - the header says there is one implementation and that the interface is the seam for another;
  - the note on lines 52-54 states the replay-from-start tail as the contract every driver keeps, without crediting Daytona;
  - "auto-stop" on lines 12 and 72 becomes "a stopped sandbox".

  Verify: a new `src/driver.test.ts` shows that `createDriver(cfg)` and `createDriver(cfg, 'ssh-docker')` both return an `SshDockerDriver`.
- [ ] 1.3 `src/config.ts` (D2, D3, D4, D7):
  - `SandboxDriverKind = 'ssh-docker'`;
  - an unset or empty `SANDBOX_DRIVER` gives `ssh-docker`;
  - `daytona` is refused with the D3 error, and any other value with an error naming `ssh-docker`;
  - `DAYTONA_API_URL` with `SANDBOX_DRIVER` unset is refused with the D4 error;
  - the `daytona` block, `snapshot.name`, `snapshot.cpu`, `snapshot.memory`, `snapshot.disk` and `sandbox.autoStopMinutes` go;
  - `snapshot.image` becomes `sandbox.image`, still read from `SNAPSHOT_IMAGE`, and `src/sshdocker.ts` (lines 423, 438) follows;
  - the comments on lines 148-165 are updated.

  The checks are pure exported helpers beside `retiredEnvWarnings`. Verify with `src/config.test.ts`:
  - (a) today's shape: `SANDBOX_DRIVER=ssh-docker`, `SSHDOCKER_HOST` and `SNAPSHOT_IMAGE` give the same driver, host, runtime, image, work directory and name prefix as before;
  - (b) unset gives `ssh-docker`;
  - (c) `daytona` is refused, and the error names `SANDBOX_DRIVER` and the fix;
  - (d) a typo is refused, and the error names `ssh-docker`;
  - (e) the D4 guard refuses `DAYTONA_API_URL` without `SANDBOX_DRIVER`, and lets `DAYTONA_API_URL` with `SANDBOX_DRIVER=ssh-docker` through.
- [ ] 1.4 `retiredEnvWarnings` (D5) adds one line that names whichever of the eight retired settings are present. Verify with `src/config.test.ts`:
  - each key alone gives one line;
  - several keys together give one line naming all of them;
  - none gives no line;
  - the `DISPATCH` case is unchanged.
- [ ] 1.5 `src/projects.ts` (D3):
  - `loadProjects` refuses a `driver` other than `ssh-docker`, with an error naming the project, its field, the accepted value and, for `daytona`, the removal and the fix;
  - the comment on lines 68-71 is updated.

  `projects.config.example.json`: acme-shop loses `"driver": "daytona"`. Verify with `src/projects.test.ts`:
  - `daytona` is refused, and the error names the project;
  - `ssh-dokcer` is refused, and the error names `ssh-docker`;
  - an absent field and `ssh-docker` load without a warning;
  - "the shipped projects.config.example.json loads" still passes.

  At reload, the error takes the existing path that the `reload-fails` recording pins: the error, and "The previous config stays active".
- [ ] 1.6 `src/sandboxopts.ts`: delete `isDefaultSandbox` (only the driver used it). The `assertDeletable` comment drops "Daytona's does"; the guard itself stays (D1). Verify: `src/sandboxopts.test.ts` passes without its two `isDefaultSandbox` assertions, and the guard's tests are unchanged.
- [ ] 1.7 `src/netretry.ts`: drop the `DaytonaConnectionError` name check, and rewrite the header: the Teams connector retries through the module, and Slack uses its `stackHead`. In `src/netretry.test.ts`, the Daytona-named errors get generic names. Verify: `src/netretry.test.ts` passes, and the Teams tests are unchanged.
- [ ] 1.8 The CLI probe:
  - `src/cliprobe/sandbox.ts` is ssh-docker only. `SANDBOX_DRIVER` may be unset or `ssh-docker`; `daytona` is refused with the D3 wording before any sandbox is created. The probe's config loses `SNAPSHOT_NAME`, the CPU, memory and disk values and `autoStopMinutes`. The header comment is updated.
  - `src/cliprobe/report.ts:69`, `src/cliprobe/types.ts:9`, `src/cliprobe/ctx.test.ts:172` and `src/claudeSession.recorded.test.ts:135` describe a transport's copy of stdin without naming Daytona. The `echo` record kind stays (D1).

  Verify: the cliprobe tests (a new case: `driverFromEnv` refuses `daytona`) and `npm run cli-probe -- check`.
- [ ] 1.9 Comments in shared code drop Daytona:
  - `src/claudeSession.ts` (354, 483, 933);
  - `src/tasks.ts` (74, 241, 319);
  - `src/state.ts` (35, 212);
  - `src/pollers.ts` (305);
  - `src/sshdocker.ts` (9, 15-16, 42, 215);
  - `src/chat/core/commands.ts` (68-69, 140-141);
  - `src/chat/views.ts` (128);
  - `src/chat/slack/blocks.ts` (2);
  - the "no Slack/Daytona deps" headers of `src/format.ts`, `src/pr.ts`, `src/schedule.ts` and `src/steps.ts` (2, 5);
  - `src/sources/serve.ts` (5).

  Verify: `git grep -n -i daytona -- src scripts` lists only the refusal and warning texts of 1.3, 1.4, 1.5 and 1.8, and their tests.
- [ ] 1.10 Test stubs:
  - `autoStopMinutes` leaves the seven config stubs (`src/chat/slack/{commands,events,pollers,turn}.record.test.ts`, `src/chat/slack/twin.test.ts`, `src/chat/teams/commands.test.ts`, `src/chat/teams/pollers.record.test.ts`);
  - `src/chat/slack/commands.record.test.ts` drops its `DAYTONA_*` env juggling (217-218, 292-293);
  - `src/chat/teams/config.test.ts` drops `SNAPSHOT_NAME` from `BASE`.

  Verify: `npm test`.

## 2. Chat surfaces

- [ ] 2.1 `StatusReport.daytonaOk` becomes `sandboxesOk` in `src/chat/views.ts`, `src/chat/core/commands.ts`, `src/chat/teams/cards.ts` and `src/chat/teams/cards.test.ts`. Slack's health line says `Sandboxes` (`src/chat/slack/blocks.ts:721`, D8). Verify: re-capture `src/fixtures/chat/commands/status.json` with `UPDATE_SNAPSHOTS=1`. Its diff is `_Daytona ⚠️` → `_Sandboxes ⚠️`, and `src/fixtures/chat/teams/cards.json` is unchanged.
- [ ] 2.2 Re-capture `src/fixtures/chat/commands/memory-live-no-sandbox.json`. The twin has no driver settings, so the error now names `SSHDOCKER_HOST`. Verify: `git diff --stat src/fixtures` lists exactly the two files of 2.1 and 2.2.
- [ ] 2.3 Home tab (CLAUDE.md: a Slack UI change updates the Home tab): no change. Its `/aven status` line ("a live view of sandboxes…") names no provider and stays right. Verify: `src/fixtures/chat/interactions/home.json`, `home-client.json` and the Teams home card in `src/fixtures/chat/teams/cards.json` are unchanged.
- [ ] 2.4 Prompt goldens: no change. The base prompt names no driver. Verify: `git diff --stat src/fixtures/prompt` is empty.

## 3. Dependencies and CI

- [ ] 3.1 `npm uninstall @daytonaio/sdk` (D10). Verify:
  - a JSON diff of the lockfile's `packages` shows 159 entries removed, none added and no version changed;
  - `npm ci` prints no deprecation warning for the SDK;
  - `npm audit --package-lock-only` reports only the one moderate OpenTelemetry advisory.
- [ ] 3.2 `.github/dependabot.yml`: drop the `ignore` block and its comment. The header keeps "security updates only, no version-update PRs". Verify: `git diff` shows only that block and the header line. After the merge, the repository's Dependabot page lists the configuration without an error.
- [ ] 3.3 The CI workflows need no change: no step depends on the SDK. Verify: the PR's CI `verify` and `hub` jobs are green.

## 4. Templates

- [ ] 4.1 `.env.example`:
  - the Daytona block, `SNAPSHOT_NAME`, `SANDBOX_CPU`, `SANDBOX_MEMORY`, `SANDBOX_DISK` and `SANDBOX_AUTOSTOP_MINUTES` go;
  - `SANDBOX_DRIVER=ssh-docker` heads the ssh-docker block, with `SSHDOCKER_HOST` (`local`, or a host) and `SSHDOCKER_RUNTIME`;
  - the snapshot comment loses "snapshot name";
  - the "dev vs prod on a SHARED Daytona" note becomes "dev and prod on one Docker host" (`SANDBOX_NAME_PREFIX`, `SANDBOX_MANAGED_BY`).

  Verify: `src/cliprobe/gate.test.ts` passes (its CLI pin line is untouched), and gitleaks and the public guard are clean.
- [ ] 4.2 `infra/deploy/ops.example/.env.example`: the same removals. Add the ssh-docker block that the template lacks today. Verify: gitleaks and the public guard are clean.

## 5. Docs

- [ ] 5.1 Rewrite `docs/sandbox-drivers.md` along D6. It keeps its file name. Sections:
  - ssh-docker;
  - *Selecting the driver*;
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
  - `docs/stream-json-contract.md` (42, and the "Daytona transport mapping" from line 99, which becomes the driver contract and the ssh-docker mapping);
  - `docs/memory.md` (152-155, 181, 219) and `docs/housekeeping.md:70`;
  - `docs/multitenancy.md`: the current parts (99, 293, 335), plus one dated note above the 2026-07 option analysis, which otherwise stays.

  Verify: reviewed in the PR.
- [ ] 5.5 Tooling comments:
  - `infra/deploy/README.md:12`, `infra/deploy/deploy.sh:4` and `infra/deploy/coach-aven.service.tmpl:10`;
  - `snapshot/Dockerfile`: lines 3-6, and line 38, where the driver overrides the entrypoint with `sleep` and starts dockerd lazily;
  - `snapshot/plain/Dockerfile` (15-16): "the drivers" becomes "the driver";
  - `snapshot/build-and-push.sh`: the comment on lines 5-7, and the Daytona hint on line 97, which is deleted.

  Verify: `src/chat/teams/deploy.test.ts` passes (it renders from the template), and `bash -n infra/deploy/deploy.sh snapshot/build-and-push.sh` is clean.
- [ ] 5.6 `.claude/skills/manage-project/SKILL.md`:
  - the `driver` row says to omit the field, or set `"ssh-docker"`;
  - the `peek-sandbox` line becomes the `docker exec` line (D13).

  Verify: reviewed in the PR.
- [ ] 5.7 History stays history. Verify: `git grep -n -i daytona -- . ':!openspec/changes/archive' ':!openspec/changes/retire-daytona-driver'` lists only:
  - the refusal and warning texts and their tests;
  - the *Retired: Daytona* section of `docs/sandbox-drivers.md`;
  - the ledger in `docs/rollout.md`;
  - the dated notes (`docs/stream-json-contract.md:11`, `docs/memory.md:114`, the option analysis in `docs/multitenancy.md`);
  - the in-flight records named in D14.

## 6. Rollout and release

- [ ] 6.1 `docs/rollout.md` (D11):
  - one ledger row: removal of dead code with bug-fix risk; default-preserving for configurations that select ssh-docker; breaking for an installation that still runs Daytona; what to watch at each installation's first boot on the tag;
  - a *Retired* entry for `SANDBOX_DRIVER=daytona` and the eight settings.

  Verify: the public guard in CI.
- [ ] 6.2 The PR: the D12 title, the label `fix` (as `retire-agent-dispatch` had), and a body that names the bucket, the ledger row and the breaking note. Verify: CI `verify` is green: typecheck, tests, the cli-probe check, the public guard on the tree and on the PR text, and gitleaks.
- [ ] 6.3 When the tag is cut: the D12 upgrade note goes at the top of the release notes, naming the last release with Daytona. Verify: `gh release view <tag>`.

## 7. Operators, in-flight changes, archive

- [ ] 7.1 Before the tag, for each installation:
  - either `SANDBOX_DRIVER=ssh-docker` is set, or `DAYTONA_API_URL` is absent;
  - every project's `driver` is absent or `ssh-docker`. Check per element: `jq -r '.projects[] | "\(.slug) \(.driver)"' projects.config.json`, never one fallback over the whole array.

  Verify: `npm run ops -- <slug> import` shows that the box equals the overlay that was checked.
- [ ] 7.2 After an installation's first boot on the new code, delete the settings its `config:` warning names from the `.env` in its ops repo, then export and restart. Verify: the next boot logs no `config:` warning.
- [ ] 7.3 In-flight changes (D14): none is edited. `agent-messaging` D12, D13 and task 0.2, and one sentence of `agent-skills`' design, stay as records. Verify: the code PR's `git diff --stat openspec/changes` lists only this change's own files.
- [ ] 7.4 After the merge, archive the change, which creates `openspec/specs/sandbox-drivers/`. Verify: `openspec validate --specs --strict`.
