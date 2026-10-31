# Design

## Context

What exists (see proposal.md — Why for the problem):
- `deploy.sh <slug> deploy <version>` already does a whole deploy of one installation: pull → pin (`compose/.env`) → `up -d` → wait for the running line → a line in the box's `deploys.log`. It accepts `vX.Y.Z` everywhere and `sha-<commit>` only with `CANARY=1`.
- The home installation runs on the operator's machine. Its overlay names `DEPLOY_HOST=localhost`, but `deploy.sh` always goes through ssh, so home is deployed with `deploy.sh home remote-script deploy <v> | bash`.
- `ci.yml` verifies every push to `main`, and `image.yml` then publishes `sha-<commit>`. A `v*` tag runs `release.yml` (verify → promote the image to `vX.Y.Z` → GitHub Release). `scripts/release.sh` tags and dispatches the ops workflow.
- The web chat driver runs with `WEB_AUTH=none` on loopback. `docs/local-dev.md` and `docs/web.md` name the settings that keep a second bot apart from an installation: `SANDBOX_NAME_PREFIX`, `AVEN_DIR`/`AVEN_DATA_DIR`, no hub. `quickstart/` holds the smallest complete installation as templates: one `demo` project, a fine-grained `GITHUB_TOKEN`, local unprivileged sandboxes and the web chat.
- Overlays (`infra/<slug>/`) exist only in the operator's main checkout. Worktrees have none.

## Goals / Non-Goals

**Goals:**
- One deterministic command per intent: `ship` (move installations), `where` (what runs where), `preview` (see a change before merge).
- Installations change only through `deploy.sh`. `ship` adds order, the stage rule, tagging, a lock and a journal, nothing on the boxes.
- A session can answer "is my PR live, and where?" without asking the operator.

**Non-Goals:**
- No new component on any box, and no pull or auto-update.
- No model call inside `ship`. Judgement (the review) stays in the session.
- No change to the ops-repo deploy workflow or `release.yml`.

## Decisions

**D1. A TypeScript planner and a thin CLI, not more bash.**
- `src/ship.ts` is pure. It takes the staged installations (slug, stage, canary), their pinned versions, the candidate commits, an ancestry oracle and the merged PRs' labels. It returns either an ordered list of steps (slug, version, commit, tag-to-create) or a refusal with its sentence.
- `src/shipcli.ts` gathers those inputs with git, `gh` and `deploy.sh`, then executes the steps.
- Why: the stage rule, the candidate choice and the version bump are the parts that can be wrong silently, and the repo's rule is that such logic lives in a tested module.
- Alternative rejected: extending `deploy.sh`. It acts on one installation and is tested through bash fixtures, and cross-installation logic would grow it into the mini-orchestrator the container-deploy walkthrough was cut back from.

**D2. `STAGE` in each overlay's `deploy.env`, not a separate ship config.**
- The installation's own file already says how it is deployed (`CANARY`, `CHAT_DRIVER`). One key keeps one place per installation, and it is tracked in the ops repo.
- An overlay without `STAGE` is invisible to `ship`. That is the opt-in.

**D3. A later stage is promoted from the stage below, not from `main`.**
- The default candidate for stage N is the commit that stage N-1 runs. If there are several, it takes the oldest, which is an ancestor of the others; on divergent histories `ship` refuses.
- This makes "prod only gets what already ran" the default path rather than a check that is easy to override.
- Explicit `--commit`/`--version` still go through the same ancestry check (spec: *A release stage only receives what a lower stage already ran*).
- Alternative rejected: a soak time (the 2-day rule). Nothing measured it, and the operator chooses when to promote anyway.

**D4. Truth is read from the installations; the journal is history.**
- `ship` and `where` read each installation's pinned version through a new `deploy.sh <slug> pinned` (prints `AVEN_VERSION` from `compose/.env`: over ssh, or locally for `localhost`).
- `infra/ships.log` records what `ship` did, but a hand deploy or a box restored from backup would make it lie, so no decision reads it.
- `sha-<c>` maps to commit `c`, and `vX.Y.Z` to `git rev-list -n1 vX.Y.Z` (after `git fetch --tags`).

