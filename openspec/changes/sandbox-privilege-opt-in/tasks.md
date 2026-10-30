# Tasks

## 1. Settings and one resolved shape (bucket 2, stage 1)

- [x] 1.1 `src/config.ts`, as plain `process.env` reads so the configuration-docs test finds them:
  - `SANDBOX_DEFAULT` (`dind` | `plain`, anything else is a boot error) and `sandboxDefaultSet`;
  - `sshDocker.runtimeSet`;
  - `SANDBOX_LOCAL_PRIVILEGED`.

  `src/cliprobe/sandbox.ts`'s own `Config` gains the same fields. Verify in `src/config.test.ts`: each value, an invalid one, unset.
- [x] 1.2 `resolveSandboxOptions(input, installationDefault)`: a `dind: true` block without `privileged` implies privileged. `loadProjects` keeps `resolvedSandbox` on each project; `/aven reload` (`src/chat/core/commands.ts`) and `src/sources/cli.ts` load through it. Verify in `src/sandboxopts.test.ts` and `src/projects.test.ts`:
  - unset gives today's resolution;
  - a `plain` default;
  - field-by-field override;
  - `{ dind: true }` under `plain`.
- [x] 1.3 Every reader sees the installation default. *Done by writing the block out: under `plain`, `loadProjects` puts the resolved `sandbox` block on each project, so the five readers need no change, and under `dind` or unset the config stays as written. A per-project `resolvedSandbox` field was not needed.* Originally:
  - `src/sshdocker.ts` (flags);
  - `src/tasks.ts` (dockerd guard, prompt input);
  - `src/prompt.ts`;
  - `src/pollers.ts` (housekeeping guard);
  - `src/idlestop.ts` (`dindOf`).

  Verify, unchanged byte for byte for today's configurations (prod's block-less shape, staging's and home's plain blocks): the `docker run` argv goldens, the golden prompts (`src/fixtures/prompt/`), the housekeeping and idle-stop scripts. Then one test with `SANDBOX_DEFAULT=plain` and a block-less project that checks all five sites.

## 2. Warnings

- [x] 2.1 Three pure warning functions in `src/sandboxopts.ts` (design D2: the runtime warning keyed on privileged), logged once at boot from `src/chat/root.ts` and by `/aven reload` for added projects. Verify with a test per function:
  - prod's shape gives the implicit-default warning only;
  - staging's and home's shapes give none;
  - local plus privileged without the confirmation warns;
  - `{privileged: true, dind: false}` without a runtime warns.

## 3. Templates and docs

- [x] 3.1 `SANDBOX_DEFAULT` written out with a one-line comment in:
  - `.env.example`;
  - `quickstart/.env.example` (`plain`);
  - `infra/deploy/ops.example/.env.example` (a dotfile; `deploy.env.example` beside it is the deploy target's).

  `SANDBOX_LOCAL_PRIVILEGED` goes in commented. The root `projects.config.example.json` gives its block-less projects a `sandbox` block. Verify: `src/configdocs.test.ts` (rows in `docs/configuration.md` are required), `src/quickstart.test.ts`, the public guard.
- [x] 3.2 Docs:
  - `docs/security.md`: the privileged-default note and one egress line, no recipe (design D3);
  - `docs/sandbox-drivers.md`: the three settings and which image goes with which default;
  - `docs/configuration.md`: the rows;
  - `docs/troubleshooting.md`: the three warnings.

  Verify: doclinks, guard, a read.
- [x] 3.3 `docs/rollout.md`: the row "sandbox privilege opt-in", bucket 2 (stage 1: settings and warnings). It names stage 2 (bucket 3: unset is an error, containers listed and recreated) as a later change and its own row.

## 4. Ship and stage

- [ ] 4.1 One PR for sections 1–3. Verify: typecheck, tests, guard, gitleaks, an independent review.
- [ ] 4.2 **Operators:**
  - prod sets `SANDBOX_DEFAULT=dind` (and keeps `SSHDOCKER_RUNTIME=sysbox-runc`);
  - staging and home set `SANDBOX_DEFAULT=plain`;
  - each restarts in its window.

  Verify: no privilege warning in any boot log.
- [ ] 4.3 Archive after 4.2. Stage 2 is its own change.
