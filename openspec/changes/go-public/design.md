# Design

## Context

Private repo, 238 commits, tags `v0.1.0`…`v0.40.x`, tag-triggered deploy (`.github/workflows/release.yml`: `verify` → GitHub Release → `deploy` with `environment: production`, secrets `DEPLOY_SSH_KEY` + `DEPLOY_ENV`). The home bot runs from the main checkout of this repo (`coach-aven-home`, follows `main`); prod receives code by upload from the CI runner, so no prod clone exists. Three worktrees are on live branches. The `production` environment has no protection rules and no deployment branch policy today.

## Goals / Non-Goals

**Goals:**
- Flip visibility with nothing in tracked files or history that names a third party's mailbox, a tenant id, or a host.
- Make the state self-maintaining (CI guard), not a one-off sweep.
- Keep tags, releases and the deploy pipeline working through the rewrite.

**Non-Goals:**
- Hiding that Bluefin/Caldora are customers (public companies; names in docs may be replaced for neutrality, not for secrecy).
- A generic multi-tenant product README; one honest self-host path is enough.

## Decisions

- **Replacement list is one file, used three times.** `scripts/public-guard.txt` holds the forbidden patterns (e-mail domains contoso/vixa/adfire/pedalix/bluefin/caldora/hcg, the Entra GUID, `T0000FAKE01`/`T0000FAKE02`, `<bot-host>`/`<sandbox-vm>`/`<sandbox-host>`, `<gateway-host>`/`<grafana-host>`/`<daytona-host>`). The sweep PR uses it to find, the CI guard uses it to forbid, `filter-repo --replace-text` uses a derived `old==>new` file to rewrite history. One source of truth, so the history rewrite cannot miss what the tree sweep found.
- **Anonymise, don't delete, in tests.** Replace addresses with `<role>@example.com` (the half of the suite that already uses `acc@x.com`/`me@x.com` is normalised to the same style), ids with the `T_FIX_n` convention the twin fixtures use. Test semantics are unchanged; `npm test` is the proof.
- **App repo + ops repo (GitOps split), not "move to the tenant repos".** The installation is a private overlay `pedalix/coach-aven-ops` cloned at `infra/prod/runtime/` — the path is already gitignored and already what `deploy.sh import|export` syncs, so the mechanics barely change: `export` = refuse-if-dirty → `git -C runtime push` → scp of the runtime files as before (the box keeps no clone and needs no deploy key); `import` = scp down as before → `git status` shows the drift to commit. The overlay holds `projects.config.json`, `projects.d/`, `README.md` (three-host topology, IPs, who runs what), `docs/sources-live.md` (the owen-ops example), `ideas/`, tenant notes. Alternatives rejected: (a) owen-ops/bluefin-ops — they are the tenant agents' context; operator topology is noise there (Owen, 2026-10-15); (b) git submodule — pins a commit in the public repo and leaks the private repo name in `.gitmodules` for nothing; (c) copybara/subtree export from a private monorepo — nothing in the code is private, only the instance. The overlay is only needed where deploys run (the main checkout), so worktrees not having it is fine.
- **Product docs keep the mechanism, overlay keeps the instance.** `docs/sources.md` keeps schema, commands and scope rules with `you@example.com`-style values; `infra/prod/README.md` describes the runtime dir, the ops-repo pattern and `runtime.example/` as the template; `README.md`/`docs/*` say `<gateway-host>`. Cross-references both ways ("see your ops repo" / overlay links public paths), so context is not lost, it is split by reader. `manage-project` SKILL stays public with the mechanics and reads slugs/hosts from the overlay; whether Claude Code also loads `.claude/skills` from a nested checkout is checked during apply (if yes, the Bluefin-specific half of the skill can move to the overlay).
- **Apache-2.0** (decided 2026-10-15). `LICENSE` + `license` field in `package.json`; no per-file headers.
- **GitHub hardening is a prerequisite, not a follow-up** (amended 2026-10-15: environment protection rules and fork-PR approval are refused on a private Free-plan repo, so those two land within minutes after the flip; everything else before). Before the flip: `production` environment → required reviewer (Owen) + deployment branch policy "selected tags: `v*`"; Actions → "Require approval for all outside collaborators", fork PRs cannot read secrets by GitHub default but the environment policy closes the `workflow_dispatch`-with-ref path; secret scanning + push protection enabled (free on public). Dependabot security updates on, version updates off (noise).
- **History rewrite with `git filter-repo`, after the sweep PRs are merged** so the guard has already proven the tree clean and the replacement file is final. Procedure in Migration Plan. Commit messages are not rewritten (out of scope).
- **Flip only after the rewrite is verified**: `git log --all -p | grep -f public-guard.txt` empty on the fresh mirror, CI green on `main`, one tag re-run of `verify` (not `deploy`) green.