**D5. `ship` tags and deploys from the operator's machine, as `npm run ops -- <slug> deploy` does today.**
- The tag is created locally (`git tag <v> <commit>`, `git push origin <v>`), with the operator's git credentials, as `release.sh` does.
- `ship` waits for that tag's `release.yml` run (`gh run watch`, 20-minute timeout) and then runs `deploy.sh <slug> deploy <v>`. It does not dispatch the ops workflow, so it sees the health check itself and holds the lock across the step.
- `release.sh` and the ops workflow stay unchanged for operators who deploy from GitHub.

**D6. Version bump from first-parent merge commits.**
- `git log --first-parent <last-tag>..<commit>` lists the merge commits. `Merge pull request #N` gives N, and `gh pr view N --json labels` gives the labels.
- If any PR has `feature`, the next tag is the next minor; otherwise the next patch.
- The last tag is the highest `vX.Y.Z` reachable from the commit, not the newest by date, so a hotfix line cannot confuse it.

**D7. The lock is a file in the overlays' checkout.**
- `infra/.ship.lock` is created with exclusive create (`wx`). It holds `{pid, host, slugs, startedAt}` and is removed on exit, including on SIGINT and SIGTERM.
- A lock whose pid is not alive on this host is stale: `ship` removes it and says so.
- `infra/` is ignored except the public tooling directories, so the lock file and `ships.log` are ignored with no new `.gitignore` line.
- `ship` and `where` run in the checkout that holds the overlays. From a worktree without overlays they exit and name that checkout (the first entry of `git worktree list`).

**D8. `localhost` deploys locally inside `deploy.sh`.**
- `dssh` becomes `bash -c "$*"` (`bash -s` for stdin) when `DEPLOY_HOST=localhost`, and the ssh preflight is skipped.
- Every other path is unchanged. A test runs `deploy.sh` with a fake `ssh` on `PATH` and asserts that a remote host still calls it with the same arguments.

**D9. The review is a skill step, not a `ship` feature.**
- `.claude/skills/ship/SKILL.md` runs `ship --plan <slug>`. For a release stage it then spawns one fresh reviewer agent on `git diff <prod version>..<candidate>`, read-only, with the PR review prompt's precision bias, and shows the maintainer one screen: version, PRs, findings.
- It runs `ship` only after the maintainer's explicit go, consistent with "merge needs an explicit go".
- Why not inside `ship`: the host-side tooling stays deterministic, and the maintainer has asked for fewer review layers. One review per release, not per PR.

**D10. Preview: the quickstart's installation, run from source, on a scratch project.**
- No installation is a source, home included: home is a live node of the operator's network. Copying an installation's environment and stripping its identity would be a deny-list that each new setting can slip past. The quickstart already defines the smallest complete installation (`quickstart/.env.example`: credit, `GITHUB_TOKEN`, local unprivileged sandboxes, web chat; `projects.config.example.json`: one `demo` project). A preview is that shape, so it also keeps the quickstart's templates honest.
- `src/preview.ts` is pure. Inputs: the two quickstart templates, the operator's `preview.env` (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `PREVIEW_REPO`, optional `SANDBOX_IMAGE`), and `{port, branch, worktree}`. Output: the `.env` text and the projects config JSON. The template's credit, token and repository values are replaced from `preview.env`; `WEB_AUTH=none`, `WEB_BIND=127.0.0.1`, `WEB_PORT`, `WEB_BASE_URL`, `AVEN_DIR=<wt>/.preview`, `AVEN_DATA_DIR=<wt>/.preview/data`, `SANDBOX_NAME_PREFIX=pv-<branch-slug>-` and `SANDBOX_MANAGED_BY=coach-aven-preview` are set; and the `demo` project's repository becomes `PREVIEW_REPO`.
- **GitHub access is a fine-grained token for the scratch repository only.** The operator's GitHub App mints installation-wide tokens, which would let a preview agent push to real repositories. The token keeps the preview's reach at one scratch repo, which it may freely open PRs against.
- **Sandbox image.** A worktree commit has no published image, so the default is the plain sandbox image of the newest release tag; `SANDBOX_IMAGE` in `preview.env` overrides it.
- `.preview/.env` and `.preview/projects.config.json` are written on every start (they are derived), and `.preview/state.json` and `data/` persist until `stop --clean`.
- `src/previewcli.ts` starts `tsx src/cli.ts web` detached with `AVEN_DIR=<wt>/.preview`, the pid in `.preview/pid` and the log in `.preview/bot.log`. It waits for `Web chat running` and prints the URL. `stop` kills the pid and removes the `docker ps -a --filter name=^pv-<branch-slug>-` containers.
- The operator's scratch repository is a private repo of the product owner, created for the quickstart rehearsal. Another contributor sets their own in `preview.env`. The repo ships no default.

