# Proposal

> **Status: proposed 2026-10-17.** Decisions taken in review:
> - **Scope.** Agent messaging is a property of the system: any agent the bot runs can ask any agent that accepts it, in its own installation or in another one. The first user is an operator's tenant agent; people's own agents and routines come next. All of them use the same mechanism.
> - **Transport.**
>   - Between installations: a hub on Cloudflare (Workers + one Durable Object with WebSocket hibernation), not an inbound peer API or SSH.
>   - Inside an installation: in-process, no hub.
> - **Access.** The receiving agent's configuration decides who may ask it. The hub only admits enrolled installations.
> - **Security.**
>   - End-to-end encryption between installations from day one.
>   - Authentication by a signed challenge, so clocks do not matter; the bot only warns when its clock is more than 30 s off.
>   - No approval click, except a person's Send when data from one domain would reach another. A domain is one installation, or one client workspace inside a multi-workspace installation.
> - **Protocol.**
>   - A2A 1.0 message shapes, with no A2A SDK and no public A2A endpoint.
>   - The agent tools mirror the A2A operations: `send_message`, `get_task`, `cancel_task`, `agents`, `request_input`.
> - **Delivery.** Incoming messages are folded into the agent's running turn (measured on the CLI's stream-json input) or start a new one.
> - **Answering side.** The task runs in a **shadow conversation** that never posts to chat.

## Why

Agents of one installation can reach each other only through dispatch: a proposal, a person's click, a turn in the target's channel. Agents of different installations cannot reach each other at all. Three uses need more:
- **Tenant agent across installations.** An operator's tenant agent (owen-ops, on the home bot) plans work for projects that run in other installations: prod (bluefin) and a Teams staging host (northwind). Today a question like "why did caldora's orders drop yesterday?" means copying it into another workspace by hand and carrying the answer back. The home bot sits behind NAT, with no inbound address.
- **A person's own agent.** It is fed with that person's work context, and it should be able to ask the agents that have more access (a tenant agent, a project agent) and come back with the answer.
- **Routines.** A weekly report that wakes up, asks several agents and composes their answers.

These are one capability, not three features: ask an agent, get the answer back into the asking session, and keep the answering side quiet.

## The model

- **Installation.** One bot process with its own ops overlay (`ops-overlay`). Each has an id (`home`, `bluefin`, `northwind`) and, to use the hub, a key pair.
- **Agent.** A project the installation runs: a project agent, a tenant agent, or a person's own agent. All of them are projects to the bot.
- **Target.** `<installation>/<agent>` (`bluefin/caldora`), or `<agent>` for the own installation.
- **Acceptance.** A project may be configured to send, and lists who may ask it (`accept`). Accepting a sender gives the sender, and whoever may drive it, what the agent answers.
- **Transport.**
  - Inside an installation, messages stay in the bot process.
  - Between installations they go through a hub that every participating installation connects to *outbound*. The hub routes and stores envelopes it cannot read.
- **Task.**
  1. The asking agent sends a message, and the tool returns at once.
  2. The answering installation runs the message as a turn in a **shadow conversation**: its own Claude session in the target's sandbox, with nothing posted to chat.
  3. Every message back reaches the other agent's session **inside its running turn**, at the next tool step, or as a new turn when the session is idle. A message back is the answer, a clarification (A2A `input-required`), or a reply to one.
  4. Nobody waits with a turn open, and people keep talking to the asking agent meanwhile.
- **Domain.** One tenant of one installation. A single-workspace installation is one domain; a multi-workspace installation has one domain per workspace.
- **Marks.** A conversation remembers which other domains' data reached it, and which domains already had that data. A message that would carry data to a domain that did not have it needs a person's Send.

## What Changes

- **Messaging core** (`src/messaging/`, pure parts tested):
  - A2A-shaped payloads (`Message`, `Task` with `submitted | working | input-required | completed | failed | canceled | rejected`, `AgentCard`);
  - the envelope and frames;
  - the acceptance check;
  - a `PeerTransport` seam, with an in-process transport for the own installation.
- **Hub** (`hub/`, new):
  - a Cloudflare Worker + Durable Object, in TypeScript, with its own `package.json` and tests;
  - it admits installations by a signed challenge and routes encrypted envelopes between enrolled installations;
  - it keeps a per-installation durable outbox with a monotonic `seq`, replayed on reconnect;
  - idle connections hibernate.

  Generic code lives in this repo. The domain and the enrolled keys live in the operator's ops repo.
- **Hub client in the bot**:
  - one outbound WebSocket when `HUB_URL` is set;
  - reconnect with backoff, and `ack` by `seq`;
  - envelopes sealed and opened with the installation's keys (`node:crypto` X25519 + Ed25519 + AES-256-GCM, no new dependency);
  - peers pinned in `hub.peers.json`.
- **Host tools mirroring A2A** (`host-tools`):
  - for projects configured to send: `send_message`, `get_task`, `cancel_task`, `agents`;
  - for shadow conversations: `request_input`.

  All of them return at once. `host` is registered with a `messaging` configuration (it once also was with `DISPATCH=1`; dispatch, retired by `retire-agent-dispatch`). A prompt paragraph tells sending agents how answers come back.
- **Delivery into a running turn.** `ClaudeSession.inject` writes a stream-json user message without waiting for its own `result`, and the CLI folds it in at the next tool boundary. With no turn running, a normal turn starts. A message counts as delivered only when the CLI echoes it (`--replay-user-messages`). It is written again only when the process died before the echo, and each write carries a `uuid`, so a `result` settles only its own message.
- **Shadow conversations** on the answering side:
  - a quiet `ChatDriver` (`src/chat/shadow/`) that journals the turn instead of posting it;
  - conversation key `a2a:<taskId>`;
  - the same turn engine, queue, metering and restart recovery.

  A task completes with the conversation's answer once nothing is outstanding there: an unanswered `request_input`, an open sub-task, a message not taken up yet, or a CLI background task. If everything resolves and no turn follows, the bot asks the agent once for its final answer.
