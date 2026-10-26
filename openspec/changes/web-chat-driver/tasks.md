# Tasks

## 1. Groundwork

- [ ] 1.0 Prerequisite: `multi-driver-installation` PR 1 and PR 2 merged and canaried on the Teams staging installation. Verify: `CHAT_SURFACES` accepts a second surface there.
- [ ] 1.1 Pin the OIDC client and markdown packages (exact versions ≥ 2 weeks old, licences checked); record in design D3/D4. Verify: versions and dates noted.
- [ ] 1.2 Register an OIDC app client for the web surface in the platform's Cognito staff pool (the installation's Terraform, like the gateway's bot clients); values in the ops overlay, placeholders in `docs/web.md`. Verify: the login round trip works against a stub page with a staff account.

## 2. PR 1 — web driver core (bucket 3 by construction)

- [ ] 2.1 `web` in `drivers.ts` as a surface plugin of the shared root (`orch web` = default surface, `CHAT_SURFACES=web` = additional); `webRoom` on `ProjectConfig`; `web` config block (`WEB_PORT`, `WEB_BASE_URL`, `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_ALLOW`, `WEB_OPERATORS`, `WEB_SESSION_SECRET`, `WEB_MAX_FILE_MB`, `WEB_AUTH`). Verify: config tests for absent / partial / full and the localhost-only `WEB_AUTH=none` rule.
- [ ] 2.2 Server, login, session, CSRF, allow-list, security headers. Verify: tests for 401 / redirect, denied page, forged POST rejected, CSP header present.
- [ ] 2.3 History store (`web/<slug>/*.jsonl`, compaction, room index, `visibleTo`). Verify: store tests, including replay from an event id and restart.
- [ ] 2.4 `webformat.ts` (markdown → safe HTML) and `webviews.ts` (status, answer, question, thread, room, Home). Verify: golden tests + hostile-input suite (script tags, event attributes, `javascript:` / `data:` links, nested HTML in code).
- [ ] 2.5 SSE stream with per-user visibility and `Last-Event-ID` resume; client script for swaps, posting, the composer. Verify: stream tests with two users and a reconnect.
- [ ] 2.6 Driver inbound/outbound wiring: top-level posts, thread replies, private conversations, `!` notes, status lifecycle with Cancel / Show steps / Restart, questions, recovery. Verify: the core turn scenarios of `chat-driver-interface` run against the web driver.
- [ ] 2.7 `docs/web.md` (model, config, login, nginx with SSE, data dir, placeholders); ledger row "Web installation mode", gate `orch web`; PR. Verify: CI green, `scripts/public-guard.sh` clean.

## 3. PR 2 — parity rest (bucket 3)

- [ ] 3.1 Commands (MVP): `/status`, `/help`, `/home`, `/restart` with suggestions, private replies, the private-question form of `/`. Verify: those verb scenarios against the web driver; the rest answer "not on the web yet".
- [ ] 3.2 Dialogs, feedback with live tally, Session panel, PR links, background / long-task entries. Verify: view snapshots + feedback record test.
- [ ] 3.3 File upload, limits, protected download. Verify: upload tests (limit, rejected file named), headers on download.
- [ ] 3.4 Background deliveries (MVP): routines, dream, housekeeping, reviews, alerts, the ✋ held-message card. Verify: the pollers scenarios of `chat-driver-interface` against the web driver, minus YouTrack and autofix.
- [ ] 3.5 Allow-list from config (e-mails and Cognito groups), operators as admins; `/users` read-only. Verify: access tests with web identities.
- [ ] 3.6 Home page from the shared cheat-sheet source; unread counts and in-tab notifications. Verify: view snapshot; Slack `homeBlocks` snapshot unchanged.
- [ ] 3.7 `/security-review` on the branch; findings fixed or recorded. Ledger row; PR. Verify: CI green.

## 4. Canary

- [ ] 4.1 Home bot with `CHAT_SURFACES=web` on localhost (`WEB_AUTH=none`), the canary project in a room; run every MVP spec scenario. Verify: scenarios ticked in the PR; the Slack home bot shows no regression.
- [ ] 4.2 The Teams staging installation with `CHAT_SURFACES=web` on a hostname behind its nginx: the newsletter project rebound from Teams to its web room, Brandnamic's people on the allow-list, a newsletter built end to end (stop 1, stop 2 with the preview link, upload on an explicit go-ahead, photos attached), reconnect, restart mid-turn. Verify: two-user live scenarios; `platform` on Teams unaffected.

## 5. PR 3 — the rest of parity (when a client needs it)

- [ ] 5.1 The remaining `/aven` verbs, YouTrack card + dialogs + mentions, autofix Fix, `/users` editing the allow-list. Verify: the remaining verb and poller scenarios against the web driver; ledger row.
