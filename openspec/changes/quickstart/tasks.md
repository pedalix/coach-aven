# Tasks

## 1. The sign-in link (bucket 2)

- [x] 1.1 `webConfigFrom` in `src/config.ts` accepts `WEB_AUTH=link` (design D2):
  - any bind, and a localhost base URL (default `http://localhost:<port>`);
  - `org` defaults to `local`;
  - a set `WEB_SESSION_SECRET` must have at least 32 characters;
  - `WebConfig.auth` gains `'link'`.

  Verify in `src/config.test.ts`:
  - link on `0.0.0.0` is accepted;
  - a public base URL is refused, with a sentence naming `WEB_BASE_URL`;
  - a short secret is refused;
  - `none` on `0.0.0.0` is still refused;
  - the `oidc` cases are unchanged.
- [x] 1.2 The session secret under `link` when `WEB_SESSION_SECRET` is unset: generated on first boot and kept in `AVEN_DIR/web-session.secret` (0600), reused afterwards. A function beside the web config, given the directory. Verify with a test over a temp directory: first call creates the file with mode 0600, a second returns the same value, and a set variable wins without touching the file. `.gitignore` covers the file at the root and under `quickstart/`.
- [x] 1.3 `src/chat/web/server.ts`:
  - **Explicit branches.** `/login` and `/auth/callback` test `cfg.auth` by name, never `!deps.oidc` alone.
  - **The key.** Under `link`, `/login?key=` compares the key in constant time and sets the local user's session.
  - **Refusals.** A missing or wrong key gets the 401 page that points to `docker compose logs bot | grep sign-in`.
  - **No session.** A request without a session redirects to `/login`, as today.

  `app.ts`:
  - the per-boot key, drawn at boot;
  - the local user is an operator under `link`;
  - the sign-in line is written to stdout directly after `Web chat running`;
  - a `link` counterpart of the `WEB_AUTH=none` warning.

  Verify over HTTP in the server tests:
  - right key → a session, and `/usage` answers;
  - wrong or missing key → 401, no cookie, and `putWebUser` not called;
  - no session → no room, `/stream` or `/upload`;
  - a session cookie from before a key change still works;
  - the key goes through no `log.*` call (a spy on the logger);
  - every `none` and `oidc` test passes unchanged.
- [x] 1.4 Docs and templates for `link`:
  - `docs/web.md`: the *Local run* paragraph names `link` beside `none`, with what each is for, the localhost rule, where the link is, the secret file, and that localhost cookies are shared across ports;
  - `.env.example` and `infra/deploy/ops.example/.env.example`: the `WEB_AUTH` comment lists `link` (the ops template has no `WEB_AUTH` line: an operated installation never uses `link`, so it stays as it is).

  Verify: a read, the doclinks test, the public guard.

## 2. The local Docker check (bucket 2)

- [x] 2.1 A function in `src/sshdocker.ts`, started without waiting from the shared boot path when `SSHDOCKER_HOST=local` (design D6):
  - `docker version` with a 10 s timeout, retried for up to 60 s;
  - after the last failure, one error line naming the socket, the process's groups and the fix;
  - no error-tracker event.

  Verify with a test over a stub exec and a fake clock:
  - failing throughout → one error line with the text;
  - failing for 30 s, then answering → nothing logged;
  - success → nothing logged;
  - an ssh host → the exec is never called;
  - the boot path does not await it.

## 3. The quickstart directory

