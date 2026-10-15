# Tasks

## 0. Inventory and the replacement list

- [x] 0.1 `scripts/public-guard.txt` with the forbidden patterns (e-mail domains, Entra GUID, Slack team ids, IPs, Bluefin hostnames) and `scripts/public-guard.sh` (`git ls-files -z | xargs -0 grep -nEf scripts/public-guard.txt` → exit 1 on a hit, prints file:line). Verify: the script fails on today's `main`, listing every file from the 2026-10-15 inventory.
- [x] 0.2 Golden prompt fixtures checked 2026-10-15: no Bluefin hostname or name in `src/fixtures/prompt/*.txt` or the twin fixtures — nothing to re-snapshot.

## 1. PR 1 — tests and comments (`fix`)

- [x] 1.1 Anonymise the 15 `src/sources/**/*.test.ts` + `src/scrub.test.ts`: addresses → `<role>@example.com`, Entra GUID → `00000000-0000-4000-8000-000000000000`, `T0000FAKE01` → `T_FIX_1` (also `src/fixtures.test.ts`, `src/dispatch.test.ts`, `src/sources/slack/normalise.test.ts`). Verify: `npm test` green, `bash scripts/public-guard.sh` reports no `src/` hit.
- [x] 1.2 Comments: `src/sources/people.ts` example person, `src/sources/google/auth.ts`, `src/sources/{google,msgraph}/normalise.ts`, `src/youtrack.ts`, `src/youtrack.test.ts` → placeholder identities. Verify: guard clean on `src/`.
- [ ] 1.3 `npm run typecheck && npm test`; merge; home bot picks it up (no behaviour change — canary is "tests green, bot unchanged").

## 2. PR 2 — ops overlay + docs placeholders (`docs`/`fix`)