- **Marks and held messages.** A message that would carry one domain's data to another domain that did not have it waits for a person's Send. The card has Send and Dismiss and does not depend on `DISPATCH`. In a shadow conversation such a message is refused.
  - Task tools work only in the conversation that started the task.
  - The bot's posts in a marked conversation carry a marker, and the project's chat sources do not ingest them.
- **Chains and routines.**
  - A shadow conversation may ask further agents, up to depth 3. A parent that ends cancels its open sub-tasks.
  - A routine's turn may ask, and the answers continue the run's thread. The routine guard does not retry a failed run that already sent tasks.
- **Fail loudly.** A catalogue of events goes to the log and Sentry: refused or replaced connections, bad signatures, clock skew, messages that cannot be delivered or are slow or lost, mismatched results, limits, marks.
- **Prerequisites.**
  - A separate change, `cli-probe`: a reusable harness for hypotheses about the headless CLI, with a CI contract check.
  - A fleet-wide Claude Code pin bump to the version the harness passed on.
- **Audit.** `/aven asks` lists incoming, outgoing, local and held tasks, with the shadow transcript on request. The Home tab cheat-sheet gains the verb and the held-message card.
- **Docs:**
  - `docs/agent-messaging.md`, the overview;
  - `docs/hub.md`: deploying the hub, enrolling and removing an installation, rotating keys, keeping the clock in sync;
  - runtime-config rows, and the rollout ledger row.

## Out of scope

- ~~Asking another agent to change something.~~ No longer out of scope: messaging carries requests to do work too (dispatch, retired by `retire-agent-dispatch`, D3).
- Admin operations over the hub (reload, run a routine, sandbox status).
- A public A2A HTTP endpoint for third-party agents; that would be a later adapter on the hub.
- MCP Tasks (`tasks/*`): Claude Code does not drive them, and the tools return immediately instead.
- Mirroring shadow conversations into a chat channel (a later per-pair flag).
- People as addressees, and per-person policy on the answering side; the protocol carries agents.
- Clock correction: keeping the host's clock in sync is the host's job.

## Capabilities

### New Capabilities
- `agent-messaging`: an agent asks any agent that accepts it, in the same installation or another, and gets the answer back. It covers acceptance, the tools, delivery into the running turn, shadow conversations and completion, clarifications, chains, marks, encryption between installations, limits, failures and audit.
- `messaging-hub`: the relay between installations. It covers enrolment, the challenge, routing between enrolled installations, durable delivery, hibernation, presence, and what the hub may and may not see.

### Modified Capabilities
- `host-tools`: two requirements.
  - "Served over the session's control channel": `host` is also registered for a project with a `messaging` configuration, and never offers `propose` in a shadow conversation.
  - "Deterministic, read or gated": the task tools execute without a button. Their gate is the configuration and the receiver's acceptance, or a person's Send under the marks.
- `agent-dispatch`, "Off by default": it covers proposal buttons and dispatched turns, not the held-message card.
- `chat-driver-interface`, "One chat driver per installation": one driver for people; the shadow driver runs beside it.

## Impact

- **Rollout.**
  - Bucket 2 for messaging inside an installation. It is gated per project by `messaging` in `projects.config.json`, and a project without it has a byte-identical tool list, spawn line, prompt and settle rule.
  - Bucket 3 for the hub. It is behind `HUB_URL`; unset, there is no socket.
  - Canary on three installations, since held messages need a third domain:
    - the home bot (owen-ops sends; one local ask);
    - the prod bot, with `HUB_URL` and one project that accepts `home/owen-ops`;
    - the Teams staging bot, the same way.
  - One ledger row in `docs/rollout.md`.
- **Code.**
  - New: `hub/` (a package deployed with `wrangler` from the ops repo), `src/messaging/*`, `src/chat/shadow/`.
  - Changed:
    - `src/hosttools.ts` / `src/hostrouter.ts` (the tools; `host` registration);
    - `src/prompt.ts` (the messaging paragraph; goldens unchanged for others);
    - `src/turn.ts` (a turn may run on a shadow driver; chat-bound turns are unchanged);
    - `src/claudeSession.ts` (`inject`, the message ledger, `--replay-user-messages` and background-task tracking for configured projects);
    - `src/chat/views.ts` + the Slack and Teams renderers (the held-message card);
    - `src/chat/core/commands.ts` + `src/chat/slack/blocks.ts` (`/aven asks`, Home tab);
    - `src/state.ts` (task records, marks);
    - `src/routineguard.ts` (no retry for a failed run that already sent tasks);
    - `infra/deploy/deploy.sh` (`hub.peers.json` in export/import);
    - `src/cli.ts` (`orch hub keygen`).
- **Config.**
  - `.env`: `INSTALLATION_ID` (default `local`; explicit for the hub), `HUB_URL`, `HUB_KEY_PATH`.
  - `hub.peers.json` beside the projects config.
  - Per project: `messaging: { send?, accept?, description?, sendPerDay?, acceptPerDay?, maxRounds?, costWarnUsd? }`.
- **External.** A Cloudflare account and a Worker route on the operator's domain. Workers Free covers the expected volume: a few installations, hundreds of messages a day.
- **Data.**
  - Question and answer text leave an installation only encrypted to the receiver's key.
  - The hub stores ciphertext and routing metadata (from, to, method, size, time).
  - Shadow transcripts stay on the answering installation for 30 days.
