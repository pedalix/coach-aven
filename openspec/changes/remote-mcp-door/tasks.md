# Tasks

## 1. People in the accept list

- [x] 1.1 `protocol.ts`: a person matcher beside `accepts()` — `user:<e-mail>` and `group:<name>`, case-insensitive; `*` and agent entries never match a person, person entries never match an agent. Verify: new cases in `src/messaging/protocol.test.ts`
- [x] 1.2 `config.ts`: `isAcceptPattern` takes the two forms and refuses `user:` / `group:` with nothing after; the error text names all five forms. Verify: `src/messaging/config.test.ts`, including "a config without person entries validates exactly as before"
- [x] 1.3 `docs/agent-messaging.md`: the accept table gains the two forms, with the sentence that `*` is agents only and the release-before-entries order. Verify: `scripts/public-guard.sh` passes and the examples use `.example` addresses

## 2. A task asked by a person

- [x] 2.1 `service.ts`: an entry that takes `{person, groups, target, text, skill}` and creates the `InTask` with `from: user:<e-mail>` under the checks `onAsk` applies (accept, per-sender cap, skill, local target only), then starts the shadow conversation. Verify: `src/messaging/service.test.ts` — accepted, not accepted, unknown agent gives the same error, cap, unknown skill, a target of another installation
- [x] 2.2 Status changes of a person's task are written to the record and sent nowhere; the two places that parse `from` as an address branch on the prefix. Verify: service test — a completed, a failed and a canceled person task post no envelope and leave the right `state`/`last`/`cost`
- [x] 2.3 Reads and replies by the asker only: `getTask`, `cancelTask` and a reply on an `input-required` task for a person; another person gets the unknown-task error. Verify: service tests for each, including question back → reply → completed
- [x] 2.4 `reload()` ends a person's open tasks when their entry is gone (`canceled: not accepted`). Verify: service test with an entry removed between two calls
- [x] 2.5 Waiters: a per-task set woken when the record gets content or ends; a limit per person. Verify: service test with a fake clock — returns early on an answer, at the limit otherwise, the fifth concurrent wait of one person returns at once

## 3. The listener

- [x] 3.1 Lift the HTTP shell of `src/sources/serve.ts` (bearer check, body limit, JSON-RPC framing, 405 on GET) into a shared module and make `serve.ts` use it. Verify: `src/sources/serve.test.ts` passes unchanged
- [x] 3.2 The endpoint module in `src/messaging/`: identity from `X-MCP-User` / `X-MCP-Groups`, the four tools with `waitSeconds` on `send_message` and `get_task`, tool errors for a missing identity. Verify: a test beside it over a real loopback socket — 401 without the bearer, `tools/list` names four tools, a full ask → wait → answer round, an input field naming another person is ignored
- [x] 3.3 Settings in `config.ts` (`AGENT_MCP_LISTEN`, `AGENT_MCP_TOKEN`) and start/stop in `runtime.ts`; half-configured logs the missing one and opens nothing; a non-loopback bind warns. Verify: `src/messaging/runtime.test.ts` — unset opens no listener; a recorded turn of a messaging project (`src/chat/slack/turn.record.test.ts`) is byte-identical
- [x] 3.4 `docs/runtime-config.md`: the two settings and the gateway's part — an example route that verifies the person's token and overwrites the two headers; `docs/security.md`: what an accepted person reaches and that the answer leaves to their client. Verify: the example route's header names match the constants (a test greps the doc)

## 4. Audit and usage

- [x] 4.1 `/aven asks` shows a person's task with the e-mail as its origin; transcript and cancel work on it. Verify: the asks rendering test with one agent task and one person task
- [x] 4.2 `UsageRecord.user`, written on the answering turns of a person's task (the three places that record a task's origin). Verify: `src/metering.test.ts` (`originUser`, a record read back), `src/chat/slack/turn.record.test.ts` (an agent's task carries no `user`), and the end-to-end run of 5.2, whose usage record names the person
- [x] 4.3 `docs/rollout.md`: the ledger row — bucket 2, gates `AGENT_MCP_LISTEN` + `AGENT_MCP_TOKEN` and a `user:`/`group:` accept entry, what to watch on the canary. Verify: the row is in the code PR's diff

## 5. End to end

- [x] 5.1 `npm run typecheck` and `npm test` pass; `openspec validate remote-mcp-door --strict` passes
- [x] 5.2 On a scratch installation (`npm run preview`, the listener on loopback): a `curl` with the bearer and the headers lists agents, sends a task with `waitSeconds` and reads the answer. Verify: the responses pasted into the PR (done 2026-11-23: 401 without the bearer; no agent before the project lists anyone; after `group:support`, a question answered in one held call of 29.5 s; another person told `no task … of yours`; the usage record with `user`)

## Workflow follow-up

- Canary: set the two settings on the canary installation, add the route on its gateway (its ops repo), list one person on one project, ask from Claude; then the first client installation and its client.
- Archive the change after the merge; bring the accept sentence of `agent-messaging` in line there.
