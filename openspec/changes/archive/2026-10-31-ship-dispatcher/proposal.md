# Proposal

## Why

Several agent sessions work on this repository at once. Each one merges to `main` and then deploys by hand: it runs `deploy.sh <slug> remote-script deploy sha-<commit> | bash` for the home installation, or `npm run ops -- <slug> deploy`, or `npm run release`. The result is a race, and nobody keeps track of it:
- **No session knows what runs where.** Session A deploys commit X to the home bot. Ten minutes later session B deploys Y over it, and A is still telling the maintainer that X is live.
- **A deploy is a habit, not a rule.** The home bot, a staging installation and prod each take a different command. Which one is "allowed" lives in prose (CLAUDE.md, the operator's notes), and prose slips in a long session.
- **The canary rule is fiction.** `docs/rollout.md` says to tag only after ~2 days on the home bot. In practice tags follow within a day (three releases in two days this week). Nothing checks the rule, and what really protects prod is "prod gets what already ran somewhere else", which nothing enforces either.
- **Seeing a change means deploying it.** The maintainer wants to see a change right away, but the only places to see it are the shared installations. A second bot from source next to the home bot splits its Slack socket.

A release is really a snapshot of `main` that has passed some checks. The deploy order (home → staging → prod) is the real safety net. Both can be one mechanism instead of four habits.

## What Changes

- **One command moves installations: `npm run ship -- <slug>…`.** Sessions merge; only `ship` deploys. For each named installation, in stage order, it does the following:
  - **Picks what to deploy.** The first stage gets the newest `main` commit whose CI passed and whose image exists. Every later stage gets what the stage before it runs, so prod only ever receives a commit that another installation already ran.
  - **Deploys through `deploy.sh`.** The health check and `deploys.log` work as today. An installation on this machine (`DEPLOY_HOST=localhost`) is deployed without ssh.
  - **Tags at the release step.** A release installation (not `CANARY=1`) takes `vX.Y.Z`. `ship` tags the commit (the next patch, or the next minor when a merged PR since the last tag has the `feature` label; `--version` overrides), waits for the release workflow to publish the image, and deploys that version.
  - **Takes one lock and writes one journal.** Two ships never overlap. Each step adds a line to `infra/ships.log`: time, installation, version, commit, outcome.
  - **Is the rollback too.** `ship <slug> --version <earlier>` deploys an earlier version through the same checks.
  - **Plans before it acts.** `ship --plan <slug>…` prints what would go out (the version, the commit range and the merged PR titles) and changes nothing.
- **Stages come from the overlay.** `deploy.env` gets `STAGE=<n>`. Installations without it are not shipped, and `ship` names the key.
- **`npm run where -- [<PR#>|<commit>]` answers "is it live?".** It reads each installation's pinned version live from the box and checks git ancestry: `home ✓ (sha-… since 12:03) · staging ✓ · prod ✗`. With no argument it lists each installation's version and how far behind `main` it is.
- **A preview bot per worktree: `npm run preview`.** It starts the worktree's code as a web-chat bot on loopback (`WEB_AUTH=none`, a free port). The maintainer looks at the change before it merges, and no installation is involved.
  - It reads nothing from any installation: not home's either, which is a live node of the network even if experimental.
  - It is the quickstart's installation shape run from source: the quickstart's settings and its one `demo` project on a scratch repository, in a `.preview/` directory of its own, with its own sandbox prefix.
  - The operator's values (Claude credit, GitHub access — the App or a token — that reaches the scratch repository only, the repository's name) come from one file, `~/.config/coach-aven/preview.env`.
  - `npm run preview -- stop` removes its process and sandboxes.
- **A `ship` project skill.** Before a release step, the session gets one independent read-only review of the diff since the last tag and shows the maintainer one screen (PRs, findings, version). It runs `ship` only on the maintainer's go.
- **Docs follow.**
  - `docs/rollout.md`: the 2-day canary rule is replaced with the stage rule; flags still go canary-first.
  - `CLAUDE.md` Release section: deploys go through `ship`.
  - `infra/deploy/README.md`: `STAGE`, `ship`, `where`.
  - `docs/local-dev.md`: `preview`.

## Capabilities

### New Capabilities
- `ship`: moving installations to a version in stage order. Covers what each stage receives, tagging at a release stage, the lock, the journal, rollback, the plan, and the `where` query.
- `worktree-preview`: running a worktree's code as an isolated loopback web-chat bot on a scratch project, beside the installations on the same machine and sharing nothing with them.

### Modified Capabilities
None. `deploy.sh`'s contract (`container-deploy`, `ops-overlay`, `release-deploy-split`) is unchanged.
- `ship` calls `deploy.sh <slug> deploy <version>` with the versions it already accepts.
- The ops workflow and `npm run release` stay as the path for an operator who deploys from their ops repository.
- `STAGE` is a key only `ship` reads. A `deploy.env` without it behaves exactly as today.

## Impact

- **Code.**
  - New `src/ship.ts`, the pure planner, with `src/ship.test.ts`.
  - `src/shipcli.ts`: `ship` and `where`, running git, `gh` and `deploy.sh`.
  - `src/preview.ts` builds the preview's `.env` and projects config from the quickstart templates and `preview.env`, with `src/preview.test.ts`; `src/previewcli.ts`.
  - `package.json` scripts `ship`, `where`, `preview`.
  - `deploy.sh`: `DEPLOY_HOST=localhost` runs its remote script locally instead of over ssh.
  - `.gitignore`: `.preview/`.
  - `.claude/skills/ship/SKILL.md`.
- **Rollout bucket 2, by construction.**
  - No bot code changes, and nothing runs in an installation.
  - `deploy.sh` changes only for `DEPLOY_HOST=localhost`, which no box uses. It is the home installation's stub, deployed today with `remote-script … | bash`. A test proves that a remote host still goes over ssh, byte for byte.
  - There is no flag. The gate is `STAGE` in an overlay: an installation without it cannot be shipped.
  - A ledger row records it.
- **Operator side, not in this repository.**
  - Each overlay's `deploy.env` gets `STAGE`.
  - The operator's local guard hook denies direct `deploy.sh … deploy`, `remote-script deploy` and `npm run release` in this checkout and points to `ship`. It asks before `ship` reaches a release stage.

### Out of scope

- **A Slack button for `ship`.** That comes later and will call the same command.
- **Installations that pull new versions by themselves.**
- **Per-PR automatic reviews.**
- **Retiring `npm run release` or the ops-repo deploy workflow.** Both stay for operators without `ship`.
- **Previewing Slack- or Teams-specific rendering.** A preview is the web chat; Slack-only UI is still checked on the first stage.
- **Synthetic sources data in a preview.** A synthetic organisation, e.g. the lab's `bench-agency` world, is for when a feature needs it.
- **Several preview projects.** Edit `.preview/projects.config.json` by hand until a need shows up.