- [x] 3.1 `quickstart/.env.example`, the trial minimum, each line with a one-line comment:
  - `CLAUDE_CODE_OAUTH_TOKEN`, and `ANTHROPIC_API_KEY` commented out with the exposure line;
  - `GITHUB_TOKEN`, with the permissions and "one repository, an expiry";
  - `SANDBOX_DRIVER=ssh-docker`, `SSHDOCKER_HOST=local`;
  - `SANDBOX_NAME_PREFIX=qs-`, `SANDBOX_MANAGED_BY=coach-aven-quickstart`;
  - `SNAPSHOT_IMAGE=coach-aven-sandbox-plain:local`, `CLAUDE_CLI_VERSION`, `CLAUDE_MODEL`;
  - `WEB_AUTH=link`, `WEB_BIND=0.0.0.0`.

  `quickstart/projects.config.example.json`: one project, as in design D5.

  Verify:
  - a test loads both through `loadConfig` and `loadProjects` with the placeholders filled, and `resolveSandboxOptions` gives `privileged: false, dind: false`;
  - `src/cliprobe/gate.test.ts` checks the quickstart's `CLAUDE_CLI_VERSION` against `PROBED_CLI_VERSIONS`.
- [x] 3.2 `quickstart/compose/compose.yaml` (design D1, D3, D4):
  - **`sandbox-image`:** built from `../../snapshot/plain`, tagged `coach-aven-sandbox-plain:local`, one-shot.
  - **`bot`:**
    - image `ghcr.io/pedalix/coach-aven:${AVEN_VERSION:?…}`, command `web`;
    - `AVEN_DIR=/aven` and `HOME=/aven/home`;
    - `WEB_PORT` and `WEB_BASE_URL` from `AVEN_WEB_PORT`, published as `127.0.0.1:${AVEN_WEB_PORT}:${AVEN_WEB_PORT}`;
    - `user`, `group_add` and the socket;
    - `init`, `stop_grace_period`, `restart: unless-stopped`;
    - `depends_on` the image build, `service_completed_successfully`.

  Every interpolation has `:?run ./init.sh first`. A header comment says what each part is for, in the style of `infra/deploy/compose.yaml`.

  Verify:
  - `docker compose config` passes with a filled `compose/.env`, and fails naming `./init.sh` without it;
  - a test reads the file and asserts the loopback-only publish, the absence of `privileged`, and no `latest`.
- [x] 3.3 `quickstart/init.sh` (design D4):
  - POSIX sh, safe to rerun;
  - copies the two templates only when their targets are missing;
  - writes the exact tag or `sha-<HEAD>` with a warning;
  - finds the socket group through `docker run … stat`;
  - takes the port from `AVEN_WEB_PORT` or uses 8787;
  - creates `home/`;
  - touches no credential.

  `.gitignore`: `/quickstart/*` except the tracked templates and `compose/compose.yaml`.

  Verify:
  - a test runs the script twice in a temp copy with a stub `docker` and `git` on `PATH`, and checks `compose/.env`, untouched copies, and the tag and sha branches;
  - `shellcheck` passes;
  - `git status` is clean after a real run.

## 4. Docs

- [x] 4.1 `docs/quickstart.md` (design D7, D8):
  - before you start: Docker, a GitHub account, and a Claude subscription or an Anthropic Console account;
  - the numbered steps in the proposal's order (`init.sh` before the token), with commands and time placeholders;
  - two ways to get the token;
  - the GitHub token's exact permissions and an expiry;
  - the security line;
  - the platforms run;
  - "Uninstall", the sandbox containers by label included;
  - "Going on", with the configuration files named for an ops repository.

  README: a "Try it" block linking to the page.

  Verify: the doclinks test, the public guard, and a read of the page top to bottom.
- [x] 4.2 `docs/rollout.md`: the row "quickstart (`WEB_AUTH=link`)", bucket 2. The canary is the rehearsal and the maintainer's run; there is no prod stage. It retires when the maintainer's times are in `docs/quickstart.md`. Verify: a read.

## 5. Ship and measure

