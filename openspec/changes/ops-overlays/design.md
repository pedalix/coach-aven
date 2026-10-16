## Context

See proposal.md — Why. What exists today:

- `infra/prod/` mixes the generic tooling (`deploy.sh`, three unit templates, `nginx-sources.conf.example`, `runtime.example/`) with the one overlay checkout (`runtime/`, gitignored by exact path) and the deploy target `infra/prod/.env` (gitignored by the global `.env` rule, but a file of the public tree).
- `deploy.sh` resolves `RUNTIME_DIR="$HERE/runtime"` and `ENV_FILE="$HERE/.env"`; the overlay's `deploy.yml` writes `infra/prod/.env` from a `DEPLOY_ENV` secret before calling `deploy.sh deploy`; `snapshot/build-and-push.sh` reads the CLI pin from `../infra/prod/runtime/.env`; `.gitleaks.toml` allow-lists `infra/prod/runtime/` by path (gitleaks runs `--no-git`, so it scans ignored directories too).
- A Terraform root for a Teams bot identity exists as an operator draft: azuread app + rotating password, azurerm bot (F0, SingleTenant) + Teams channel, `random_uuid` for the Teams app id, manifest rendered with `templatefile`, zip via `archive_file`, a publish script over the MicrosoftTeams PowerShell module. `terraform validate` and `plan` (11 resources) pass. It becomes the module here.
- Teams facts that shape the module: multi-tenant bot creation ended in 2025, new bots are single-tenant; a bot reads channel messages without a mention only with the RSC permissions in the manifest; the organization catalog has no Terraform provider and the Azure CLI's Graph token lacks `AppCatalog.*`, while the MicrosoftTeams PowerShell module can read and write it with an interactive admin login.

## Goals / Non-Goals

**Goals:**
- Any number of installations side by side in one product checkout, each addressed by slug, none visible in the public tree.
- The Terraform that creates a Teams bot identity is public and generic; an overlay is a variables file plus local state.
- Operator commands stay the same verbs with one extra word.

**Non-Goals:**
- Changing what `deploy.sh` does on the box (upload → `npm ci` → restart → health check stays byte-for-byte).
- Terraform for hosts.
- The Teams driver (`teams-chat-driver`).
- Any operator's migration: which repos exist, what moves where, which host runs what is that operator's plan in their ops repo.

## Decisions

### D1. Slug as the first argument, no default
`infra/deploy/deploy.sh <slug> <command>`; `npm run ops -- <slug> <command>` is the only npm entry (the eleven `prod:*` scripts go). No default slug and no `OPS=` env fallback: with several installations a default is the one that gets deployed by mistake. A missing or unknown slug lists `infra/*/` directories that contain `deploy.env`.
*Alternative:* keep `prod:*` with a default slug — rejected, the name "prod" is exactly the ambiguity being removed.

### D2. Overlay root = runtime files; `deploy.env` tracked
Overlay layout:
```
projects.config.json  projects.d/        the bot's config (as today)
deploy.env                               DEPLOY_HOST/USER, ROOT_USER, REMOTE_DIR, SERVICE_NAME (was infra/prod/.env)
.env  github-app-private-key.pem         secrets — ignored, travel by scp
docs/                                    operator notes (topology, tenants, the operator's plans)
teams/                                   main.tf (module call) + terraform.tfvars; state ignored
<cloud>/                                 optional: the host's Terraform
.github/workflows/deploy.yml             the installation's deploy
```
`deploy.env` holds a host address and user names — private-repo material, not a secret — so it is tracked, and `deploy.yml` checks out its own repo at `src/infra/<slug>/` next to the product checkout at `src/` and runs `deploy.sh <slug> deploy`. One secret (`DEPLOY_SSH_KEY`) instead of two.
`deploy.sh` keeps `RUNTIME_FILES=(.env github-app-private-key.pem projects.config.json)` and `RUNTIME_DIRS=(projects.d)`; `deploy.env` is read, not uploaded.

### D3. `.gitignore` allow-list for `infra/`
```
infra/*
!infra/README.md
!infra/deploy/
!infra/teams/
```
replaces `infra/prod/runtime/`. The ignore file names only public directories, so another overlay needs no edit and leaks no name. `.gitleaks.toml` gets the matching path regex `infra/(?!deploy/|teams/)[^/]+/` so the no-git scan skips overlays as it skipped `infra/prod/runtime/`. `scripts/public-guard.sh` is unaffected (tracked files only).

