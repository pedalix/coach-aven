# Proposal

## Why

Today the public repository deploys our production box itself: `release.yml` carries a `deploy` job with `environment: production`, an SSH key and the deploy target in repository secrets. That ties one installation to the product repo — a second installation (another client, another host) has no place to live, GitHub's environment protection for those secrets is unavailable to us on the Free plan while the repo is private, and after the delete-and-recreate the secrets are gone anyway. The app-repo / ops-repo split that `go-public` started (OpenSpec `go-public`, `infra/prod/runtime/` = ops checkout) is incomplete until deployment lives on the ops side too.

## What Changes

- **The public repo only cuts releases.** `release.yml` on a `v*` tag: verify (typecheck, tests, guards) → GitHub Release with generated notes → one notification step that tells the ops repo a release exists (`repository_dispatch`, event `coach-aven-release`, payload `{tag}`) and is skipped when no `OPS_APP_ID`/`OPS_APP_PRIVATE_KEY` secrets are configured (a self-hoster's fork cuts releases without them). The notification token is minted per run from our GitHub App (`actions/create-github-app-token`), scoped to the ops repo and `contents: write` only — no personal access token, nothing that expires. **BREAKING for operators:** the `deploy` job, the `production` environment and the `DEPLOY_SSH_KEY`/`DEPLOY_ENV` secrets disappear from the public repo; `workflow_dispatch` on `release.yml` goes away with the deploy job.
- **The ops repo deploys.** `coach-aven-ops` gets `.github/workflows/deploy.yml`: on `repository_dispatch` (`coach-aven-release`) or `workflow_dispatch(tag)` it checks out the public repo at that tag, writes `infra/prod/.env` from its own `DEPLOY_ENV` secret, installs its own `DEPLOY_SSH_KEY`, and runs `infra/prod/deploy.sh deploy` (upload → `npm ci` → restart → health check) exactly as the public job did; `RELEASE=<tag>` is stamped for Sentry as before. Concurrency group `prod-deploy` moves with it.
- **The template teaches it.** `infra/prod/runtime.example/` gains `workflows/deploy.yml` (the same workflow with placeholders) and its README explains: copy it into your ops repo, add the two secrets, deploy by `workflow_dispatch(tag)` or subscribe to releases with a dispatch token of your own.
- `infra/prod/README.md` → *Releases (CI/CD)* describes the split; the manual `npm run prod:deploy` path is unchanged.

## Capabilities

### New Capabilities
- `release-deploy-split`: the product repo publishes releases and notifies installations; each installation deploys itself from its ops repo with its own secrets.

### Modified Capabilities
- `ops-overlay` (from `go-public`): the ops repo additionally holds the deploy workflow; no change to the export/import contract.

## Impact

- **Rollout bucket: none for bot behaviour** — CI/deploy tooling only; no flag, no runtime code. Ledger row anyway, because the *next tag* is the proof: `vX.Y.Z` must reach prod through the ops workflow. Until that tag, prod is deployable by `npm run prod:deploy` from an operator machine, so there is no window without a deploy path.
- Files (public): `.github/workflows/release.yml`, `infra/prod/README.md`, `infra/prod/runtime.example/README.md`, new `infra/prod/runtime.example/workflows/deploy.yml`, `docs/rollout.md`. Files (ops repo): `.github/workflows/deploy.yml`, `README.md`. GitHub settings: `OPS_APP_ID` + `OPS_APP_PRIVATE_KEY` (the `coach-aven` GitHub App, already installed on every org repo) on the public repo; `DEPLOY_SSH_KEY`, `DEPLOY_ENV`, `APP_ID`, `APP_PRIVATE_KEY` on the ops repo; the public `production` environment is NOT recreated on the new repo. No PATs anywhere.
- Ordering with `go-public`: implement on the recreated repo (secrets are re-entered once, on the right side). While the public repo is still private, the ops workflow mints an App token scoped to `coach-aven` + `contents: read` for the checkout; after the flip that step can stay (harmless) or go.

## Out of scope

- Any change to `deploy.sh`'s `deploy` command, to the systemd unit, or to how the box is laid out.
- A pull-based deploy (ops repo polling releases on a schedule) — the dispatch covers our case; a self-hoster uses `workflow_dispatch(tag)` or their own trigger.
- Deploying the home bot (it follows `main` by `git pull` + `systemctl --user restart`, outside CI) and `orch sources serve`'s unit.
- Canary gating of tags (the ~2-day rule stays a human rule, as today).
