# Design

## Context

`release.yml` today: `verify` → `release` (tags only) → `deploy` (`environment: production`, secrets `DEPLOY_SSH_KEY`, `DEPLOY_ENV`, writes `~/.ssh/id_ed25519` and `infra/prod/.env`, runs `infra/prod/deploy.sh deploy` with `RELEASE=<tag>`); `concurrency: prod-deploy`; `workflow_dispatch(ref)` deploys an arbitrary ref. `deploy.sh deploy` needs only `infra/prod/.env` and the checkout (it tars the repo minus `.git`, `node_modules`, `infra/prod/runtime`, secrets) — it does not touch `infra/prod/runtime/`. The ops repo `coach-aven-ops` exists, private, Free-plan org (2 000 Actions minutes/month, enough for a few one-minute deploys). The public repo is about to be deleted and recreated (`go-public`), which wipes its secrets and environment. See proposal.md.

## Goals / Non-Goals

**Goals:**
- Zero installation secrets in the public repo; one place per installation for deploy config.
- The tag → prod path stays automatic for us and takes one click for anyone else.
- No change to what runs on the box or how.

**Non-Goals:**
- Generalising to N installations from one dispatch (fan-out list in the public repo) — each installation subscribes itself.
- Replacing `deploy.sh` with a GitHub-native deployment or a container.

## Decisions

- **Push notification, not polling.** The release job calls `POST /repos/pedalix/coach-aven-ops/dispatches` with `event_type: coach-aven-release`, `client_payload: {tag}`. Needs a token with write access to the ops repo → minted per run from the `coach-aven` GitHub App with `actions/create-github-app-token@v2` (`repositories: coach-aven-ops`, `permission-contents: write`): installation tokens live one hour, are scoped at mint time and are revoked by rotating one key. Alternatives rejected: a fine-grained PAT (only a human can create one, expires, is bound to a person's account); a schedule in the ops repo polling `releases/latest` — adds latency and a "what did we deploy last" state file for no gain; a self-hoster who wants it can add it.
- **Skip, don't fail, without the App secrets.** The mint and notify steps are guarded by `if: env.HAS_OPS_APP == 'true'` with `HAS_OPS_APP: ${{ secrets.OPS_APP_PRIVATE_KEY != '' }}` set at job level (secrets cannot be read in `if:` directly). A fork or a self-hoster's clone cuts releases and nothing else happens.
- **The ops workflow checks out two things**: itself (for nothing yet — reserved for future ops-side steps) and the product repo at the tag via `actions/checkout` with `repository: pedalix/coach-aven`, `ref: ${{ event.client_payload.tag || inputs.tag }}`, `path: src`. While the product repo is private, `token:` is an App token minted in the same job (`repositories: coach-aven`, `permission-contents: read`); after the flip it is still valid and simply unnecessary. Then `cd src && RELEASE=<tag> bash infra/prod/deploy.sh deploy` with `infra/prod/.env` written from `DEPLOY_ENV` — byte-for-byte the steps of today's `deploy` job, just in another repo.
- **The tag is validated** before anything runs: `^v[0-9]+\.[0-9]+\.[0-9]+$`, else the job fails fast — the manual input must not deploy a branch (that was the old `workflow_dispatch(ref)` footgun the environment policy was meant to close).
- **`concurrency: prod-deploy` moves to the ops workflow** unchanged (queue, never cancel).
- **No `production` environment anywhere.** The ops repo is private, only Owen can push to it or run its workflows; an environment would add an approval click without adding a boundary. If the Free plan ever allows it for private repos, it can be added there.
- **Template = the real file.** `infra/prod/runtime.example/workflows/deploy.yml` is the ops workflow verbatim plus comments: the product repo it checks out is the same for everyone, and the ops repo it runs in is implicit. The README says where to put it (`.github/workflows/deploy.yml` of their ops repo) and which two secrets to add.
- **Sequencing with `go-public`**: land this on the recreated repo. Order: recreate repo (no environment, no deploy secrets) → merge this change → add `OPS_APP_ID`/`OPS_APP_PRIVATE_KEY` to the public repo, `DEPLOY_SSH_KEY`/`DEPLOY_ENV`/`APP_ID`/`APP_PRIVATE_KEY` to the ops repo → `workflow_dispatch` the ops workflow with the current prod tag (`v0.39.0`) as the first proof — it redeploys the same code, a no-op for users → flip.

## Risks / Trade-offs

- [The App's private key sits in two repos' Actions secrets] → same exposure class as the old `DEPLOY_SSH_KEY` in the public repo (never readable by fork PRs; only a tag push by a writer runs the job); the minted tokens are scoped to one repo and one permission and die in an hour; a dedicated second App key for CI can replace it later without touching the workflows. The notify step fails the `release` job on a non-204 so a broken mint is visible on the tag's run; manual `workflow_dispatch(tag)` is always available.
- [A dispatch arrives while a manual deploy from a laptop runs] → the laptop path has no lock today either; unchanged. The ops workflow at least serialises its own runs.
- [Ops repo Actions minutes] → ~1–2 min per deploy; dozens per month fit in 2 000.
- [Someone with write access to the ops repo can deploy any tag] → that is the trust boundary by design; the same person can `npm run prod:deploy`.

## Migration Plan

1. Public: PR removes `deploy` job, environment reference, `workflow_dispatch`, concurrency; adds the notify step; adds template + docs. Mergeable before the recreate or after — nothing runs until a tag.
2. Ops repo: add `deploy.yml`, README section, secrets.
3. Proof: `workflow_dispatch` ops deploy with the tag prod already runs → green health check, Sentry release unchanged.
4. Next real tag: observe dispatch → deploy. Ledger row gets the date.
5. Rollback: re-add the old `deploy` job from git history and the secrets to the public repo (10 minutes); nothing on the box changes shape.

## Open Questions

- None blocking. (Whether to also notify a Slack channel from the ops deploy is a later nicety.)
