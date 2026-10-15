# Tasks

## 1. Public repo: releases only

- [x] 1.1 `.github/workflows/release.yml`: delete the `deploy` job, the `concurrency` block and `workflow_dispatch`; keep `verify` → `release`; add the mint + notify steps to `release` (job env `HAS_OPS_APP`, `actions/create-github-app-token@v2` scoped to `coach-aven-ops` / `contents: write`, then `gh api repos/pedalix/coach-aven-ops/dispatches -f event_type=coach-aven-release -F 'client_payload[tag]=…'`, fail on non-204). Update the header comment. Verify: `actionlint` (npx) passes; a dry read shows no `secrets.DEPLOY_*` left (`grep -c DEPLOY_ .github/workflows/release.yml` = 0).
- [x] 1.2 `infra/prod/runtime.example/workflows/deploy.yml`: the ops deploy workflow verbatim with explanatory comments (triggers, tag validation, App token mint (`coach-aven` / `contents: read`), checkout of the product repo at the tag, `.env` from `DEPLOY_ENV`, key from `DEPLOY_SSH_KEY`, `deploy.sh deploy`, concurrency). Verify: `actionlint` passes on the file.
- [x] 1.3 Docs: `infra/prod/README.md` *Releases (CI/CD)* rewritten (public = release + notify; ops = deploy; secrets table moves to the ops side; manual path unchanged); `infra/prod/runtime.example/README.md` gains "Deploy from your ops repo" (copy the workflow, add the two secrets, run by tag or subscribe with a dispatch token). Verify: `bash scripts/public-guard.sh` clean; both files name no host.
- [x] 1.4 `docs/rollout.md` row: "Deploy moves to the ops repo (OpenSpec `deploy-from-ops`)" | PR | gate: none (CI/deploy tooling) | date | note "proof = first tag deployed by `coach-aven-ops/deploy.yml`". Verify: row present, table still renders (7 columns).

## 2. Ops repo: the deploy workflow

- [x] 2.1 `coach-aven-ops/.github/workflows/deploy.yml` (same content as 1.2 minus the template comments). Verify: `actionlint` passes; `git -C infra/prod/runtime log -1` shows the commit; pushed.
- [x] 2.2 `coach-aven-ops/README.md`: "Deploys" section — how a release reaches prod, the four secrets (`DEPLOY_SSH_KEY`, `DEPLOY_ENV`, `APP_ID`, `APP_PRIVATE_KEY`), the `OPS_APP_ID`/`OPS_APP_PRIVATE_KEY` pair on the public side, the manual `workflow_dispatch(tag)` path, rollback = dispatch the previous tag. Verify: section present.
- [x] 2.3 Secrets via `gh secret set`: on `pedalix/coach-aven-ops` — `DEPLOY_SSH_KEY` (`~/.ssh/aven-prod`), `DEPLOY_ENV` (`infra/prod/.env`), `APP_ID` and `APP_PRIVATE_KEY` (from the overlay's runtime `.env` / `.pem`); on `pedalix/coach-aven` — `OPS_APP_ID`, `OPS_APP_PRIVATE_KEY`. Verify: `gh secret list -R pedalix/coach-aven-ops` shows four; `gh secret list -R pedalix/coach-aven` shows the two `OPS_*` only.

## 3. Proof and cut-over

- [x] 3.1 Manual proof: `gh workflow run deploy.yml -R pedalix/coach-aven-ops -f tag=v0.39.0` (the tag prod already runs). Verify: run green, `npm run prod:status` active, `journalctl` shows "Slack bot running", `/aven` answers in `#bluefin-aven-caldora`. **Done 2026-10-15:** ops run 38726169971 green (all steps), prod active on v0.39.0.
- [x] 3.2 First real release through `npm run release -- vX.Y.Z` (decision 2026-10-15: manual hand-off, no credential in the public repo; the dispatch step stays opt-in and is skipped). Verify: Release published, ops `workflow_dispatch` run green, Sentry release = the tag; `docs/rollout.md` row dated. **Done 2026-10-15:** `npm run release -- v0.40.0` → release run 38726311037 green (dispatch steps skipped, as designed), ops run 38726313954 green, prod `.release` = v0.40.0.
- [x] 3.3 Dropped 2026-10-15: `OPS_APP_*` deleted from the public repo (manual hand-off chosen); nothing to re-set after the recreate. Verify: `gh secret list -R pedalix/coach-aven` is empty.
