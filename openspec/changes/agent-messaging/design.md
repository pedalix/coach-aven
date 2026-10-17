## Context

- **Dispatch exists, within one installation only** (`agent-dispatch`, `src/dispatch.ts` + `src/dispatchrun.ts`). A `propose` host tool, then buttons, then `engine.liveTurn` in the target's channel and a pointer back. It needs a chat channel on both ends and a human click. It is for work in another agent's scope, and it stays as it is.
- **Host tools** (`host-tools`) are served in-process over the session's control channel (`src/hosttools.ts`, `src/hostrouter.ts`).
  - `HostCaller` carries `slug`, `conversationKey` and `teamId`, so a tool knows exactly which conversation called it.
  - Tool calls time out at `HOST_TIMEOUT_MS` (30 s), so anything long must return early.
  - After a bot restart, a call the old bot never answered is served again on reattach. So a host tool must be idempotent; `propose` is, by content.
  - Today `host` exists only with `DISPATCH=1`, and its prompt paragraph calls `propose` "the ONLY way to reach beyond this thread".
- **The turn engine renders only through `ChatDriver`** (`src/chat/driver.ts`):
  - `liveTurn(chat, channel, msgTs, threadTs, key, project, question, attachments, opts)` posts a status message, journals the turn (`queue.jsonl`), runs it, posts the answer and calls `opts.onAnswer` / `opts.onSettle`.
  - Restart recovery (`resumeInflightTurns` / `resumeQueuedTurns`) picks the driver with `driverFor(teamId)`.
  - It reattaches to a still-running CLI by reading the command's whole output log (`ClaudeSession.open` with `attach`).
  - Concurrency is capped by global turn slots (`TURN_MAX_CONCURRENT`, default 4) and live sessions by an LRU (`MAX_LIVE`, 100).
- **Tenants:** an installation in multi-workspace mode serves several tenants, such as Slack workspaces. Conversation keys carry the tenant as a prefix, and the home tenant's keys are bare (`src/teamkeys.ts`).
- **Late output already has a path.** A `result` with no pending turn goes to `onIdleResult`, which posts it as `🔔 Background update` in the conversation (for example, a background subagent's report). A conversation's place (channel, thread) comes from the running turn's `inflight`; without one, it comes from the key and the project's bound channel (`dispatchrun.ts`).
- **Known gap:** a replayed turn loses its callbacks (`turn.ts` replay passes no `opts`). So a dispatch's pointer back is lost if the bot restarts before the child turn starts. This change must not repeat that.
- **Sentry:** `log.warn` / `log.error` reach Sentry only as structured logs, and only with `SENTRY_LOGS`. `captureError` / `captureMessage` are the explicit path.
- **Topology:**
  - the home bot sits behind NAT, outbound only;
  - prod has a public host, but nginx exposes only the OAuth paths;
  - the Teams staging host is a third box;
  - agents of one tenant usually share one installation.
- **Who will use it:**
  - first, an operator's tenant agent asking projects of other installations;
  - next, a person's own agent (a project fed with that person's sources) asking agents with more access;
  - and routines that gather from several agents, such as a weekly report.

  The design treats agent messaging as a property of the system, not of one use.
- **Prior art studied** (`slopus/happy`, MIT):
  - everything connects outbound to a relay;
  - RPC by rooms;
  - durable updates with a per-user `seq`, versus ephemeral events;
  - per-session keys, so the server stores ciphertext.
- **A2A 1.0** gives task states and message shapes but assumes inbound HTTP and webhook push.
- **MCP Tasks** (2025-11, reworked in the 2026-07-28 RC) are not driven by the Claude Code client.

## Goals / Non-Goals

**Goals:**
- Any agent configured to send can ask any agent that accepts it, in its own installation or another, and get the answer back in its own session. There is no inbound port anywhere and no click, except a person's Send when data from one domain would reach another.
- One mechanism whatever the distance. Tools, delivery, shadow conversations, limits and audit are the same; only the transport differs (in-process, or the hub).
- Nothing readable by the relay. Nothing visible in the answering installation's chat. Everything visible to operators in `/aven asks`.
- Survives restarts and disconnects on either side. Every message reaches the agent once.
- No effect on a project without a `messaging` configuration, nor on an installation without any.

**Non-Goals:**
- Asking another agent to change something (commits, tickets, chat messages). Messages ask; work in another agent's scope stays with dispatch and its Send button.
- People as addressees: the protocol carries agents, and who drove the sending turn stays in the sender's audit.
- Admin operations over the hub, a public A2A endpoint, MCP Tasks, mirroring shadow conversations into chat.

## Decisions

### D1. One mechanism, two transports
Everything above the transport is shared:
- the tools (D9);
- the shadow conversation (D10);
- delivery (D11) and its accounting (D13);
- marks (D14) and chains (D15);
- events (D16) and audit (D17).

The transport sits behind `PeerTransport {send, onDeliver, ack, presence}` (`src/messaging/transport.ts`):
- **Local** (`src/messaging/local.ts`): for agents of the caller's own installation, whatever their tenant.
  - It keeps the same durable outbox record as the hub client and hands the message to the receiving side in the same process. After a restart, unacknowledged local messages are handed over again and de-duplicated by envelope id.
  - Nothing is encrypted, because nothing leaves the process.
  - It is also the test double for every bot-side test.
- **Hub** (`src/messaging/hubclient.ts`): for agents of other installations, through the relay (D3–D8).
- A third transport would touch nothing above it: SSH, direct A2A over HTTP, or a rehosted relay.

The target's installation picks the transport:
- the caller's own installation → local;
- a pinned peer → hub;
- anything else → the tool refuses it.

### D2. Who may ask whom: the receiving agent decides
Per project in `projects.config.json`:

```
"messaging": {
  "send": true,                                       // the sending tools (D9)
  "accept": ["home/owen-ops", "nora", "*"],           // who may ask this agent
  "description": "Orders, payments and partner bookings of caldora",  // its agent card
  "sendPerDay": 50,                                   // tasks this agent may start per day
  "acceptPerDay": 30,                                 // new tasks per sender per day it takes
  "maxRounds": 5, "costWarnUsd": 2
}
```

- **Patterns.** An absent or empty `accept` means nobody may ask. A pattern is one of:
  - `<installation>/<agent>`;
  - a bare agent name, for the own installation;
  - `*`, for every agent of this agent's own domain (D14).

  No pattern covers a whole other domain. So on a multi-workspace installation, another client's agents are accepted only by name, and a wildcard never crosses a client boundary.
- **Shared projects.** A project listed for several tenants (`workspaces`, `projectOwnerTeam`) is refused a `messaging` configuration at load, because its domain would be ambiguous.
- **Who checks.** The receiving installation checks acceptance on every incoming message of a task, new or reply. It checks two things:
  - the authenticated sender installation (the hub binding plus the signature, D4–D6);
  - the agent named by the sender's bot.

  The same check filters `agents` cards. Configuration is read when the call or message is handled, not when the session opened.