- [x] 2.1 Create private `pedalix/coach-aven-ops` (`gh repo create pedalix/coach-aven-ops --private`), `.gitignore` with `.env`, `*.pem`, `state.json`. Seed from today's `infra/prod/runtime/` (after `npm run prod:import`): `projects.config.json`, `projects.d/`. Verify: `git -C infra/prod/runtime status` clean, no `.env`/`.pem` tracked (`git ls-files | grep -E '\.env|\.pem'` empty).
- [x] 2.2 Move instance content into the overlay: `README.md` (three-host topology with IPs, services, restart window), `docs/sources-live.md` (today's `docs/sources.md` example block verbatim), `ideas/` (currently untracked in the public tree), tenant notes worth keeping from memory. Verify: overlay README names every host the public README used to.
- [x] 2.3 `infra/prod/deploy.sh`: `export` = `git -C "$RUNTIME_DIR" push` (fails if dirty/unpushed, prints the hint) + scp of `.env` and the App key; `import` = `git -C "$RUNTIME_DIR" pull --ff-only` + scp back of the two secret files; `RUNTIME_DIR` without a `.git` → `die` with the clone command. Verify: `npm run prod:import` on the main checkout, then `npm run prod:export` is a no-op and the box's files are byte-identical (`ssh … sha256sum`).
- [x] 2.4 Public mechanism docs: `infra/prod/README.md` (runtime dir = your ops repo, how to start one, `DEPLOY_HOST=<host>`), new `infra/prod/runtime.example/` (`projects.config.json` + one `projects.d/example.md` with placeholders), `infra/prod/.env.example` without the IP. Verify: guard clean on `infra/`.
- [x] 2.5 `docs/sources.md` → schema, commands, scope rules with `you@example.com`/`T_FIX_1`/fake GUID; a one-line pointer "a live example lives in your ops repo". Verify: guard clean on `docs/`.
- [x] 2.6 `README.md`, `docs/*.md`, `projects.config.example.json`, `slack-app-manifest.json`, `.env.example`: Bluefin hostnames → `<gateway-host>` / `<grafana-host>` / `<daytona-host>`, people names removed. Verify: guard clean repo-wide.
- [x] 2.7 `.claude/skills/manage-project/SKILL.md`: mechanics stay, slugs/hosts read from `infra/prod/runtime/`; check whether Claude Code loads `.claude/skills` from the nested overlay (`claude --print '/manage-project'` from the main checkout after adding a stub skill in the overlay) and record the answer in design.md. Verify: guard clean on `.claude/`.
- [x] 2.8 `openspec/changes/*/proposal.md`: names of people → roles; archive the completed change (`sources-slack-channel-allowlist`) with `/opsx:archive`. Verify: `bash scripts/public-guard.sh` clean on `openspec/ docs/ README.md`.
- [x] 2.9 Home bot: its config is outside the repo (`PROJECTS_CONFIG_PATH=~/owen-ops-home/runtime/…`), so the overlay does not touch it; note that in the overlay README. Verify: `systemctl --user status coach-aven-home` unchanged after merge.

## 3. PR 3 — public scaffolding and the guard (`docs`/`ci`)

- [x] 3.1 `LICENSE` Apache-2.0 (copyright "Owen Hale"), `"license": "Apache-2.0"` in `package.json`.
- [x] 3.2 `README.md` rewritten: what it is, architecture in five lines, self-host quickstart (Slack app from the manifest → `.env` → `SANDBOX_DRIVER` → first project), status disclaimer, link to coachaven.com. `CONTRIBUTING.md` (typecheck + test + OpenSpec + rollout buckets), `SECURITY.md` (contact, no bounty).
- [x] 3.3 CI: `public-guard` job + gitleaks action in `.github/workflows/release.yml` `verify` and a new `ci.yml` on push/PR; `.gitleaks.toml` allow-listing `src/scrub.test.ts`, `src/sources/audit.test.ts`, `.env.example`. Verify: a scratch branch adding a real partner-domain mailbox to a test fails CI.
- [x] 3.4 `docs/rollout.md` row: "Public-repo hygiene guard + history rewrite" | PR numbers | gate: none (no behaviour change) | date | canary note "tests green, bot unchanged".

## 4. GitHub hardening (settings, before the flip)

- [ ] 4.1 `production` environment: required reviewer Owen; deployment branch policy → tags `v*` only. Verify: `gh api repos/pedalix/coach-aven/environments/production` shows the rule and the policy. **Tried 2026-10-15: GitHub refuses both on a private repo of a Free-plan org (HTTP 422 "billing plan" / 404 on branch policies); they are available for public repos → do this within minutes of 6.1.** Risk in that gap is nil: deploy runs only on tag push (write access) and fork PRs never get secrets.
- [ ] 4.2 Actions: fork PR approval required; secret scanning + push protection on; Dependabot security updates on; Discussions/Wiki/Projects off. Verify: `gh api repos/pedalix/coach-aven` fields. **Done 2026-10-15 except fork-PR approval** (secret scanning + push protection enabled, Dependabot alerts + security updates enabled, wiki/projects/discussions off); fork-PR approval is "not allowed for private repositories" → right after 6.1.
- [ ] 4.3 Branch protection on `main`: PR required, status checks `verify` + `public-guard` required. (Only after PR 3 is on `main`: a required check that has never reported blocks every merge.)

## 5. History rewrite (option B, decided 2026-10-15)

- [ ] 5.1 Freeze: `gh pr list` empty (merge or close; note branch names); restart window open (20:30–08:00 MSK).
- [ ] 5.2 Fresh mirror in the scratchpad: `git clone --mirror`, `scripts/public-guard-replacements.txt` (derived from the guard list, committed with PR 3), `git filter-repo --replace-text …`. Verify: `git log --all -p | grep -Eif scripts/public-guard.txt` empty; `git tag | wc -l` unchanged; `git rev-list --all --count` unchanged. **Dry run 2026-10-15 on a scratch mirror: 796 matching lines → 0; 352 commits → 352; 66 tags → 66; 2.3 s.** The real run repeats this on a fresh mirror after PRs #149–#151 are merged.
- [ ] 5.3 `git push --force --mirror origin`. Verify: `gh release list` shows every release attached to its tag (re-publish any draft).
- [ ] 5.4 Main checkout: `git fetch && git reset --hard origin/main`; `systemctl --user restart coach-aven-home`; `journalctl --user -u coach-aven-home -n 20` shows a clean start. Worktrees: rebase each live branch onto the new `main` (`git rebase --onto origin/main <old-main> <branch>`), or delete if merged.
- [ ] 5.5 Re-run `verify` for the latest tag via `workflow_dispatch` (not `deploy`). Verify: green.

## 6. Flip

- [ ] 6.1 `gh repo edit pedalix/coach-aven --visibility public`. Verify: anonymous `git ls-remote https://github.com/pedalix/coach-aven` works; CI on the next push green with the guard.
- [ ] 6.2 coachaven.com: "Source on GitHub" link (Lovable project); README link back. Verify: both links resolve.
- [ ] 6.3 Memory/ledger: `docs/rollout.md` row dated; owen-ops `docs/PLAN.md` one decision line ("repo public since <date>, history rewritten <date>, installation lives in coach-aven-ops"); nothing else goes to the tenant repos.
