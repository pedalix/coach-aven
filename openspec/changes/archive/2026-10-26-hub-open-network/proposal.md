# Proposal

> **Status: proposed 2026-10-18.** Decisions taken in review:
> - **The hub is an open relay.** It serves anyone's installations, not one operator's.
>   - Registration is open by default; the hub operator can close it, and more admission modes plug in later.
>   - Every node is untrusted by default: the hub, the installations and their sandboxes.
> - **Identity is a key; a name is a handle on it.**
>   - An installation is its signing key. Its name is unique on its hub and goes to the first key that claims it.
>   - A hub is named by its host, so `name@host` stays free for federation, which is not built.
> - **Each installation decides its inbound.** The hub only enforces the coarse part: it delivers to an installation only from installations that installation pinned. Which agent may ask which stays private on the receiving side.
> - **The hub sees installations, not agents.** Agent names, the method and the task id move inside the encryption.
> - **No compatibility layer.** The protocol becomes version 2 and version 1 is refused: only the operator's own canary installations speak it today.

## Why

The hub was built for one operator's installations:
- the operator enrols each one by hand in the hub's configuration;
- each pair of installations pins the other's keys by hand.

That shape does not survive the next users: other people's installations, and a person's own Claude Code on a laptop. The hub operator does not trust them, and they do not trust each other. Four properties of today's protocol would leak or break:
- **Admission** is a list the hub operator edits and redeploys, one line per installation.
- **Every installation learns about every other.** `hello` lists all enrolled installations, and presence goes to everyone, so a public hub would publish its users and their activity.
- **Anyone admitted can fill anyone's mailbox.** The hub routes between any two enrolled installations. The receiver refuses only after the envelope has taken its share of the 1000-envelope backlog.
- **The hub sees who asks which agent what.** The clear header carries both agent names, the method and the task id.

Now is the time: only the operator's canary installations speak this protocol. It can change without a compatibility layer, and no old release has to keep reading it, because prod has no messaging configured yet.

## What Changes

- **Names (BREAKING).**
  - An installation claims its name when it connects. The hub binds a free name to the claiming key, first come first served, one name per key; a bound name admits only its key.
  - The hub operator's configuration becomes a policy:
    - `registration: open | closed`;
    - reserved names, each bound to keys (the operator's own installations; in `closed` mode the only ones admitted) or to nobody (blocked names);
    - limits: claims per IP address per day, and the idle days after which a name is released.
  - A released or revoked name is reported like a removed installation.
  - The grammar `name@host` is reserved for addresses on other hubs and refused for now.
- **Inbound allow list (BREAKING).**
  - After connecting, and again on every `/aven reload`, an installation sends the hub the installations it pinned in `hub.peers.json`.
  - The hub routes an envelope only when the recipient allows the sender. It answers anything else as `unknown installation`, so a sender cannot learn who exists.
  - A new installation hears from nobody until it pins a peer.
- **Presence along relationships (BREAKING).** An installation sees another online only when the two allow each other. It hears of a removal only for installations it allows. `hello` no longer lists enrolled installations.
- **Quota per pair.** The per-recipient backlog stays at 1000 envelopes or 50 MB. On top of it, one sender may hold at most 200 envelopes or 10 MB waiting for one recipient.
- **Installation-level header (BREAKING).**
  - The clear envelope carries only the version, the id, and the sending and receiving installations. Agent names, the method and the task id travel sealed.
  - The hub stores and logs only those fields and sizes, and reports an expiry by envelope id.
  - The key derivation binds the receiver's encryption key and the signature the sender's signing key, so a name that changes hands can neither open nor forge an envelope.
- **Connect hint.**
  - The bot connects to `wss://<hub>/connect?as=<name>`, and the hub refuses an `auth` for another name.
  - The hint lets a later hub give each installation its own object without a protocol change.
- **Version 2 (BREAKING).** Envelopes, frames and the signed challenge carry version 2. Version 1 is refused with `unsupported version`.

## Out of scope

Each of these is an extension the design leaves room for; none is built here:
- pairing codes and `/aven peer add`;
- encryption keys signed by the identity key and served by the hub: one pin per peer, then prekeys and forward secrecy;
- key succession, a new key signed by the old one. Until then, rotation works as today for reserved names;
- organisation keys, names on an installation's own domain (`/.well-known/`), a public log of name bindings;
- contact requests from installations not yet pinned, and a directory of installations;
- one object per installation on the hub (sharding), and federation between hubs;
- a laptop node: an MCP server that makes a person's Claude Code an installation of one agent;
- padding envelope sizes.

Also out of scope: accepting tasks from installations the operator does not run. That still waits for the hard read-only mode of shadow conversations (`agent-messaging` design, Risks). Open registration does not need it, because an installation hears only from peers it pinned.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
Both capabilities come from the `agent-messaging` change, which is not archived yet. It is archived first, and this change's deltas apply to the specs it leaves.
- `messaging-hub`:
  - changed: connecting and proving a key (the name claim, the hint, version 2);
  - changed: routing, only to installations that allow the sender;
  - changed: what the hub sees, installations only;
  - changed: delivery (expiry by envelope id, quota per pair);
  - changed: presence, along relationships and with no enrolment list;
  - new: names, first come first served under a registration policy;
  - new: the inbound allow list.
- `agent-messaging`:
  - changed: encryption between installations (installation-level header, keys bound);
  - changed: different releases (version 2 refuses version 1);
  - changed: discovery (a peer that does not accept the caller reads as offline);
  - new: pinned peers are the installation's allow list at the hub;
  - new: addresses on other hubs are refused for now.

## Impact

- **Rollout.**
  - Bucket 3: everything here runs only with `HUB_URL` set. Today that means the operator's home bot and the Teams staging installation; prod has no `HUB_URL`.
  - Inside an installation (bucket 2) nothing changes: the local transport keeps its behaviour, proved by the existing service tests.
  - The cut-over is one step for all hub users: deploy the hub with version 2 and the new configuration, then upgrade the canary bots (home in its restart window).
  - Prod joins the hub only on a tag that carries version 2.
  - One ledger row in `docs/rollout.md`.
- **Code.**
  - Bot side:
    - `src/messaging/protocol.ts`: the version, header, frames and address grammar;
    - `seal.ts`: what is signed and what goes into key derivation;
    - `hubclient.ts`: the hint, `auth`, `allow`, presence, and expiries by envelope id;
    - `runtime.ts`: the allow list on reload;
    - the services that build and read envelopes, and the task records (the envelope ids of each task).
  - Hub side:
    - `hub/src/config.ts`: the policy;
    - `store.ts`: names, allow lists, outbox columns, counts per pair, and a migration that drops version-1 rows;
    - `hub.ts`: the claim, the filter, presence and the quota;
    - `index.ts`: the hint.
- **Config.**
  - The hub's `HUB_CONFIG` changes shape (`registration`, `reserved`, `limits`). A configuration in the old shape is refused at start.
  - Bots get no new setting. `hub.peers.json` keeps its format and gains a meaning: it is the allow list.
- **Data.**
  - The hub stores ciphertext, both installations, sizes and times, and the name registry (name, key, when it was claimed and last seen).
  - Version-1 envelopes still waiting at cut-over are dropped, and the canary tasks they belong to fail as expired.