## Risks / Trade-offs

- [Force-pushed tags detach GitHub Releases] → releases reference tag names; after the force-push, check each release still shows its tag (`gh release list`); if one turned draft, re-publish it from the draft (notes are preserved). Deploy history is not affected.
- [Home bot checkout on rewritten main] → `git fetch && git reset --hard origin/main` in the main tree + `systemctl --user restart coach-aven-home`; done inside the restart window (20:30–08:00 MSK). Worktree branches: `git rebase --onto origin/main <old-main-sha> <branch>` each, or recreate — the diff is tiny and re-applies.
- [Open PRs at rewrite time] → freeze: list open PRs, merge or close, rewrite, then re-open from rebased branches. Otherwise GitHub shows them against the old base.
- [Public issues/PR spam, Dependabot noise] → Discussions/Wiki/Projects off; issue template pointing to coachaven.com for support; `CONTRIBUTING.md` says PRs are reviewed when time allows.
- [Golden prompt fixtures (`src/fixtures/prompt/*.txt`) contain host names] → check first; if a hostname is in a golden, it changes with the sweep and is re-snapshotted on purpose (bucket 2 by test, prod prompt text unaffected because prod's hostnames come from `projects.config.json`, not from the base text).
- [A client-named string that is actually load-bearing (e.g. a channel-name prefix default `bluefin-aven-`)] → the guard list does not include product defaults; only identifiers of people/tenants/hosts. Reviewed line by line in PR 1.

## Migration Plan

1. PR 1 (tests + comments), PR 2 (ops overlay: create `coach-aven-ops`, move instance content, `deploy.sh` over git, docs/skill placeholders), PR 3 (LICENSE, README, CONTRIBUTING, SECURITY, guard + gitleaks in CI). Each: `npm run typecheck && npm test && bash scripts/public-guard.sh`.
2. GitHub settings (environment, Actions, scanning) — done in the UI/`gh api`, recorded in `infra/prod/README.md`.
3. Freeze: no open PRs; home bot restart window.
4. Rewrite on a fresh mirror: `git clone --mirror`, `git filter-repo --replace-text replacements.txt`, verify with the guard over `git log --all -p`, `git push --force --mirror` (branches + tags).
5. Re-base: main checkout hard-reset + restart; worktrees rebased; `gh release list` checked; one `verify` run green.
6. `gh repo edit --visibility public`; landing page gets the Source link; `docs/rollout.md` row dated.

## Open Questions

- ~~Does any golden prompt fixture carry a Bluefin hostname?~~ Checked 2026-10-15: no (`grep` over `src/fixtures/prompt/*.txt` and the twin fixtures is empty) — PR 1 re-snapshots nothing.
- ~~Does Claude Code load `.claude/skills` from the nested overlay checkout?~~ Checked 2026-10-15 with a probe skill in `infra/prod/runtime/.claude/skills/`: **no** (`claude -p` reports it absent). So `manage-project` stays public with the mechanics; instance values (hosts, team ids, slugs) live in the overlay README and the skill points there.
- Overlay layout: `infra/prod/runtime/{projects.config.json,projects.d/,README.md,docs/,ideas/}` proposed; `.env` + `.pem` stay untracked inside it (`.gitignore` in the overlay).