- [x] 5.1 One PR for sections 1–4, bucket 2, with the ledger row. No Home tab change: the Slack surface is untouched. Verify: `npm run typecheck`, `npm test`, the public guard and gitleaks on every changed file and on the PR text, and an independent review before merge.
- [x] 5.2 The Linux rehearsal (design D8). In a fresh privileged `docker:dind` container standing in for a clean Linux machine, follow `docs/quickstart.md` verbatim from `git clone` to the first answer in the room, on the merged `main` commit (`sha-<commit>`).
  - Time each step.
  - Use a fine-grained token for a scratch repository and a subscription token.
  - Try `docker compose run --rm sandbox-image claude setup-token` in a TTY (now `docker compose run --rm setup-token`, task 6.2). If it does not work, drop that way from the page.
  - Run "Uninstall" at the end.
  - Fix the page or the files in a follow-up PR wherever a step did not work as written.

  Verify:
  - the first answer in the room;
  - a PR opened by the agent in the scratch repository;
  - no container with the quickstart's label left after "Uninstall";
  - the times in the page.
  *Done 2026-10-30 on `sha-eb1b7a4`, in `docker:dind` on WSL2:*
  - 5 s clone, 35 s `init.sh`, 70 s sandbox image build, 5 s `up`;
  - 25 s to the first answer, 25 s to the agent's PR in the scratch repository;
  - `setup-token` in a TTY reaches "Paste code here";
  - the GitHub token was an App installation token scoped to the scratch repository, because a fine-grained token can only be created in the UI;
  - "Uninstall" left nothing.

  Nothing in the page needed fixing. The note for a release that predates `quickstart/` was exercised: v0.43.0.
- [x] 5.3 The WSL run on the maintainer's machine. The quickstart runs beside the home bot with `AVEN_WEB_PORT=8790`. Verify:
  - the socket group `init.sh` found works;
  - the first answer;
  - the home bot's containers untouched.

  Then run "Uninstall".
  *Done 2026-10-30 on port 8790 beside the home bot:*
  - `init.sh` found group 1001;
  - first answer in 21 s;
  - the home containers were untouched.
- [ ] 5.4 **Needs the maintainer: a clean cloud VM and a stopwatch, after the next release tag.** The maintainer follows the page. Goal: under 60 minutes from clone to first answer. The times replace the rehearsal's, with the date and the VM type. Verify: the page's numbers and the date; the ledger row retired.
- [ ] 5.5 Archive with `/openspec-archive-change` after 5.4.

## 6. The published sandbox image (design D3, revised)

- [x] 6.1 CI publishes the plain sandbox image.
  - `image.yml`: the image × architecture matrix, and one manifest list per image as `sha-<commit>`.
  - `release.yml`: both images promoted, with a notice for a commit without a sandbox image.
  - `ci.yml`: `sandbox-pr` builds `snapshot/plain` on both architectures for a pull request that changes it, and checks the toolchain.
  - `dependabot.yml`: `/snapshot/plain`. The base is pinned by digest.

  Verify:
  - the workflows parse;
  - the first `main` run publishes both images;
  - `docker manifest inspect` shows two platforms each;
  - an anonymous pull works.
- [x] 6.2 The quickstart runs the published image.
  - `compose.yaml`: `SNAPSHOT_IMAGE` from `AVEN_VERSION`, or from `SANDBOX_IMAGE`; the `setup-token` service under a profile; no `build:`.
  - `init.sh`: pulls both images and stops early when either is not published; writes `SANDBOX_IMAGE` when it is set.
  - `.env.example`: no `SNAPSHOT_IMAGE`.
  - docs: `docs/quickstart.md`, `snapshot/README.md`, the header of `build-and-push.sh`.

  Verify: `src/quickstart.test.ts` (one version names both images, nothing built, the override written), shellcheck.
