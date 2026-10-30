# Tasks

## 1. One runtime in the deploy script

- [x] 1.1 (2026-10-30: 589 → 444 lines; `deploy.test.ts` one-runtime test, every compose case unchanged, `deploy.compose.test.ts` refusal message) `infra/deploy/deploy.sh`: `RUNTIME` retired in `load_env` (absent or `compose` accepted; `systemd` refused naming v0.43.0 and the checklist; anything else refused naming `compose`); the systemd functions (`render_unit`, the systemd `cmd_install`, the tar `cmd_deploy`, `cmd_logs`/`cmd_status`/`cmd_start`/`cmd_stop`/`cmd_restart`/`cmd_down`, `is_compose`) and the `render-unit` subcommand removed; the compose functions take the plain names; the header describes one runtime. Verify: `bash infra/deploy/deploy.sh` prints the help; `src/chat/teams/deploy.test.ts` — no `RUNTIME` renders the compose file, `RUNTIME=compose` the same bytes, `RUNTIME=systemd` refused with the pointer, `RUNTIME=docker` refused naming `compose`; every compose render case and `src/chat/teams/deploy.compose.test.ts` unchanged.
- [x] 1.2 (2026-10-30) The unit templates removed: `infra/deploy/coach-aven.service.tmpl`, `coach-aven-sources-daemon.service.tmpl`, `coach-aven-sources.service.tmpl`. Verify: `git ls-files infra/deploy` lists `compose.yaml`, `deploy.sh`, `nginx-sources.conf.example`, `README.md` and `ops.example/`; `grep -rn 'service.tmpl'` over the tree finds nothing.
- [x] 1.3 (2026-10-30: `CHAT_DRIVER` test over the compose render) The chat-driver tests move from the unit to the compose file: `CHAT_DRIVER=teams` and `web` render the command, an unknown driver is refused with the list. Verify: `npm test`.

## 2. Nothing beside the code

- [x] 2.1 (2026-10-30: `SENTRY_RELEASE` only; the guard passes without the exception) `src/config.ts`: the Sentry release is `SENTRY_RELEASE` or nothing; `.release` leaves `.gitignore`, `.dockerignore`, the comments of `src/paths.ts` and the guard's exception in `src/paths.test.ts`. Verify: `npm test` (the guard passes without the exception); `grep -rn '\.release'` finds only the README's cleanup list and the archived change.
- [x] 2.2 (2026-10-30: `src/mirrors.test.ts` asserts the script is gone) `scripts/mirror.ts` removed; `src/mirrors.test.ts` pins `orch mirror` alone; the comments in `src/mirrorjob.ts` and `src/mirrors.ts`. Verify: `npm test`; `npm run orch -- mirror --help`.

## 3. Docs and the ledger

- [x] 3.1 (2026-10-30) `infra/deploy/README.md`: one runtime in the intro, the *Files* table and the day-2 table; the move checklist for an installation on v0.43.0's systemd deploy, with the sentence that there is no way back; the legacy section removed. Verify: the public guard; `grep -n -i systemd infra/deploy/README.md` shows only the checklist.
- [x] 3.2 (2026-10-30; actionlint not installed locally — the workflow's shell step changed by deletion only) The ops template: `deploy.env.example` (no runtime key; `SERVICE_NAME` is the compose project and the journal tag), `ops.example/README.md` and `.env.example` name `orch mirror`, the deploy workflow's header describes one runtime. Verify: `actionlint` on the workflow; the public guard.
- [x] 3.3 (2026-10-30) `docs/runtime-config.md` (the installation directory without the `.release` exception; the mirror crontab line only), `docs/sources.md` (the daemon as the compose service), `docs/local-dev.md`. Verify: the public guard.
- [x] 3.4 (2026-10-30: #108) `docs/rollout.md`: the compose row's *Default since* = this change, its rollback column reads "none — the systemd path is retired"; a *Retired* row for `RUNTIME`. Verify: the diff of `docs/rollout.md`.

## 4. Verification

- [x] 4.1 (2026-10-30: typecheck, 2016 tests, guard clean, 32 OpenSpec items valid) `npm run typecheck`, `npm test`, the public guard, `openspec validate retire-systemd-deploy --strict`. Verify: all green.
- [x] 4.2 (2026-10-30: `status` against the canary overlay from the worktree — the pin and the container shown; a scratch overlay with `RUNTIME=systemd` refused with the pointer) Against the canary installation: `deploy.sh <slug> status` with its overlay (a leftover `RUNTIME=compose`) answers as before. Verify: the pin and the container shown.
