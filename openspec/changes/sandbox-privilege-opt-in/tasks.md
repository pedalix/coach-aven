# Tasks

## 1. First merge (#156, superseded in part)

- [x] 1.1 `SANDBOX_DEFAULT`, `"dind": true` implies privileged, three warnings, templates and docs (#156). Never in a tag; reworked in section 2.

## 2. Image and privilege per project (bucket 2)

- [x] 2.1 Remove `SANDBOX_DEFAULT` (code, templates, docs); a leftover value is named in the boot's settings line. `privilegeWarnings`: block-less projects (fix `"dind": true`), local privileged unconfirmed; the runtime warning goes. Verify: `src/sandboxopts.test.ts`, `src/projects.test.ts`.
- [x] 2.2 `sandbox.image`: validated in `resolveSandboxOptions` (a non-empty image reference), `ensureImage(image)` and `docker run` use the project's image or `SANDBOX_IMAGE`. Verify: the `docker run` script carries it; a block-less project's script is byte-identical to today's.
- [x] 2.3 The names: `SANDBOX_IMAGE`/`SANDBOX_HOST`/`SANDBOX_DIND_RUNTIME`, old names as fallbacks with one boot line (`src/config.ts`, `src/cliprobe/sandbox.ts`, `infra/deploy/deploy.sh`, the quickstart compose file). Verify: `src/config.test.ts` (new, old, both), `src/quickstart.test.ts`, `src/chat/teams/deploy.test.ts` (the host deploy.sh picks: new, old, both, empty, repeated).
- [x] 2.4 Templates and docs in the new names: `.env.example`, `quickstart/.env.example`, `infra/deploy/ops.example/.env.example`, `docs/configuration.md`, `docs/sandbox-drivers.md`, `docs/security.md`, `docs/troubleshooting.md`, `docs/local-dev.md`, `docs/quickstart.md`, `README.md`, `snapshot/README.md`, the manage-project skill. Verify: `src/configdocs.test.ts`, doclinks, the public guard.
- [x] 2.5 `docs/rollout.md`: the row reworded (bucket 2 now; the flip later, bucket 3).
- [x] 2.6 One PR (#157); typecheck, tests, guard, gitleaks, an independent review.

## 3. Operators

- [x] 3.1 Home: drop `SANDBOX_DEFAULT`, rename the settings. Staging: rename. Prod: rename, and `"dind": true` on its 11 block-less projects (no behaviour change), at the next tag. *Done 2026-10-31: home and staging on main 304690f, prod on v0.48.0.*
- [x] 3.2 Verify: no `sandboxes:` warning and no old-name line in any boot log.
- [x] 3.3 The old names retired (bucket 3, the maintainer: right after the rollout): no fallback, no boot line, `deploy.sh` reads `SANDBOX_HOST` only.

## 4. Later

- [x] 4.1 The flip, its own PR (bucket 3): block-less = plain; the block-less warning gone. No container listing: no operated project is block-less, and the release notes and `docs/troubleshooting.md` say to write `"dind": true` and `docker rm` the container.
- [ ] 4.2 Archive this change after 3.2, renaming the settings in the main specs (`sandbox-drivers`, `container-deploy`, `bot-image`, `sandbox-idle-stop` still say the old names).