### D4. `infra/teams/` is a module; the overlay is the root
The Terraform draft moves into the public tree as a **module** with every identifier a variable (`tenant_id`, `subscription_id`, `bot_name`, `display_name`, `developer_name`, `website_url`, `messaging_endpoint`, `app_version`, `location`, `resource_group_name`, optional `icon_color_path` / `icon_outline_path`). The overlay's `teams/main.tf` is a root module: provider blocks, `module "teams" { source = "../../teams" … }`, outputs re-exported. Local state in the overlay directory, ignored.
Rationale: Terraform's `-state`/`-var-file` flags against a shared root are legacy and fragile; a root per installation is the idiom, and the module stays free of provider configuration.
Manifest: `manifest.json.tftpl` in the module, schema 1.19, scopes `personal` + `team` + `groupChat`, RSC `ChannelMessage.Read.Group` + `ChatMessage.Read.Chat`, `supportsFiles: false` (the driver spec decides files later), `validDomains: []`. Icons: neutral placeholder PNGs (192 colour, 32 outline) in the module, overridable per overlay — two bots in one tenant must look different.
`publish.sh` lives in the module and takes the overlay's `teams/` directory as its argument: it reads `terraform output` there and runs `New-TeamsApp` / `Set-TeamsApp` through `pwsh` with device-code login.
*Alternative:* Graph `POST /appCatalogs/teamsApps` via `az rest` — needs an admin-consented Graph scope on the Azure CLI app; more setup for the same result.

### D5. Repo convention, manual deploys
One ops repo per installation, named `coach-aven-ops` in the org of whoever owns the installation — the org says whose it is, the slug under `infra/` is the operator's short name for it. Deploys are manual (`workflow_dispatch` with the tag, or `npm run ops -- <slug> deploy` from a laptop); the product repo holds no `OPS_APP_*` secrets, and the release dispatch stays documented as optional wiring. With several installations to stabilise, an automatic deploy on every tag is a risk, not a convenience.

### D6. `ops.example/` replaces `runtime.example/`
Same files plus `deploy.env.example` and a `.gitignore` (`.env`, `.env.*`, `*.pem`, `state.json`, `*.tfstate*`, `.terraform/`); `deploy.yml` rewritten for D2. The word "runtime" leaves the operator vocabulary: an overlay is "the ops repo", its checkout "the overlay".

### D7. Plain image additions
`apk add python3 py3-pip make unzip rsync` in `snapshot/plain/Dockerfile`; the laravel variant is untouched. `build-and-push.sh` reads the CLI pin from `CLAUDE_CLI_VERSION` or an explicit `ENV_FILE`, no longer from a hard-coded overlay path. Alpine stays: the variant is defined as the small multi-arch image; a glibc variant is a separate decision if a project needs wheels that musl lacks. Anything a project needs beyond the list (PHP, say) is one `apk add` line and a rebuild, never a hand install into a running sandbox: housekeeping recycles containers and hand-installed packages vanish with them. An installation that wants its own registry copy (a private registry the host's role can pull from without a token) uses the existing `IMAGE=` override.

## Risks / Trade-offs

- [Operators type the old `npm run prod:deploy`] → the script is gone; `npm run ops` with no args prints the usage with the slugs present. Documented in the ledger row and the PR title.
- [A deploy workflow misses a secret after an overlay move] → the first deploy after a move is manual (`npm run ops -- <slug> deploy`), and the workflow is tried with `workflow_dispatch` on the same tag before the next release.
- [gitleaks regex typo scans an overlay and fails CI on a real secret in `.env`] → the regex is exercised in the PR by running the CI gitleaks command locally with an overlay checkout present.
- [Terraform state lost] → everything is re-creatable: `terraform import` of the four Azure/Entra objects, or delete the resource group and the app and apply again (the Teams app id changes only in the second case; users re-add the app).
- [`:latest` of the plain image moves under a running installation] → the push is manual and announced; sandboxes are re-created at the next housekeeping, which is the canary.

## Migration Plan

1. Public repo PR (this change): `git mv infra/prod infra/deploy`, drop `runtime/` from it, add `infra/teams/`, `infra/README.md`, `.gitignore`, `.gitleaks.toml`, `package.json`, docs, Dockerfile. CI green = public-guard + gitleaks + tests.
2. Each operator: move their overlay checkout to `infra/<slug>/`, add `deploy.env`, update their deploy workflow from `ops.example/`; verify with `npm run ops -- <slug> import` (a no-op diff proves the overlay equals the box). Their plan, in their ops repo.
3. Image: `snapshot/build-and-push.sh plain` after the merge; installations pick it up at the next sandbox creation.
Rollback: the tooling is operator-side; `git revert` of the PR restores `infra/prod/` paths, and an overlay clone is a directory move.
