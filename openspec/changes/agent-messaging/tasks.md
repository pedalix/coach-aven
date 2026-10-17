## 0. Prerequisites: Claude Code behaviour, pinned

- [x] 0.1 Separate change `cli-probe` merged: the harness (`src/cliprobe/`, scenarios with verdicts, a report and recordings per CLI version in `src/fixtures/cli/`), event checks against the declarations of `@anthropic-ai/claude-agent-sdk` (`sdk.d.ts`, the de facto schema), the probed set `PROBED_CLI_VERSIONS` and its CI gates — that change's own tests
- [x] 0.2 Make the rows the delivery relies on contract scenarios of `cli-probe`, judged on the frames: fold-in at the tool boundary, the echo at take-up, an interrupt keeps the message, a kill before take-up loses it, `background_tasks_changed` (their replay tests through `ClaudeSession` come with the ledger, 4.1/4.2). Then probe what D12 has not measured yet, at least three runs each — the report in the PR, rows added to D12:
  - stdin through the ssh-docker FIFO and through the Daytona session (`cli-probe`'s sandbox transport);
  - the race between the last tool result and the final text (with `--include-partial-messages`);
  - a long Opus turn;
  - claude-code#102220 (mid-turn task notifications) on the pinned CLI

  Done on 2.1.282: every item above is measured and recorded in D12 (#22). The Daytona session was measured with prod's organization and snapshot: the four delivery rows hold. Its output carries a copy of stdin, so D13 confirms delivery only by `isReplay` echoes. `cli-probe` records such a copy as `echo`.
- [x] 0.3 Bump the fleet's Claude Code pin to a version in `PROBED_CLI_VERSIONS`, on every installation (sandbox image + pin, home, prod, Teams staging), as its own PR with a ledger row — `src/cliprobe/gate.test.ts`; the upgrade notice (`Claude Code <old> → <new>`) on each installation
  Done 2026-10-17: the fleet runs 2.1.292 (probed in full, #25) — home, the Teams staging installation and prod, each `.env` edited on its box and checked at restart.

## 1. Messaging core (pure, shared)

- [x] 1.1 `src/messaging/a2a.ts`: the Message / Task / AgentCard subset (card: name, description, accepting, plus `domain`), the state set, parsers and validators — `src/messaging/a2a.test.ts`
- [x] 1.2 `src/messaging/protocol.ts` — `src/messaging/protocol.test.ts`:
  - frames: `challenge`, `auth`, `hello` with `removed`, `send`, `ack`, `deliver`, `routed`/`rejected`, `expired`, `presence`;
  - the envelope (`ask|answer|cancel|agents|cards`) and its payload `{message, domain, marks, depth, cost?}`;
  - target parsing (`<installation>/<agent>`, bare `<agent>`);
  - the accept-pattern matcher
- [x] 1.3 `src/messaging/seal.ts`: Ed25519 + X25519 with `node:crypto` — `src/messaging/seal.test.ts` ("tampered envelope"):
  - seal and open: ephemeral ECDH → HKDF → AES-256-GCM, header + envelope id as AAD, Ed25519 signature;
  - key lists with `notAfter`;
  - tests: tamper, wrong key, wrong sender, replayed ciphertext, rotation grace
- [x] 1.4 Imports test: `protocol.ts` and `a2a.ts` import nothing from `node:` — `src/messaging/imports.test.ts`
- [x] 1.4a Versions: unknown payload and frame fields ignored; unknown `v` rejected with both versions; a fixture of today's envelope kept, so later changes are checked against it — `src/messaging/protocol.test.ts` ("prod on the last tag", "unknown version")
- [x] 1.5 `src/messaging/transport.ts` + `local.ts`: the `PeerTransport` interface and the in-process transport (the same outbox record as the hub client, re-handed after a restart; the double for every bot-side test) — `src/messaging/transport.test.ts`
- [x] 1.6 `src/messaging/events.ts`: the D16 catalogue (names, levels, fields) and its helper, which logs and sends warnings and errors to Sentry explicitly (`captureMessage` / `captureError`) — `src/messaging/events.test.ts`
- [x] 1.7 `orch hub keygen` writes the key file (0600) and prints the public halves — cli unit test + manual run

## 2. Hub (`hub/`)

- [x] 2.1 Package skeleton: `hub/package.json`, `tsconfig`, `wrangler.example.toml`, vitest with `@cloudflare/vitest-plugin` (the renamed `@cloudflare/vitest-pool-workers`, which is deprecated); root `npm test` unaffected; a `hub` job in CI — `cd hub && npm test`
- [x] 2.2 Challenge auth in the object — hub tests "enrolled installation", "unknown or wrong key", "clocks do not matter", "second connection":
  - the challenge carries the hub's time;
  - verify against the installation's keys valid now (a list, for rotation);
  - one socket per installation (the older one closed `replaced`);
  - anything before `auth` refused;
  - the alarm closes silent sockets
- [x] 2.3 Durable Object: hibernatable accept with attachment, auto-response ping/pong, SQLite schema with `schema_version` and migrations — hub test "wake on message"
- [x] 2.4 Routing: overwrite the `from` installation; both installations enrolled; outbox append; deliver; `routed`/`rejected`; backlog cap — hub tests "routed", "unknown recipient", "backlog cap"
- [x] 2.5 Durable delivery: ack deletes; ordered replay on reconnect; same seq on redelivery; alarm expiry (7 days) with an `expired` frame to the sender, now or on its next connection — hub tests "recipient offline", "duplicate after reconnect", "expired undelivered"
- [x] 2.6 Removal and presence: tombstones; `removed` in `hello` and `presence`; outbox dropped on the first request after the deploy — hub tests "peer goes away", "installation removed"
- [x] 2.7 Storage holds ciphertext and routing fields only — hub test "stored envelope"

## 3. Bot: configuration, state, hub client

- [x] 3.1 Project config `messaging: { send, accept, description, sendPerDay, acceptPerDay, maxRounds, costWarnUsd }`, read at call time. Refused on a project shared by several tenants. `.env` `INSTALLATION_ID` (explicit for the hub) / `HUB_URL` / `HUB_KEY_PATH` — `src/projects.test.ts` ("shared project")
  Done: `src/messaging/config.ts` (the block, its defaults and `messagingEnv`), validated in `src/projects.ts`; a shared project’s block is dropped with an error, the project unchanged.
- [x] 3.2 `state.json` — `src/state.test.ts`, `src/housekeeping.test.ts` ("task outlives the hub"):
  - outgoing tasks by task id, incoming ones by (origin installation, task id); a local task has both;
  - marks per conversation key (domain → holders);
  - domains learned per peer agent;
  - held messages;
  - 30-day pruning; local expiry
  Done: `src/messaging/records.ts` (shapes) and the `Store` methods, tested in `src/state.test.ts`; the expiry pass is `src/messaging/expiry.ts` ("task outlives the hub" in `expiry.test.ts`); the 30-day pruning runs in both composition roots’ daily retention. Telling a conversation that its task expired comes with the deliverer (4.4).
- [x] 3.3 `src/messaging/peers.ts`: `hub.peers.json` with key lists; a reload that drops a peer ends its open tasks — `src/messaging/peers.test.ts`
  Done: `parsePeers`/`loadPeers`, `validKeys`, `droppedPeers` and `endTasksWithPeer` (tested). `/aven reload` calls them from 3.5, where the composition root holds the peers.
- [x] 3.4 `src/messaging/hubclient.ts` (`PeerTransport` over the hub) — `src/messaging/hubclient.test.ts` ("peer removed"):
  - challenge auth; skew warning above 30 s, once per connection, no correction;
  - backoff, keep-alive, persisted outbox;
  - ack only after the handler's durable record; dedupe;
  - `replaced` logged; `expired` → `failed: expired`; `removed` → `failed: peer removed`
  Done: `applyHubReports` turns expiries, removals and rejections into task states; telling the conversations comes with the deliverer (4.4). The composition root starts the client with 3.5.
- [ ] 3.5 Composition roots (Slack, Teams): start the transports; register `host` with `DISPATCH=1` or a `messaging` configuration; never `propose`/`registry` in a shadow conversation — `src/hostrouter.test.ts` ("installation without configuration", "project not configured", "nothing is registered without the gate", "messaging without dispatch", "shadow conversation", "a host tool call needs no transport"; host list and spawn line byte-identical for unconfigured projects)
  Lands with section 5: the composition roots start the transports once the deliverer (4.4) and the incoming-task handler (5.4) exist to take their deliveries, and `host` is registered once there are messaging tools to list. It also re-reads `hub.peers.json` on `/aven reload` and ends the dropped peers’ tasks (`droppedPeers` + `endTasksWithPeer`).
- [x] 3.6 `deploy.sh export`/`import` carry `hub.peers.json` beside the projects config — `src/chat/teams/deploy.test.ts` (extended) + a dry run of `npm run ops -- <slug> export`
  Done: `hub.peers.json` is an optional runtime file of `infra/deploy/deploy.sh`; `deploy.sh <slug> runtime-files` lists what export and import carry (export has no dry run).

## 4. Bot: accounting and delivery

- [x] 4.1 `ClaudeSession` ledger (D13), only for projects with `messaging` — `src/claudeSession.test.ts` with a fake CLI, and `src/claudeSession.recorded.test.ts` over `cli-probe`'s contract recordings of the delivery rows (test cases: one result for two messages, turn already over → unsolicited turn, result for the wrong message, missed injection answered as a delivery, background task list; scenarios "restart mid-call", "several calls pending"); `src/chat/slack/turn.record.test.ts` byte-identical for unconfigured projects:
  - a `uuid` per write; `--replay-user-messages`;
  - settle a pending turn only by the `result` after its own echo; an injected message that missed its turn is answered as a delivery, not as `🔔 Background update`;
  - unsolicited results as today; a mismatch → event;
  - background tasks from `background_tasks_changed`;
  - the ledger rebuilt from the reattach snapshot;
  - every unanswered `mcp_message` of the turn served again after reattach, not only the last event;
  - the spawn mode recorded per session;
  - the background-task list cleared when the process ends
  Done: `ClaudeSession` with `ledger` (`LEDGER_ARGS`, `onLedgerResult`, `McpCallBook`), `--replay-user-messages` only for projects with `messaging`; the chat record keeps the spawn mode (`ledger`) and the turn’s uuid (`inflight.uuid`). The recordings of the delivery rows are replayed through it, with a new contract row `echo-carries-uuid` (the echo carries the written uuid; holds on 2.1.282 and 2.1.292). Rendering an `answered` delivery and the `ask.*` events for it are the deliverer’s (4.4).
- [x] 4.2 `ClaudeSession.inject(text)` — `src/claudeSession.test.ts` ("process dies before the next tool step", "a long tool", "message stuck on an idle process", "bot restarts after the write"):
  - write without a pending turn; echo → delivered;
  - no echo after 10 min → warning, keep waiting;
  - an idle process without the echo after 2 min → restart the session, requeue;
  - process died → requeue;
  - after a bot restart the snapshot decides
  Done: `ClaudeSession.inject` / `recoverInjected` → `folded` · `answered` · `lost` · `stuck` · `refused`; the requeue and the session restart on `stuck` are the deliverer’s (4.4).
- [x] 4.3 Per-session contract check: from the session's `system/init` (a capability if the CLI reports one, else the version), inject only on a CLI in the passed set kept in `src/cliversion.ts`; otherwise queued turns + `ask.inject.disabled` — `src/cliversion.test.ts`
  Done: `injectRefusal()` (the ledger, an open session, the version from `system/init` in `PROBED_CLI_VERSIONS`; no capability names fold-in yet); `ask.inject.disabled` is emitted by the deliverer when it falls back to a queued turn (4.4).
- [ ] 4.4 Deliverer (`src/messaging/deliver.ts`), both transports — `src/messaging/deliver.test.ts` (scenarios "answer while the asker is idle", "answer while the asker is working", "people keep talking while the task is open", "turn ends just as the message arrives", "automatic turn running", "asker in a direct message or a Teams chat", "the person sees the fold", "fan-out", "answer after the asker's bot restarted", "nowhere to deliver", "answer from someone else", "late answer"):
  - the counterpart check; messages for ended tasks acked and logged;
  - the explicit reply target (chat or shadow);
  - inject only into a started turn of a person, routine or task, younger than the soft deadline, with fewer than 5 injections, in a session spawned with the ledger on a checked CLI; else `liveTurn`;
  - a trail step for a fold; state written before the ack
- [ ] 4.5 `wrapAnswer` / `wrapReply` / `wrapTask` (pure; golden fixtures `src/fixtures/messaging/{answer,reply,task}.txt`): the original question, the never-forward sentence, the still-open line, the no-writes frame — `src/messaging/wrap.test.ts` ("session gone")
- [ ] 4.6 Marks (D14) — `src/messaging/marks.test.ts` ("forwarding waits for a person", "a released message can be answered", "second message to the same domain", "two clients in one installation", "no laundering through a local agent", "a peer claims another domain", "compaction keeps the marks", "fresh session"):
  - domains (installation, and a tenant tag);
  - marks with holders, from messages with content only (a task's question included);
  - holders gain the target on every message that goes out or is released;
  - domain claims checked against the authenticated installation; `toDomain` checked by the receiver;
  - the rule for every outgoing message; an unknown remote domain has nothing;
  - held in chat, refused in shadow (a refused answer → `failed: refused by marks`);
  - per conversation key, ended by `🔄 Restart session` or with the conversation's record
- [ ] 4.6a Posts of a marked conversation carry the marker (Slack message metadata, the Teams equivalent), and the Slack source skips them at ingest — `src/sources/slack/normalise.test.ts` ("answer posted in a thread is not ingested") + driver golden for the metadata
- [ ] 4.7 The held-message card — `src/chat/slack/events.record.test.ts` + Teams cards golden ("held message without the flag", "flag off"; existing byte-identical):
  - a `heldAsk` view for a new task or a reply;
  - Slack blocks and a Teams card with their own action ids;
  - a handler gated by `mayDrive`;
  - Send releases once; Dismiss → `canceled: dismissed` (a dismissed reply leaves `input-required`, and the conversation is told);
  - independent of `DISPATCH`

## 5. Bot: tools and the answering side

- [ ] 5.1 Tools `send_message`, `get_task`, `cancel_task`, `agents` for senders (shadow conversations included), and `request_input` on shadow keys — `src/hosttools.test.ts`, `src/hostrouter.test.ts` ("task message without a button", "propose returns the gate" unchanged, "send returns at once", "unknown installation", "agent that does not accept the caller", "status on demand", "another thread asks for the answer", "call served again after a restart", "sending withdrawn", "someone else's task", "depth exceeded", "cap reached" sender side):
  - task tools scoped to the calling conversation; configuration read at call time;
  - the reply target resolved like a proposal's thread (its own key for a shadow conversation); refused in `runAsk` conversations;
  - task and reply ids derived from the conversation and the call's request id, looked up before any other check;
  - depth; the daily cap; held / refused under the marks
- [ ] 5.2 Messaging prompt paragraph for projects with `messaging.send`; the dispatch sentence names both when both are on; goldens for other projects unchanged — `src/prompt.test.ts` + new fixture `src/fixtures/prompt/*messaging*.txt`
- [ ] 5.3 `agents`: own installation answered locally; a peer by one bounded round trip, or `offline`; only agents that accept the caller; domains learned from the cards — `src/messaging/agents.test.ts` ("listing a peer", the own installation)
- [ ] 5.4 Incoming-task handler (`src/messaging/answer.ts`) — `src/messaging/answer.test.ts` ("accepted in the same installation", "not accepted", "receiver rejects", "answer-only project", "nothing in the channel", "cap reached"):
  - verify and open (remote);
  - acceptance checked for every message of a task;
  - depth; the daily cap per sender;
  - a shadow `liveTurn` with the tenant-prefixed key `[<tenant>:]a2a:<origin>/<taskId>`
- [ ] 5.5 `src/chat/shadow/driver.ts` (journal only) and `settleShadowTurn` in `src/messaging/answer.ts` (the one owner of completion) — `src/chat/shadow/driver.test.ts`, `src/messaging/answer.test.ts` ("background subagent", "asked back and ended the turn", "sub-question", "answer arrives during the final text", "nothing outstanding and no turn comes", "nudge gives no answer"):
  - the journal; `working` on start;
  - completion only when nothing is outstanding: an unanswered `request_input`, open sub-tasks, messages not taken up yet, CLI background tasks. Otherwise the answer becomes the status message;
  - at most one nudge turn per task, then `failed: no answer`;
  - `AskUserQuestion` → `request_input` + event; late results → event;
  - expiry on the answering side too
- [ ] 5.6 Clarifications (at most `maxRounds`, the next ends the task), cancel with cascade to sub-tasks, acceptance withdrawn on reload, a later message bounced → `failed` — `src/messaging/answer.test.ts` ("clarification answered while still working", "clarification needs a person", "agents loop", "asker gives up", "acceptance withdrawn", "reply bounced", "parent canceled")
- [ ] 5.7 Restart recovery — `src/chat/slack/turn.record.test.ts` byte-identical ("slack mode", "unknown driver" unchanged) + "restart mid-answer", "recovery fails", "incoming burst", "shadow conversations beside slack":
  - keys `[<tenant>:]a2a:<origin>:<taskId>:<slug>` (validated ids; `slugForKey` and `projectBusy` see them);
  - queued replay of an `a2a:` key → the shadow driver and `shadowOpts(key)`; inflight recovery of an `a2a:` key → `settleShadowTurn` plus a metering record with the origin; Slack and Teams unchanged;
  - a shadow turn that cannot be recovered → `failed`;
  - shadow turns limited to half of the turn slots;
  - the shadow session closed when its task ends
- [ ] 5.8 `TurnOpts.origin` accepts `{slug, taskId}`; metering stamps it and the number of folded task messages — `src/metering.test.ts`
- [ ] 5.9 Routine guard: no retry for a failed run that already started tasks; a run without tasks retries as today — `src/routineguard.test.ts` ("routine gathers answers")

## 6. Audit and UI

- [ ] 6.1 `/aven asks` — `src/chat/slack/commands.record.test.ts` ("operator audit", "not an operator", "installation without configuration" for `/aven asks why?`; existing byte-identical):
  - for the installation's operators, every tenant with a tenant column;
  - both directions, local and remote, held first;
  - cost from metering or from the answering side;
  - `/aven asks <taskId>` (the transcript), `/aven asks cancel <taskId>`;
  - the verb exists only where messaging is configured
- [ ] 6.2 Home tab cheat-sheet: the `/aven asks` line and the held-message card, shown only when a project has a `messaging` configuration (Slack `homeBlocks` + Teams Home card) — blocks golden test

## 7. Docs, rollout, ops

- [ ] 7.1 `docs/agent-messaging.md` from this change's `overview.md`: mermaid, high level, including what an accept entry grants and what a domain is — review
- [ ] 7.2 `docs/hub.md`, plus `docs/runtime-config.md` rows for `INSTALLATION_ID`, `HUB_URL`, `HUB_KEY_PATH` and `messaging` — review. `docs/hub.md` covers:
  - deploying the hub from an ops repo;
  - enrolment and removal; key rotation (lists on both sides);
  - keeping the host clock in sync (NTP; the WSL sleep case);
  - data at rest (`shadow/`, task records, marks)
- [ ] 7.3 `docs/rollout.md` ledger row — review:
  - bucket 2 (per-project `messaging`, the routine-guard retry rule) + bucket 3 (`HUB_URL`);
  - canary on three installations;
  - existing sessions need `🔄 Restart session`
- [ ] 7.4 Failure-path test: every path in D16 emits its event, and warnings and errors reach Sentry without `SENTRY_LOGS`; the hub reports through `@sentry/cloudflare` when a DSN is set — `src/messaging/events.test.ts` ("process lost a message"), hub test for the reporter
- [ ] 7.5 `scripts/public-guard.sh` clean on the branch — CI
- [ ] 7.6 Operator steps in the ops repos — checklist in the PR body:
  - deploy the hub;
  - enrol home, prod and the Teams staging installation;
  - `.env` and `hub.peers.json` on all three;
  - `messaging` on the canary projects
- [ ] 7.7 End-to-end on the canary — recorded in the PR:
  - a local ask on home;
  - owen-ops asks a prod project while idle and while busy;
  - a clarification answered the next day;
  - restart each bot mid-flight;
  - kill a sandbox before pickup;
  - a forwarding to the Teams staging installation held, then released and dismissed;
  - `/aven asks` on both sides;
  - the project's channel shows nothing;
  - Sentry shows no unexpected event
