# Tasks

## 1. Parsing and validation

- [ ] 1.1 `src/repohost.ts`: `parseRepo(entry)` → `{ host: 'github' | 'bitbucket', owner, name, url }` (throws on another host or a malformed entry), `githubRepos(list)`, `bitbucketRepos(list)`; `src/repohost.test.ts` with two-segment, `bitbucket.org/` and invalid entries
- [ ] 1.2 `src/project.ts`: `repoName` = the last segment (via `repohost`); test that `owner/name` gives today's names
- [ ] 1.3 `src/projects.ts`: each entry parses, or the load fails naming project and entry; duplicate checkout names fail naming both; tests in `src/projects.test.ts`
- [ ] 1.4 `src/config.ts`: `BITBUCKET_TOKEN`; the load fails when a project has a Bitbucket entry and the token is empty, naming the projects; never logged; tests

## 2. Sandbox credential and clone

- [ ] 2.1 `src/project.ts` `seedBitbucketAuth(sandbox, token | undefined)`: the token file (600, file API) and the two `credential.https://bitbucket.org.helper` lines (D3); with no token, both removed; test the exec calls with the fake sandbox
- [x] 2.2 Verify D3 (`git credential fill` for `bitbucket.org` and `github.com` with both helpers set, both file orders): done 2026-11-18 with git 2.55, recorded in the design; repeat once in the sandbox image's git during 2.1's test run
- [ ] 2.3 `cloneRepo`: URL from `repohost` for the clone and the `remote set-url` reset; tests for both hosts; the GitHub case's commands byte-identical

## 3. Turn wiring

- [ ] 3.1 `src/tasks.ts`: `scopedRepos` over GitHub repos only; no GitHub repo → `seedGitHubAuth(sandbox, '')` and no composer `auth.json`; `seedBitbucketAuth` in `prepareChat` and both `ensureSession` paths; tests that a GitHub-only project's calls are unchanged
- [ ] 3.2 `src/github.ts`: the installation lookup and the identity lookup run only when there is a GitHub repo; test a Bitbucket-only project makes no GitHub request

## 4. Prompt and PR work

- [ ] 4.1 `src/prompt.ts`: the repo list shows each repo's host; a read-only paragraph for Bitbucket repos (no push, no PR, propose a diff); a Bitbucket-only project gets no `pr`/`direct` flow text; new golden fixture for a mixed project; every existing fixture byte-identical
- [ ] 4.2 `src/pollers.ts` (auto-review, autofix watches) and `src/chat/core/commands.ts` (`/aven status` PR count, `/aven pr` on a Bitbucket repo answers that it is read-only): GitHub repos only; tests

## 5. Docs and checks

- [ ] 5.1 `docs/runtime-config.md` (the `repos` field: the `bitbucket.org/` form, read-only), `docs/configuration.md` (`BITBUCKET_TOKEN`: kinds of token, scope, rotation), `docs/security.md` (what reaches a sandbox), `projects.config.example.json` (one Bitbucket entry)
- [ ] 5.2 `npm run typecheck && npm test`; `scripts/public-guard.sh`; `openspec validate bitbucket-repos --strict`
- [ ] 5.3 Canary on the installation that needs it: one Bitbucket-only project, a conversation that clones, fetches on the next turn, and answers from the code; a push attempt refused by Bitbucket
