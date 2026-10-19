## 0. Order with `agent-messaging`

- [ ] 0.1 Before archiving this change, archive `agent-messaging`, after its canary run (7.7) on home and the Teams staging installation. Its prod items move to prod's own rollout. Its 4.6a is moot until a Teams installation ingests its own workspace, so carry it as a follow-up. Verify: `openspec archive agent-messaging`, then `openspec validate hub-open-network --strict`.

## 1. Protocol version 2 (pure, shared)

- [x] 1.1 `src/messaging/protocol.ts` (design N5). Verify: `src/messaging/protocol.test.ts`.
  - `PROTOCOL_VERSION = 2` and `SIG_CONTEXT = 'coach-aven-hub/2'`.
  - The outer envelope `{v, id, from, to}` names installations.
  - The payload gains the agents (`from`, `to`), `method` and `task`.
  - Parsers for both halves.
  - `headerAad`, `signingText` and `kdfInfo` as in design N5; `challengeText(host, name, key, nonce)`.
- [x] 1.2 Frames. Verify: `src/messaging/protocol.test.ts`.
  - `auth {v, name, key, sig}`;
  - a new `allow {installations}`;
  - `hello {now, online, removed}` without `enrolled`;
  - `expired {id}`;
  - an `auth` in the version-1 shape parses as `unsupported version`.
- [x] 1.3 Address grammar. A target `<name>@<host>/<agent>` is refused, without contacting the hub, as "addresses on other hubs are not supported". `@` and `.` stay invalid in installation names. Verify: `src/messaging/protocol.test.ts`, and `src/messaging/service.test.ts` ("Address on another hub").
- [x] 1.4 `src/messaging/seal.ts`. Seal and open the version-2 envelope: the receiver's encryption key goes into the KDF info, tried for the current key and for the keys still in their grace period. `signChallenge` and `verifyChallenge` take the name and the key. Verify: `src/messaging/seal.test.ts`, with these cases:
  - a tampered envelope;
  - a wrong key;
  - an envelope re-targeted to another installation;
  - a name taken over by another key gives `bad_signature`;
  - the rotation grace period.
- [x] 1.5 `protocol.ts` and `a2a.ts` stay free of `node:` imports, because the hub shares them. Verify: `src/messaging/imports.test.ts`.

## 2. Hub

- [x] 2.1 `hub/src/config.ts`: `HUB_CONFIG` version 2 (design N7). Verify: `hub/test/hub.test.ts` ("Old configuration").
  - `registration`, `reserved`, and `limits` with defaults;
  - `local` and `hub` reserved for nobody;
  - the version-1 shape refused, with an error naming the expected shape.
- [x] 2.2 `hub/src/store.ts`: the schema 2 migration (design N6), which drops version-1 rows. Tables `names`, `allow`, `claims` and `removed(name, at, reason)`, and the `(installation, sender)` index. Verify: `hub/test/hub.test.ts` (migrating a version-1 store).
- [x] 2.3 `hub/src/index.ts`: `/connect?as=<name>` is checked and forwarded. The object refuses an `auth` whose name differs from the hint. Verify: `hub/test/hub.test.ts` ("Hint and claim differ").
- [x] 2.4 `hub/src/hub.ts`: `auth` version 2 and `admit()`.
  - Admission covers reserved names, bound names, and a free name under `open` within the claim limit; a key holds one name.
  - Refusal reasons go out as close reasons, and as `hub.auth.refused` logs without key material.
  - Verify: `hub/test/hub.test.ts` ("First claim", "Name taken", "One name per key", "Reserved name", "Closed registration", "Claim flood", "Version 1 client").
- [x] 2.5 Alignment and release.
  - On the first request after a deploy, revoke the names the configuration now reserves for nobody or for other keys.
  - The alarm releases names idle past `idleDays`.
  - Both tombstone the name, drop its outbox and allow list, close its socket and report it.
  - Verify: `hub/test/hub.test.ts` ("Installation removed", "Silent name").
- [x] 2.6 The allow list.
  - The `allow` frame replaces the stored list and is capped at `allowMax`.
  - The hub routes only when the recipient allows the sender.
  - A free, released, revoked or not-allowing recipient all get the same `rejected: unknown installation`.
  - Verify: `hub/test/hub.test.ts` ("Routed", "Recipient does not allow the sender", "Peer added", "Peer dropped", "Before any list").
- [x] 2.7 Presence along mutual edges (design N4).
  - `hello` has no `enrolled`.
  - `online` and pushed `presence` are recomputed per recipient on connect, disconnect and allow-list change.
  - Removals go to the installations whose list names the removed one.
  - Verify: `hub/test/hub.test.ts` ("Peer goes away", "One-sided allow list", "Nothing about strangers").
- [x] 2.8 Storage and logs at installation level.
  - Outbox rows and log lines carry no agent, method or task.
  - Expiries are reported as `expired {id}`.
  - The pair cap sits beside the recipient cap.
  - Verify: `hub/test/hub.test.ts` ("Stored envelope", "Hub logs", "Expired undelivered", "Backlog per sender", "Backlog cap").
- [x] 2.9 `hub/test/client.ts`, the test client, speaks version 2. Verify: `npm test` and `npx tsc --noEmit` in `hub/`.

