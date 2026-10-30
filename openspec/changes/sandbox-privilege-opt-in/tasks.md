# Tasks

## 1. Settings and resolution (bucket 3, stage 1)

- [ ] 1.1 `src/config.ts`: `SANDBOX_DEFAULT` (`dind` | `plain`, anything else is a boot error), `sandboxDefaultSet`, `sshDocker.runtimeSet`, `SANDBOX_LOCAL_PRIVILEGED`. Verify in `src/config.test.ts`: each value, an invalid one, unset.
- [ ] 1.2 `resolveSandboxOptions(input, installationDefault)` and `loadProjects` pass the default; unset means `dind`. Verify: today's resolutions byte for byte for a block-less project, the plain default, field-by-field override (`src/sandboxopts.test.ts`, `src/projects.test.ts`); the ssh-docker `docker run` goldens unchanged.

## 2. Boot warnings

- [ ] 2.1 Three pure warning functions in `src/sandboxopts.ts` (design D2), logged once from `src/chat/root.ts` after the projects load. Verify with a test per function:
  - prod's shape gives the implicit-default warning only;
  - staging's and home's shapes give none;
  - local plus privileged without the confirmation warns.

## 3. Templates and docs

- [ ] 3.1 `.env.example` and `infra/deploy/ops.example/.env.example`: `SANDBOX_DEFAULT` written out with a one-line comment each; `SANDBOX_LOCAL_PRIVILEGED` commented. `projects.config.example.json`: the `sandbox` block on its projects. Verify: the configuration-docs test (every setting documented), the public guard.
- [ ] 3.2 Docs:
  - `docs/security.md`: the trust note and the egress allow-list recipe (design D3);
  - `docs/sandbox-drivers.md`: the three settings;
  - `docs/configuration.md`: the new rows;
  - `docs/troubleshooting.md`: the three warnings.

  Verify: doclinks, guard, a read.
- [ ] 3.3 `docs/rollout.md`: the row "sandbox privilege opt-in", bucket 3. Stage 1 is warnings; stage 2 (plain default and errors) is a later change after prod sets `SANDBOX_DEFAULT=dind` and staging and home set `plain`.

## 4. Ship and stage

- [ ] 4.1 One PR for sections 1–3. Verify: typecheck, tests, guard, gitleaks, an independent review.
- [ ] 4.2 **Operators:** prod sets `SANDBOX_DEFAULT=dind`; staging and home set `SANDBOX_DEFAULT=plain`, each with a restart in its window. Verify: no privilege warning in each boot log.
- [ ] 4.3 Archive after 4.2; stage 2 is its own change.