- **Claims.** The agent part of `from` is the sending installation's claim, as strong as that installation's bot. Third-party agents would need keys per agent; `v` in the envelope leaves room for that.
- **Accepting a sender grants indirect access.** Whoever may drive the sender learns what the accepting agent answers. That is the decision an accept entry records, and `docs/agent-messaging.md` says it in those words.
- **The hub decides nothing per agent.** It admits enrolled installations and routes between them (D3). One place decides who may ask an agent, with or without a hub.
- **Withdrawal.** `/aven reload` re-reads the configuration.
  - Open incoming tasks whose sender is no longer accepted end `canceled: not accepted`, their shadow turns are canceled, and the sender is told. A reply that arrives after that is refused, and its task ends `failed: not accepted`.
  - Dropping `send` refuses new tasks at call time; open ones finish.
- **Peers.** `hub.peers.json` (beside the projects configuration) pins each peer installation's keys. Every open task with a peer ends `failed: peer removed` when the hub reports that peer removed, or when a reload drops it from `hub.peers.json`.

### D3. Relay on Cloudflare: one Worker, one Durable Object
`hub/` is a Worker with a single Durable Object instance (`idFromName("hub")`). The object holds every connection through the WebSocket Hibernation API:
- `ctx.acceptWebSocket(ws)` on upgrade;
- `ws.serializeAttachment({installation?, nonce, acceptedAt})` keeps the socket's state across evictions; sockets are found by their attachment (there are only a handful of installations);
- `setWebSocketAutoResponse("ping" → "pong")` answers keep-alives without waking the object.

State lives in the object's SQLite:
- `outbox(installation, seq, envelope_json, expires_at)`, plus `next_seq` per installation;
- `pending(id, from, to, method, task_id, routed_at)`, for expiry reports;
- `removed(installation, at)`: tombstones, so removal is known even with an empty outbox;
- an alarm that sweeps expired rows, sends `expired` reports, and closes sockets that have not authenticated within 10 s;
- `schema_version` with forward migrations, run on the first request after a deploy (a deploy drops every socket, and clients reconnect);
- a backlog cap per recipient outbox (1000 envelopes or 50 MB) → `rejected: backlog` to the sender.

**Enrolment.** `HUB_CONFIG` is a Worker secret: `{installations: {<id>: {sign: [{key, notAfter?}]}}}`.
- A list of keys per installation allows rotation with overlap.
- Adding or removing an installation is one line in the operator's ops repo plus `wrangler deploy`.
- On the first request after a deploy, the object tombstones every installation that is no longer enrolled and drops its outbox.

A single object is enough for a handful of installations and hundreds of messages a day. It also gives a global ordering that a multi-process Socket.IO + Redis setup would need extra machinery for.

**Alternatives considered:**
- *A peer HTTP API on each installation, plus polling*: every answering host needs an inbound path, and home cannot be reached at all.
- *SSH from one host to the others*: one-way, while every installation must be able to reach every other.
- *A self-hosted relay on the prod box*: puts operator infrastructure on a client host and adds a service to run.
- *happy-server as it is*: about 12k lines with Postgres/Redis/Prisma and their user/session/machine model.

### D4. Authentication: a signed challenge, no clocks
1. The Worker forwards `wss://<hub>/connect` to the object. The object accepts the socket and sends `{t:"challenge", nonce, now}`: 32 random bytes and the hub's time.
2. The client answers `{t:"auth", installation, sig}`, where `sig = Ed25519("coach-aven-hub/1" | hub host | installation | nonce)`, signed with its signing key.
3. The object verifies `sig` against the installation's enrolled keys that are valid now. It then:
   - binds the socket;
   - closes an older socket of the same installation with the reason `replaced`;
   - answers `{t:"hello", now, enrolled, online, removed}`;
   - replays the outbox.
4. Anything other than `auth` first, an unknown id or a bad signature closes the socket (`hub.auth.refused`).

The nonce is fresh per connection. So there is no timestamp window, no replay store, and no bearer token to rotate or leak.

**Clocks.** Nothing in the protocol depends on the bot's clock at a finer grain than days: task expiry, key `notAfter`.
- The bot compares the hub's `now` with its own on every challenge. It logs `hub.clock.skew` (a warning, so it reaches Sentry, D16) once per connection when they differ by more than 30 s. It corrects nothing.
- Keeping the host's clock in sync (NTP) is the host's job. `docs/hub.md` says so, and covers the WSL case: the clock stops while the laptop sleeps.

### D5. Envelope and frames
Frames are JSON text messages.

| Direction | Frames |
|---|---|
| Client → hub | `{t:"auth", …}`, `{t:"send", env}`, `{t:"ack", seq}` |
| Hub → client | `{t:"challenge", …}`, `{t:"hello", …}`, `{t:"deliver", seq, env}`, `{t:"routed"\|"rejected", id, reason?}`, `{t:"expired", id, task, to}`, `{t:"presence", online, removed?}` |

The envelope:

```
{ v: 1, id, from: "home/owen-ops", to: "bluefin/caldora", method: "ask"|"answer"|"cancel"|"agents"|"cards",
  task: "<taskId>", eph: <x25519 pub, b64>, ct: <b64>, sig: <ed25519 over everything above, b64> }
```

- **Payload.** The sealed payload is `{message, domain, toDomain, marks, depth, cost?}`:
  - `message`: the A2A message or status (D7);
  - `domain`: the sending agent's domain (D14);
  - `toDomain`: the target's domain as the sender assumed it, or none when unknown (D14);
  - `marks`: the sending conversation's marks (D14);
  - `depth`: the task's depth (D15);
  - `cost`: on a terminal status, the cost of the answering turns.
- **Routing.** The hub overwrites the `from` installation with the authenticated one and keeps the agent part. It checks that both installations are enrolled, appends the envelope to the recipient's outbox, delivers it if the recipient is connected, and answers the sender `routed` or `rejected`. When an envelope expires undelivered, the sender gets `expired`.
- **Locally**, the same envelope travels with the payload in clear and without `eph`, `ct` and `sig`. It is never serialized outside the process.
- **Versions.** Home runs `main` and prod runs the last tag, so installations on different releases must interoperate.
  - Within `v: 1`, changes to frames and payload are additive only. A receiver ignores fields it does not know.
  - An envelope with an unknown `v` is rejected (`rejected: unsupported version`, `ask.rejected` with both versions), never guessed at.
  - The hub's frames follow the same rule, so a hub deploy never has to wait for every bot.

### D6. End-to-end encryption with `node:crypto` only
Each installation has an Ed25519 signing key and an X25519 encryption key, generated by `orch hub keygen` into `HUB_KEY_PATH` (mode 0600). The public halves go to:
- the operator's hub configuration (the signing key only);
- the other installations' `hub.peers.json` (both keys, pinned).

