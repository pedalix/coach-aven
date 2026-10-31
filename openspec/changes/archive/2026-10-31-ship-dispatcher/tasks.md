# Tasks

## 1. deploy.sh: local installations and the pinned version

- [x] 1.1 `DEPLOY_HOST=localhost`: `dssh` runs `bash -c` / `bash -s` locally, and the ssh preflight is skipped (design D8). Verify: a new case in `src/chat/teams/deploy.test.ts` runs `deploy.sh <tmp-slug> deploy sha-<40 hex>` with `DEPLOY_HOST=localhost`, a fake `docker` on `PATH` and a fake `ssh` that fails the test if called; the pin lands in `<REMOTE_DIR>/compose/.env`.
- [x] 1.2 A remote host is unchanged. Verify: a test with a fake `ssh` on `PATH` asserts the same argv (`-o … deployer@h bash -s`) for `deploy` as before this change.
- [x] 1.3 `deploy.sh <slug> pinned` prints the pinned `AVEN_VERSION` (or nothing and exit 1 when there is no pin), over ssh or locally (design D4). Verify: tests for localhost (temp `compose/.env`) and for remote (fake `ssh` echoes a pin).

## 2. The planner (`src/ship.ts`, pure)

- [x] 2.1 Staged installations from overlays: `STAGE` parsing, sort by stage, refusal naming `STAGE` and the file for an unstaged slug. Verify: `src/ship.test.ts` — *Overlay without a stage*, *Order follows the stage*.
- [x] 2.2 Candidate choice: lowest stage = newest commit with green CI and a published image (reporting the skipped newer commit); stage N = the commit stage N-1 runs (oldest of several; refusal on divergence). Verify: `ship.test.ts` — *The newest commit is still building*, *Promoting staging's commit to prod*.
- [x] 2.3 Stage rule for explicit `--commit`/`--version`: ancestor-or-equal of a lower stage's pinned commit; lowest stage exempt. Verify: `ship.test.ts` — *Skipping a stage* refused, *Rollback passes the check* allowed.
- [x] 2.4 Version for a release step: reuse an existing tag on the commit; else next minor if any merged PR since the highest reachable `vX.Y.Z` has `feature`, else next patch; `--version` overrides. Canary steps get `sha-<commit>`. Verify: `ship.test.ts` — *Re-shipping a tagged commit*, *Only fixes*, *A feature*, *Home takes main's image*.
- [x] 2.5 Plan rendering (version, commit, range, PR titles per step) as a pure function. Verify: `ship.test.ts` golden string for a three-stage plan.

## 3. The CLI (`src/shipcli.ts`): ship, where

