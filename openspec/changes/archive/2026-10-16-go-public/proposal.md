# Proposal

## Why

`pedalix/coach-aven` is private. The code carries no secrets (checked 2026-10-15: every token-shaped string in the history is a test placeholder; `projects.config.json`, the App key and `.env` never entered git), but it carries Bluefin's and Owen's world: client names in 60+ files, real third-party e-mail addresses in 15 `src/sources/**` test files, an Entra tenant GUID, the home Slack team id, the prod host IP and hostnames, and tenant-specific docs (`docs/sources.md` is in effect owen-ops configuration). Making the repo public is the cheapest credibility signal we have (TSG, HCG, hiring, the Anthropic ecosystem), it fits the locked self-hosted path (static mode stays), and it forces the hygiene CLAUDE.md already declares: "the tenant plan records decisions, this repo records behaviour".

## What Changes

- Tests and comments stop naming real people, companies and tenants: `@example.com`-style addresses, `T_FIX_1`-style Slack ids, a fake Entra GUID.
- Our installation becomes a private **ops overlay** repo, `pedalix/coach-aven-ops`, checked out at `infra/prod/runtime/` (already gitignored, already the import/export target). It holds `projects.config.json`, `projects.d/`, the three-host topology with IPs, the live `sources` example for owen-ops, `ideas/` and tenant notes. Secrets (`.env`, the App key) stay out of git as today. `deploy.sh import|export` keep their names but become `git pull|push` of the overlay plus the scp of the two secret files.
- The public repo keeps the **mechanism**: `infra/prod/README.md` explains the runtime dir and how to keep your own installation as an ops repo (`infra/prod/runtime.example/` as the template), `docs/sources.md` keeps schema, commands and scope rules with placeholder values, `README.md`/`docs/*` use `<gateway-host>`-style placeholders instead of `<gateway-host>` & co., `.claude/skills/manage-project` keeps its mechanics and reads instance specifics from the overlay. Rule of thumb: a line a stranger self-hosting needs is public; a line naming our host, customer or person is overlay.
- Nothing moves into owen-ops or bluefin-ops: those repos are the tenant agents' context, and operator topology would be noise for them (decided 2026-10-15). bluefin-infra keeps only what it already owns (gateway routes, Auth0).
- Public scaffolding: `LICENSE` (Apache-2.0), README rewritten for a stranger (self-host quickstart, status disclaimer), `CONTRIBUTING.md`, `SECURITY.md`.
- A CI guard (`scripts/public-guard.sh` + gitleaks) fails the build when a tenant identifier or a secret-shaped string lands in a tracked file.
- GitHub hardening before the flip: `production` environment gets a required reviewer and a `v*` tag-only deployment policy; forks cannot run workflows with secrets; secret scanning + push protection on.
- History rewrite with `git filter-repo` (decided 2026-10-15, option B) using the same replacement list, then force-push of `main` and the tags; the home checkout, worktrees and open PR branches are re-based onto the rewritten history.
- Visibility flip to public, in place (`pedalix/coach-aven` stays the owner; decided 2026-10-15).

## Capabilities

### New Capabilities
- `public-repo-hygiene`: tracked files and history free of tenant identifiers, enforced by CI; deploy secrets reachable only from protected tags.
- `ops-overlay`: an installation lives in its own repo checked out at `infra/prod/runtime/`; `deploy.sh` syncs it by git, secrets by scp.

### Modified Capabilities
- none (no bot behaviour changes).

## Impact

- **Rollout bucket: 1-equivalent (no behaviour change).** Tests, comments, docs, CI and GitHub settings only. No flag, no ledger row for behaviour; one ledger row records the guard and the rewrite date so the canary/prod split stays auditable. Prod runs the last tag; the rewritten tag objects point at byte-identical trees except for the rewritten test/doc strings, which never reach prod runtime.
- Files: `infra/prod/deploy.sh` (import/export over git), new `infra/prod/runtime.example/`, `src/sources/**/*.test.ts`, `src/scrub.test.ts`, `src/fixtures.test.ts`, `src/dispatch.test.ts`, `src/sources/people.ts`, `src/youtrack*.ts` (comments), `docs/sources.md`, `README.md`, `docs/*.md`, `infra/prod/README.md`, `infra/prod/.env.example`, `.claude/skills/manage-project/SKILL.md`, `openspec/changes/*/proposal.md` (names of people), `.github/workflows/*`, new `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `scripts/public-guard.sh`.
- Cross-repo: new private `pedalix/coach-aven-ops` (overlay). owen-ops gets one PLAN.md decision line ("repo public since …"), nothing else. bluefin-infra unchanged.

## Out of scope

- The website. `coachaven.com` (Lovable landing, Google Workspace mail) is the public name; `aven.guru` stays the infra host (`bot.aven.guru` is the OAuth callback baked into the Slack manifest — changing it means a manifest change + reinstall). The README links to coachaven.com; the landing page gets a "Source" link after the flip. No other domains are registered (`.ch/.dev/.ai/coach-aven.com` do not resolve).
- Moving the repo to another org or renaming it.
- Client names in **commit messages and PR titles** of the history: filter-repo rewrites blobs by the replacement list; messages are left alone (client names are public companies, not secrets; only e-mails/ids/IP are replaced).
- Any change to bot behaviour, prompts or golden fixtures.
