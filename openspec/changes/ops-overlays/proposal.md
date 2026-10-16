## Why

`go-public` made an installation an *ops overlay* — one private repo checked out at `infra/prod/runtime/` — but the layout still assumes a single installation called "prod". An operator who runs several (a production bot, a staging bot that will carry the Teams driver, a personal one) hits three walls: the deploy tooling hard-codes one overlay path, the deploy target lives in the public tree (`infra/prod/.env`), and the Teams bot's Azure side has nowhere to live. Nothing stops a second overlay's directory name — typically a customer's — from becoming a tracked path either.

## What Changes

- **One overlay per installation, by slug.** An ops repo is checked out at `infra/<slug>/`, with the installation's files at its root — no `runtime/` level. Convention: the repo is named `coach-aven-ops` in the org of whoever owns the installation.
- **Allow-list ignore for `infra/`.** `.gitignore` ignores everything under `infra/` except the public tooling directories, so an overlay checkout can never be staged and the public tree never lists an installation's slug.
- **`infra/prod/` → `infra/deploy/`** with the installation as a parameter: `infra/deploy/deploy.sh <slug> <command>` (`npm run ops -- <slug> <command>`). **BREAKING** for operators: the `prod:*` npm scripts and `infra/prod/.env` go away; the deploy target moves into the overlay as `deploy.env`, and the overlay's deploy workflow reads it from its own checkout instead of a secret.
- **`infra/teams/`: a Terraform module for a Teams installation's bot identity** — single-tenant Entra app with a rotating secret, Azure Bot (F0) with the Teams channel, and the Teams app package (manifest + icons) rendered from state — plus the catalog publish script. An overlay instantiates the module with a variables file; state and the secret stay with the operator.
- **Plain sandbox image gains `python3`, `py3-pip`, `make`, `unzip`, `rsync`** — the default toolchain for projects that never run containers of their own.
- **`runtime.example/` becomes `ops.example/`** with the new layout, including `deploy.env.example` and the rewritten deploy workflow.

## Capabilities

### New Capabilities
- `teams-bot-infra`: a Teams installation's bot identity (Entra app, Azure Bot, Teams channel, app package) is created from a variables file by one `terraform apply`, re-created identically from the same inputs, and published to the organization's app catalog by one script.
- `sandbox-image`: the toolchain the plain sandbox image guarantees to the agent.

### Modified Capabilities
- `ops-overlay`: the runtime directory becomes `infra/<slug>/`, selected per command; the deploy target moves into the overlay; the public tree ignores overlay directories by allow-list; the template reflects the new layout.

## Impact

- **Rollout bucket: none for bot behaviour** — the bot process does not change; this is deploy tooling, infrastructure code, `.gitignore` and docs. Ledger row as for `go-public`. The image change is **bucket 2** (additive packages; the image is built and pushed by hand with `snapshot/build-and-push.sh plain`, so the merge alone changes no sandbox; installations on `plain:latest` pick it up at their next sandbox creation).
- **Code:** `infra/prod/*` → `infra/deploy/*` (deploy.sh, unit templates, nginx example, `ops.example/`), new `infra/teams/`, new `infra/README.md`, `.gitignore`, `.gitleaks.toml` path allow-list, `package.json` scripts, `snapshot/plain/Dockerfile`, `snapshot/build-and-push.sh` (CLI pin lookup), pointers in `CLAUDE.md`, `README.md`, `docs/local-dev.md`, `docs/observability.md`, `docs/sources.md`, `docs/fixtures.md`, the `release.yml` comment.
- **Other changes:** `teams-chat-driver` D8 and tasks 1.2 / 2.6 describe a manifest template plus `npm run teams:package`; the module replaces both. Those artifacts get a pointer when that change is refreshed, not here.
- **Operators:** deploys stay manual (`workflow_dispatch` with the tag, or `npm run ops -- <slug> deploy`); the release dispatch is optional wiring an operator may add later. Splitting an existing overlay into several, creating the repos, hosts and Teams identities is each operator's own plan, kept in their ops repo — this repo documents the mechanism only.
- **Out of scope:** the Teams driver (`teams-chat-driver`); Terraform for hosts (an overlay's concern until a second installation on the same cloud justifies a public module); a glibc image variant (the fleet image stays Alpine; a project that needs more gets it added to the Dockerfile, never installed by hand into a sandbox that housekeeping will recycle); remote Terraform state; where an installation pushes its copy of the image (`IMAGE=` override exists).
