# Design

## Context

- Bolt is imported by `slack.ts`, `turn.ts`, `events.ts` (19 action/view/event handlers), `commands.ts` (the `/aven` router), `pollers.ts`, `channels.ts`, `installations.ts`, `slackfiles.ts`. Rendering is Block Kit in `blocks.ts`. The turn engine posts/updates with `chat.postMessage` / `chat.update`, reacts with `reactions.add/remove`, and recovers through `ClientForTeam`.
- An installation is already self-contained: `state.json` in the checkout root, config from `.env`, instance config in the ops overlay (`infra/prod/runtime/`), sandboxes separated by `SANDBOX_NAME_PREFIX`.
- Two consumers are planned and shape the interface: Teams (Adaptive Cards, dialogs, targeted messages, no reactions, HTTP webhook) and our web chat (we render everything and keep the history ourselves).

## Goals / Non-Goals

**Goals:**
- Everything chat-related goes through one interface; the core has no platform import.
- Slack byte-identical, proven per PR.
- The interface is shaped so Teams and web can implement it without core changes.

**Non-Goals:**
- Mixing drivers in one installation.
- Generality beyond Slack, Teams and web.

## Decisions

### D1. One installation = one chat driver, chosen by the run command
The run command builds the registry, turn engine and pollers, then starts one driver. Nothing persisted needs a platform field and keys need no platform prefix: each driver keeps today's key shapes (`thread:…`, `dm:…:<slug>`, slug-based routine/review keys), digesting its own ids when they contain `:`.
*Alternative*: several drivers per process. Rejected: platform-tagged keys and recovery records, mixed listener lifecycles, ambiguous poller delivery when a project has two channels.

### D2. The interface
- **Inbound** (driver → core handlers): `ChatMessage` (conv, thread, user, text, files, mentioned, direct), `ChatAction` (action id, value, user, message ref, dialog context), `DialogSubmit`, `ChatCommand` (verb, args, user, conv), home opened (an `Actor`). Install lifecycle events stay inside each driver: on Slack they only drop the installation record, which is driver state, not core logic.
- **Outbound** (core → driver): `post`, `update`, `mark`, `permalink` (turn path); `reply` (private answer to a click), `postPrivate`, `openDialog`, `updateDialog`, `refreshRating`, `publishHome` (interactions); `postDirect`, `fetchFile`, `mention`, `isAdmin`, `projectChannel` as the later PRs need them. Restart recovery takes a `DriverForTenant`.
- **View models** (`src/chat/views.ts`): StatusView, AnswerView, QuestionView, TicketCardView, SessionPanelView, MemoryView, RoutineListView, StatusReportView, HomeView, the dialog views… Text inside them is GitHub markdown; each driver converts it. `blocks.ts` becomes the Slack renderer.
- **Capabilities**: `{ privateReplies: 'native' | 'fallback', threadRepliesNeedMention: boolean, reactions: boolean, … }` so shared help/Home bullets pick the right wording.
*Alternative*: a fake Slack `WebClient` for other platforms. Rejected: Block Kit would be translated at runtime and every new Slack call would break the others silently.

### D3. Four PRs, each pinned by recorded calls
A test-only recording fake Bolt (`WebClient` + registered handlers) drives scripted scenarios and snapshots every outgoing call. Snapshots are written **before** each move and must stay byte-identical after it:
1. turn path (post/update/react/permalink, questions, background, recovery);
2. actions, dialogs, Home, install events;
3. messages, DMs, files, every `/aven` verb and denial;
4. pollers, routines (with and without `ROUTINE_GUARD`), dispatch, alerts.

### D4. Directory layout and import rule
`src/chat/driver.ts`, `src/chat/views.ts`, `src/chat/core/*`, `src/chat/slack/*`. A test fails when any file outside `src/chat/slack/` imports `@slack/bolt`; later drivers add the same rule for their SDKs.

## Risks / Trade-offs

- [The refactor touches every Slack surface] → Four PRs, snapshots before each move, canary days between tags. Any snapshot diff blocks the PR.
- [Interface shaped wrongly for Teams/web] → The Teams and web designs are written against it now (their changes reference D2); gaps found there become additive interface methods, not core rewrites.
- [Big diffs are hard to review] → Moves are mechanical commits separate from logic commits within each PR.

## Migration Plan

PRs 1–4 merge to `main`, run on the home bot, and are tagged after the usual canary window like any bucket-1 change. Rollback is a revert of the PR.
