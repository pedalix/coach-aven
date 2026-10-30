# Tasks

## 1. Groundwork

- [x] 1.0 Prerequisite: `multi-driver-installation` PR 1 and PR 2 merged and canaried on the Teams staging installation. Verify: `CHAT_SURFACES` accepts a second surface there. _(2026-10-26: #76 and #78 merged and deployed to home and staging; the second surface is the web itself — the operator chose to skip a Slack-surface rehearsal and canary the whole pack together.)_
- [x] 1.1 Pin the OIDC client and markdown packages (exact versions ≥ 2 weeks old, licences checked); record in design D3/D4. Verify: versions and dates noted. _(openid-client 6.8.8 of 2026-09-05, MIT; markdown-it 14.3.2 of 2026-09-12, MIT, with @types/markdown-it 14.2.0 — design D3/D4.)_
- [x] 1.2 Register an OIDC app client for the web surface in the platform's Cognito staff pool (the installation's Terraform, like the gateway's bot clients); values in the ops overlay, placeholders in `docs/web.md`. Verify: the login round trip works against a stub page with a staff account. — Done: the staging installation logs in against its Cognito staff pool (an app client of its own, beside the gateway's bot client).

## 2. PR 1 — web driver core (bucket 3 by construction)

- [x] 2.1 `web` in `drivers.ts` as a surface plugin of the shared root (`orch web` = default surface, `CHAT_SURFACES=web` = additional); `webRoom` on `ProjectConfig`; `web` config block (`WEB_PORT`, `WEB_BASE_URL`, `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_ALLOW`, `WEB_OPERATORS`, `WEB_SESSION_SECRET`, `WEB_MAX_FILE_MB`, `WEB_AUTH`). Verify: config tests for absent / partial / full and the localhost-only `WEB_AUTH=none` rule.
- [x] 2.2 Server, login, session, CSRF, allow-list, security headers. Verify: tests for 401 / redirect, denied page, forged POST rejected, CSP header present.
- [x] 2.3 History store (`web/<slug>/*.jsonl`, compaction, room index, `visibleTo`). Verify: store tests, including replay from an event id and restart.
- [x] 2.4 `webformat.ts` (markdown → safe HTML) and `webviews.ts` (status, answer, question, thread, room, Home). Verify: golden tests + hostile-input suite (script tags, event attributes, `javascript:` / `data:` links, nested HTML in code).
- [x] 2.5 SSE stream with per-user visibility and `Last-Event-ID` resume; client script for swaps, posting, the composer. Verify: stream tests with two users and a reconnect.
- [x] 2.6 Driver inbound/outbound wiring: top-level posts, thread replies, private conversations, `!` notes, status lifecycle with Cancel / Show steps / Restart, questions, recovery. Verify: the core turn scenarios of `chat-driver-interface` run against the web driver.
- [x] 2.7 `docs/web.md` (model, config, login, nginx with SSE, data dir, placeholders); ledger row "Web installation mode", gate `orch web`; PR. Verify: CI green, `scripts/public-guard.sh` clean. _(#80, merged 2026-10-26; canary on home and the Teams staging installation since then.)_

## 3. PR 2 — parity rest (bucket 3)

- [x] 3.1 Commands (MVP): `/status`, `/help`, `/home`, `/restart` with suggestions, private replies, the private-question form of `/`. Verify: those verb scenarios against the web driver; the rest answer "not on the web yet". _(Every router verb works on the web through the shared router; `/help` is the web's own (the Home dialog); Restart is the session panel's button, as on Slack.)_
- [x] 3.2 Dialogs, feedback with live tally, Session panel, PR links, background / long-task entries. Verify: view snapshots + feedback record test.
- [x] 3.3 File upload, limits, protected download. Verify: upload tests (limit, rejected file named), headers on download.
- [x] 3.4 Background deliveries (MVP): routines, dream, housekeeping, reviews, alerts, the ✋ held-message card. Verify: the pollers scenarios of `chat-driver-interface` against the web driver, minus YouTrack and autofix.
- [x] 3.5 Access at the start: `open` mode for every logged-in user (the identity provider's pool is the allow-list), every room visible, operators from `WEB_OPERATORS`; `/users` read-only. Verify: access tests with web identities (operator vs member; a second organization id never passes the gate).
- [x] 3.6 Home page from the shared cheat-sheet source; unread counts and in-tab notifications. Verify: view snapshot; Slack `homeBlocks` snapshot unchanged.
- [x] 3.7 `/security-review` on the branch; findings fixed or recorded. Ledger row; PR. Verify: CI green. _(The skill is not available here: a self-review recorded in design.md → Security review; a second pair of eyes before the first client-shared deployment stays open.)_

## 4. Canary

- [ ] 4.1 End-to-end harness: the web surface on localhost with `WEB_AUTH=none` and a fake sandbox transport, every MVP spec scenario driven over HTTP (`src/chat/web/e2e.test.ts` or `npm run e2e:web`), re-runnable by anyone. Verify: the harness is green in CI (or documented as a local run if it needs a sandbox).
- [ ] 4.2 The Teams staging installation with `CHAT_SURFACES=web` on a hostname behind its nginx: the newsletter project rebound from Teams to its web room, the client's people on the allow-list, a newsletter built end to end (stop 1, stop 2 with the preview link, upload on an explicit go-ahead, photos attached), reconnect, restart mid-turn. Verify: two-user live scenarios; `platform` on Teams unaffected.

## 5. PR 3 — the rest of parity (when a client needs it)

- [ ] 5.1 The remaining `/aven` verbs, autofix Fix, `/users` editing the allow-list, `allowlist` mode and groups → rooms. Verify: the remaining verb and poller scenarios against the web driver; ledger row. (YouTrack on the web dropped 2026-10-30: not needed on this surface.)
