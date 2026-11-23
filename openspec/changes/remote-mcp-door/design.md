# Design

## Context

See `proposal.md` for the why. What exists and shapes the approach:

- **The answering side is complete.** `src/messaging/service.ts` takes a task (`onAsk`), checks `accept`, the
  per-sender daily cap and the skill, runs the turn in a shadow conversation, applies the completion rule and
  keeps the result on the `InTask` record (`state`, `last`, `cost`). `/aven asks` lists and cancels.
- **The asking side assumes a session.** `sendMessage(c, …)` takes a caller `{slug, conversationKey}`, needs a
  thread to answer into (`replyTargetOf`) and delivers the answer as a turn of that conversation. A person in
  an outside client has neither a project nor a conversation here.
- **A stateless MCP listener exists.** `src/sources/serve.ts`: `node:http`, streamable HTTP without sessions
  or an event stream, a static bearer, loopback by default, the gateway as its only client.
- **Identity for people is the gateway's.** An installation's gateway already verifies people's tokens at its
  identity provider on its people routes and can forward claims as headers; the bot authenticates nobody
  except through the web chat's own login.
- **Constraints.** The host runs deterministic code only. Prod must not change by a merge. `validate
  MessagingConfig` throws on an accept entry it does not know.

## Goals / Non-Goals

**Goals:**

- A person's question reaches the answering side through one new entry point, with no second copy of its
  rules (accept, caps, skills, completion, audit).
- No new trust boundary in the bot: one bearer, one caller (the gateway), identity as data from it.
- Nothing changes for an installation that sets nothing.

**Non-Goals:**

- Serving MCP clients directly (TLS, OAuth discovery, client registration) — the gateway's job.
- Server-initiated messages, MCP Tasks, resumable streams. Clients differ in what they support; request and
  response is the part all of them have.
- Per-person rights inside a project (roles, per-sender skill sets).

## Decisions

### D1. The person's task enters at the answering side, with no transport

The endpoint calls a new service entry — in effect `onAsk` for a person — which creates the `InTask` and
starts the shadow conversation. No `OutTask`, no envelope, no `LocalTransport` record: there is no asking
agent whose session must be told. Status changes that would be sent to an asker are, for a person's task,
written to the record only.

*Alternative rejected:* a pseudo-project ("the door") that owns a conversation and calls `sendMessage`. It
would reuse the asking side as is, but needs a fake project in the registry, a fake reply target and a
delivery that goes nowhere — three fictions to save one function.

### D2. The asker is `user:<e-mail>`, never an address

`InTask.from` holds `user:<e-mail>` (lower-cased), `origin` the own installation. The form cannot parse as
`<installation>/<agent>`, so no agent entry can match a person and code that posts to `from` cannot be reached
by mistake: the two places that parse `from` as an address (status sending, the cancel cascade) branch on the
prefix first. The shadow key keeps its shape (`a2a:<origin>:<taskId>:<slug>`); task ids are random, so a
person's task and an agent's cannot collide.

### D3. Accept entries `user:` and `group:`; `*` stays agents-only

`accepts()` in `protocol.ts` gets a second matcher for people; `isAcceptPattern` learns the two forms.
`*` is documented as "every agent of the agent's own domain" and several installations rely on it: widening
it to people would open those projects by a merge. A person belongs to the domain of the project that lists
them — listing is the operator's statement that this person may read what the agent answers — so the
answering side's marks check treats the task as same-domain. The answer does leave the installation, to the
person's client; `docs/security.md` says so.

*Alternative rejected:* accept by gateway route (everyone the gateway lets onto a project's route). It moves
the decision out of the project's config into the gateway's, and one endpoint per installation would need a
route per project.

### D4. One listener in the bot process, per installation

The listener needs the turn engine, so it lives in the bot (not a separate `orch` command as `sources
serve`), started and stopped by `messagingRuntime` for whichever chat driver runs. One endpoint serves every
project: `agents` is the directory, `target` picks the agent. Settings: `AGENT_MCP_LISTEN` (`host:port`,
loopback when only a port is given) and `AGENT_MCP_TOKEN`. In a container deployment the operator publishes
the port to the gateway's network; the bearer is what keeps anyone else out.

The HTTP shell (bearer check, body limit, JSON-RPC framing, 405 on GET) is the same as `sources serve`'s;
it is lifted into a small shared module rather than copied.

### D5. Identity headers, fixed names

`X-MCP-User` (e-mail) and `X-MCP-Groups` (comma-separated). `X-MCP-User` is already the name an
installation's gateway uses toward its own MCP proxies. The names are constants, not settings: one more
setting would only let an installation misconfigure which header is trusted. The gateway must overwrite, not
append, these headers — a client-supplied copy must not survive; the docs' example route shows it.

### D6. Waiting is a bounded hold on the request

`waitSeconds` holds the HTTP response until the task's record changes to a state with content
(`completed`, `input-required`) or an end, or the time is up. The limit is 50 s: common MCP clients give a
tool call about a minute. Implemented as a per-task set of waiters the service wakes when it patches the
record — no polling of `state.json`. A bot restart drops the held request; the client calls `get_task`.

*Alternative rejected:* MCP progress notifications or an event stream to keep a long call alive. It needs a
stateful transport and client support that is uneven.

### D7. No idempotency key in v1

Agent calls derive the task id from the control channel's request id; a stateless HTTP call has none that is
stable across a client's retry. A retried `send_message` makes a second task. The daily cap bounds the
damage; a client-supplied key can be added without changing anything else.

### D8. `user` on usage records of answering turns only

`UsageRecord` gets an optional `user`. It is written where the task id already is — the shadow turns of a
task — when the task's asker is a person. Ordinary chat turns are not touched: that is a separate change
with its own questions (which id per chat platform).

## Risks / Trade-offs

- **Every question starts a cold session** → slower and dearer than a follow-up in a chat thread. Accepted
  for v1 (the maintainer's call); the cost per task is visible in `/aven asks`, which is the evidence for or
  against a kept session later.
- **The gateway is trusted for identity** → a misconfigured route that lets a client set `X-MCP-User` is an
  impersonation. Mitigation: the listener is bearer-protected and loopback by default; the docs' route
  example overwrites the headers; a boot warning when the listener is bound to a non-loopback address.
- **Answers leave to a third-party client** → an operator may list a group without thinking of that.
  Mitigation: stated in `docs/security.md` and beside the `accept` forms in the docs; nothing is accepted by
  default.
- **An ops repo ahead of the bot** → `user:` entries fail the config load on an older release (the validator
  throws on unknown forms). Mitigation: documented order (release first, entries after); the rollout row
  says it.
- **E-mail addresses in `state.json`, events and usage files** → personal data in more places. The same
  class as chat user ids there today; noted in the docs, no new store.
- **Held requests** → up to 50 s each. Bounded by the per-person daily cap and a small limit on concurrent
  waits per person.

## Migration Plan

Nothing to migrate. Rollout: merge (no installation sets the two settings) → on the canary installation set
them, add a route on its gateway, list one person on one project → ask from a client → the same on the first
client installation. Rollback: unset the settings and restart; the `user:` entries can stay only on a
release that knows them, so remove them before rolling the bot back past this change.

## Open Questions

- The concurrent-wait limit per person (a constant; 4 is the starting value).
- Whether Langdock sends anything a held request trips over (timeouts, retries): found out on the first
  real connection, changes a constant at most.