Sealing:
1. ephemeral X25519 key pair;
2. ECDH with the recipient's X25519 public key;
3. HKDF-SHA256 (`info = "coach-aven-hub/1" | from | to | task`);
4. AES-256-GCM over the payload, with the routing header **and the envelope id** as AAD (a replayed ciphertext under a new id fails);
5. Ed25519 signature by the sender over header + `eph` + `ct`.

The receiver verifies the signature with the pinned key of `from` before decrypting.

- **Why the hub never distributes keys:** a compromised hub cannot substitute keys, so it cannot read or forge envelopes. It can only drop or delay them.
- **Forward secrecy:** each envelope uses a fresh ephemeral key on the sender's side; recipient keys are static.
- **Rotation:** `hub.peers.json` holds a list of keys per peer, each with `notAfter`, and the receiver tries them in order. An installation keeps its previous private key for a grace period (default 14 days), so envelopes sealed before the rotation still open.
- **Seen ids:** the bot keeps the set of seen envelope ids for the life of each task.
- **Dependencies:** no new dependency in the bot. The hub never decrypts, so it needs no crypto beyond Ed25519 verification (WebCrypto in workerd).

### D7. A2A 1.0 shapes, types only
`src/messaging/a2a.ts` declares the subset we use:
- `Message {role, parts:[{kind:"text", text}], messageId, taskId?, contextId?}`;
- `Task {id, contextId, status:{state, message?, timestamp}}` with A2A's states;
- `AgentCard {name, description, accepting}` plus our extension field `domain` (D14).

Mapping:

| Our envelope | A2A operation |
|---|---|
| `ask` (from `send_message`: a new task, or a reply) | `SendMessage` |
| `answer` (from the shadow side: `working` when the shadow turn starts, `request_input`, the final answer, failures) | `Task` status update |
| `cancel` (from `cancel_task`) | `CancelTask` |
| `agents` → `cards` | Agent Card discovery |

The task id is minted by the asker (D9), so it is known before the transport answers. The pure parsers and validators are tested; there is no SDK. A later public A2A adapter on the hub would translate HTTP ⇄ these shapes.

### D8. Bot-side hub client
The client starts in the composition root only when `HUB_URL` is set. It also needs an explicit `INSTALLATION_ID` (the default `local` is refused for the hub) and `HUB_KEY_PATH`. If either is missing, the client logs an error and does not start, and local messaging keeps working.

The connection:
- one socket, exponential backoff with jitter (1 s → 60 s), keep-alive `ping` every 30 s;
- challenge → auth → hello, with the clock comparison of D4.

Frames:
- **`deliver`** frames go to a handler and are **acked only after the handler has durably recorded the effect**: an ask → its shadow turn journaled; an answer → delivered per D11. A redelivery with a known envelope id is acked and ignored.
- **`expired`** ends the task `failed: expired`.
- **`removed`** in `hello` or `presence` ends open tasks with that peer: `failed: peer removed`.
- A close with `replaced` is logged (`hub.replaced`, warning): two bots are running with one key.

Outgoing envelopes are written to `state.json` before sending and cleared on `routed`/`rejected`, so a restart re-sends them. The hub de-duplicates by envelope id.

The bot keeps its own clock on tasks, in both transports. A task with no message for the hub's expiry plus one day ends `failed: expired` locally, and the asker is told. So a task cannot stay open forever because an envelope was lost before the hub (hub recreated, backlog cap), or because a shadow conversation never answered.

### D9. Agent tools mirror A2A operations
`host` is registered when `DISPATCH=1` or when the session's project has a `messaging` configuration (`host-tools`). Today only the former registers it.
- Without `DISPATCH`, `host` lists the messaging tools only.
- A shadow conversation never gets `propose` or `registry`: nobody can click there, and an auto-listed target would execute without anyone.
- Servers are registered when a session opens, so sessions already open get the tools after `🔄 Restart session`.

| Tool | A2A operation | Who has it | Returns |
|---|---|---|---|
| `send_message(target, text, {taskId?})` | `SendMessage` | sessions of projects with `messaging.send`, shadow conversations included | `{taskId, state}` at once; with `taskId`, it is the reply to an `input-required` |
| `get_task(taskId)` | `GetTask` | the same | state, times, last message, from local state (no round trip) |
| `cancel_task(taskId)` | `CancelTask` | the same | `canceled` once the envelope is queued |
| `agents(installation?)` | Agent Card discovery | the same | the agents that accept the caller; for a peer, one `agents` round trip bounded by 10 s, or `offline`; no cache in v1, but domains learned from cards are kept (D14) |
| `request_input(question, {options?})` | the server side of `input-required` | shadow conversations | `{state: "input-required"}` at once |

- **Nothing blocks.** Every tool returns within `HOST_TIMEOUT_MS`. Replies and answers come back as messages (D11).
- **The caller is the session** (`host-tools`).
  - `request_input` takes its task from its own shadow key, never from input.
  - `get_task`, `cancel_task` and a reply through `send_message` accept only tasks **the calling conversation** started. A task's content never reaches another conversation through a tool, so it cannot get around that conversation's marks.
- **`send_message`:**
  1. Reads the project's current configuration. A project that may not send any more is refused.
  2. Parses the target: `<installation>/<agent>`, or `<agent>` for the own installation.
     - An unknown installation is an error.
     - A local agent that does not exist, or does not accept the caller, is an error that lists the local agents that accept it.
  3. Resolves the **reply target**, the place answers will come back to, the way `dispatchrun.ts` resolves a proposal's thread:
     - while a turn runs, its `inflight` gives channel and thread;
     - otherwise the conversation key gives the tenant and the thread or DM, and the project's bound channel gives the channel.

     A shadow conversation's reply target is its own shadow key. A conversation run through `runAsk` (a one-off `/aven` answer or a dream) has no place for answers, so it cannot start tasks; the tool says to ask from a thread. The reply target is stored explicitly and never derived again later, because `pruneChats` may drop the chat record.
  4. Derives an id from the installation, the conversation key and the tool call's request id (the `mcp_message` control request). This is a task id for a new task and a message id for a reply. A call that is served again after a restart finds that record and returns it, before any other check, so a re-served call is never refused by a cap it already counted against.
  5. Checks the depth (D15) and the sender's daily cap (`sendPerDay`). For a reply, it checks that the task is in `input-required`.
  6. Stores the outgoing record: slug, conversation key, reply target, target, state, depth, rounds, and the outbox.
  7. Checks the marks (D14):
     - clear → the envelope is queued;
     - not clear, in a chat conversation → the message is **held**, and the reply says `held` and why;
     - not clear, in a shadow conversation → the message is refused.