- [x] 6.3 The package `coach-aven-sandbox-plain` is public after its first publish. Verify: `docker pull` without a login.
- [x] 6.4 The rehearsal again on the published image (as 5.2). Verify:
  - `init.sh` pulls both images;
  - `docker compose run --rm setup-token` reaches the paste prompt;
  - the first answer comes;
  - the page's times are updated.
  *Done 2026-10-30 on `sha-b85e606`, in a fresh `docker:dind`:*
  - 4 s clone; 115 s `init.sh`, both images from an empty cache;
  - `docker compose run --rm setup-token` reaches the paste prompt in 4 s;
  - 3 s `up`, 22 s to the first answer;
  - the sandbox ran `ghcr.io/pedalix/coach-aven-sandbox-plain:sha-b85e606…`, unprivileged, with no pull during the turn;
  - the package pulls anonymously (6.3: manifest 200 without a login).

## 7. One script (design D9)

- [x] 7.1 `quickstart/coach-aven` replaces `init.sh`: `init [owner/repo]`, `setup-token`, `up` (force-recreate, then the
  current start's link), `link`, `logs`, `down`, `uninstall` (the label's containers, this version's two images).
  `compose.yaml` names `./coach-aven init` in every `${…:?}`. Verify: `src/quickstart.test.ts` (init copies and rewrites,
  the repository written and replaced, a bad one refused, `up`/`link` print the current start's link, nothing before
  init), `sh -n`.
- [x] 7.2 The templates: no `sandbox` block in the quickstart example (the default is plain); the root example drops
  `driver`, the default `sandbox` flags and the mount; Slack beside the web chat as commented lines in
  `quickstart/.env.example`. Verify: `src/quickstart.test.ts`, `src/preview.test.ts`, `src/projects.test.ts`.
- [x] 7.3 The texts that named `init.sh` or the grep: the web login page and its test, the local-Docker boot error,
  `docs/quickstart.md` (steps, what to ask next, uninstall, Slack), `docs/troubleshooting.md`, the README (the try-it
  line, *Self-host with Slack or Teams* as one path: trial → Slack → server), `docs/why.md`, `docs/glossary.md`,
  `docs/local-dev.md`, `docs/README.md`. Verify: `npm test`, `grep -rn init.sh` finds only archived changes.
- [ ] 7.4 A rehearsal of the new steps in a fresh `docker:dind` (as 6.4), with Slack added once a test Slack app exists.
  Verify: `up` → answers → the link → first answer → `uninstall` leaves nothing (see 8.5).

## 8. One command that asks; GitHub access optional (design D10)

- [x] 8.1 `GITHUB_AUTH=none` (spec `github-access`): `githubAuthNone` in `config.ts`, an empty token from
  `getGitHubToken`, `seedGitHubAuth` seeds only the identity, composer auth skipped, `apiHeaders` without
  `Authorization`, the prompt paragraph (`noGitHub`). Verify: `src/config.test.ts`, `src/github.test.ts`,
  `src/project.test.ts`, `src/prompt.test.ts` (golden `single-repo-no-github`, the four others unchanged).
- [x] 8.2 `quickstart/coach-aven up` writes the machine every run and asks for what `.env` lacks; `init` and
  `setup-token` removed; the example points at `pedalix/coachaven-quickstart-demo`; `.env.example` carries
  `# GITHUB_AUTH=none`. Verify: `src/quickstart.test.ts` (Enter twice, own repository and token, a rerun asks nothing,
  a later token, no terminal, a bad repository, unpublished image, link).
- [x] 8.3 The page, the README, troubleshooting, glossary, `why.md`, the Docker boot error and `configuration.md`
  (`GITHUB_AUTH`). Verify: `npm test` (`configdocs.test.ts`), `grep -rn 'coach-aven init'` finds only the design.
- [x] 8.4 `pedalix/coachaven-quickstart-demo` public, its rehearsal PRs closed. Verify: an anonymous `git clone`.
  *Done 2026-10-31: five rehearsal PRs closed with their branches, no deny-list hit in the tree or the PRs, the
  repository public; an anonymous clone and the unauthenticated API (200) work.*
- [ ] 8.5 Task 7.4's rehearsal covers both paths: Enter twice (the demo, a question, a change shown as a diff) and the
  person's repository with a token (a pull request).