- [x] 3.1 Inputs: overlays from the current checkout (exit naming the overlays' checkout from `git worktree list` when there are none), pinned versions via `deploy.sh <slug> pinned` in parallel with a 10 s timeout, CI/image state via `gh run list` for `ci.yml`/`image.yml` on `main`, merged PRs from first-parent merge commits + `gh pr view --json labels`, `git fetch --tags`. Verify: `npm run ship -- --plan home` on the home checkout prints a plan and changes nothing (`git tag`, `infra/ships.log` unchanged).
- [x] 3.2 Lock `infra/.ship.lock` (exclusive create, `{pid, host, slugs, startedAt}`, removed on exit/SIGINT/SIGTERM, stale pid cleared with a message); `--plan` and `where` take no lock. Verify: `src/ship.test.ts` covers the lock helper with a temp dir (held → second acquire fails naming slugs and time; dead pid → reclaimed).
- [x] 3.3 Execute steps in stage order: for a release step `git tag` + `git push origin <v>` (with `git push --dry-run` checked first), wait for that tag's `release.yml` run (`gh run watch`, 20 min), then `deploy.sh <slug> deploy <version>`; stop at the first failure naming the slug and the previous pinned version; append one `infra/ships.log` line per step. Verify: a `shipcli` test with stubbed command runner — three steps journaled `ok`; a failing second step leaves the third untouched and journals `failed`.
- [x] 3.4 `where [<PR#>|<commit>]`: per staged installation version, commit, commits behind `main`; with an argument ✓/✗ by ancestry; `unreachable` + non-zero exit when a pin cannot be read. Verify: stubbed-runner tests for *Is my PR live?* and *A box is unreachable*; manually `npm run where -- <a merged PR>` on the home checkout.
- [x] 3.5 `package.json` scripts `ship` and `where`. Verify: `npm run ship -- --help`, `npm run where -- --help`.

## 4. Preview (`src/preview.ts`, `src/previewcli.ts`)

- [x] 4.1 Pure builder (design D10): from the real `quickstart/.env.example` and `quickstart/projects.config.example.json` plus a `preview.env` map → `.env` text (credit, `GITHUB_TOKEN` from `preview.env`; `WEB_AUTH=none`, `WEB_BIND=127.0.0.1`, port, base URL, `AVEN_DIR`/`AVEN_DATA_DIR`, `pv-<branch-slug>-` prefix, `coach-aven-preview` label; `SANDBOX_IMAGE` override) and projects config (`demo` on `PREVIEW_REPO`). Verify: `src/preview.test.ts` reads the real templates — *First preview on a machine*; *Missing operator file* (names the missing keys); the output has no `SLACK_`/`TEAMS_`/`HUB_`/`YOUTRACK_` key; branch `fix/thread` → prefix `pv-fix-thread-`.
- [x] 4.2 `npm run preview`: read `~/.config/coach-aven/preview.env` (refuse naming the file/keys when absent), first free port from 8790, write `.preview/.env` + `.preview/projects.config.json` each start, default sandbox image = plain image of the newest release tag, detached `tsx src/cli.ts web` with `AVEN_DIR=<wt>/.preview`, pid + log files, wait for `Web chat running`, print the URL. Verify: in a worktree, `npm run preview` → `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790` answers; a turn in `demo` creates `pv-<branch>-proj-demo` and answers about the scratch repo; a second worktree gets 8791.
- [x] 4.3 `npm run preview -- stop [--clean]`: kill the pid, remove `pv-<branch-slug>-*` containers, keep `.preview/` unless `--clean`. Verify: after stop, the port is free and `docker ps -a --filter name=^pv-` lists none of the branch's containers; home's `proj-*` containers unchanged.
- [x] 4.4 `.gitignore`: `.preview/`. Verify: `git check-ignore .preview/bot.log`.

## 5. Skill and docs

- [x] 5.1 `.claude/skills/ship/SKILL.md`: `ship --plan`, for a release stage one fresh read-only reviewer agent on `git diff <prod version>..<candidate>`, one screen (version, PRs, findings) to the maintainer, `ship` only on an explicit go; `where` to answer "is it live?"; `preview` before merge on request (design D9). Verify: the skill lists in a fresh session (`/skills`), and a dry walk with `--plan` shows the screen.
- [x] 5.2 `docs/rollout.md`: replace the "~2 days on the canary" tag rule with the stage rule (prod gets what a lower stage runs, enforced by `ship`); keep the flag lifecycle. Verify: `grep -n '2 days' docs/rollout.md` returns nothing in the process section.
- [x] 5.3 `CLAUDE.md` Release bullet: deploys go through `npm run ship`; `where` answers what runs where; `preview` before merge. Verify: `npm test` (the prompt/fixture tests that read CLAUDE.md, if any) and a reread.
- [x] 5.4 `infra/deploy/README.md` (`STAGE`, `ship`, `where`, `pinned`, localhost) and `infra/deploy/ops.example/deploy.env.example` (`STAGE` commented with an example). Verify: `bash scripts/public-guard.sh` passes (no installation names in examples).
- [x] 5.5 `docs/local-dev.md`: `npm run preview` section (the quickstart shape from source; `preview.env` with its three values and how to make the scratch-repo token; reads no installation; its turns are real on the scratch repo). Verify: reread; `public-guard` passes.
- [x] 5.6 `docs/rollout.md` ledger row: "One deploy path: `ship` / `where` / `preview` (OpenSpec `ship-dispatcher`)" — bucket 2, no bot change; gate = `STAGE` in an overlay. Verify: the row is present in the PR diff.

## 6. Gate

- [x] 6.1 `npm run typecheck` and `npm test` green. Verify: both exit 0.
- [x] 6.2 `openspec validate ship-dispatcher --strict` passes. Verify: exit 0.

## Workflow follow-up

- Operator (not in this repo): `STAGE` in each ops overlay (home 1, staging 2, prod 3); local guard hook denies direct deploys and asks before a release-stage `ship` (design D11); `~/.config/coach-aven/preview.env` with the credit, the GitHub App (or a fine-grained token) reaching the scratch repo, and `PREVIEW_REPO`.
- First runs per the Migration Plan in design.md; then `/opsx:archive`.