- **Held messages** (a new task, or a reply to a clarification) get a card of their own: a `heldAsk` view with the target, the text, why it is held, and Send and Dismiss.
  - The chat driver renders it (Slack blocks, Teams card) with its own action ids. It does not depend on `DISPATCH` or the proposal store (`agent-dispatch` "Off by default" is clarified to say so).
  - Anyone who may drive that conversation (`mayDrive`) may click.
  - Send releases the message once (idempotent on the task and message) and records who released it.
  - Dismiss ends a held new task `canceled: dismissed`. A dismissed reply leaves its task in `input-required`, and the conversation is told, so the agent does not wait until the task expires.
- **Prompt:** `src/prompt.ts` adds a messaging paragraph for projects with `messaging.send`. It covers:
  - the tools;
  - answers arrive later in this conversation, as quoted data;
  - never pass one domain's data to another;
  - messages ask, they do not order.

  With `DISPATCH` too, the dispatch paragraph's "ONLY way" sentence names both. Projects without `messaging` keep today's text byte-exact, and a new golden pins the variant.

### D10. Shadow conversations and when a task completes
`src/chat/shadow/driver.ts` implements `ChatDriver` over an append-only journal.
- **Key:** `[<tenant>:]a2a:<origin installation>:<taskId>:<slug>`.
  - The tenant prefix is the target project's tenant, bare for home, as in `src/teamkeys.ts`. So `HostCaller.teamId`, `/aven status` and the slot accounting see the right tenant.
  - The origin keeps two senders' task ids apart.
  - The slug comes last, like `dm:` and `cmd:` keys, so `slugForKey` finds it and `projectBusy` holds dreams and in-place CLI upgrades off while a shadow turn runs.
  - A peer's ids go into keys and paths only after validation: an installation id matches `[a-z0-9-]{1,32}` and a task id is 24 lowercase hex characters. Anything else is dropped (`ask.unexpected`).
