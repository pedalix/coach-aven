# Tasks

## 1. Groundwork

- [ ] 1.1 Pin the OIDC client and markdown packages (exact versions ≥ 2 weeks old, licences checked); record in design D3/D4. Verify: versions and dates noted.
- [ ] 1.2 Register an OIDC client for the home installation in our identity provider; values in the home runtime dir, placeholders in `docs/web.md`. Verify: the login round trip works against a stub page.

## 2. PR 1 — web driver core (bucket 3 by construction)

- [ ] 2.1 `orch web` in `src/cli.ts`; `web` config block (`WEB_PORT`, `WEB_BASE_URL`, `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_ALLOW`, `WEB_OPERATORS`, `WEB_SESSION_SECRET`, `WEB_MAX_FILE_MB`, `WEB_AUTH`). Verify: config tests for absent / partial / full and the localhost-only `WEB_AUTH=none` rule.
- [ ] 2.2 Server, login, session, CSRF, allow-list, security headers. Verify: tests for 401 / redirect, denied page, forged POST rejected, CSP header present.
- [ ] 2.3 History store (`web/<slug>/*.jsonl`, compaction, room index, `visibleTo`). Verify: store tests, including replay from an event id and restart.
- [ ] 2.4 `webformat.ts` (markdown → safe HTML) and `webviews.ts` (status, answer, question, thread, room, Home). Verify: golden tests + hostile-input suite (script tags, event attributes, `javascript:` / `data:` links, nested HTML in code).
- [ ] 2.5 SSE stream with per-user visibility and `Last-Event-ID` resume; client script for swaps, posting, the composer. Verify: stream tests with two users and a reconnect.
- [ ] 2.6 Driver inbound/outbound wiring: top-level posts, thread replies, private conversations, `!` notes, status lifecycle with Cancel / Show steps / Restart, questions, recovery. Verify: the core turn scenarios of `chat-driver-interface` run against the web driver.
- [ ] 2.7 `docs/web.md` (model, config, login, nginx with SSE, data dir, placeholders); ledger row "Web installation mode", gate `orch web`; PR. Verify: CI green, `scripts/public-guard.sh` clean.

## 3. PR 2 — parity rest (bucket 3)

- [ ] 3.1 Commands: `/verb` with suggestions, private replies, private questions. Verify: every verb scenario of `chat-driver-interface` task 3.1 against the web driver.
- [ ] 3.2 Dialogs, feedback with live tally, Session panel, PR links, background / long-task entries. Verify: view snapshots + feedback record test.
- [ ] 3.3 File upload, limits, protected download. Verify: upload tests (limit, rejected file named), headers on download.
- [ ] 3.4 Background deliveries: routines, dream, housekeeping, reviews, autofix Fix, YouTrack card + dialogs + mentions, dispatch, alerts. Verify: the pollers scenarios of `chat-driver-interface` task 4.1 against the web driver.
- [ ] 3.5 `/users` editing the allow-list, operators as admins. Verify: access tests with web identities.
- [ ] 3.6 Home page from the shared cheat-sheet source; unread counts and in-tab notifications. Verify: view snapshot; Slack `homeBlocks` snapshot unchanged.
- [ ] 3.7 `/security-review` on the branch; findings fixed or recorded. Ledger row; PR. Verify: CI green.

## 4. Canary

- [ ] 4.1 Home web installation on localhost bound to the canary project; run every spec scenario. Verify: scenarios ticked in the PR.
- [ ] 4.2 Same installation on a hostname behind nginx with two colleagues on the allow-list. Verify: two-user live scenarios, reconnect, restart mid-turn; the Slack home bot shows no regression.