## 3. Bot

- [x] 3.1 `src/messaging/hubclient.ts`. Verify: `src/messaging/hubclient.test.ts`.
  - `connectUrl(base, name)` adds `?as=`.
  - `auth` is version 2.
  - A refused `auth` logs `hub.connect.failed` with the hub's reason (design N2).
  - `hello` and `presence` have no `enrolled`; `enrolledInstallations()` goes.
- [x] 3.2 Sending and receiving in the hub client.
  - On send, a message is split into the outer envelope and the sealed payload.
  - On delivery, the two are joined and checked:
    - an envelope whose clear `to` is not this installation is dropped as unexpected;
    - a sealed `to` naming no local agent goes to the service, which answers `rejected: not accepted` (design N5).
  - The local transport is untouched.
  - Verify: `src/messaging/hubclient.test.ts`, and `src/messaging/transport.test.ts` with `src/messaging/service.test.ts` passing unchanged for the local path.
- [x] 3.3 The allow list. Send `Object.keys(peers)` after every `hello`, and after a `/aven reload` that changes the peers (`src/messaging/runtime.ts`). Verify: `src/messaging/hubclient.test.ts` ("Peer pinned on reload").
- [x] 3.4 Expiry by envelope id. The hub client keeps each routed record, without its ciphertext, until the bot's own task expiry; `expired {id}` finds the task there and ends it as today (design N5). Verify: `src/messaging/hubclient.test.ts`.
- [x] 3.5 Wording. `rejected: unknown installation` and `offline` tell the agent that the peer may not have pinned this installation. Verify: `src/messaging/service.test.ts` ("Peer has not pinned us").
- [x] 3.6 `orch hub keygen` prints the `reserved` entry for the hub's configuration, and the entry for the peers. Verify: `src/messaging/keygen.test.ts`.
- [x] 3.7 `npm run typecheck` and `npm test` pass, and the turn, prompt and Slack snapshots are unchanged. No Slack surface changes, so the Home tab needs no update.

## 4. Docs and rollout

- [x] 4.1 `docs/hub.md`, reviewed in the PR:
  - the version-2 configuration: registration, reserved names, limits;
  - joining a hub: a name is claimed on connect, and an operator reserves their own names;
  - removing an installation: reserve its name for nobody;
  - rotation: reserved names rotate as today; claimed names wait for key succession;
  - what the hub stores and logs;
  - the allow list is the pins;
  - `unknown installation` usually means a missing pin;
  - the cut-over.
- [x] 4.2 `docs/agent-messaging.md`: addresses (`name@host` reserved), the clear header, pins as the allow list. Also the comments in `hub/README.md` and `hub/wrangler.example.toml`. Reviewed in the PR.
- [x] 4.3 `docs/rollout.md` ledger row: bucket 3 behind `HUB_URL`, the cut-over order, and prod joining on a tag that carries version 2. Verify: `scripts/public-guard.sh` in CI.
- [x] 4.4 Every changed file and the PR text pass the public guard and gitleaks. Verify: CI `verify`.

## 5. Canary

- [x] 5.1 (done 2026-10-18: the operator's `hub.config.json` is version 2, `registration: open`, three names reserved; `/health` answers `ok`; the bots not yet upgraded logged `hub.connect.failed reason="unsupported version"` until their upgrade) In the operator's ops repo, put `hub.config.json` into the version-2 shape, with the operator's installations reserved (prod's name included), and deploy the hub. Verify: `/health`, and `hub.auth.refused unsupported version` from the bots not yet upgraded.
- [x] 5.2 (done 2026-10-19: both bots on version 2 since 2026-10-18 21:31 MSK, every boot logs `hub client for <name> → wss://… (1 pinned peer(s))` on both sides; the home tenant agent's `agents()` listed the staging installation with its project card, and four asks routed to it the same hour — presence is a tool's answer, not a `/aven` verb) Upgrade the Teams staging bot, and the home bot in its restart window. Verify: the connect logs, both allow lists sent, and each installation sees the other online.
- [x] 5.3 (done 2026-10-19 — the operator saw the cost line in `/aven asks` for the completed tasks; the hub's rows and logs are pinned by its tests, a live `wrangler tail` waits for the operator's login: the home tenant agent asked the staging `platform` project twice on 2026-10-18 (tasks `1f03d42a…`, `d93df5a5…`, both `completed`; the answering side's usage records carry `originSlug`/`taskId` and the cost, 0.115 and 0.404 USD); a stranger — a fresh key under a new name, `registration: open` admits it — sent an envelope to `home/owen-ops` and the hub answered `unknown installation` (home never saw it; a header with an id outside the protocol's format is `malformed` first); left: the cost line in `/aven asks` seen by a person, and a live look at the hub's rows and logs — `wrangler tail` needs the operator's login, the hub's tests pin that only installation names are stored and logged) End to end, recorded in the PR:
  - owen-ops asks a staging project and gets the answer, with its cost in `/aven asks`;
  - a stranger's key claims a name, and its envelope for home gets `unknown installation`;
  - the hub's stored rows and logs name installations only.
- [ ] 5.4 Prod joins later, on a tag that carries version 2: keygen, pins on both sides, `HUB_URL`. Neither archive waits for it.