- **Journal:** `shadow/<origin installation>/<taskId>.jsonl`, beside `state.json`.
- **`post`/`update`:** append the view and return synthetic message ids.
- **The final `answer` view** completes the task with its markdown **only when nothing is outstanding** in the conversation:
  - no `request_input` without a reply;
  - no open task that this conversation started (D15);
  - no message delivered to this conversation that the agent has not taken up yet, that is, an injected message not echoed or a turn queued on the key (D11);
  - no CLI background task running. The CLI reports these in `system/background_tasks_changed` with the full `tasks` list (replace semantics, empty when the last one ends; measured and in the SDK's types, D12). `ClaudeSession` keeps that list per session (D13).

  Otherwise the text becomes the task's status message (`get_task` shows it) and the task stays open. The next final answer after the last outstanding item resolves completes it.
- **One owner of the rule:** `settleShadowTurn(key, outcome)` in `src/messaging/answer.ts`. Three paths call it:
  - the `shadowOpts(key)` callbacks of a live or replayed turn;
  - the `a2a:` branch of `resumeInflightTurns`, which also writes the turn's metering record with the task's origin, since recovery writes none today;
  - the nudge.

  The shadow driver only journals.
- **Nudge, once per task:** when the conversation is idle, nothing is outstanding, and the task is still open, the bot starts one turn: "Nothing is outstanding any more; give your final answer to the task now."
  - This covers a background task that ends with no turn after it (claude-code#102220 reports such notifications getting lost), and an agent that ended its last turn with only a progress note.
  - The next time the conversation is idle with nothing outstanding and no completing answer, the task ends `failed: no answer`. There is no second nudge, so a nudge turn that starts new work cannot loop (`ask.shadow.nudge`, `ask.shadow.no_answer`).
- **Background work ends with its process:** when the session's process ends (death, LRU close, restart without reattach), its background-task list is cleared, so a dead subagent never blocks completion.
- **Unsolicited turns** are turns like any other on a shadow conversation; a background subagent's report is one. The completion rule decides whether their answer completes the task. One that arrives after the task ended is journaled and logged (`ask.shadow.late_result`).
- **A `question` view** means the agent used `AskUserQuestion` despite the framing. It is treated as `request_input` with the question and options, answered at once with "sent to the asker; continue or end your turn", and logged (`ask.shadow.askuserquestion`).
- **Start:** when the shadow turn actually starts, the driver sends `working`.
- **`mark`, `permalink`, `openDialog`, …:** no-ops or `undefined`.
- **Capabilities:** `{reactions:false, privateReplies:"fallback", threadRepliesNeedMention:false}`.

The answering installation calls:

```
engine.liveTurn(shadow, key, undefined, undefined, key, project, wrapTask(...), undefined, shadowOpts(key))
```

**`shadowOpts(key)`** builds the turn's options from the incoming task record:
- `origin: {slug: "home/owen-ops", taskId}` for metering;
- `onAnswer` / `onSettle`, which apply the completion rule and send the terminal status.

**Restart recovery.**
- `resumeQueuedTurns` resolves the driver with `driverFor(teamId)` and passes no options, **unless the key's base starts with `a2a:`**. For such a key it uses the shadow driver and `shadowOpts(key)`, so a replayed shadow turn keeps its callbacks and its metering origin.
- `resumeInflightTurns` does not go through `liveTurn`. For an `a2a:` key, it hands the adopted result to `settleShadowTurn` and writes the metering record with the origin.
- Both branches are default-preserving: chat keys behave as today.

A shadow turn that can be neither reattached nor replayed ends its task `failed` with the answering side's error.

**`wrapTask`** (pure, golden-tested) frames the text as a question from another agent:
- answer it and change nothing: no commits, PRs, tickets, chat messages, memory notes or files left in the workspace;
- ask back with `request_input` if needed, and keep working while waiting if there is something useful to do;
- when the project may send: other agents may be asked (depth and marks permitting), and the answer waits for them;
- the first line is the answer in one sentence.

**Rounds:** a task allows at most `maxRounds` (the answering project's setting, default 5) `request_input` calls. The next one ends it `failed: too many rounds`.

**Ending a task:**
- A cancel from either side ends the task and cancels a running shadow turn via `engine.cancel`.
- A task that ends without completing cancels the open tasks its conversation started (`canceled: parent ended`).
- A message for a task that has already ended is acked, logged (`ask.after_end`) and not delivered.
- "Both sides are told" means the other side's record changes. No turn starts in a shadow conversation whose session is closed.
- **Expiry on both sides:** the answering side also ends a task that has had no message for the hub's expiry plus one day (`failed: expired`). It closes the shadow session and tells the asker, so neither side keeps a record or a session forever.

**Slots and sessions:**
- Shadow turns take the engine's global turn slots like any turn, but at most half of them (at least one). A second counter in the slot gate does it, so a fan-out or a routine elsewhere cannot take every slot from this installation's people.
- When a task ends, its shadow session is closed and its journal stays. So shadow conversations do not crowd the live-session LRU or the sandbox's memory. At completion nothing is outstanding, so no background work is cut off.

**`TurnOpts.origin`** widens from `{slug, proposalId}` to also allow `{slug, taskId}`. Metering stamps it.

### D11. Delivery: into the running turn, or a new turn
One deliverer handles every incoming task message, on both sides and for both transports: an answer, `working`, an `input-required` question, a reply, or a terminal state. `working` only updates state; it is never delivered to an agent.

**0. Check the counterpart.** A message on an existing task is accepted only from that task's counterpart. Answers and status come from its target; replies and cancels come from its origin. Anything else is dropped, with `ask.unexpected` (warning) naming the reason: unknown task or wrong counterpart. A message for a task that has ended is acked and logged (`ask.after_end`).

**1. Resolve the conversation.**
- Sending side: the reply target stored by `send_message` (D9), and its conversation key. A shadow conversation that sent a sub-task has its shadow key.
- Answering side: the shadow key.
- Nothing to resolve, because the project was removed by `/aven reload` or the workspace is gone: the task ends `failed: nowhere to deliver`, the message is acked, and `ask.deliver.no_conversation` is logged at error.

**2. Pick the path.** Inject only when all of these hold:
- the live session on that key has a turn that has **started** (a pending turn the CLI has echoed, D13), not one merely queued or opening;
- that turn was started by a person, a routine or a task, not an automatic turn that posts to a tracker on its own (YouTrack draft or auto-post, autofix, review), so an answer never reaches a tracker unseen;
- the turn is younger than `STREAM_MAX_MS` (the soft deadline), so injections cannot push it into the hard cap;
- fewer than 5 messages were injected into this turn;
- the session was spawned with the delivery accounting (D13), and its CLI passed the contract check (D12). Both are recorded per session. A session opened before a reload that added `messaging` has neither.

When all hold:
- `ClaudeSession.inject(text)` writes a stream-json user message with its own `uuid` and no pending turn of its own.
- The CLI folds it in at the next tool boundary (D12). The agent sees it, and the running turn's single `result` covers both.
- The turn's trail gets a step `↩ answer from bluefin/caldora (task …) folded in`.

Otherwise the message gets its own turn: `engine.liveTurn(driver, channel, undefined, thread, key, project, wrapped)` with a plain journal entry, after the running turn. A restart replays it.

**3. Confirm.** An injected message counts as delivered only when the CLI **echoes** it (D13). The echo comes when the CLI takes the message up, not when it is written. That is measured on 2.1.282 and 2.1.302, and stated in the SDK changelog (D12).
- **While the process lives, the message is never written again.** The CLI keeps it until a boundary, or runs it as its own turn after the running one; an interrupt keeps it too. After 10 minutes without the echo the bot logs `ask.inject.slow` (warning) and keeps waiting.
- **When the process dies before the echo,** the message is lost (measured). It is delivered again as a queued turn (`ask.inject.lost`, error).
- **When the process is idle and has not echoed the message within 2 minutes,** it will not take the message up any more. The CLI runs a pending message as soon as the turn ends, so being idle without the echo is a defect. The bot restarts the session (kill, resume), which drops the stale write, and delivers the message as a queued turn (`ask.inject.stuck`, error).
- **After a bot restart,** the reattach snapshot (the session's whole output log) shows which injected messages were echoed. An unechoed one on a live process is still waiting; on a dead process it is requeued.
- The transport is acked only after the echo, or after the queued turn is journaled.

**Framing.** `wrapAnswer` / `wrapReply` are pure and golden-tested. Between markers, as data, they carry:
- the source, the task id, the state, the original question and the text;
- the never-forward sentence;
- a line listing the tasks from this conversation that are still open, with their states, so a fan-out knows whether to wait.

**Exactly-once.** The task state and the delivery record are written before the ack. A redelivery finds `delivered` and only acks.

**What this replaces.**
- The earlier coalescing step: several answers during one long turn are folded in one by one.
- The "end the turn with the question" rule: `request_input` lets the answering agent keep working.

### D12. How a late message reaches a persistent Claude Code session (measured, partly documented)
The answer and the reply reach the agent as a **stream-json user message** written to the session's stdin, between markers that say whose data it is. A person's message and a dispatched task (`wrapDispatch`) use the same mechanism. It is not a tool result: the call that started the task returned long before.

The stream-json input accepts an optional `priority` on a user message (`now` | `next` | `later`, default `next`). It was measured with the `cli-probe` harness:
- CLI 2.1.282 (the fleet's pin) and 2.1.302;
- Haiku 5.5 and Opus 5.5;
- 1–3 runs per case, the same behaviour in every run.

| Case | Observed | `result` events |
|---|---|---|
| no priority / `next`, chain of tools | folded in right after the current tool's result; answered in the same final text | 1 |
| `later` | its own turn after the running one | 2 |
| `now` | the tool is not cut; the turn ends with an empty `result` at the boundary, and a new turn answers and finishes the original task | 2, first empty |
| one long tool | waits for the tool to finish (delay = its remaining time), then folded in | 1 |
| two messages mid-turn | both folded in | 1 |
| while the final text streams (no more tools) | not folded, not lost: its own turn after the running one | 2 |
| parallel tools | folded in after **all** parallel results | 1 |
| synchronous subagent running | the subagent does not see it; the parent does, after the subagent returns | 1 |
| background subagent (the Agent tool's default) | the parent turn ends at once; the message gets its own turn; the subagent's report comes as an unsolicited turn | 2+ |
| permission request pending | waits for the permission answer and the tool's result, then folded in | 1 |
| interrupt 300 ms after the message | the turn ends `error_during_execution`; the message is **kept** and runs as its own turn | 2 |
| process killed before the boundary, then `--resume` | **the message is lost**: not in the transcript | — |
| echo (`--replay-user-messages`) of a message written mid-tool | comes right after that tool's result, when the message is taken up, not when it is written (2.1.282 and 2.1.302) | — |
| background task bookkeeping | `system/background_tasks_changed` lists the running background tasks, then `[]` when the last one ends (`task_progress`, `task_updated` in between) | — |
| hooks at take-up (`--include-hook-events`, a `UserPromptSubmit` hook) | the hook fires for an injected message at the tool boundary, right before its echo; every Bash call also shows as `system/task_started` / `task_notification` (`local_bash`, not backgrounded) | 1 |

**What Anthropic documents.** There is no formal wire spec; claude-code#102880, "Emit a JSON Schema for the stream-json protocol", is open.
- **The de facto schema** is `sdk.d.ts` in `@anthropic-ai/claude-agent-sdk`, whose release numbers follow the CLI's (0.3.302 ↔ 2.1.302). It declares:
  - `SDKUserMessage` with `priority`, `uuid`, `origin` and `shouldQuery`;
  - `SDKUserMessageReplay` (`isReplay: true`, required `uuid`);
  - the `system` subtypes above, including `background_tasks_changed` with replace semantics;
  - the control requests: `initialize`, `interrupt` with `cancel_queued`, `can_use_tool`, `mcp_message`, `hook_callback`, `set_model`, `set_permission_mode`;
  - the optional `capabilities` on `system/init`.
- **The Agent SDK TypeScript reference documents `priority`** as we measured it:
  - `next` is read once the running tool calls finish;
  - `later` waits for the turn;
  - `now` interrupts, or with `origin.kind: "human"` (from 2.1.286) moves background-capable work to the background.
- **Changelogs.**
  - The SDK changelog (0.3.290) says a replayed message comes when a turn takes it.
  - The Claude Code CHANGELOG dates `--replay-user-messages` to 1.0.86 and background-by-default subagents to 2.1.198, so the fleet's 2.1.282 has them already.
  - The headless docs recommend `system/init` `capabilities` over version strings.
- **What stays observation only:**
  - folding at the tool boundary as measured (the docs say "once the tool calls finish");
  - the empty `result` of `now`;
  - what happens to a message when the process is killed;
  - the hooks' timing.

**Consequences:**
- The default (`next`) is the delivery path of D11. Its latency is the remaining time of the running tool.
- A write needs its own accounting (D13). A folded message never gets a `result` of its own, and a message that misses the turn gets one later.
- `later` equals the engine's own queue. `now` is not used: its empty `result` would read as an empty answer, and its meaning changed in 2.1.286.
- The echo marks take-up, and a kill before take-up loses the message. So a delivery is confirmed by the echo, never by the write, and only a dead process makes the bot write a message again.
- `background_tasks_changed` tells the bot when the CLI still has work outstanding (D10).
- `--verbose` is not an extra: `-p` with stream-json output refuses to start without it. The extras are:
  - `--include-partial-messages`: token-level `stream_event`s;
  - `--include-hook-events`: the hook lifecycle;
  - `--replay-user-messages`: the echo, used here.

  The echo is enough for delivery; the other two are probe instruments.
- **Not yet measured:**
  - stdin through the ssh-docker FIFO and the Daytona session;
  - the race between the last tool result and the start of the final text (`--include-partial-messages` shows the exact start of a text block);
  - long Opus turns with a large context;
  - claude-code#102220 (mid-turn task notifications never reaching the model) on the pinned CLI.

  `cli-probe` covers them before the canary (task 0.2).

**Mechanisms considered and not used:**
- **Interrupt** (`control_request {subtype: "interrupt"}`): throws away the running turn's work.
- **CLI background tasks as a waiting point:** something inside the sandbox would have to wait on them, which contradicts the no-mount, control-channel-only rule.
- **MCP server-to-client notifications** over the control channel: not known to reach the model; not needed.
- **The Agent SDK as the driver** (`spawnClaudeCodeProcess` runs the CLI in "VMs, containers, or remote environments"): it would replace `ClaudeSession`'s hand-written protocol. But the bot's reattach to a running CLI after its own restart has no counterpart there. That is a separate evaluation, in `cli-probe`'s follow-ups, not part of this change.

**Contract check.** The observed rows are not a published contract. A contract check pins them:
- `cli-probe` makes the rows the delivery relies on contract scenarios. An operator runs them live against a CLI version and commits the report and the recordings. CI re-checks every recorded event against the SDK's declared types, replays the recordings through `ClaudeSession`, and fails when the images' pin is not a probed version. A pin bump that breaks a contract row, or the types, fails CI.
- The check is **per session**, because a project can override `cliVersion` and the CLI is upgraded in place at chat prep (`src/cliversion.ts`).
  - The session reads its `system/init`, preferring a capability when the CLI reports one and falling back to the version.
  - Injection is used only on a CLI that `cli-probe` passed; otherwise that session gets queued turns and logs `ask.inject.disabled`.
  - The passed set is `PROBED_CLI_VERSIONS` in `src/cliversion.ts`, beside the fleet pin. The pin-bump PR updates both, with the probe report.
  - A version leaves the set only when no installation or project still pins it, because a session on a version outside the set gets no injection (loudly, `ask.inject.disabled`).

### D13. Message accounting in `ClaudeSession`
Today `ClaudeSession` keeps one pending turn and settles it with the first `result` that arrives. That is wrong as soon as two messages can be in flight. It is already subtly wrong with CLI background tasks: a background report that finishes while a person's turn waits to start can settle that turn with the report's text. Injection would make it routine.

The new accounting:
- **The ledger.** Every write carries a `uuid`, and the session runs with `--replay-user-messages`. `ClaudeSession` keeps a ledger: **sent → taken up (echo) → settled (`result`)**.
- **Settling.**
  - A pending turn is settled only by a `result` that follows the echo of **its own** message.
  - An injected message folded into a running turn is settled by that turn's `result`.
  - An injected message that missed its turn is settled by the `result` after its own echo. The bot renders that as the delivery's answer in the conversation, with the task's origin in metering, not as a `🔔 Background update`.
- **Other results.** A `result` with no message of its own in the ledger is an unsolicited turn (`onIdleResult`), as today. A `result` that would settle the wrong message is logged (`ask.inject.result_mismatch`, error) and treated as unsolicited.
- **Background tasks.** `background_tasks_changed` updates the session's list of running background tasks (D10).
- **One result, several messages.** A `result` that settles a person's message and folded task messages is rendered once, as that turn's answer. The trail lists the messages it covered.
- **Reattach.** The ledger is rebuilt from the snapshot: echoed uuids are taken up, and the last `result` settles what it covers.
  - Every `mcp_message` of the current turn that has no tool result after it is served again, not only the last event (`host-tools`, "A pending call survives a bot restart"). This matters because parallel host calls, a fan-out for example, would otherwise leave all but one unanswered.
  - The task tools find their earlier records by request id (D9), so serving them again is safe.
- **Spawn mode.** The session records how it was spawned: with or without the ledger, and its CLI version or capabilities. Delivery follows that record, not the current configuration.

The flag and the ledger change the spawn line, so they apply only to sessions of projects with a `messaging` configuration (bucket 2). Every other session keeps today's spawn line and settle rule, pinned by the recorded turn tests.

### D14. Marks: data from one domain does not reach another without a person
An answer from a client's agent carries that client's data: tickets, logs, mail. It may reach an agent that also holds other sources and can message other agents. An instruction hidden in that data could make it forward one client's data to another.

**Domains.** The unit of trust is the **domain**: one tenant of one installation.
- The home tenant's domain is the installation id (`bluefin`).
- Another tenant's domain is `bluefin~<tag>`, where the tag is the first 8 hex characters of the SHA-256 of the tenant id. So tenant ids never leave their installation.
- A single-workspace installation is one domain.
- Inside a domain, the accept lists decide. Between domains, including two tenants of one installation, marks apply.
- Every message carries its sender's domain (D5), and cards carry the agent's domain (D7). The sender keeps the domains it has learned, per peer agent.

**Marks.** A conversation's marks map each other domain whose data reached it to the domains that already have that data.
- When a message with content arrives from domain S (S ≠ the conversation's own):
  - `marks[S] ∪= {S}`;
  - for each mark `m` the message carried, with its holders `h` (`m` ≠ own): `marks[m] ∪= h ∪ {S}`.

  Content means a task's question, an answer, an `input-required` question or a reply. States and fixed reasons carry no content and mark nothing.
- A message from the own domain adds only the marks it carries. So a local hop cannot launder data.
- When a message goes out to domain Z, because the rule allowed it or a person released it, Z is added to the holders of every mark. Z has that data now, and a second message to Z is not held again.

**Domain claims.** A remote sender's domain is checked against its authenticated installation:
- the domain must be that installation's id, or the id followed by `~<tag>`;
- anything else is dropped (`ask.unexpected`).

The tag itself is a claim, as strong as that installation's bot, like the agent part of `from`.
- Every message carries the target domain its sender assumed (`toDomain`). The receiver refuses it when that is not the target's actual domain: `rejected: domain changed` for a first message, `failed` for a later one.
- So a stale learned domain, such as an agent that moved to another tenant, cannot let a message past the rule.

**The rule.** A message from the conversation to an agent of domain Z goes out only when, for every mark `m`, `m = Z` or `Z ∈ marks[m]`: Z is the data's source, or already had it. The rule covers a new task, a reply and an answer.
- Messages to agents of the own domain always go out, carrying the marks.
- A remote agent whose domain is not known yet counts as a domain that has nothing, so in a marked conversation its first message is held. Unmarked conversations are unaffected.
- When the marks do not allow a message:
  - in a chat conversation it is **held** for a person's Send (D9; `ask.marks.held`, info);
  - in a shadow conversation it is refused (`ask.marks.refused`, warning).

  A shadow conversation's data comes from its origin, or is already the origin's, so its answers to its origin always pass. A refused answer would end its task `failed: refused by marks`.

Examples:
- A person released a message from home (marked bluefin) to northwind. Northwind's conversation holds `marks = {home: {home}, bluefin: {bluefin, home}}`, so its answer to home passes.
- The same conversation could not send to bluefin, since home's mark has `bluefin ∉ {home}`.

**Lifetime.** Marks belong to the conversation, stored per conversation key in `state.json`. The session's context keeps the data across turns, through compaction and after a resume. The CLI session id changes on compaction, so it is not the key.
- Marks end only in two cases: when the conversation starts a fresh session with `🔄 Restart session`, or when `pruneChats` drops the conversation's record. Age alone never ends them.
- A per-turn mark would miss the next turn in the same thread.

**The project's own sources.** A tenant agent's sources may ingest the workspace it posts in. A reply built on another domain's answer would then come back through the store, unmarked. To prevent that:
- the bot's posts in a marked conversation carry a marker (Slack message metadata `aven_marked`; the Teams driver sets its own equivalent);
- the chat sources skip marked posts at ingest (`src/sources/slack/normalise.ts`).

`wrapAnswer` also says it in words: never pass content from one domain's answer to another.

**Consequence:** a thread that has asked one client's agent needs a person's Send before it asks another client's agent in the same session. That is the price of the rule.

### D15. Chains, routines and people's own agents
**Chains.**
- A shadow conversation of a project with `messaging.send` has the sending tools.
- Depth: a conversation with a person or a routine starts tasks at depth 0, and a sub-task carries `depth = parent depth + 1`. The tool refuses depth 4, and the receiver rejects it (`rejected: too deep`).
- Marks travel with the sub-task.
- The parent's answer waits for open sub-tasks (D10), and a parent that ends without completing cancels them.
- Ping-pong between two agents is bounded by depth, rounds, the daily caps and the expiry.

**Routines.**
- A routine's turn is an ordinary turn of its project, and it may send.
- The answers arrive as turns in the run's thread, or fold into the run's turn while it is still running.
- The guard records the run's own outcome and waits for nothing.
- The agent composes its report when the wrap's still-open line is empty (D11).
- One change to `routineguard.ts`: the one retry is not planned for a failed run that already started tasks. Its answers continue in its thread, and a retry would send them again. A run without tasks retries as today.

**People's own agents.** Nothing specific is needed:
- a person's own agent is a project with that person's sources;
- it is configured to send, and accepted by the agents it may reach;
- who may drive it is the existing channel gate.

### D16. Fail loudly
Every unexpected state goes to the log.
- The events helper (`src/messaging/events.ts`) also sends every warning and error to Sentry **explicitly**, with `captureMessage` / `captureError` and the tag `area: "messaging"`. `log.warn` reaches Sentry only with `SENTRY_LOGS`, so the helper does not rely on it.
- The hub reports its own errors through `@sentry/cloudflare` when a DSN is set as a Worker secret, and to Workers logs otherwise.
- A test walks every failure path and checks that it emits its event.

| Event | Level | Fields |
|---|---|---|
| `hub.auth.refused` (hub) / `hub.connect.failed` (bot) | error, once per reason per hour while retrying | installation, reason (`bad_sig`, `unknown`, `not_authenticated`) |
| `hub.replaced` | warn | installation |
| `hub.clock.skew` | warn when > 30 s, once per connection | skew_ms |
| `hub.disconnected.long` | warn after 10 min offline | minutes, local outbox size |
| `hub.peer.removed` | warn | peer, open tasks ended |
| `hub.envelope.bad_signature` / `decrypt_failed` | error | from, method, task, env_id, key fingerprint |
| `hub.envelope.duplicate` | info | from, task, env_id |
| `hub.rejected` (unknown installation, backlog) | warn | from, to, method, reason |
| `hub.outbox.backlog` | warn when > 100 | installation, size, oldest age |
| `ask.rejected` (not accepted, budget, too deep, unsupported version) | warn | from, to, task, reason, versions |
| `ask.unexpected` (unknown task, wrong counterpart, bad id, domain claim) | warn | task, from, expected |
| `ask.after_end` | info | task, state, method |
| `ask.inject.slow` | warn after 10 min without echo | key, task, CLI version, waited ms |
| `ask.inject.lost` | error | key, task, CLI version → requeued |
| `ask.inject.stuck` | error | key, task, waited ms → session restarted, requeued |
| `ask.inject.result_mismatch` | error | key, expected and actual uuid |
| `ask.inject.skipped` / `ask.inject.disabled` | info / warn | key, task, reason (automatic turn, soft deadline, cap, spawn mode, CLI) |
| `ask.deliver.no_conversation` | error | task, key, slug, driver |
| `ask.shadow.late_result` | warn | task, length |
| `ask.shadow.askuserquestion` | warn | task, slug |
| `ask.shadow.nudge` / `ask.shadow.no_answer` | info / warn | task, slug |
| `ask.rounds.exceeded` / `ask.expired` / `ask.canceled` | warn / info | task, from, to, rounds, age |
| `ask.marks.held` / `ask.marks.refused` | info / warn | task, marks, requested target |
| `ask.cost.high` | warn when a task's turns cost > `costWarnUsd` | task, slug, cost |
| `hub.schema.migrated` | info | from, to |

### D17. Audit: `/aven asks`
The verb exists only on an installation where some project has a `messaging` configuration or `HUB_URL` is set. Elsewhere, `/aven asks …` stays a question to the agent.

It is for the installation's operators, who are always home-tenant operators (`isOperator` within the home tenant), like `/aven usage`. It covers every tenant:
- `/aven asks` lists the last 50 tasks: both directions, local and remote, held ones first. Each line has the local agent's tenant, the state, the times, the origin or target, the cost, and the first lines.
  - The cost comes from metering for turns run here, and from the terminal status for answers from another installation (D5).
- `/aven asks <taskId>` shows a shadow journal as markdown.
- `/aven asks cancel <taskId>` cancels a task.

Housekeeping prunes task records and `shadow/` after 30 days. Marks are not pruned by age; they go with their conversation's record (D14).

The Home tab cheat-sheet gains the verb and a line on held messages. It is shown when any project has a `messaging` configuration, and Slack and Teams share the text.

### D18. Where things live; configuration; rollout
- **Public repo:**
  - `hub/`: Worker, Durable Object, `wrangler.example.toml`, tests on `@cloudflare/vitest-pool-workers`, its own `package.json`. Not a dependency of the bot.
  - `src/messaging/`: `a2a`, `protocol`, `seal`, `transport`, `local`, `hubclient`, `peers`, `deliver`, `wrap`, `marks`, `events`, `agents`, `answer`.
  - `src/chat/shadow/`.
  - `docs/agent-messaging.md` (the overview, from `overview.md` of this change) and `docs/hub.md` (operations).
- **Pure, shared modules:** `hub/` imports `src/messaging/protocol.ts` and `src/messaging/a2a.ts` for types and validation, so there is one source of truth. An imports test keeps those two free of `node:` imports.
- **Installation configuration:**
  - `.env`: `INSTALLATION_ID` (default `local`; must be set explicitly for the hub), `HUB_URL`, `HUB_KEY_PATH`. Changing an installation's id makes its old domain foreign: marks that name it stay, and open tasks fail. `docs/hub.md` says to change it only with no open tasks;
  - `projects.config.json`: `messaging` per project (D2);
  - `hub.peers.json` beside it: peer ids → key lists. `deploy.sh export`/`import` carry it like the projects config. `state.json`, the marks and `shadow/` stay out of the ops repo, as `state.json` does today.
- **Operator's ops repo:** `hub/wrangler.toml` (route, account) and `hub.config.json` (enrolled installations and their keys), pushed as the Worker secret. Private keys never leave their box.
- **Rollout:**
  - bucket 2 for messaging inside an installation: per-project configuration, with unconfigured projects byte-identical;
  - bucket 3 for the hub (`HUB_URL`);
  - one ledger row.
- **Canary:** three installations, because held messages need a third domain. Home (owen-ops sends), prod (one project accepts `home/owen-ops`) and the Teams staging installation (one project accepts it).

## Risks / Trade-offs

- **[Prompt injection across agents]** A question is attacker-controllable text that reaches an agent with its tools.
  - Mitigations: questions are wrapped as data with a "change nothing" frame; accept lists name who may ask each agent; daily caps per sender; marks stop forwarding between domains; every ask is in `/aven asks` with its transcript.
  - Next step: hard read-only enforcement through a Claude Code permission mode per shadow conversation, before an installation the operator does not run joins.
- **[Indirect access]** An accept entry lets whoever drives the sender learn what the agent answers, even someone who could not use that agent directly. → That is the explicit meaning of an accept entry; the docs say so, and answers are audited on the answering side.
- **[Cost]** A shadow turn costs the answering installation's quota, and a fan-out or a chain costs more. → Daily caps on both sides, depth 3, half of the turn slots, `ask.cost.high`, and the cost per task in `/aven asks`. Metering marks how many task messages were folded into a turn.
- **[Hub down]** Asks between installations stop; local ones and chat keep working. → Outgoing envelopes wait in `state.json` and go out on reconnect, and `send_message` says so in its reply.
- **[Cloudflare dependency]** Routing metadata (who asks whom, when, sizes) is visible to Cloudflare and the operator's account. → Contents are end-to-end encrypted, and the relay is small enough to rehost behind the same `PeerTransport`.
- **[Key compromise]** A stolen installation key lets someone impersonate the installation and read its traffic. → Keys are 0600 on the box; rotation is documented in `docs/hub.md`; removing the installation from the hub configuration cuts it off at once.
- **[Shadow turns are invisible to the answering side's people]** That is the decision for now. → The audit verb shows everything to operators; mirroring into a channel is a later per-pair flag.
- **[A folded message changes a person's answer]** An answer folded into a person's turn may appear in the reply to that person. → It is the same conversation and agent, the framing says whose data it is, and the trail shows the fold. The contract check (D12) pins the CLI behaviour, with queued turns as the fallback. Automatic tracker turns never take folds (D11).
- **[Marks get in the way]** A thread that talks to two domains needs a person's Send for the second. → Deliberate (D14); a fresh session clears the marks.
- **[Marks follow conversations, not files]** What a marked conversation writes can reach the project's other conversations, which carry no mark: files in the sandbox, memory notes, the ledgers a tenant agent keeps. Marks are a guard against injected forwarding, not full information-flow control.
  - Shadow conversations: `wrapTask` forbids writing anything, and the hard read-only permission mode (the next step above) closes this.
  - The automatic path, the bot's own posts coming back through the project's sources, is closed by the marker (D14).
  - What an asking agent deliberately writes down for its person stays that person's decision, and is documented as the limit.
- **[Undocumented CLI behaviour]** Fold-in timing, the empty `result` of `now`, kill-before-take-up and the hooks' timing are observed, not published. → `cli-probe` records them per probed version and makes the ones the delivery relies on contract scenarios, re-checked in CI against the SDK's types; each session's check falls back to queued turns.
- **[Shadow data at rest]** `shadow/`, the task records and the marks hold other agents' text for 30 days on the answering installation, outside the ops repo. `docs/hub.md` documents this.
- **[Answer size]** Long answers in one frame. → The A2A message is capped at 256 KiB on send; answers are truncated with a note, and attachments are out of scope.
- **[Clock drift]** Out of the system's responsibility: nothing breaks, and the bot warns past 30 s.

## Open Questions

- Should the answering agent see which person drove the asking turn? Proposed: no in v1, agents only; the asker can say it in the text. Revisit with people's own agents if answering agents need it for their own rules.
- Does an answering installation want a weekly digest of incoming asks in its tenant channel? Not in this change.