**D11. "Sessions never deploy" is stated by the repo and enforced by the operator.**
- `CLAUDE.md` (Release) says deploys go through `ship`.
- The operator's local PreToolUse guard denies direct `deploy.sh … deploy`, `remote-script deploy` and `npm run release` in this checkout, and asks before a `ship` that reaches a release stage.
- The hook is per machine and not shipped: another operator may deploy from their ops workflow.

## Risks / Trade-offs

- **[A lower stage is unreachable, so `ship prod` cannot prove what it runs]** → `ship` refuses and names the unreachable installation. The operator can pass `--commit` after checking by hand, and that still goes through the ancestry check against the stages it can read.
- **[Staging has real pilot users, and "promote what home runs" puts a commit there minutes after home]** → Promotion is a deliberate command. Risky behaviour still ships behind flags, canary-first (`docs/rollout.md` keeps the flag lifecycle). `ship --plan` shows what goes out.
- **[The tag push fails on credentials, e.g. gh tokens in a keyring that is locked after a reboot]** → `ship --plan` checks `git push --dry-run origin` for a release stage, so the failure shows before anything is deployed.
- **[The release workflow is slow or fails]** → `ship` waits up to 20 minutes, then stops with the run's link. Nothing is deployed after the failure. A pushed tag without a release is reused on the next ship (spec: *re-shipping a tagged commit*).
- **[A preview's turns are real turns: they spend the credit and can open PRs on the scratch repository]** → That is the point of a preview. The token reaches only that repository. `docs/local-dev.md` says so, and the skill starts a preview only when asked.
- **[The quickstart templates change shape, and the preview breaks]** → The preview builder's tests read the real templates, so a template change that drops a key the preview replaces fails `npm test` in the same PR.
- **[`where` costs one ssh round trip per installation]** → One call per installation, run in parallel with a 10 s timeout. Acceptable for an interactive query.
- **[Two machines with overlays could ship at once]** → The lock is per machine. There is one operator machine today; a shared lock (e.g. a git ref) is left for when there is a second.

## Migration Plan

1. Merge. This is bucket 2: no bot code changes, and `deploy.sh` changes only for `localhost`.
2. Operator: `STAGE=1` home, `STAGE=2` staging, `STAGE=3` prod, in each ops overlay. Home's `DEPLOY_HOST=localhost` is already there.
3. Operator: update the local guard hook (D11). Write `~/.config/coach-aven/preview.env`: the credit, a fine-grained token on the scratch repository (Contents and Pull requests: read and write, with an expiry), and `PREVIEW_REPO`.
4. First run: `ship --plan home`, `ship home`. Compare with `deploys.log`. Then `where`.
5. First release through `ship`: `ship --plan prod`, the skill's review, then `ship prod`.

Rollback: stop using `ship`. `deploy.sh` for remote hosts is unchanged, and the localhost path is the same script without ssh.
