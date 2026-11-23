# Proposal

## Why

An agent of an installation can be asked from the installation's own chat and by other agents (agent
messaging), but not from the tools a team already works in: an MCP client such as Claude, Claude Code or
Langdock. The roadmap's Reach direction is done when "one of its agents answers a question asked from a client
this project did not build" (`docs/how-we-work.md`); today no such door exists. The first consumer is a client
team whose non-developers work in such a client and should not need a second chat to ask what their system
does.

## What Changes

- **An MCP endpoint for people.** The bot can serve an MCP streamable-HTTP listener (stateless, like
  `orch sources serve`) with the four messaging tools — `agents`, `send_message`, `get_task`, `cancel_task`.
  The caller is a person, not a session.
- **The gateway authenticates, the bot authorizes.** The listener accepts only the installation's gateway
  (a static bearer) and takes the person's identity — e-mail and groups — from headers the gateway sets after
  it verified the person's token at the installation's identity provider. The bot runs no OAuth server.
- **People in `messaging.accept`.** Two new entry forms, `user:<e-mail>` and `group:<name>`. Only a project
  that lists a person or one of their groups is visible to them and takes their questions. `*` keeps meaning
  "every agent of my domain" and never matches a person.
- **One question, one task.** A question becomes a task answered in a shadow conversation, exactly as a task
  from another agent: the same caps, the same audit (`/aven asks`), the same skills (`skill` as a parameter).
  The answer is kept on the task and read with `get_task`; nothing is posted to any chat.
- **Waiting.** `send_message` and `get_task` take `waitSeconds`: the call returns as soon as the task has an
  answer, a question back or an end, or when the time is up — whichever comes first.
- **Usage by person.** The usage records of a task's answering turns name the person who asked.

Decided with the maintainer (2026-11-23): tasks, not a dialogue with a kept session; the four general tools
first, a tool per skill later; the first check is a person in Claude on the same route a client will use.

Out of scope:

- A dialogue (follow-ups in one kept session), and a tool per project skill.
- An OAuth authorization server in the bot, and an MCP or A2A HTTP adapter on the hub (the hub cannot read
  envelopes; an adapter there would hold a client's key).
- People asking agents of *another* installation through this endpoint: targets are agents of the own one.
- The gateway's own configuration (routes, identity provider, client registration): an installation's ops
  matter, described in the docs, not shipped here.
- A `user` field on ordinary chat turns, and any `/aven usage` change.
- A local stdio bridge to the hub for a laptop client (a separate change).

## Capabilities

### New Capabilities

- `agent-mcp-endpoint`: people in an outside MCP client ask the installation's agents — the listener and who
  may call it, how a person is identified and accepted, the tools and their waiting, where the answer is kept,
  caps, audit and usage.

### Modified Capabilities

None. The answering side — shadow conversations, completion, caps, cards, skills — is used as specified in
`agent-messaging`. That spec's sentence listing the accept entry forms becomes incomplete; it is brought in
line when this change is archived (its requirement is over the length limit, and splitting eleven over-long
requirements of that spec is a change of its own).

## Impact

- **Rollout:** bucket 2, default-preserving. Two gates, both off by default: the listener starts only when
  `AGENT_MCP_LISTEN` and `AGENT_MCP_TOKEN` are set, and a project takes a person's question only when its
  `messaging.accept` names them. With neither, no port is opened and every session's tools and arguments are
  what they are today (test). Ledger row in `docs/rollout.md` in the code PR.
- **Code:** a new module in `src/messaging/` for the listener and its tools; `src/messaging/config.ts` and
  `protocol.ts` (the two entry forms); `src/messaging/service.ts` (a task whose asker is a person; no
  transport on the asking side); `src/messaging/runtime.ts` (start and stop); `src/metering.ts` (the `user`
  field); `/aven asks` rendering (the asker shown as a person).
- **Config:** `messaging.accept` gains two entry forms. A bot older than this change refuses them at load, so
  an ops repo adds them only after the installation runs the release that knows them.
- **Docs:** `docs/agent-messaging.md` (a section for people), `docs/runtime-config.md` (the two settings, the
  gateway's part with an example route), `docs/security.md` (what an accepted person can reach; the answer
  leaves to the person's client).
- **No Slack, Teams or web surface changes;** the Home tabs stay as they are.
- **Dependencies:** none new (the listener is `node:http`, as `sources serve`).
